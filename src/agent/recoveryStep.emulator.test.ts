/**
 * The recovery observer against the Firestore emulator, with a fake GitHub (#390). The whole story the issue asks for, as
 * the engine sees it: a fault is detected (an incident with a rate), a verified PR is opened, a PERSON merges it, the
 * target's pipeline deploys it (a GitHub deployment), and then either the error stays away (recovered) or comes back
 * (recurred), and every way it must NOT say recovered: no deployment, a failed one, ingest not caught up, an error too
 * rare for silence to mean anything, a retired incident, and a merge nobody can see deployed. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { GithubError, type DeploymentObservation } from "../integrations/githubPr.js";
import { stateDocId } from "../ingest/run.js";
import { PUBLIC_VIEW_OFF } from "../testConfig.js";
import { recordRecovery } from "./cycle.js";
import { CONFIG_GAP_GIVE_UP_MS } from "./recovery.js";
import { observeRecoveries, selectMergedCycles, type DeploymentReader, type RecoveryStepConfig } from "./recoveryStep.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("recoveryStep.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "recovery-emulator-tests");
const db: Firestore = getFirestore(app, "recovery-tests");
afterAll(() => deleteApp(app));

const MIN = 60_000;
const HOUR = 60 * MIN;
const MERGED = Date.parse("2026-10-15T03:36:40Z");
const DEPLOYED = MERGED + 6 * MIN;
const MERGE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const T_START = DEPLOYED + 5 * MIN; // after the grace
const T_END = T_START + 60 * MIN; // 10 an hour before the merge: the 60-minute window already expects 10

let cfg: RecoveryStepConfig;
let target: { watchedProjectId: string; environment: string };
beforeEach(() => {
  cfg = {
    cycleCollection: `cycles_${randomUUID().slice(0, 8)}`,
    incidentCollection: `incidents_${randomUUID().slice(0, 8)}`,
    runCollection: `runs_${randomUUID().slice(0, 8)}`,
    watchedProjectId: "shop-prod",
    environment: "demo",
    leaseSeconds: 300,
    cycleDeadlineMinutes: 60,
    maxCycleAttempts: 3,
    maxPrChecksPerPass: 10,
    deployEnvironment: "production",
    recoveryQuietMinutes: 60,
    recoveryGraceMinutes: 5,
    recoveryMinExpected: 5,
    recoveryGiveUpHours: 24,
    ...PUBLIC_VIEW_OFF,
  };
  target = { watchedProjectId: cfg.watchedProjectId, environment: cfg.environment };
});

const hourOf = (t: number) => String(Math.floor(t / HOUR));
/** The incident the fix was for: 10 occurrences an hour for the day before the merge, last seen shortly before it. */
async function seedIncident(id: string, over: Record<string, unknown> = {}) {
  const buckets: Record<string, number> = {};
  for (let h = 1; h <= 24; h++) buckets[hourOf(MERGED - h * HOUR)] = 10;
  await db
    .collection(cfg.incidentCollection)
    .doc(id)
    .set({ environment: "demo", status: "logged", firstOccurredAt: Timestamp.fromMillis(MERGED - 48 * HOUR), lastOccurredAt: Timestamp.fromMillis(MERGED - 20 * MIN), recurrenceCount: 0, occurrencesByHour: buckets, ...over });
}
/** A finished cycle whose PR a person merged, as reconcile.ts records it. */
async function seedCycle(id: string, over: Record<string, unknown> = {}, prState: Record<string, unknown> = {}) {
  const ts = Timestamp.fromMillis(MERGED);
  await db
    .collection(cfg.cycleCollection)
    .doc(id)
    .set({
      incidentId: id.split("_")[0],
      environment: "demo",
      recurrence: 0,
      state: "done",
      path: "pr",
      outcome: "pr-opened",
      createdAt: ts,
      updatedAt: ts,
      summary: {
        pr: { opened: true, number: 41, url: "https://github.com/acme/shop/pull/41" },
        prState: { number: 41, state: "merged", mergedAt: new Date(MERGED).toISOString(), closedAt: new Date(MERGED).toISOString(), headSha: HEAD_SHA, mergeCommitSha: MERGE_SHA, checks: "passed", checksPassed: 1, checksRequired: 1, checkedAt: new Date(MERGED + MIN).toISOString(), ...prState },
      },
      ...over,
    });
}
/** Ingest has read this target's logs through `at`. */
const seedCheckpoint = (at: number) => db.collection(cfg.runCollection).doc(stateDocId(target)).set({ target, checkpoint: Timestamp.fromMillis(at) });
const cycle = async (id: string) => (await db.collection(cfg.cycleCollection).doc(id).get()).data()!;
const recovery = async (id: string) => (await cycle(id)).summary.recovery as Record<string, unknown>;
const incidentDoc = async (id: string) => (await db.collection(cfg.incidentCollection).doc(id).get()).data()!;

