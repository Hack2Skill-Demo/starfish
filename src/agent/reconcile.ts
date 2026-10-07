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
import { recordPrState, type CycleConfig, type CycleKey, type PrStateRecord } from "./cycle.js";
import { linkIncident } from "./incidentLinks.js";

export type ReconcileConfig = Pick<StarfishConfig, "environment" | "verifyChecks" | "verifyCheckApp" | "maxPrChecksPerPass" | "incidentCollection"> & CycleConfig;
export type PrReader = Pick<GithubClient, "readPullRequest" | "listCheckRuns">;

/** Cycles scanned for an opened PR, newest first. Uses the Runs page's (environment, updatedAt) index. */
export const MAX_SCAN = 200;
const MAX_FAILED_NAMES = 300;
/** Errors after which the rest of the pass would only fail the same way. */
const STOP_RULES: ReadonlySet<string> = new Set(["unauthorized", "forbidden", "rate-limited"]);

type CheckSummary = Pick<PrStateRecord, "checks" | "checksPassed" | "checksRequired" | "failedChecks">;

/**
 * The runs that can stand for the named required checks: the right name, posted by the configured app
 * (`verifyCheckApp`, `github-actions` by default). A run of that name from any other app is not the target's CI and is
 * ignored: it can neither pass nor hide a failure (#205).
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

const SETTLED_CHECKS: readonly string[] = ["passed", "failed", "not-configured"];

/**
 * The finished cycles with an opened PR worth reading again, least recently checked first (never checked first), at
 * most `limit`. A merged PR whose checks are settled is left alone: nothing about it can change that matters here.
 */
export async function selectPrCycles(db: Firestore, cfg: ReconcileConfig, limit: number): Promise<PrCycle[]> {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const snap = await db.collection(cfg.cycleCollection).where("environment", "==", cfg.environment).orderBy("updatedAt", "desc").limit(MAX_SCAN).get();
  const found: { cycleId: string; number: number; key?: CycleKey; url?: string; checkedMs: number }[] = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const pr = d.summary?.pr as { opened?: unknown; number?: unknown; url?: unknown } | undefined;
    // A seeded synthetic cycle (seedDemo.ts) names a pull request that does not exist: never read from GitHub (#192).
    if (d.synthetic === true || d.state !== "done" || pr?.opened !== true || typeof pr.number !== "number" || !Number.isInteger(pr.number) || pr.number < 1) continue;
    const prior = d.summary?.prState as { state?: unknown; checks?: unknown; checkedAt?: unknown } | undefined;
    if (prior?.state === "merged" && SETTLED_CHECKS.includes(String(prior.checks))) continue;
    const checked = typeof prior?.checkedAt === "string" ? Date.parse(prior.checkedAt) : NaN;
    const key =
      typeof d.incidentId === "string" && typeof d.environment === "string" && Number.isInteger(d.recurrence)
        ? { incidentId: d.incidentId, environment: d.environment, recurrence: d.recurrence as number }
        : undefined;
    const url = typeof pr.url === "string" ? pr.url : undefined;
    found.push({ cycleId: doc.id, number: pr.number, ...(key && { key }), ...(url !== undefined && { url }), checkedMs: Number.isFinite(checked) ? checked : -Infinity });
  }
  return found
    .sort((a, b) => a.checkedMs - b.checkedMs)
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
        ...summarizeChecks(runs, cfg.verifyChecks, cfg.verifyCheckApp),
        checkedAt,
      });
      if (!written.ok) summary.errors.push({ cycleId, message: `not recorded: ${written.reason}` });
      else {
        if (written.applied) summary.recorded += 1;
        else summary.unchanged += 1;
        // The incident's PR link shows the same PR and state (#194), never its status. Written on every read, not only
        // on a change, so a copy that failed before is repaired; best effort. A merged PR with settled checks is not
        // read again (selectPrCycles), so that last copy is tried twice.
        if (key) {
          const link = { kind: "pr-state" as const, number: pr.number, state: pr.state, ...(url !== undefined && { url }) };
          if (!(await linkIncident(db, cfg.incidentCollection, key, link)) && pr.state === "merged") {
            await linkIncident(db, cfg.incidentCollection, key, link);
          }
        }
      }
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
