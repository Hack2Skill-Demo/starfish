/**
 * Recovery of a MERGED fix (#390): was it deployed, and did the error stop? For every pull request Starfish opened that has
 * been merged, by Starfish or by a person, this says one of:
 *
 *   - `awaiting-deploy`  merged; no deployment of the merge commit has completed yet (reading GitHub's Deployments API).
 *   - `observing`        deployed at `deployedAt`; the quiet window, or ingest's read of the logs through it, is not done.
 *   - `recovered`        deployed, the window passed with ingest having read through it, the error did not come back, and
 *                        the error's rate before the merge says it would have shown if the fix had not worked.
 *   - `recurred`         the error was seen again after the deployment (and the grace for the old revision to drain).
 *   - `unverified`       Starfish cannot say, and says why (`reason`). Never `recovered`.
 *
 * What it never does, because each would be a false "recovered":
 *   - Infer recovery from silence alone. Silence counts only when (a) ingest's checkpoint has read the logs through the
 *     window (a stalled ingest records nothing either), and (b) the error's rate before the merge makes silence
 *     meaningful: the window is lengthened until at least `recoveryMinExpected` occurrences were expected, and when that
 *     cannot fit inside the give-up time the answer is `unverified: low-traffic`, however quiet it has been.
 *   - Treat a merge as a release. The clock starts at the deployment's completion, not at the merge: an error still
 *     firing while the old revision serves is not a failed fix, and a quiet pre-deploy hour is not a recovery.
 *   - Count a retired or missing incident: its fingerprint was freed, so a recurrence would be a NEW incident this one
 *     cannot see (`unverified: incident-gone`).
 *   - Resolve the incident, change the cycle's outcome, or revert anything. It observes. (A merge Starfish made itself
 *     also has the fast-revert watch, src/agent/fastRevert.ts, which acts; that is separate, and starts at the merge.)
 *
 * What it cannot see: that the deployed revision actually exercised the fixed code path. "No occurrences in a window where
 * about N were expected" is evidence, with a stated expected count (a chance of `exp(-N)` of seeing none if the error was
 * still happening at its old rate), not proof. A positive probe, as the missing-index path has, would be stronger and is
 * not built for code fixes. Never run against real GitHub: tested with a fake client and the Firestore emulator.
 *
 * `decideRecovery` is pure; `observeRecoveries` (recoveryStep.ts) reads GitHub, the incident and ingest's checkpoint, and
 * writes the result on the cycle (cycle.ts `recordRecovery`).
 */
import type { StarfishConfig } from "../config.js";

export type RecoveryConfig = Pick<StarfishConfig, "deployEnvironment" | "recoveryQuietMinutes" | "recoveryGraceMinutes" | "recoveryMinExpected" | "recoveryGiveUpHours">;

export type RecoveryState = "awaiting-deploy" | "observing" | "recovered" | "recurred" | "unverified";

/** Why Starfish cannot say, or what the record is still waiting for. Plain words, shown as is. */
export type RecoveryReason =
  | "no-deployment-environment"
  | "deploy-failed"
  | "deploy-not-observed"
  | "deploy-unreadable"
  | "incident-gone"
  | "low-traffic"
  | "ingest-not-covering"
  | "waiting-for-deployment"
  | "waiting-for-window"
  | "waiting-for-ingest";