type Obs = DeploymentObservation | Error;
function fakeGithub(obs: Obs) {
  const calls: { commit: string; environment: string; mergedAt: string }[] = [];
  const client: DeploymentReader = {
    deploymentOfCommit: async (commit, environment, mergedAt) => {
      calls.push({ commit, environment, mergedAt });
      if (obs instanceof Error) throw obs;
      return obs;
    },
  };
  return { client, calls };
}
const deployedObs: DeploymentObservation = { state: "deployed", deploymentId: 26, sha: MERGE_SHA, completedAt: new Date(DEPLOYED).toISOString(), exact: true };
const observe = (client: DeploymentReader, nowMs: number) => observeRecoveries({ db, config: cfg, client, now: () => new Date(nowMs) });

describe("the whole story: fault, detection, verified PR, a person's merge, deployment, recovery", () => {
  it("awaits the deployment, observes through the window, and only then, with ingest read through it, says recovered", async () => {
    await seedIncident("inc1");
    await seedCycle("inc1_r0");
    const before = await cycle("inc1_r0");

    // 1. Merged, and the pipeline has not deployed yet: nothing is claimed.
    const pending = fakeGithub({ state: "pending", deploymentId: 26, sha: MERGE_SHA });
    expect(await observe(pending.client, MERGED + 2 * MIN)).toMatchObject({ considered: 1, recorded: 1, decided: [], errors: [] });
    expect(await recovery("inc1_r0")).toMatchObject({ state: "awaiting-deploy", reason: "waiting-for-deployment", mergeCommitSha: MERGE_SHA, baselineTaken: true, baselinePerHour: 10, baselineHours: 24 });
    expect(pending.calls).toEqual([{ commit: MERGE_SHA, environment: "production", mergedAt: new Date(MERGED).toISOString() }]);

    // 2. Deployed: the clock starts at the deployment's completion, not at the merge. Quiet so far, but the window is open.
    const live = fakeGithub(deployedObs);
    await seedCheckpoint(DEPLOYED + 20 * MIN);
    await observe(live.client, DEPLOYED + 30 * MIN);
    expect(await recovery("inc1_r0")).toMatchObject({
      state: "observing",
      reason: "waiting-for-window",
      deployedAt: new Date(DEPLOYED).toISOString(),
      deploymentId: 26,
      deploymentSha: MERGE_SHA,
      windowStart: new Date(T_START).toISOString(),
      windowEnd: new Date(T_END).toISOString(),
      expectedOccurrences: 10,
    });

    // 3. Once found, the deployment is not looked for again; the window is over, ingest has read through it: recovered.
    await seedCheckpoint(T_END + 5 * MIN);
    const again = fakeGithub(new Error("must not be called"));
    const done = await observe(again.client, T_END + 15 * MIN);
    expect(again.calls).toEqual([]);
    expect(done.decided).toEqual([{ cycleId: "inc1_r0", state: "recovered" }]);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "recovered", expectedOccurrences: 10, windowEnd: new Date(T_END).toISOString() });

    // 4. Final: it is not read, or changed, again (its watch mark is gone, #422); and nothing else of the cycle or the
    // incident moved.
    expect(await selectMergedCycles(db, cfg, 10)).toEqual([]);
    const after = await cycle("inc1_r0");
    expect(after.observedAt).toEqual({});
    expect({ ...after, observedAt: undefined, summary: { ...after.summary, recovery: undefined } }).toEqual({ ...before, observedAt: undefined, summary: { ...before.summary, recovery: undefined } });
    expect(await incidentDoc("inc1")).toMatchObject({ status: "logged" });
  });

  it("says recurred as soon as the error is seen after the deployment, and never resolves or reopens the incident itself", async () => {
    const seen = DEPLOYED + 25 * MIN;
    await seedIncident("inc1", { lastOccurredAt: Timestamp.fromMillis(seen) });
    await seedCycle("inc1_r0");
    await seedCheckpoint(DEPLOYED + 30 * MIN);
    const r = await observe(fakeGithub(deployedObs).client, DEPLOYED + 30 * MIN);
    expect(r.decided).toEqual([{ cycleId: "inc1_r0", state: "recurred" }]);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "recurred", recurredAt: new Date(seen).toISOString() });
    expect((await incidentDoc("inc1")).status).toBe("logged");
  });

  it("does not take an occurrence from the old revision, inside the deployment's grace, for a failed fix", async () => {
    await seedIncident("inc1", { lastOccurredAt: Timestamp.fromMillis(DEPLOYED + 2 * MIN) });
    await seedCycle("inc1_r0");
    await seedCheckpoint(T_END + 5 * MIN);
    await observe(fakeGithub(deployedObs).client, T_END + 15 * MIN);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "recovered" });
  });
});

