/**
 * One PASS of the agent over the incident store (#74): which incidents are worth a cycle, which source files
 * the stack trace names, and a bounded driver that runs a cycle for each. Everything here is plain
 * functions with the store and the cycle injected, so it is tested without any job around it.
 *
 * What this file is NOT: the job. `src/agentCli.ts` is the entrypoint, and `scripts/deploy-gcp.sh` (DEPLOY_AGENT=1)
 * deploys it with a separate verify job, because the verify gate runs the target repository's own tests (candidate
 * code) and `verifyGate.ts` is not a sandbox: with `cloud-run-job` isolation the agent never runs them itself.
 */
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { OPEN_INCIDENT_STATUSES } from "../types.js";
import { cycleId, type CycleConfig, type CycleState } from "./cycle.js";
import { isExcludedPath } from "./verifyGate.js";
import type { LoopResult } from "./loop.js";

export type PassConfig = Pick<StarfishConfig, "environment" | "incidentCollection" | "patchExcludedPaths"> & CycleConfig;

export interface Candidate {
  incidentId: string;
  /** The incident's `recurrenceCount`: one cycle per recurrence. */
  recurrence: number;
}

/** A cycle in one of these states is finished or waiting on a person: running it again would only repeat it. */
const SETTLED: readonly CycleState[] = ["done", "declined", "waiting-human", "failed"];

const OPEN: readonly string[] = OPEN_INCIDENT_STATUSES;

/** Incidents scanned per candidate wanted: most of a page is closed or already has a settled cycle. */
const SCAN_FACTOR = 5;
const MAX_SCAN = 500;

/**
 * Open incidents of this environment that have no settled cycle for their current recurrence, newest
 * activity first, at most `limit`. A cycle that is absent or still `running` is a candidate (the loop's
 * lease decides whether another worker holds it). An operator-retired incident is never one. Uses the same
 * (environment, lastOccurredAt) index as the incidents list, so it needs no new index.
 */
export async function selectCandidates(db: Firestore, cfg: PassConfig, limit: number): Promise<Candidate[]> {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const scan = Math.min(limit * SCAN_FACTOR, MAX_SCAN);
  const snap = await db
    .collection(cfg.incidentCollection)
    .where("environment", "==", cfg.environment)
    .orderBy("lastOccurredAt", "desc")
    .limit(scan)
    .get();

  const open: Candidate[] = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.retired === true || !OPEN.includes(String(d.status))) continue;
    const recurrence = typeof d.recurrenceCount === "number" && Number.isInteger(d.recurrenceCount) && d.recurrenceCount >= 0 ? d.recurrenceCount : 0;
    const id = cycleId({ incidentId: doc.id, environment: cfg.environment, recurrence });
    if (id === null) continue; // an id that cannot name a cycle is never worked on
    open.push({ incidentId: doc.id, recurrence });
  }
  if (open.length === 0) return [];

  const refs = open.map((c) => db.collection(cfg.cycleCollection).doc(cycleId({ incidentId: c.incidentId, environment: cfg.environment, recurrence: c.recurrence })!));
  const cycles: DocumentSnapshot[] = await db.getAll(...refs);
  const out: Candidate[] = [];
  open.forEach((c, i) => {
    const state = cycles[i]?.data()?.state as CycleState | undefined;
    if (state !== undefined && SETTLED.includes(state)) return;
    if (out.length < limit) out.push(c);
  });
  return out;
}

// ---- Which files the stack trace names ----------------------------------------------------------------------

