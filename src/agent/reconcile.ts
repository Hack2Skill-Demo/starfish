/**
 * Reconciling a pull request's later life (#17), by POLLING: a cycle ends when its pull request is opened, but what
 * happens to the PR afterwards (merged, closed, the required checks on its head passing or failing) is worth knowing on
 * the Runs and evidence pages. Each agent pass reads a bounded number of opened PRs back from GitHub and records what it
 * saw on the cycle as `summary.prState` (cycle.ts `recordPrState`).
 *
 * What it will not do:
 *   - Write to GitHub. `readPullRequest` and `listCheckRuns` are GETs.
 *   - Change a cycle's outcome, or the incident's status. A merged PR, or a closed issue, never marks an incident healed:
 *     that takes deployment and recovery evidence (#9, #11), which this does not have. The PR's state is copied onto
 *     the incident's `githubPrState` for the UI's link, and nothing else of it is written (incidentLinks.ts).
 *   - Go backwards. Observations are ordered by when GitHub was read, and a merge is final (cycle.ts).
 *   - Read without bound. At most `maxPrChecksPerPass` PRs a pass, the least recently observed first, chosen by the
 *     cycle's own watch mark (`observedAt.pr`, cycle.ts, #422) however old the cycle is: a PR a person merges weeks
 *     later is still read. The mark is set when the cycle finishes having opened a PR, moved by every read, and removed
 *     once nothing about the PR can change that matters (cycle.ts `prWatchEnded`: merged with its checks settled and
 *     its merge commit kept, or closed unmerged for a week). Until #422 the scan was the newest 200 cycles by
 *     `updatedAt`, which these reads never move, so an older PR fell out of it; a cycle finished before the mark
 *     existed is still found (among the first `MAX_SCAN` PR cycles) and gets one on its first read.
 *
 * Polling, not webhooks: a webhook would need a public endpoint and its secret; a pass already runs on a schedule.
 * Never run against real GitHub: tested with a fake GitHub API and the Firestore emulator.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { redactPii } from "../ingest/redact.js";
import type { CheckRun, GithubClient } from "../integrations/githubPr.js";
import { markObserved, observedMs, prWatchEnded, recordPrState, unmarkWatched, type CycleConfig, type CycleKey, type ObservedBy, type PrStateRecord } from "./cycle.js";
import { linkIncident } from "./incidentLinks.js";

export type ReconcileConfig = Pick<StarfishConfig, "environment" | "verifyChecks" | "verifyCheckApp" | "maxPrChecksPerPass" | "incidentCollection"> & CycleConfig;
export type PrReader = Pick<GithubClient, "readPullRequest" | "listCheckRuns">;

/**
 * The most cycles one bounded scan of the post-merge watchers reads: cycles finished before their watch mark existed
 * (#422, here and recoveryStep.ts), and the cycles in a watched record state (autoMerge.ts `cyclesInState`).
 */
export const MAX_SCAN = 200;

/** Whether a cycle carries the watch mark `observedAt.<by>` (cycle.ts, #422). */
export const isMarked = (d: Record<string, unknown>, by: ObservedBy): boolean => (d.observedAt as Record<string, unknown> | undefined)?.[by] !== undefined;
const MAX_FAILED_NAMES = 300;
/** Errors after which the rest of the pass would only fail the same way. */
const STOP_RULES: ReadonlySet<string> = new Set(["unauthorized", "forbidden", "rate-limited"]);

type CheckSummary = Pick<PrStateRecord, "checks" | "checksPassed" | "checksRequired" | "failedChecks">;

/**
 * The runs that can stand for the named required checks: the right name, posted by the configured app
 * (`verifyCheckApp`, `github-actions` by default). A run of that name from any other GitHub App is ignored: it can neither
 * pass nor hide a failure (#205). The slug does not tell workflows apart: every workflow in the target repository posts
 * as `github-actions`.
 */
export function requiredRuns(runs: readonly CheckRun[], required: readonly string[], app: string): CheckRun[] {
  return runs.filter((r) => required.includes(r.name) && r.app === app);
}

/**
 * The named required checks on a commit, judged like the CI verifier judges them (verifyCi.ts): only the configured
 * app's runs count (`requiredRuns`), and EVERY run of a name must be a `success`: a newer run that passed does not hide
 * one that failed (#205). One failed: `failed`. Otherwise one still running: `pending`; a name never reported:
 * `missing`; all succeeded: `passed`. None named: `not-configured`, said as such and never as passed.
 */
export function summarizeChecks(runs: readonly CheckRun[], required: readonly string[], app: string): CheckSummary {
  if (required.length === 0) return { checks: "not-configured", checksPassed: 0, checksRequired: 0 };
  const counted = requiredRuns(runs, required, app);
  const byName = required.map((n) => counted.filter((r) => r.name === n));
  const failed = required.filter((_, i) => byName[i]!.some((r) => r.status === "completed" && r.conclusion !== "success"));
  const passed = byName.filter((rs) => rs.length > 0 && rs.every((r) => r.status === "completed" && r.conclusion === "success")).length;
  const base = { checksPassed: passed, checksRequired: required.length };
  if (failed.length > 0) return { ...base, checks: "failed", failedChecks: failed.join(", ").slice(0, MAX_FAILED_NAMES) };
  if (byName.some((rs) => rs.some((r) => r.status !== "completed"))) return { ...base, checks: "pending" };
  if (byName.some((rs) => rs.length === 0)) return { ...base, checks: "missing" };
  return { ...base, checks: "passed" };
}

