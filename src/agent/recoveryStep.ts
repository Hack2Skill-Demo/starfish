/**
 * The recovery observer's pass (#390): for each pull request Starfish opened that has been MERGED (by Starfish, or by a
 * person: the only merges there have been so far), read whether its merge commit has been deployed (GitHub's Deployments
 * API, `STARFISH_DEPLOY_ENVIRONMENT`), look at the incident and at how far ingest has read, and record the answer on the
 * cycle as `summary.recovery` (cycle.ts `recordRecovery`). The decision itself is pure, in recovery.ts, which says what each
 * answer means and what is never inferred.
 *
 * What this step will not do:
 *   - Write to GitHub (one GET family: deployments, their statuses, a compare), change the incident, resolve it, revert,
 *     merge or notify. It observes.
 *   - Decide a result twice: a `recovered`, `recurred` or `unverified` record is final and its cycle is not read again.
 *     A configuration gap (no deployment environment, deployments unreadable) is not a result: it waits, and is read
 *     again, until its bound (recovery.ts `CONFIG_GAP_GIVE_UP_MS`, #423).
 *   - Read without bound: at most `maxPrChecksPerPass` cycles a pass, the least recently observed first, by the cycle's
 *     watch mark (`observedAt.recovery`, #422), however old the merge; a deployment once found is recorded and not read
 *     again.
 *   - Take the baseline twice: the error's rate before the merge is recorded the first time the merge is seen, because the
 *     hourly buckets it comes from are pruned after a week.
 *
 * Needs the merge commit that reconcile.ts records in `summary.prState` (a merge reconcile has not read since that was kept
 * is read again once). Never run against real GitHub: tested with a fake client and the Firestore emulator.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { readIngestCheckpoint } from "../ingest/run.js";
import { redactPii } from "../ingest/redact.js";
import type { GithubClient } from "../integrations/githubPr.js";
import { markObserved, observedMs, recordRecovery, unmarkWatched, type CycleConfig, type RecoveryRecord } from "./cycle.js";
import { baselineBefore, decideRecovery, isFinalRecovery, type Baseline, type DeploymentFact, type RecoveryConfig } from "./recovery.js";
import { isMarked, MAX_SCAN } from "./reconcile.js";

export type RecoveryStepConfig = Pick<StarfishConfig, "environment" | "incidentCollection" | "runCollection" | "watchedProjectId" | "maxPrChecksPerPass"> & RecoveryConfig & CycleConfig;
export type DeploymentReader = Pick<GithubClient, "deploymentOfCommit">;

export interface RecoveryStepDeps {
  db: Firestore;
  config: RecoveryStepConfig;
  client: DeploymentReader;
  now: () => Date;
}

export interface RecoveryStepSummary {
  considered: number;
  /** Records written. */
  recorded: number;
  /** Cycles that reached a final answer this pass, with it. */
  decided: { cycleId: string; state: string; reason?: string }[];
  errors: { cycleId: string; message: string }[];
  /** Set when the pass stopped early on an error every other cycle would hit too (credentials, rate limit). */
  stoppedBecause?: string;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});
const isoMs = (v: unknown): number | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const iso = (ms: number | undefined): string | undefined => (ms === undefined || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString());
const STOP_RULES: ReadonlySet<string> = new Set(["unauthorized", "forbidden", "rate-limited"]);
const describeError = (err: unknown): string => redactPii(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300);

export interface MergedCycle {
  cycleId: string;
  incidentId: string;
  recurrence: number;
  mergeCommitSha: string;
  mergedAt: string;
  prior: Rec;
}

