/**
 * triggerIngest against the real Firestore emulator: who may run ingest now, what is recorded, and that
 * it is the scheduled run and not a lookalike. The log read is stubbed (no Cloud Logging here).
 * Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import type { ResolvedConfig } from "../runtimeSettings.js";
import { testConfig } from "../testConfig.js";
import { LAST_RUN_DOC, runIngest, stateDocId, type RunDeps } from "./run.js";
import { triggerIngest } from "./trigger.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("trigger.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "trigger-emulator-tests");
const db: Firestore = getFirestore(app, "trigger-tests");
afterAll(() => deleteApp(app));

const now = new Date("2026-10-04T12:00:00.000Z");
const empty = { entriesProcessed: 0, incidentsCreated: 0, incidentsUpdated: 0, incidentsRecurred: 0, incidentsReplayed: 0, errorsFoldedIntoOverflow: 0, capped: false };

let config: StarfishConfig;
beforeEach(async () => {
  const run = randomUUID().slice(0, 8);
  config = testConfig({
    projectId: "demo-starfish-rules",
    runCollection: `runs_${run}`,
    usersCollection: `users_${run}`,
    auditCollection: `audit_${run}`,
    defaultLookbackHours: 2,
    databaseId: "trigger-tests",
  });
  await db.collection(config.usersCollection).doc("admin1").set({ roles: ["admin"] });
  await db.collection(config.usersCollection).doc("op1").set({ roles: ["operator"] });
  await db.collection(config.usersCollection).doc("nobody").set({ roles: [] });
});

const loader = (c: () => StarfishConfig = () => config) => ({
  resolve: async (): Promise<ResolvedConfig> => ({ config: c(), source: "env", problems: [], actionsAllowed: true }),
});
const counting = () => {
  const calls: { id: string; start: number; end: number }[] = [];
  const deps: RunDeps = {
    aggregate: async (_d, _c, w) => {
      calls.push({ id: w.id, start: w.start.getTime(), end: w.end.getTime() });
      await new Promise((r) => setTimeout(r, 20));
      return empty;
    },
  };
  return { calls, deps };
};
const audit = async () => (await db.collection(config.auditCollection).get()).docs.map((d) => d.data());
const runDoc = async (id: string) => (await db.collection(config.runCollection).doc(id).get()).data();

describe("triggerIngest", () => {
  it("runs ingest for an admin, and records who asked and when", async () => {
    const { calls, deps } = counting();
    const r = await triggerIngest(db, config, loader(), "admin1", now, deps);

    expect(r).toMatchObject({ ok: true, summary: { outcome: "ok", windows: 1 } });
    expect(calls).toHaveLength(1);
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: "run-ingest", actorUid: "admin1" });
    expect(entry!.at.toMillis()).toBe(now.getTime());
  });

  it.each([
    ["an operator", "op1"],
    ["a user with no roles", "nobody"],
    ["someone with no operator record", "stranger"],
  ])("refuses %s: nothing runs, nothing is recorded, no state is written", async (_name, uid) => {
    const { calls, deps } = counting();
    expect(await triggerIngest(db, config, loader(), uid, now, deps)).toEqual({ ok: false, reason: "not-admin" });
    expect(calls).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
    expect(await runDoc(stateDocId(config))).toBeUndefined();
    expect(await runDoc(LAST_RUN_DOC)).toBeUndefined();
  });

  it.each(["a/b", "", "x".repeat(200)])("refuses a uid that is not a plain id (%j)", async (uid) => {
    const { calls, deps } = counting();
    expect(await triggerIngest(db, config, loader(), uid, now, deps)).toEqual({ ok: false, reason: "invalid-id" });
    expect(calls).toHaveLength(0);
  });

  it("records the trigger even when the run fails, and reports the failure", async () => {
    const r = await triggerIngest(db, config, loader(), "admin1", now, {
      aggregate: async () => {
        throw Object.assign(new Error("boom"), { code: "UNAVAILABLE" });
      },
    });
    expect(r).toMatchObject({ ok: true, summary: { outcome: "failed", error: "UNAVAILABLE" } });
    expect(await audit()).toHaveLength(1);
  });

  it("records the trigger BEFORE the run, so it is on record even if the run never finishes", async () => {
    let seenDuringRun = -1;
    await triggerIngest(db, config, loader(), "admin1", now, {
      aggregate: async () => {
        seenDuringRun = (await audit()).length;
        return empty;
      },
    });
    expect(seenDuringRun).toBe(1);
  });

  it("is the scheduled run, not a lookalike: the same windows, state and record", async () => {
    const viaTrigger = counting();
    const trig = await triggerIngest(db, config, loader(), "admin1", now, viaTrigger.deps);
    const triggered = { state: await runDoc(stateDocId(config)), last: await runDoc(LAST_RUN_DOC) };

    // The same run, scheduled, against a fresh set of collections.
    config = { ...config, runCollection: `${config.runCollection}_b` };
    const viaSchedule = counting();
    const sched = await runIngest(db, loader(), now, viaSchedule.deps);

    expect(trig.ok && trig.summary).toMatchObject({ outcome: sched.outcome, windows: sched.windows, totals: sched.totals });
    expect(viaTrigger.calls.map((c) => [c.start, c.end])).toEqual(viaSchedule.calls.map((c) => [c.start, c.end]));
    const scheduled = { state: await runDoc(stateDocId(config)), last: await runDoc(LAST_RUN_DOC) };
    expect(triggered.state?.checkpoint.toMillis()).toBe(scheduled.state?.checkpoint.toMillis());
    expect(triggered.last).toMatchObject({ outcome: scheduled.last?.outcome, windows: scheduled.last?.windows, capped: scheduled.last?.capped });
  });

  it("two triggers at once converge on the same windows and never overlap", async () => {
    const { calls, deps } = counting();
    await Promise.all([
      triggerIngest(db, config, loader(), "admin1", now, deps),
      triggerIngest(db, config, loader(), "admin1", new Date(now.getTime() + 60_000), deps),
    ]);
    const windows = [...new Map(calls.map((c) => [c.id, c])).values()].sort((a, b) => a.start - b.start);
    for (let i = 1; i < windows.length; i++) expect(windows[i]!.start).toBeGreaterThanOrEqual(windows[i - 1]!.end);
    expect(windows.length).toBeGreaterThan(0);
    expect(await audit()).toHaveLength(2);
  });
});
