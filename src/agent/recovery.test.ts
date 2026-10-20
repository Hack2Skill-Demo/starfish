import { describe, expect, it } from "vitest";
import { baselineBefore, CONFIG_GAP_GIVE_UP_MS, decideRecovery, INGEST_GIVE_UP_MS, isFinalRecovery, SETTLE_MS, seenAfter, type DeploymentFact, type RecoveryConfig, type RecoveryInput } from "./recovery.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const MERGED = Date.parse("2026-10-15T03:36:40Z");
const DEPLOYED_AT = MERGED + 6 * MIN;
const CFG: RecoveryConfig = { deployEnvironment: "production", recoveryQuietMinutes: 60, recoveryGraceMinutes: 5, recoveryMinExpected: 5, recoveryGiveUpHours: 24 };
const deployed: DeploymentFact = { state: "deployed", completedAtMs: DEPLOYED_AT, deploymentId: 7, sha: "a".repeat(40) };
/** An error that fired 10 times an hour before the merge: a 60-minute window expects 10, more than the 5 asked for. */
const BASE_10 = { perHour: 10, hours: 24 };
/** The incident as stored, last seen well before the merge. */
const quietIncident = (over: Record<string, unknown> = {}) => ({ lastOccurredAt: new Date(MERGED - 30 * MIN).toISOString(), recurrenceCount: 0, ...over });

function input(over: Partial<RecoveryInput> = {}): RecoveryInput {
  return { nowMs: DEPLOYED_AT + 3 * HOUR, mergedAtMs: MERGED, cfg: CFG, incident: quietIncident(), recurrence: 0, baseline: BASE_10, deployment: deployed, checkpointMs: DEPLOYED_AT + 3 * HOUR, ...over };
}

describe("decideRecovery: before a deployment", () => {
  it("waits, never final, with no deployment environment configured: a gap a person can close, not a fact about the fix (#423)", () => {
    const none = { ...CFG, deployEnvironment: "" };
    expect(decideRecovery(input({ cfg: none }))).toEqual({ state: "awaiting-deploy", reason: "no-deployment-environment" });
    expect(decideRecovery(input({ cfg: none, nowMs: MERGED + 25 * HOUR }))).toEqual({ state: "awaiting-deploy", reason: "no-deployment-environment" });
    expect(decideRecovery(input({ cfg: none, nowMs: MERGED + CONFIG_GAP_GIVE_UP_MS - 1 }))).toEqual({ state: "awaiting-deploy", reason: "no-deployment-environment" });
    // The bound: a gap still open that long after the merge is final.
    expect(decideRecovery(input({ cfg: none, nowMs: MERGED + CONFIG_GAP_GIVE_UP_MS }))).toEqual({ state: "unverified", reason: "no-deployment-environment" });
  });

  it("is unverified when the incident is gone or retired: a recurrence would be a new incident it cannot see", () => {
    expect(decideRecovery(input({ incident: null }))).toEqual({ state: "unverified", reason: "incident-gone" });
    expect(decideRecovery(input({ incident: quietIncident({ retired: true }) }))).toEqual({ state: "unverified", reason: "incident-gone" });
  });

  it.each([["none"], ["pending"]] as const)("waits while the deployment is %s, and gives up as unverified after the give-up time", (state) => {
    expect(decideRecovery(input({ nowMs: MERGED + 2 * HOUR, deployment: { state } }))).toEqual({ state: "awaiting-deploy", reason: "waiting-for-deployment" });
    expect(decideRecovery(input({ nowMs: MERGED + 24 * HOUR, deployment: { state } }))).toEqual({ state: "unverified", reason: "deploy-not-observed" });
  });

  it("names a failed deployment, and an unreadable Deployments API, when it gives up, never as 'none'", () => {
    expect(decideRecovery(input({ nowMs: MERGED + 25 * HOUR, deployment: { state: "failed" } }))).toEqual({ state: "unverified", reason: "deploy-failed" });
    // Deployments that cannot be read (a token without the permission) is a gap too: it waits, named, until its bound (#423).
    expect(decideRecovery(input({ nowMs: MERGED + 2 * HOUR, deployment: { state: "unreadable" } }))).toEqual({ state: "awaiting-deploy", reason: "waiting-for-deployment" });
    expect(decideRecovery(input({ nowMs: MERGED + 25 * HOUR, deployment: { state: "unreadable" } }))).toEqual({ state: "awaiting-deploy", reason: "deploy-unreadable" });
    expect(decideRecovery(input({ nowMs: MERGED + CONFIG_GAP_GIVE_UP_MS, deployment: { state: "unreadable" } }))).toEqual({ state: "unverified", reason: "deploy-unreadable" });
    expect(decideRecovery(input({ nowMs: MERGED + 2 * HOUR, deployment: { state: "failed" } }))).toMatchObject({ state: "awaiting-deploy" });
  });

  it("does not count quiet before the deployment as recovery: a long silence since the merge is not evidence", () => {
    // 20 hours merged, never deployed, the error silent throughout: still not recovered.
    expect(decideRecovery(input({ nowMs: MERGED + 20 * HOUR, deployment: { state: "none" }, checkpointMs: MERGED + 20 * HOUR }))).toMatchObject({ state: "awaiting-deploy" });
  });
});