describe("what it will not call recovered", () => {
  it("not while ingest has not read through the window: silence from a stalled ingest is not quiet", async () => {
    await seedIncident("inc1");
    await seedCycle("inc1_r0");
    await seedCheckpoint(T_END - 10 * MIN);
    await observe(fakeGithub(deployedObs).client, T_END + 3 * HOUR);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "observing", reason: "waiting-for-ingest" });
    // No checkpoint at all is the same, and a day on it gives up as unverified, never recovered.
    await db.collection(cfg.runCollection).doc(stateDocId(target)).delete();
    await observe(fakeGithub(deployedObs).client, T_END + 3 * HOUR + MIN);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "observing", reason: "waiting-for-ingest" });
    await observe(fakeGithub(deployedObs).client, T_END + 25 * HOUR);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "unverified", reason: "ingest-not-covering" });
  });

  it("not for an error too rare for silence to mean anything, however quiet it has been", async () => {
    // One occurrence a day: a 5-occurrence window would be five days.
    await seedIncident("inc1", { occurrencesByHour: { [hourOf(MERGED - 5 * HOUR)]: 1 } });
    await seedCycle("inc1_r0");
    await seedCheckpoint(DEPLOYED + 3 * HOUR);
    await observe(fakeGithub(deployedObs).client, DEPLOYED + 3 * HOUR);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "unverified", reason: "low-traffic" });
  });

  it("not with no deployment environment configured: it waits, GitHub is not asked, and once a person sets one it is judged (#423)", async () => {
    cfg = { ...cfg, deployEnvironment: "" };
    await seedIncident("inc1");
    await seedCycle("inc1_r0");
    await seedCheckpoint(T_END + 5 * MIN);
    const gh = fakeGithub(deployedObs);
    await observe(gh.client, DEPLOYED + 3 * HOUR);
    expect(gh.calls).toEqual([]);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "awaiting-deploy", reason: "no-deployment-environment", baselineTaken: true });
    // Days on, still unset: still waiting, never a final answer (the gap is a person's to close).
    await observe(gh.client, MERGED + 3 * 24 * HOUR);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "awaiting-deploy", reason: "no-deployment-environment" });
    // A person sets it: the merge is read again, its deployment found and judged.
    cfg = { ...cfg, deployEnvironment: "production" };
    const r = await observe(gh.client, MERGED + 3 * 24 * HOUR + HOUR);
    expect(gh.calls).toHaveLength(1);
    expect(r.decided).toEqual([{ cycleId: "inc1_r0", state: "recovered" }]);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "recovered", deployedAt: new Date(DEPLOYED).toISOString() });
  });

  it("re-reads a merge recorded unverified for a configuration gap before #423, and leaves one past the gap's bound final", async () => {
    await seedIncident("inc1");
    await seedCycle("inc1_r0");
    await seedCycle("inc1_r1", { recurrence: 1 });
    const old = (checkedAt: number) => ({ state: "unverified", reason: "no-deployment-environment", mergeCommitSha: MERGE_SHA, mergedAt: new Date(MERGED).toISOString(), baselineTaken: true, baselinePerHour: 10, baselineHours: 24, checkedAt: new Date(checkedAt).toISOString() });
    await db.collection(cfg.cycleCollection).doc("inc1_r0").update({ "summary.recovery": old(MERGED + HOUR) });
    await db.collection(cfg.cycleCollection).doc("inc1_r1").update({ "summary.recovery": old(MERGED + CONFIG_GAP_GIVE_UP_MS) });
    await seedCheckpoint(T_END + 5 * MIN);
    expect((await selectMergedCycles(db, cfg, 10)).map((c) => c.cycleId)).toEqual(["inc1_r0"]);
    await observe(fakeGithub(deployedObs).client, MERGED + 2 * 24 * HOUR);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "recovered" });
    expect(await recovery("inc1_r1")).toMatchObject({ state: "unverified", reason: "no-deployment-environment" });
  });

  it("not for a merge nobody can see deployed: it waits, then says so, naming a failed deployment as one", async () => {
    await seedIncident("inc1");
    await seedCycle("inc1_r0");
    await observe(fakeGithub({ state: "none" }).client, MERGED + 6 * HOUR);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "awaiting-deploy" });
    await observe(fakeGithub({ state: "failed", deploymentId: 9, sha: MERGE_SHA, failedAt: new Date(MERGED + HOUR).toISOString() }).client, MERGED + 25 * HOUR);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "unverified", reason: "deploy-failed" });
  });

  it("not for a merge Starfish's fast-revert watch reverted: the error the revert brings back is never the fix's recurrence (#424)", async () => {
    await seedIncident("inc1", { lastOccurredAt: Timestamp.fromMillis(T_START + 20 * MIN), recurrenceCount: 0 });
    await seedCycle("inc1_r0");
    await seedCycle("inc1_r1", { recurrence: 1 });
    await db.collection(cfg.cycleCollection).doc("inc1_r0").update({ "summary.revert": { state: "reverted", mergeSha: MERGE_SHA, by: "starfish" } });
    // Another merge's revert record (a hand edit) does not count.
    await db.collection(cfg.cycleCollection).doc("inc1_r1").update({ "summary.revert": { state: "reverted", mergeSha: "f".repeat(40) } });
    await seedCheckpoint(T_END + 5 * MIN);
    const gh = fakeGithub(deployedObs);
    await observe(gh.client, T_END + 15 * MIN);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "unverified", reason: "reverted" });
    expect(await recovery("inc1_r1")).toMatchObject({ state: "recurred" });
    expect(gh.calls).toHaveLength(1);
  });

  it("not for a retired or missing incident: a recurrence would be a new incident this one cannot see", async () => {
    await seedIncident("inc1", { retired: true });
    await seedCycle("inc1_r0");
    await seedCycle("gone_r0");
    await seedCheckpoint(T_END + 5 * MIN);
    await observe(fakeGithub(deployedObs).client, T_END + 15 * MIN);
    expect(await recovery("inc1_r0")).toMatchObject({ state: "unverified", reason: "incident-gone" });
    expect(await recovery("gone_r0")).toMatchObject({ state: "unverified", reason: "incident-gone" });
  });
});