export const FINAL_STATES: readonly RecoveryState[] = ["recovered", "recurred", "unverified"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** After the window ends, wait this long for a late log entry before reading the checkpoint as having covered it. */
export const SETTLE_MS = 10 * MINUTE;
/** A window ingest still has not read through a day after it ended is `unverified: ingest-not-covering` (as fastRevert.ts does). */
export const INGEST_GIVE_UP_MS = 24 * HOUR;

/** The error's rate before the merge, taken once, when the merge is first seen (the hourly buckets are pruned later). */
export interface Baseline {
  /** Occurrences per hour over the hours before the merge in which the incident existed. */
  perHour: number;
  /** How many hours that rate was read over. */
  hours: number;
}

export type DeploymentFact =
  | { state: "none" }
  | { state: "pending" }
  | { state: "failed" }
  | { state: "deployed"; completedAtMs: number; deploymentId: number; sha: string }
  /** The Deployments API could not be read (permission, network): said as such, never as "none". */
  | { state: "unreadable" };

export interface RecoveryInput {
  nowMs: number;
  mergedAtMs: number;
  cfg: RecoveryConfig;
  /** The incident document, or null when it is gone. */
  incident: Record<string, unknown> | null;
  /** The cycle's recurrence, to tell a regression the ingest marked after it. */
  recurrence: number;
  baseline: Baseline | null;
  deployment: DeploymentFact;
  /** How far ingest has read this target's logs, or null when not known. */
  checkpointMs: number | null;
}

export interface RecoveryDecision {
  state: RecoveryState;
  reason?: RecoveryReason;
  deployedAtMs?: number;
  /** The quiet window (start, end] in ms, once deployed and the traffic is enough to judge silence. */
  windowStartMs?: number;
  windowEndMs?: number;
  /** About how many occurrences the error's old rate predicts over the window: what makes silence meaningful. */
  expectedOccurrences?: number;
  /** The latest occurrence Starfish saw after the window's start, when it recurred. */
  recurredAtMs?: number;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const ms = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : undefined;
  }
  const t = rec(v).toMillis;
  if (typeof t === "function") {
    const n = (t as () => unknown).call(v);
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/**
 * The error's rate before the merge, from the incident's hourly buckets: the hours wholly before `mergedAtMs`, within a day
 * of it, from the hour the incident first occurred. Null when the buckets say nothing usable. Each ingest window's count is
 * put in the hour of its latest occurrence (store.ts), so this is an estimate, and `decideRecovery` treats it as one.
 */
export function baselineBefore(incident: Record<string, unknown>, mergedAtMs: number): Baseline | null {
  const buckets = rec(incident.occurrencesByHour);
  const endHour = Math.floor(mergedAtMs / HOUR); // hours below this end at or before the merge
  const first = ms(incident.firstOccurredAt);
  const fromHour = Math.max(endHour - 24, first === undefined ? endHour - 24 : Math.floor(first / HOUR));
  const hours = endHour - fromHour;
  if (hours < 1) return null;
  let sum = 0;
  for (const [k, v] of Object.entries(buckets)) {
    const h = Number(k);
    if (Number.isFinite(h) && h >= fromHour && h < endHour && typeof v === "number" && v > 0) sum += v;
  }
  return { perHour: sum / hours, hours };
}

/**
 * The incident was seen again after `startMs`, and ingest's checkpoint has read the logs at least that far. Pure.
 * `lastOccurredAt` is the latest occurrence ever recorded (the store never moves it back), so one later than `startMs` is
 * proof, and one at or before it, with the checkpoint read through the end of the window, means no occurrence between
 * (startMs, checkpoint]. A regression the ingest marked counts too.
 */
export function seenAfter(incident: Record<string, unknown>, startMs: number, recurrence: number): number | undefined {
  const last = ms(incident.lastOccurredAt);
  if (last !== undefined && last > startMs) return last;
  const regressions = incident.recurrenceCount;
  const lastRecurred = ms(incident.lastRecurredAt);
  if (typeof regressions === "number" && regressions > recurrence && lastRecurred !== undefined && lastRecurred > startMs) return lastRecurred;
  return undefined;
}

/**
 * Decide. Pure over its input: the same facts always give the same answer, and a state a caller already recorded as final is
 * never re-decided (recoveryStep.ts). See the file's header for what each answer means and what is never inferred.
 */
export function decideRecovery(i: RecoveryInput): RecoveryDecision {
  const { cfg } = i;
  const giveUpMs = i.mergedAtMs + cfg.recoveryGiveUpHours * HOUR;

  if (i.incident === null || i.incident.retired === true) return { state: "unverified", reason: "incident-gone" };
  if (cfg.deployEnvironment === "") return { state: "unverified", reason: "no-deployment-environment" };

  const d = i.deployment;
  if (d.state !== "deployed") {
    if (i.nowMs >= giveUpMs) {
      return { state: "unverified", reason: d.state === "failed" ? "deploy-failed" : d.state === "unreadable" ? "deploy-unreadable" : "deploy-not-observed" };
    }
    return { state: "awaiting-deploy", reason: "waiting-for-deployment" };
  }

  // Judge from the deployment's completion; the grace is for instances still serving the old revision.
  const startMs = d.completedAtMs + cfg.recoveryGraceMinutes * MINUTE;
  const common = { deployedAtMs: d.completedAtMs };

  // Evidence of a recurrence is evidence at any time: it does not wait for the window to end.
  const seen = seenAfter(i.incident, startMs, i.recurrence);
  if (seen !== undefined) return { state: "recurred", ...common, windowStartMs: startMs, recurredAtMs: seen };

  // The window must be long enough that the error's old rate would have shown in it; otherwise silence says nothing.
  const perMinute = i.baseline === null ? 0 : i.baseline.perHour / 60;
  const needMinutes = perMinute > 0 ? cfg.recoveryMinExpected / perMinute : Infinity;
  const windowMinutes = Math.max(cfg.recoveryQuietMinutes, Number.isFinite(needMinutes) ? Math.ceil(needMinutes) : Infinity);
  // A window longer than the give-up time cannot be waited out: the answer is "cannot tell", however quiet it has been.
  if (!Number.isFinite(windowMinutes) || windowMinutes > cfg.recoveryGiveUpHours * 60) {
    return { state: "unverified", reason: "low-traffic", ...common, windowStartMs: startMs, expectedOccurrences: perMinute * cfg.recoveryQuietMinutes };
  }
  const endMs = startMs + windowMinutes * MINUTE;
  const expected = perMinute * windowMinutes;
  const window = { ...common, windowStartMs: startMs, windowEndMs: endMs, expectedOccurrences: expected };

  if (i.nowMs < endMs + SETTLE_MS) return { state: "observing", reason: "waiting-for-window", ...window };
  // The window is over. Silence counts only if ingest has read the logs through it.
  if (i.checkpointMs === null || i.checkpointMs < endMs) {
    if (i.nowMs >= endMs + INGEST_GIVE_UP_MS) return { state: "unverified", reason: "ingest-not-covering", ...window };
    return { state: "observing", reason: "waiting-for-ingest", ...window };
  }
  return { state: "recovered", ...window };
}