describe("decideRecovery: after the deployment", () => {
  it("observes through the grace and the quiet window, then once ingest has read through it, recovers", () => {
    const start = DEPLOYED_AT + 5 * MIN;
    const end = start + 60 * MIN;
    const during = decideRecovery(input({ nowMs: DEPLOYED_AT + 30 * MIN, checkpointMs: DEPLOYED_AT + 25 * MIN }));
    expect(during).toMatchObject({ state: "observing", reason: "waiting-for-window", deployedAtMs: DEPLOYED_AT, windowStartMs: start, windowEndMs: end });
    const done = decideRecovery(input({ nowMs: end + SETTLE_MS, checkpointMs: end }));
    expect(done).toMatchObject({ state: "recovered", windowStartMs: start, windowEndMs: end });
    // What makes the silence meaningful is stated: about 10 occurrences were expected in the hour.
    expect(done.expectedOccurrences).toBeCloseTo(10, 5);
  });

  it("does not recover while ingest has not read through the window: a stalled ingest records nothing either", () => {
    const end = DEPLOYED_AT + 5 * MIN + 60 * MIN;
    expect(decideRecovery(input({ nowMs: end + 2 * HOUR, checkpointMs: end - MIN }))).toMatchObject({ state: "observing", reason: "waiting-for-ingest" });
    expect(decideRecovery(input({ nowMs: end + 2 * HOUR, checkpointMs: null }))).toMatchObject({ state: "observing", reason: "waiting-for-ingest" });
    // A day past the window and still unread: it says so, rather than wait for ever.
    expect(decideRecovery(input({ nowMs: end + INGEST_GIVE_UP_MS, checkpointMs: end - MIN }))).toMatchObject({ state: "unverified", reason: "ingest-not-covering" });
  });

  it("recurs the moment the error is seen after the deployment and its grace, without waiting for the window to end", () => {
    const seen = DEPLOYED_AT + 20 * MIN;
    const d = decideRecovery(input({ nowMs: DEPLOYED_AT + 25 * MIN, incident: quietIncident({ lastOccurredAt: new Date(seen).toISOString() }) }));
    expect(d).toMatchObject({ state: "recurred", deployedAtMs: DEPLOYED_AT, recurredAtMs: seen });
  });

  it("does not count an occurrence from the old revision, before the deployment completed and its grace", () => {
    // Seen during the deploy, 2 minutes after it finished (inside the 5-minute grace): the old instances were still draining.
    const old = DEPLOYED_AT + 2 * MIN;
    const end = DEPLOYED_AT + 5 * MIN + 60 * MIN;
    expect(decideRecovery(input({ nowMs: end + SETTLE_MS, checkpointMs: end, incident: quietIncident({ lastOccurredAt: new Date(old).toISOString() }) }))).toMatchObject({ state: "recovered" });
  });

  it("reads a regression the ingest marked after the deployment as a recurrence", () => {
    const at = DEPLOYED_AT + 40 * MIN;
    const incident = quietIncident({ recurrenceCount: 2, lastRecurredAt: new Date(at).toISOString() });
    expect(decideRecovery(input({ incident, recurrence: 1 }))).toMatchObject({ state: "recurred", recurredAtMs: at });
    // The cycle's own recurrence is not a new one.
    expect(decideRecovery(input({ incident, recurrence: 2 })).state).not.toBe("recurred");
  });

  it("lengthens the window for a slower error so that silence would have shown, then recovers only after it", () => {
    // 1 an hour, 5 expected: a 5 hour window, not the 60 minutes.
    const start = DEPLOYED_AT + 5 * MIN;
    const end = start + 300 * MIN;
    const base = { perHour: 1, hours: 24 };
    expect(decideRecovery(input({ baseline: base, nowMs: start + 2 * HOUR, checkpointMs: start + 2 * HOUR }))).toMatchObject({ state: "observing", windowEndMs: end });
    const done = decideRecovery(input({ baseline: base, nowMs: end + SETTLE_MS, checkpointMs: end }));
    expect(done).toMatchObject({ state: "recovered", windowEndMs: end });
    expect(done.expectedOccurrences).toBeCloseTo(5, 5);
  });

  it("is unverified: low-traffic when the error was too rare for silence to mean anything, however quiet", () => {
    // 0.1 an hour needs 50 hours for 5 expected: more than the 24 hours it will wait.
    const rare = decideRecovery(input({ baseline: { perHour: 0.1, hours: 24 }, nowMs: DEPLOYED_AT + 3 * HOUR }));
    expect(rare).toMatchObject({ state: "unverified", reason: "low-traffic" });
    expect(rare.state).not.toBe("recovered");
    // No usable baseline at all is the same: nothing says what silence would mean.
    expect(decideRecovery(input({ baseline: null }))).toMatchObject({ state: "unverified", reason: "low-traffic" });
    expect(decideRecovery(input({ baseline: { perHour: 0, hours: 24 } }))).toMatchObject({ state: "unverified", reason: "low-traffic" });
  });

  it("still reports a recurrence on a low-traffic error: evidence of the error is evidence at any rate", () => {
    const seen = DEPLOYED_AT + 20 * MIN;
    expect(decideRecovery(input({ baseline: null, incident: quietIncident({ lastOccurredAt: new Date(seen).toISOString() }) }))).toMatchObject({ state: "recurred" });
  });
});