/** A finished cycle's merged PR whose recovery is not final yet, or null. A synthetic cycle (seedDemo.ts) is never one. */
function mergedCandidate(id: string, d: Rec): MergedCycle | null {
  if (d.synthetic === true || d.state !== "done") return null;
  const summary = rec(d.summary);
  const pr = rec(summary.prState);
  const sha = pr.mergeCommitSha;
  if (pr.state !== "merged" || typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return null;
  const mergedMs = isoMs(pr.mergedAt);
  if (mergedMs === null || typeof d.incidentId !== "string" || !Number.isInteger(d.recurrence)) return null;
  const prior = rec(summary.recovery);
  // A record for another merge (the PR cannot be merged twice, so this is a hand edit) is not trusted: start again.
  const own = prior.mergeCommitSha === sha ? prior : {};
  if (isFinalRecovery(own)) return null;
  return { cycleId: id, incidentId: d.incidentId, recurrence: d.recurrence as number, mergeCommitSha: sha, mergedAt: new Date(mergedMs).toISOString(), prior: own };
}

/**
 * The finished cycles with a merged PR whose recovery is not final, least recently observed first, at most `limit`
 * (#422). Two bounded reads: the cycles carrying recovery's watch mark (`observedAt.recovery`, set by reconcile when it
 * records the merge, cycle.ts), oldest mark first, however old the cycle is; and, for merges recorded before the mark
 * existed, up to `MAX_SCAN` merged cycles without one (equality filters only), ordered by when they were last checked. A
 * marked cycle whose answer turns out final loses its mark. Until #422 this read the newest 200 cycles by `updatedAt`,
 * which none of these writes move, so a merge whose cycle had fallen out of them was never observed.
 */
export async function selectMergedCycles(db: Firestore, cfg: Pick<RecoveryStepConfig, "cycleCollection" | "environment">, limit: number): Promise<MergedCycle[]> {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const cycles = db.collection(cfg.cycleCollection).where("environment", "==", cfg.environment);
  const [marked, unmarked] = await Promise.all([
    cycles.orderBy("observedAt.recovery", "asc").limit(limit).get(),
    cycles.where("state", "==", "done").where("summary.prState.state", "==", "merged").limit(MAX_SCAN).get(),
  ]);
  const found = new Map<string, MergedCycle & { orderMs: number }>();
  const ended: string[] = [];
  for (const doc of marked.docs) {
    const c = mergedCandidate(doc.id, doc.data());
    if (c) found.set(doc.id, { ...c, orderMs: observedMs(doc.data(), "recovery") });
    else ended.push(doc.id);
  }
  for (const doc of unmarked.docs) {
    const d = doc.data();
    if (isMarked(d, "recovery") || found.has(doc.id)) continue;
    const c = mergedCandidate(doc.id, d);
    if (c) found.set(doc.id, { ...c, orderMs: isoMs(c.prior.checkedAt) ?? -Infinity });
  }
  for (const id of ended) await unmarkWatched(db, cfg, id, "recovery");
  return [...found.values()]
    .sort((a, b) => a.orderMs - b.orderMs)
    .slice(0, limit)
    .map(({ cycleId, incidentId, recurrence, mergeCommitSha, mergedAt, prior }) => ({ cycleId, incidentId, recurrence, mergeCommitSha, mergedAt, prior }));
}

/** One bounded round of recovery observation. Never throws for one cycle: its error is kept and the next goes ahead. */
export async function observeRecoveries(deps: RecoveryStepDeps): Promise<RecoveryStepSummary> {
  const { db, config: cfg, client } = deps;
  const picked = await selectMergedCycles(db, cfg, cfg.maxPrChecksPerPass);
  const out: RecoveryStepSummary = { considered: picked.length, recorded: 0, decided: [], errors: [] };

  // How far ingest has read this target's logs: read once, when a cycle first needs it. A failed read is "not known",
  // which never counts as covered.
  let checkpoint: { ms: number | null } | undefined;
  const ingestedThrough = async (): Promise<number | null> => {
    if (checkpoint === undefined) {
      try {
        const at = await readIngestCheckpoint(db, cfg.runCollection, { watchedProjectId: cfg.watchedProjectId, environment: cfg.environment });
        checkpoint = { ms: at === null ? null : at.getTime() };
      } catch {
        checkpoint = { ms: null };
      }
    }
    return checkpoint.ms;
  };

  for (const c of picked) {
    try {
      // The time BEFORE the reads orders this observation: whatever it saw was true then or later.
      const now = deps.now();
      const incident = (await db.collection(cfg.incidentCollection).doc(c.incidentId).get()).data() ?? null;
      const mergedAtMs = Date.parse(c.mergedAt);

      // The error's rate before the merge, taken once: the hourly buckets are pruned later.
      let baseline: Baseline | null;
      if (c.prior.baselineTaken === true) {
        baseline = typeof c.prior.baselinePerHour === "number" && typeof c.prior.baselineHours === "number" ? { perHour: c.prior.baselinePerHour, hours: c.prior.baselineHours } : null;
      } else {
        baseline = incident ? baselineBefore(incident, mergedAtMs) : null;
      }

      // The deployment, once found, is recorded and not looked for again.
      let deployment: DeploymentFact;
      let readError: string | undefined;
      let stop: string | undefined;
      let deploymentId: number | undefined;
      let deploymentSha: string | undefined;
      const priorDeployedMs = isoMs(c.prior.deployedAt);
      if (priorDeployedMs !== null && typeof c.prior.deploymentId === "number" && typeof c.prior.deploymentSha === "string") {
        deployment = { state: "deployed", completedAtMs: priorDeployedMs, deploymentId: c.prior.deploymentId, sha: c.prior.deploymentSha };
        deploymentId = c.prior.deploymentId;
        deploymentSha = c.prior.deploymentSha;
      } else if (cfg.deployEnvironment === "") {
        deployment = { state: "none" };
      } else {
        try {
          const obs = await client.deploymentOfCommit(c.mergeCommitSha, cfg.deployEnvironment, c.mergedAt);
          if (obs.state === "deployed") {
            deployment = { state: "deployed", completedAtMs: Date.parse(obs.completedAt), deploymentId: obs.deploymentId, sha: obs.sha };
            deploymentId = obs.deploymentId;
            deploymentSha = obs.sha;
          } else {
            deployment = { state: obs.state };
          }
        } catch (err) {
          deployment = { state: "unreadable" };
          const rule = (err as { rule?: unknown } | null)?.rule;
          readError = typeof rule === "string" ? rule : "error";
          out.errors.push({ cycleId: c.cycleId, message: describeError(err) });
          if (typeof rule === "string" && STOP_RULES.has(rule)) stop = rule;
        }
      }

      const needsCheckpoint = deployment.state === "deployed";
      const decision = decideRecovery({
        nowMs: now.getTime(),
        mergedAtMs,
        cfg,
        incident,
        recurrence: c.recurrence,
        baseline,
        deployment,
        checkpointMs: needsCheckpoint ? await ingestedThrough() : null,
      });

      const record: RecoveryRecord = {
        state: decision.state,
        ...(decision.reason !== undefined && { reason: decision.reason }),
        mergeCommitSha: c.mergeCommitSha,
        mergedAt: c.mergedAt,
        ...(decision.deployedAtMs !== undefined && { deployedAt: iso(decision.deployedAtMs)! }),
        ...(deploymentId !== undefined && { deploymentId }),
        ...(deploymentSha !== undefined && { deploymentSha }),
        ...(decision.windowStartMs !== undefined && { windowStart: iso(decision.windowStartMs)! }),
        ...(decision.windowEndMs !== undefined && { windowEnd: iso(decision.windowEndMs)! }),
        ...(decision.expectedOccurrences !== undefined && { expectedOccurrences: Math.round(decision.expectedOccurrences * 100) / 100 }),
        baselineTaken: true,
        ...(baseline !== null && { baselinePerHour: Math.round(baseline.perHour * 1000) / 1000, baselineHours: baseline.hours }),
        ...(decision.recurredAtMs !== undefined && { recurredAt: iso(decision.recurredAtMs)! }),
        ...(readError !== undefined && { readError }),
        checkedAt: now.toISOString(),
      };
      const written = await recordRecovery(db, cfg, c.cycleId, record);
      // A look that wrote nothing still had its turn (#422): to the back of the line, or it would be first every pass.
      if (!written.ok || !written.applied) await markObserved(db, cfg, c.cycleId, "recovery", now);
      if (!written.ok) out.errors.push({ cycleId: c.cycleId, message: `not recorded: ${written.reason}` });
      else if (written.applied) {
        out.recorded += 1;
        if (isFinalRecovery(record as unknown as Rec)) out.decided.push({ cycleId: c.cycleId, state: decision.state, ...(decision.reason !== undefined && { reason: decision.reason }) });
      }
      if (stop !== undefined) {
        out.stoppedBecause = stop;
        break;
      }
    } catch (err) {
      out.errors.push({ cycleId: c.cycleId, message: describeError(err) });
      await markObserved(db, cfg, c.cycleId, "recovery", deps.now());
    }
  }
  return out;
}