export interface PrCycle {
  cycleId: string;
  number: number;
  /** The cycle's incident and recurrence, when its record names them: where the PR's state is copied (#194). */
  key?: CycleKey;
  /** The PR's URL as the cycle recorded it, so the incident's link can be written in full (#194). */
  url?: string;
}

/** The PR a finished cycle opened, if it is one reconcile still reads; null otherwise. */
function prCandidate(id: string, d: Record<string, unknown>): PrCycle | null {
  const summary = d.summary as { pr?: { opened?: unknown; number?: unknown; url?: unknown }; prState?: Record<string, unknown> } | undefined;
  const pr = summary?.pr;
  // A seeded synthetic cycle (seedDemo.ts) names a pull request that does not exist: never read from GitHub (#192).
  if (d.synthetic === true || d.state !== "done" || pr?.opened !== true || typeof pr.number !== "number" || !Number.isInteger(pr.number) || pr.number < 1) return null;
  // Nothing left that matters (a merged PR with settled checks and its merge commit kept; one closed for a week).
  if (prWatchEnded(summary?.prState)) return null;
  const key =
    typeof d.incidentId === "string" && typeof d.environment === "string" && Number.isInteger(d.recurrence)
      ? { incidentId: d.incidentId, environment: d.environment, recurrence: d.recurrence as number }
      : undefined;
  const url = typeof pr.url === "string" ? pr.url : undefined;
  return { cycleId: id, number: pr.number, ...(key && { key }), ...(url !== undefined && { url }) };
}

/**
 * The finished cycles with an opened PR worth reading again, least recently observed first (never observed first), at
 * most `limit` (#422). Two bounded reads: the cycles carrying the watch mark, oldest mark first (the (environment,
 * observedAt.pr) index), and, for cycles finished before the mark existed, up to `MAX_SCAN` finished PR cycles without
 * one (equality filters only), ordered by when they were last checked. A marked cycle that turns out to have nothing to
 * read loses its mark, so it never takes a turn from another.
 */
export async function selectPrCycles(db: Firestore, cfg: ReconcileConfig, limit: number): Promise<PrCycle[]> {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const cycles = db.collection(cfg.cycleCollection).where("environment", "==", cfg.environment);
  const [marked, unmarked] = await Promise.all([
    cycles.orderBy("observedAt.pr", "asc").limit(limit).get(),
    cycles.where("state", "==", "done").where("summary.pr.opened", "==", true).limit(MAX_SCAN).get(),
  ]);
  const found = new Map<string, PrCycle & { orderMs: number }>();
  const ended: string[] = [];
  for (const doc of marked.docs) {
    const c = prCandidate(doc.id, doc.data());
    if (c) found.set(doc.id, { ...c, orderMs: observedMs(doc.data(), "pr") });
    else ended.push(doc.id);
  }
  for (const doc of unmarked.docs) {
    const d = doc.data();
    if (isMarked(d, "pr") || found.has(doc.id)) continue;
    const c = prCandidate(doc.id, d);
    const checked = Date.parse(String((d.summary as { prState?: { checkedAt?: unknown } } | undefined)?.prState?.checkedAt ?? ""));
    if (c) found.set(doc.id, { ...c, orderMs: Number.isFinite(checked) ? checked : -Infinity });
  }
  for (const id of ended) await unmarkWatched(db, cfg, id, "pr");
  return [...found.values()]
    .sort((a, b) => a.orderMs - b.orderMs)
    .slice(0, limit)
    .map(({ cycleId, number, key, url }) => ({ cycleId, number, ...(key && { key }), ...(url !== undefined && { url }) }));
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
  for (const { cycleId, number, key, url } of picked) {
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
        ...(pr.mergeCommitSha !== undefined && { mergeCommitSha: pr.mergeCommitSha }),
        ...summarizeChecks(runs, cfg.verifyChecks, cfg.verifyCheckApp),
        checkedAt,
      });
      // A read that wrote nothing still had its turn (#422): to the back of the line, or it would be first every pass.
      if (!written.ok || !written.applied) await markObserved(db, cfg, cycleId, "pr", new Date(checkedAt));
      if (!written.ok) summary.errors.push({ cycleId, message: `not recorded: ${written.reason}` });
      else {
        if (written.applied) summary.recorded += 1;
        else summary.unchanged += 1;
        // The incident's PR link shows the same PR and state (#194), never its status. Written on every read, not only
        // on a change, so a copy that failed before is repaired; best effort. A merged PR with settled checks is not
        // read again (selectPrCycles), so that last copy is tried twice.
        if (key) {
          const link = { kind: "pr-state" as const, number: pr.number, state: pr.state, ...(url !== undefined && { url }) };
          if (!(await linkIncident(db, cfg, key, link)) && pr.state === "merged") {
            await linkIncident(db, cfg, key, link);
          }
        }
      }
    } catch (err) {
      summary.errors.push({ cycleId, message: describeError(err) });
      // A PR that cannot be read (deleted, say) must not hold the head of the line every pass (#422).
      await markObserved(db, cfg, cycleId, "pr", deps.now());
      const rule = (err as { rule?: unknown } | null)?.rule;
      if (typeof rule === "string" && STOP_RULES.has(rule)) {
        summary.stoppedBecause = rule;
        break;
      }
    }
  }
  return summary;
}