describe("baselineBefore", () => {
  const hourOf = (t: number) => String(Math.floor(t / HOUR));
  it("is the hourly rate over the hours wholly before the merge, in the day before it", () => {
    const incident = { firstOccurredAt: new Date(MERGED - 40 * HOUR).toISOString(), occurrencesByHour: { [hourOf(MERGED - 3 * HOUR)]: 12, [hourOf(MERGED - 2 * HOUR)]: 8, [hourOf(MERGED - 30 * HOUR)]: 500, [hourOf(MERGED)]: 99 } };
    // 24 hours; the bucket 30 hours back and the merge's own hour are outside.
    expect(baselineBefore(incident, MERGED)).toEqual({ perHour: 20 / 24, hours: 24 });
  });

  it("starts at the hour the incident first occurred, so a new incident is not diluted by hours before it existed", () => {
    const incident = { firstOccurredAt: new Date(MERGED - 4 * HOUR).toISOString(), occurrencesByHour: { [hourOf(MERGED - 2 * HOUR)]: 8 } };
    const b = baselineBefore(incident, MERGED)!;
    expect(b.hours).toBeLessThanOrEqual(5);
    expect(b.hours).toBeGreaterThanOrEqual(4);
    expect(b.perHour).toBeCloseTo(8 / b.hours, 5);
  });

  it("is null when the incident began within the merge's own hour, and ignores malformed buckets", () => {
    expect(baselineBefore({ firstOccurredAt: new Date(MERGED - 5 * MIN).toISOString(), occurrencesByHour: { x: 4 } }, MERGED)).toBeNull();
    expect(baselineBefore({ firstOccurredAt: new Date(MERGED - 3 * HOUR).toISOString(), occurrencesByHour: { junk: 5, [hourOf(MERGED - HOUR)]: "7" } }, MERGED)?.perHour).toBe(0);
  });
});

describe("seenAfter", () => {
  it("is the latest occurrence when it is after the start, and nothing when it is at or before it", () => {
    const start = MERGED + HOUR;
    expect(seenAfter({ lastOccurredAt: new Date(start + 1).toISOString() }, start, 0)).toBe(start + 1);
    expect(seenAfter({ lastOccurredAt: new Date(start).toISOString() }, start, 0)).toBeUndefined();
    expect(seenAfter({}, start, 0)).toBeUndefined();
    expect(seenAfter({ lastOccurredAt: "garbage" }, start, 0)).toBeUndefined();
  });
});

describe("isFinalRecovery (#423)", () => {
  const mergedAt = new Date(MERGED).toISOString();
  const at = (ms: number) => new Date(ms).toISOString();
  it("is final for a fact, never for a state that still waits", () => {
    for (const state of ["recovered", "recurred"]) expect(isFinalRecovery({ state, mergedAt, checkedAt: at(MERGED + HOUR) })).toBe(true);
    for (const reason of ["incident-gone", "deploy-failed", "deploy-not-observed", "low-traffic", "ingest-not-covering"]) {
      expect(isFinalRecovery({ state: "unverified", reason, mergedAt, checkedAt: at(MERGED + HOUR) })).toBe(true);
    }
    for (const state of ["awaiting-deploy", "observing"]) expect(isFinalRecovery({ state, reason: "no-deployment-environment", mergedAt, checkedAt: at(MERGED) })).toBe(false);
    expect(isFinalRecovery(undefined)).toBe(false);
    expect(isFinalRecovery({})).toBe(false);
  });

  it("reads a configuration gap recorded unverified before its bound (as before #423) as still waiting, and one at its bound as final", () => {
    for (const reason of ["no-deployment-environment", "deploy-unreadable"]) {
      expect(isFinalRecovery({ state: "unverified", reason, mergedAt, checkedAt: at(MERGED + HOUR) })).toBe(false);
      expect(isFinalRecovery({ state: "unverified", reason, mergedAt, checkedAt: at(MERGED + CONFIG_GAP_GIVE_UP_MS) })).toBe(true);
      // Times it cannot read: not trusted to reopen anything.
      expect(isFinalRecovery({ state: "unverified", reason, mergedAt: "garbage", checkedAt: at(MERGED + HOUR) })).toBe(true);
    }
  });
});