describe("a GitHub that cannot be read", () => {
  it("is recorded as unreadable, not as no deployment; a refusal every cycle would meet stops the pass", async () => {
    await seedIncident("inc1");
    await seedIncident("inc2");
    await seedCycle("inc1_r0");
    await seedCycle("inc2_r0");
    const denied = fakeGithub(new GithubError("forbidden", "Resource not accessible by integration"));
    const r = await observe(denied.client, MERGED + 2 * HOUR);
    expect(r.stoppedBecause).toBe("forbidden");
    expect(denied.calls).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    const first = (await Promise.all(["inc1_r0", "inc2_r0"].map(recovery))).find((x) => x !== undefined)!;
    expect(first).toMatchObject({ state: "awaiting-deploy", readError: "forbidden" });
    // A day on, still unreadable: it says so rather than "never deployed", and keeps waiting: a permission is a gap a
    // person can close, not a fact about the fix (#423).
    await observe(fakeGithub(new GithubError("forbidden", "x")).client, MERGED + 25 * HOUR);
    const states = await Promise.all(["inc1_r0", "inc2_r0"].map(recovery));
    expect(states.some((s) => s && s.state === "awaiting-deploy" && s.reason === "deploy-unreadable")).toBe(true);
    expect(states.some((s) => s && s.state === "unverified")).toBe(false);
    // The bound: still unreadable that long after the merge, it is final.
    for (let i = 0; i < 2; i++) await observe(fakeGithub(new GithubError("forbidden", "x")).client, MERGED + CONFIG_GAP_GIVE_UP_MS + i * HOUR);
    for (const id of ["inc1_r0", "inc2_r0"]) expect(await recovery(id)).toMatchObject({ state: "unverified", reason: "deploy-unreadable" });
    expect(await selectMergedCycles(db, cfg, 10)).toEqual([]);
  });
});