const FRAME_RE = /((?:[A-Za-z]:)?[^\s():'"]+\.(?:[cm]?[jt]sx?|py|go|java|rb|kt)):\d+(?::\d+)?/g;
const MAX_STACK = 20_000;

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^file:\/+/, "/").replace(/\/{2,}/g, "/");

/** Alternative spellings of a frame's file: compiled output names the .js of a .ts source. */
function spellings(path: string): string[] {
  const out = [path];
  if (/\.(?:[cm]?js)$/.test(path)) out.push(path.replace(/\.([cm]?)js$/, ".$1ts"), path.replace(/\.js$/, ".tsx"));
  return out;
}

/**
 * Repository files a stack trace points at, top frame first, deduplicated, at most `max`. A frame's path is
 * matched against the repository's own file list, never read from disk by name: a path in a log is untrusted
 * text, and only a file that is really in the repository, not excluded and not in `node_modules`, can be
 * chosen. The match is the longest repository path the frame path ends with; failing that, a UNIQUE
 * match once a leading directory such as `src/` is dropped (compiled output rarely keeps it).
 */
export function pathsFromStack(stack: string | undefined, repoFiles: readonly string[], excluded: readonly string[], max = 5): string[] {
  if (!stack || max < 1) return [];
  const files = repoFiles.filter((f) => !f.split("/").includes("node_modules") && !isExcludedPath(f, excluded));
  const chosen: string[] = [];
  const seen = new Set<string>();
  for (const m of stack.slice(0, MAX_STACK).matchAll(FRAME_RE)) {
    const frame = norm(m[1]!);
    if (frame.split("/").includes("node_modules") || frame.startsWith("node:")) continue;
    for (const candidate of spellings(frame)) {
      const exact = files
        .filter((f) => candidate === f || candidate.endsWith(`/${f}`))
        .sort((a, b) => b.length - a.length)[0];
      let hit = exact;
      if (hit === undefined) {
        const loose = files.filter((f) => {
          const rest = f.split("/").slice(1).join("/");
          return rest.includes("/") && candidate.endsWith(`/${rest}`);
        });
        if (loose.length === 1) hit = loose[0];
      }
      if (hit !== undefined) {
        if (!seen.has(hit)) {
          seen.add(hit);
          chosen.push(hit);
        }
        break;
      }
    }
    if (chosen.length >= max) break;
  }
  return chosen;
}

// ---- The bounded driver --------------------------------------------------------------------------------------

export interface PassSummary {
  considered: number;
  /** Cycles that were handed to the loop. */
  ran: number;
  results: { incidentId: string; result: LoopResult }[];
  /** A cycle whose run threw: an infrastructure failure. Its lease will expire and it will be resumed. */
  errors: { incidentId: string; message: string }[];
  /** The pass stopped early because the store or the opener kept failing. */
  aborted: boolean;
}

/** Stop after this many cycles in a row threw: the thing they depend on is probably down. */
export const MAX_CONSECUTIVE_ERRORS = 3;

export interface PassDeps {
  select: (limit: number) => Promise<Candidate[]>;
  run: (candidate: Candidate) => Promise<LoopResult>;
  /** The most cycles one pass may start. */
  maxCycles: number;
  /** Redacts and bounds an error before it is kept. */
  describeError: (err: unknown) => string;
}

/**
 * Run a cycle for each candidate, one at a time (they share the model budget and the machine), at most
 * `maxCycles`. A cycle that returns a refusal (lease held elsewhere, closed) is a result, not an error. One that
 * throws is recorded and the next goes ahead, unless `MAX_CONSECUTIVE_ERRORS` in a row did: then the pass
 * stops, because carrying on against a store that is down would only burn the lease of every cycle.
 * Selecting candidates may throw: with nothing to select there is nothing to report, so the caller sees it.
 */
export async function runAgentPass(deps: PassDeps): Promise<PassSummary> {
  const candidates = await deps.select(deps.maxCycles);
  const summary: PassSummary = { considered: candidates.length, ran: 0, results: [], errors: [], aborted: false };
  let streak = 0;
  for (const candidate of candidates.slice(0, deps.maxCycles)) {
    summary.ran += 1;
    try {
      summary.results.push({ incidentId: candidate.incidentId, result: await deps.run(candidate) });
      streak = 0;
    } catch (err) {
      summary.errors.push({ incidentId: candidate.incidentId, message: deps.describeError(err) });
      streak += 1;
      if (streak >= MAX_CONSECUTIVE_ERRORS) {
        summary.aborted = true;
        break;
      }
    }
  }
  return summary;
}
