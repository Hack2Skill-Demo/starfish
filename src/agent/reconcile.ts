/**
 * Reconciling a pull request's later life (#17), by POLLING: a cycle ends when its pull request is opened, but what
 * happens to the PR afterwards (merged, closed, the required checks on its head passing or failing) is worth knowing on
 * the Runs and evidence pages. Each agent pass reads a bounded number of opened PRs back from GitHub and records what it
 * saw on the cycle as `summary.prState` (cycle.ts `recordPrState`).
 *
 * What it will not do:
 *   - Write to GitHub. `readPullRequest` and `listCheckRuns` are GETs.
 *   - Change a cycle's outcome, or touch the incident. A merged PR, or a closed issue, never marks an incident healed:
 *     that takes deployment and recovery evidence (#9, #11), which this does not have.
 *   - Go backwards. Observations are ordered by when GitHub was read, and a merge is final (cycle.ts).
 *   - Read without bound. At most `maxPrChecksPerPass` PRs a pass, chosen among the newest `MAX_SCAN` cycles of this
 *     environment, least recently checked first; a PR whose merge and checks are both settled is not read again. A
 *     cycle older than the newest `MAX_SCAN` is not reconciled any more.
 *
 * Polling, not webhooks: a webhook would need a public endpoint and its secret; a pass already runs on a schedule.
 * Never run against real GitHub: tested with a fake GitHub API and the Firestore emulator.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { redactPii } from "../ingest/redact.js";
import type { CheckRun, GithubClient } from "../integrations/githubPr.js";
import { recordPrState, type CycleConfig, type PrStateRecord } from "./cycle.js";

export type ReconcileConfig = Pick<StarfishConfig, "environment" | "verifyChecks" | "maxPrChecksPerPass"> & CycleConfig;
export type PrReader = Pick<GithubClient, "readPullRequest" | "listCheckRuns">;

/** Cycles scanned for an opened PR, newest first. Uses the Runs page's (environment, updatedAt) index. */
export const MAX_SCAN = 200;
const MAX_FAILED_NAMES = 300;
/** Errors after which the rest of the pass would only fail the same way. */
const STOP_RULES: ReadonlySet<string> = new Set(["unauthorized", "forbidden", "rate-limited"]);

type CheckSummary = Pick<PrStateRecord, "checks" | "checksPassed" | "checksRequired" | "failedChecks">;

/**
 * The named required checks on a commit, judged like the CI verifier judges them (verifyCi.ts): only a `success` passes.
 * A re-run leaves several runs with one name; the newest (highest id) is the one that counts. One failed: `failed`.
 * Otherwise one still running: `pending`; one never reported: `missing`; all succeeded: `passed`. None named:
 * `not-configured`, said as such and never as passed.
 */
export function summarizeChecks(runs: readonly CheckRun[], required: readonly string[]): CheckSummary {
  if (required.length === 0) return { checks: "not-configured", checksPassed: 0, checksRequired: 0 };
  const latest = new Map<string, CheckRun>();
  for (const r of runs) {
    if (!required.includes(r.name)) continue;
    const seen = latest.get(r.name);
    if (!seen || r.id > seen.id) latest.set(r.name, r);
  }
  const named = required.map((n) => latest.get(n));
  const passed = named.filter((r) => r?.status === "completed" && r.conclusion === "success").length;
  const failed = named.filter((r): r is CheckRun => r?.status === "completed" && r.conclusion !== "success");
  const base = { checksPassed: passed, checksRequired: required.length };
  if (failed.length > 0) return { ...base, checks: "failed", failedChecks: failed.map((r) => r.name).join(", ").slice(0, MAX_FAILED_NAMES) };
  if (named.some((r) => r !== undefined && r.status !== "completed")) return { ...base, checks: "pending" };
  if (named.some((r) => r === undefined)) return { ...base, checks: "missing" };
  return { ...base, checks: "passed" };
}

export interface PrCycle {
  cycleId: string;
  number: number;
}

const SETTLED_CHECKS: readonly string[] = ["passed", "failed", "not-configured"];

/**
 * The finished cycles with an opened PR worth reading again, least recently checked first (never checked first), at
 * most `limit`. A merged PR whose checks are settled is left alone: nothing about it can change that matters here.
 */
export async function selectPrCycles(db: Firestore, cfg: ReconcileConfig, limit: number): Promise<PrCycle[]> {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const snap = await db.collection(cfg.cycleCollection).where("environment", "==", cfg.environment).orderBy("updatedAt", "desc").limit(MAX_SCAN).get();
  const found: { cycleId: string; number: number; checkedMs: number }[] = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const pr = d.summary?.pr as { opened?: unknown; number?: unknown } | undefined;
    if (d.state !== "done" || pr?.opened !== true || typeof pr.number !== "number" || !Number.isInteger(pr.number) || pr.number < 1) continue;
    const prior = d.summary?.prState as { state?: unknown; checks?: unknown; checkedAt?: unknown } | undefined;
    if (prior?.state === "merged" && SETTLED_CHECKS.includes(String(prior.checks))) continue;
    const checked = typeof prior?.checkedAt === "string" ? Date.parse(prior.checkedAt) : NaN;
    found.push({ cycleId: doc.id, number: pr.number, checkedMs: Number.isFinite(checked) ? checked : -Infinity });
  }
  return found
    .sort((a, b) => a.checkedMs - b.checkedMs)
    .slice(0, limit)
    .map(({ cycleId, number }) => ({ cycleId, number }));
}

export interface ReconcileDeps {
  db: Firestore;
  config: ReconcileConfig;
  client: PrReader;
  now: () => Date;
}

export interface ReconcileSummary {
  considered: number;
  /** Observations written to a cycle. */
  recorded: number;
  /** Read, but not written: older than what was recorded, or a merged PR read as not merged. */
  unchanged: number;
  errors: { cycleId: string; message: string }[];
  /** Set when the pass stopped early on an error that every other PR would hit too (credentials, rate limit). */
  stoppedBecause?: string;
}

const describeError = (err: unknown): string => redactPii(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300);

/** One bounded round of reconciling. Never throws for one PR: its error is kept and the next goes ahead. */
export async function reconcilePullRequests(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const { db, config: cfg, client } = deps;
  const picked = await selectPrCycles(db, cfg, cfg.maxPrChecksPerPass);
  const summary: ReconcileSummary = { considered: picked.length, recorded: 0, unchanged: 0, errors: [] };
  for (const { cycleId, number } of picked) {
    try {
      // The time BEFORE the reads orders this observation: whatever it saw was true at that time or later.
      const checkedAt = deps.now().toISOString();
      const pr = await client.readPullRequest(cycleId, number);
      const runs = cfg.verifyChecks.length > 0 ? await client.listCheckRuns(pr.headSha) : [];
      const written = await recordPrState(db, cfg, cycleId, {
        number: pr.number,
        state: pr.state,
        mergedAt: pr.mergedAt,
        closedAt: pr.closedAt,
        headSha: pr.headSha,
        ...summarizeChecks(runs, cfg.verifyChecks),
        checkedAt,
      });
      if (!written.ok) summary.errors.push({ cycleId, message: `not recorded: ${written.reason}` });
      else if (written.applied) summary.recorded += 1;
      else summary.unchanged += 1;
    } catch (err) {
      summary.errors.push({ cycleId, message: describeError(err) });
      const rule = (err as { rule?: unknown } | null)?.rule;
      if (typeof rule === "string" && STOP_RULES.has(rule)) {
        summary.stoppedBecause = rule;
        break;
      }
    }
  }
  return summary;
}
