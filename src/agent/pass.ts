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
import { reconsiderTrigger, utcDay, type ReconsiderPolicy, type ReconsiderTrigger } from "./reconsider.js";
import { isExcludedPath } from "./verifyGate.js";
import type { LoopResult } from "./loop.js";

export type PassConfig = Pick<StarfishConfig, "environment" | "incidentCollection" | "patchExcludedPaths"> & CycleConfig;

export interface Candidate {
  incidentId: string;
  /** The incident's `recurrenceCount`: one cycle per recurrence. */
  recurrence: number;
  /** Set when the cycle was declined and new evidence arrived since (reconsider.ts); the lease acquire decides again. */
  reconsider?: ReconsiderTrigger;
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
 * lease decides whether another worker holds it). A `declined` one is too, with `opts.reconsider`, when new
 * evidence arrived since its decision (reconsider.ts; the lease acquire checks again in its transaction).
 * An operator-retired incident is never one. Uses the same (environment, lastOccurredAt) index as the
 * incidents list, so it needs no new index.
 */
export async function selectCandidates(
  db: Firestore,
  cfg: PassConfig,
  limit: number,
  opts: { reconsider?: ReconsiderPolicy; now?: Date } = {}
): Promise<Candidate[]> {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const scan = Math.min(limit * SCAN_FACTOR, MAX_SCAN);
  const snap = await db
    .collection(cfg.incidentCollection)
    .where("environment", "==", cfg.environment)
    .orderBy("lastOccurredAt", "desc")
    .limit(scan)
    .get();

  const open: Candidate[] = [];
  const incidents = new Map<string, Record<string, unknown>>();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.retired === true || !OPEN.includes(String(d.status))) continue;
    const recurrence = typeof d.recurrenceCount === "number" && Number.isInteger(d.recurrenceCount) && d.recurrenceCount >= 0 ? d.recurrenceCount : 0;
    const id = cycleId({ incidentId: doc.id, environment: cfg.environment, recurrence });
    if (id === null) continue; // an id that cannot name a cycle is never worked on
    open.push({ incidentId: doc.id, recurrence });
    incidents.set(doc.id, d);
  }
  if (open.length === 0) return [];

  const refs = open.map((c) => db.collection(cfg.cycleCollection).doc(cycleId({ incidentId: c.incidentId, environment: cfg.environment, recurrence: c.recurrence })!));
  const cycles: DocumentSnapshot[] = await db.getAll(...refs);
  const out: Candidate[] = [];
  const now = opts.now ?? new Date();
  open.forEach((c, i) => {
    const data = cycles[i]?.data();
    const state = data?.state as CycleState | undefined;
    if (state === "declined" && data && opts.reconsider) {
      const trigger = reconsiderTrigger(data, incidents.get(c.incidentId), opts.reconsider, now);
      if (trigger !== null && out.length < limit) out.push({ ...c, reconsider: trigger });
      return;
    }
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

/** Directories that hold compiled output or sources: not part of what makes two paths the same file. */
const BUILD_DIRS = new Set(["src", "lib", "dist", "build", "out"]);
const CODE_EXT = /\.[cm]?[jt]sx?$/;

/**
 * The repository file whose path and a frame's path share the longest tail once build directories are ignored, when
 * that tail has at least two segments (a directory and a file) and exactly one file has it. This is what finds
 * `functions/src/orders/createOrder.ts` from a Cloud Functions frame `/workspace/lib/orders/createOrder.js`: the
 * repository keeps its code under a package directory and the build drops it. Never a bare file name, never a tie.
 */
function tailMatch(candidate: string, files: readonly string[]): string | undefined {
  if (!CODE_EXT.test(candidate)) return undefined;
  const segs = (p: string): string[] => p.replace(CODE_EXT, "").split("/").filter((x) => x !== "" && !BUILD_DIRS.has(x));
  const want = segs(candidate);
  let best = 0;
  let hits: string[] = [];
  for (const f of files) {
    if (!CODE_EXT.test(f)) continue;
    const have = segs(f);
    let k = 0;
    while (k < have.length && k < want.length && have[have.length - 1 - k] === want[want.length - 1 - k]) k++;
    if (k > best) {
      best = k;
      hits = [f];
    } else if (k === best && k > 0) hits.push(f);
  }
  return best >= 2 && hits.length === 1 ? hits[0] : undefined;
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
      if (hit === undefined) hit = tailMatch(candidate, files);
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

/**
 * How many cycles of this environment were started (created, or reopened for a reconsideration) on the UTC day of
 * `now`: what the daily cap compares against. One count aggregation over the cycle documents' `startDays`, so it
 * reads no documents. A cycle started twice in one day counts once, so the cap bounds distinct cycles started per day;
 * a cycle written before `startDays` existed is not counted. Throws when the store does: the caller then starts nothing.
 */
export async function countCyclesStartedToday(db: Firestore, cfg: Pick<PassConfig, "environment" | "cycleCollection">, now: Date): Promise<number> {
  const snap = await db
    .collection(cfg.cycleCollection)
    .where("environment", "==", cfg.environment)
    .where("startDays", "array-contains", utcDay(now))
    .count()
    .get();
  return snap.data().count;
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
  /**
   * The pass did nothing at all: automation is off (or the switch could not be read, which reads as off), or the
   * daily cycle cap was already reached.
   */
  skipped?: "automation-disabled" | "daily-cap";
  /** The daily cycle cap, and how many cycles had been started today before this pass. Absent when no cap is given. */
  daily?: { cap: number; startedBefore: number };
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
  /**
   * The kill switch, asked once before anything is selected (#133). Off: the pass starts no cycle at all, so no
   * incident is touched while automation is off. Absent: on.
   */
  automationEnabled?: () => Promise<boolean>;
  /**
   * The daily cycle cap (#5/#7): the most cycles started per UTC day, and how many were started today so far, asked
   * once before anything is selected. A pass then selects at most what is left; the resumes it runs count against that
   * too, so one pass alone can only undershoot the cap. Two passes running at the same time each count before either
   * starts, so together they could pass it by up to one pass's `maxCycles`. Absent: no daily cap.
   */
  daily?: { cap: number; startedToday: () => Promise<number> };
}

/**
 * Run a cycle for each candidate, one at a time (they share the model budget and the machine), at most
 * `maxCycles`. A cycle that returns a refusal (lease held elsewhere, closed) is a result, not an error. One that
 * throws is recorded and the next goes ahead, unless `MAX_CONSECUTIVE_ERRORS` in a row did: then the pass
 * stops, because carrying on against a store that is down would only burn the lease of every cycle.
 * Selecting candidates may throw: with nothing to select there is nothing to report, so the caller sees it.
 */
export async function runAgentPass(deps: PassDeps): Promise<PassSummary> {
  if (deps.automationEnabled && !(await deps.automationEnabled())) {
    return { considered: 0, ran: 0, results: [], errors: [], aborted: false, skipped: "automation-disabled" };
  }
  let limit = deps.maxCycles;
  let daily: PassSummary["daily"];
  if (deps.daily) {
    const startedBefore = await deps.daily.startedToday();
    daily = { cap: deps.daily.cap, startedBefore };
    const left = Math.floor(deps.daily.cap - startedBefore);
    if (left < 1) return { considered: 0, ran: 0, results: [], errors: [], aborted: false, skipped: "daily-cap", daily };
    limit = Math.min(limit, left);
  }
  const candidates = await deps.select(limit);
  const summary: PassSummary = { considered: candidates.length, ran: 0, results: [], errors: [], aborted: false, ...(daily && { daily }) };
  let streak = 0;
  for (const candidate of candidates.slice(0, limit)) {
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