describe("selecting what to observe", () => {
  it("takes finished cycles with a recorded merge commit, never a synthetic, open, unmerged or unfinished one, and not a final record", async () => {
    await seedIncident("a");
    await seedCycle("a_r0");
    await seedCycle("synth_r0", { synthetic: true });
    await seedCycle("run_r0", { state: "running" });
    await seedCycle("open_r0", {}, { state: "open", mergedAt: null });
    await seedCycle("nomerge_r0", {}, { mergeCommitSha: null });
    await seedCycle("final_r0");
    await db.collection(cfg.cycleCollection).doc("final_r0").update({ "summary.recovery": { state: "recovered", mergeCommitSha: MERGE_SHA, checkedAt: new Date(MERGED).toISOString() } });
    expect((await selectMergedCycles(db, cfg, 10)).map((c) => c.cycleId)).toEqual(["a_r0"]);
    expect(await selectMergedCycles(db, cfg, 0)).toEqual([]);
  });

  it("reads watched merges least recently observed first, however old and however many cycles came after them (#422)", async () => {
    // More merged cycles with a final answer than the scan for unmarked ones reads, all ahead of the watched ones by id;
    // none of them, nor a newer run of other cycles, moves the watched ones out of reach.
    for (let start = 0; start < 210; start += 105) {
      const batch = db.batch();
      for (let i = start; i < start + 105; i++) {
        const ts = Timestamp.fromMillis(MERGED + 30 * 24 * HOUR + i * 1000);
        batch.set(db.collection(cfg.cycleCollection).doc(`a${String(i).padStart(4, "0")}_r0`), {
          environment: "demo",
          state: "done",
          incidentId: "a",
          recurrence: 0,
          updatedAt: ts,
          summary: { prState: { state: "merged", mergedAt: new Date(MERGED).toISOString(), mergeCommitSha: MERGE_SHA }, recovery: { state: "recovered", mergeCommitSha: MERGE_SHA, checkedAt: new Date(MERGED).toISOString() } },
        });
      }
      await batch.commit();
    }
    for (const id of ["x", "y", "z"]) await seedIncident(id);
    const mark = (minutes: number) => ({ observedAt: { recovery: Timestamp.fromMillis(MERGED + minutes * MIN) } });
    await seedCycle("x_r0", mark(30));
    await seedCycle("y_r0", mark(10));
    await seedCycle("z_r0", mark(20));
    const gh = fakeGithub({ state: "pending", deploymentId: 26, sha: MERGE_SHA });
    cfg = { ...cfg, maxPrChecksPerPass: 1 };
    for (let i = 0; i < 4; i++) await observe(gh.client, MERGED + (i + 1) * HOUR);
    expect(gh.calls.map((c) => c.mergedAt)).toHaveLength(4);
    const order: [string, unknown][] = [];
    for (const id of ["x_r0", "y_r0", "z_r0"]) order.push([id, (await recovery(id)).checkedAt]);
    // y (oldest mark), z, x, then y again: each look sends the cycle to the back.
    expect(order.sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([id]) => id)).toEqual(["z_r0", "x_r0", "y_r0"]);
    expect(await recovery("y_r0")).toMatchObject({ checkedAt: new Date(MERGED + 4 * HOUR).toISOString() });
  });
});

describe("recordRecovery", () => {
  const record = (over: Record<string, unknown> = {}) => ({ state: "observing" as const, mergeCommitSha: MERGE_SHA, mergedAt: new Date(MERGED).toISOString(), checkedAt: new Date(MERGED + HOUR).toISOString(), ...over });

  it("refuses a record for a different merge, a cycle that is not merged, a malformed one, and a missing cycle", async () => {
    await seedCycle("a_r0");
    await seedCycle("open_r0", {}, { state: "open", mergedAt: null });
    expect(await recordRecovery(db, cfg, "a_r0", record({ mergeCommitSha: "f".repeat(40) }))).toEqual({ ok: false, reason: "not-merged" });
    expect(await recordRecovery(db, cfg, "open_r0", record())).toEqual({ ok: false, reason: "not-merged" });
    expect(await recordRecovery(db, cfg, "a_r0", record({ state: "healed" }))).toEqual({ ok: false, reason: "invalid" });
    expect(await recordRecovery(db, cfg, "a_r0", record({ checkedAt: "yesterday" }))).toEqual({ ok: false, reason: "invalid" });
    expect(await recordRecovery(db, cfg, "a_r0", record({ expectedOccurrences: -1 }))).toEqual({ ok: false, reason: "invalid" });
    expect(await recordRecovery(db, cfg, "nope_r0", record())).toEqual({ ok: false, reason: "no-such-cycle" });
  });

  it("never moves backwards: an older read is stale, and a final answer is final", async () => {
    await seedCycle("a_r0");
    expect(await recordRecovery(db, cfg, "a_r0", record())).toEqual({ ok: true, applied: true });
    expect(await recordRecovery(db, cfg, "a_r0", record())).toEqual({ ok: true, applied: false, reason: "stale" });
    expect(await recordRecovery(db, cfg, "a_r0", record({ checkedAt: new Date(MERGED + 2 * HOUR).toISOString(), state: "recovered" }))).toEqual({ ok: true, applied: true });
    expect(await recordRecovery(db, cfg, "a_r0", record({ checkedAt: new Date(MERGED + 3 * HOUR).toISOString(), state: "recurred" }))).toEqual({ ok: true, applied: false, reason: "final" });
    expect(await recovery("a_r0")).toMatchObject({ state: "recovered" });
  });
});
