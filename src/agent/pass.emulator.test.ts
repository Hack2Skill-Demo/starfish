/**
 * Choosing which incidents get a cycle, against the real Firestore emulator.
 * Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { countCyclesStartedToday, findStrandedCycles, selectCandidates, type PassConfig } from "./pass.js";
import { PUBLIC_VIEW_OFF } from "../testConfig.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("pass.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "pass-emulator-tests");
const db: Firestore = getFirestore(app, "pass-tests");
afterAll(() => deleteApp(app));

let cfg: PassConfig;
beforeEach(() => {
  const run = randomUUID().slice(0, 8);
  cfg = {
    environment: "demo",
    incidentCollection: `incidents_${run}`,
    cycleCollection: `cycles_${run}`,
    patchExcludedPaths: [],
    leaseSeconds: 300,
    cycleDeadlineMinutes: 60,
    maxCycleAttempts: 3,
    ...PUBLIC_VIEW_OFF,
  };
});

const ts = (minutesAgo: number) => Timestamp.fromMillis(Date.now() - minutesAgo * 60_000);
async function incident(id: string, over: Record<string, unknown> = {}) {
  await db.collection(cfg.incidentCollection).doc(id).set({ environment: "demo", status: "new", lastOccurredAt: ts(1), ...over });
}
const cycle = (id: string, state: string) => db.collection(cfg.cycleCollection).doc(id).set({ incidentId: id.replace(/_r\d+$/, ""), environment: "demo", state });
const ids = (c: { incidentId: string; recurrence: number }[]) => c.map((x) => `${x.incidentId}:${x.recurrence}`);

describe("selectCandidates", () => {
  it("picks open incidents, newest activity first", async () => {
    await incident("old", { lastOccurredAt: ts(60) });
    await incident("new", { lastOccurredAt: ts(1) });
    await incident("mid", { lastOccurredAt: ts(30), status: "acknowledged" });
    expect(ids(await selectCandidates(db, cfg, 10))).toEqual(["new:0", "mid:0", "old:0"]);
  });

  it("leaves out closed incidents, other environments, retired ones and seeded synthetic ones (#192)", async () => {
    await incident("resolved", { status: "resolved" });
    await incident("ignored", { status: "ignored" });
    await incident("prod", { environment: "prod" });
    await incident("retired", { retired: true });
    await incident("synthetic", { synthetic: true });
    await incident("open");
    expect(ids(await selectCandidates(db, cfg, 10))).toEqual(["open:0"]);
  });

  it("leaves out an incident whose cycle for the current recurrence is settled, but not one that is only running", async () => {
    await incident("done");
    await cycle("done_r0", "done");
    await incident("declined");
    await cycle("declined_r0", "declined");
    await incident("waiting");
    await cycle("waiting_r0", "waiting-human");
    await incident("failed");
    await cycle("failed_r0", "failed");
    await incident("running");
    await cycle("running_r0", "running");
    await incident("fresh");
    expect(ids(await selectCandidates(db, cfg, 10)).sort()).toEqual(["fresh:0", "running:0"]);
  });

  it("selects a failed run only for a fresh explicit retry request", async () => {
    const now = new Date();
    const reconsider = { reconsiderCooldownMinutes: 30, reconsiderMaxPerDay: 3, reconsiderBurstOccurrences: 20 };
    await incident("failed");
    await cycle("failed_r0", "failed");
    await db.collection(cfg.cycleCollection).doc("failed_r0").update({ settledAt: ts(10), recurrence: 0 });
    expect(await selectCandidates(db, cfg, 10, { reconsider, now })).toEqual([]);
    await db.collection(cfg.incidentCollection).doc("failed").update({ retriageRequestedAt: ts(1) });
    expect(await selectCandidates(db, cfg, 10, { reconsider, now })).toEqual([expect.objectContaining({ incidentId: "failed", reconsider: "operator" })]);
  });

  it("gives a regression a fresh cycle: the old recurrence's settled cycle does not count", async () => {
    await incident("back", { status: "recurred", recurrenceCount: 1 });
    await cycle("back_r0", "done");
    expect(ids(await selectCandidates(db, cfg, 10))).toEqual(["back:1"]);
    await cycle("back_r1", "done");
    expect(await selectCandidates(db, cfg, 10)).toEqual([]);
  });

  it("puts a recurred incident first, then untriaged ones, ahead of newer ones already past triage (#303)", async () => {
    await incident("past-triage", { lastOccurredAt: ts(1) });
    await db.collection(cfg.cycleCollection).doc("past-triage_r0").set({
      incidentId: "past-triage",
      environment: "demo",
      state: "running",
      summary: { triage: { decision: "act" } },
    });
    await incident("untriaged-running", { lastOccurredAt: ts(2) });
    await cycle("untriaged-running_r0", "running");
    await incident("untriaged", { lastOccurredAt: ts(3) });
    await incident("regression", { lastOccurredAt: ts(90), status: "recurred", recurrenceCount: 1 });
    expect(ids(await selectCandidates(db, cfg, 10))).toEqual(["regression:1", "untriaged-running:0", "untriaged:0", "past-triage:0"]);
    expect(ids(await selectCandidates(db, cfg, 2))).toEqual(["regression:1", "untriaged-running:0"]);
  });

  it("finds a recurred incident behind a flood of newer ones, within the read budget (#303)", async () => {
    // A flood of 30 newer, distinct, untriaged incidents fills more than a page of a limit of 2 (2 x 5).
    for (let i = 0; i < 30; i++) await incident(`flood${i}`, { lastOccurredAt: ts(i) });
    await incident("regression", { lastOccurredAt: ts(120), status: "recurred", recurrenceCount: 2 });
    expect(ids(await selectCandidates(db, cfg, 2))).toEqual(["regression:2", "flood0:0"]);
  });

  it("stops at the limit, and looks past closed incidents to find enough open ones", async () => {
    for (let i = 0; i < 6; i++) await incident(`closed${i}`, { status: "resolved", lastOccurredAt: ts(i) });
    for (let i = 0; i < 4; i++) await incident(`open${i}`, { lastOccurredAt: ts(10 + i) });
    expect(ids(await selectCandidates(db, cfg, 2))).toEqual(["open0:0", "open1:0"]);
  });

  it("pages past newer settled incidents to an older open one (#226)", async () => {
    // Fifteen newer incidents whose cycles are settled fill the first page of a limit of 3 (3 x 5).
    for (let i = 0; i < 15; i++) {
      await incident(`settled${i}`, { lastOccurredAt: ts(i) });
      await cycle(`settled${i}_r0`, "waiting-human");
    }
    await incident("older", { lastOccurredAt: ts(120) });
    expect(ids(await selectCandidates(db, cfg, 3))).toEqual(["older:0"]);
  });

  it("stops at its read budget and says so (#226)", async () => {
    for (let i = 0; i < 6; i++) await incident(`closed${i}`, { status: "resolved", lastOccurredAt: ts(i) });
    await incident("beyond", { lastOccurredAt: ts(120) });
    const capped: number[] = [];
    expect(await selectCandidates(db, cfg, 1, { maxScanned: 6, onScanCapped: (n) => capped.push(n) })).toEqual([]);
    expect(capped).toEqual([6]);
    // Under the budget, the end of the store is not a cap.
    const notCapped: number[] = [];
    expect(ids(await selectCandidates(db, cfg, 1, { onScanCapped: (n) => notCapped.push(n) }))).toEqual(["beyond:0"]);
    expect(notCapped).toEqual([]);
  });

  it("treats a bad recurrence count as zero, and asks for nothing when the limit is not a positive whole number", async () => {
    await incident("odd", { recurrenceCount: -2 });
    expect(ids(await selectCandidates(db, cfg, 5))).toEqual(["odd:0"]);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(await selectCandidates(db, cfg, bad)).toEqual([]);
  });

  it("returns nothing for an empty store", async () => {
    expect(await selectCandidates(db, cfg, 5)).toEqual([]);
  });

  it("with a reconsideration policy, picks a declined cycle only when new evidence arrived since its decision (#8)", async () => {
    const policy = { reconsiderCooldownMinutes: 30, reconsiderMaxPerDay: 3, reconsiderBurstOccurrences: 20 };
    const declinedOn = (id: string, decision: Record<string, unknown>) =>
      db.collection(cfg.cycleCollection).doc(`${id}_r0`).set({ incidentId: id, environment: "demo", recurrence: 0, state: "declined", updatedAt: ts(60), decision: { at: ts(60), ...decision } });
    await incident("burst", { occurrenceCount: 50 });
    await declinedOn("burst", { occurrenceCount: 5 });
    await incident("same", { occurrenceCount: 6 });
    await declinedOn("same", { occurrenceCount: 5 });
    await incident("asked", { occurrenceCount: 5, retriageRequestedAt: ts(1) });
    await declinedOn("asked", { occurrenceCount: 5 });
    const picked = await selectCandidates(db, cfg, 10, { reconsider: policy });
    expect(picked.map((c) => `${c.incidentId}:${c.reconsider}`).sort()).toEqual(["asked:operator", "burst:burst"]);
    // Without the policy a decline stays settled.
    expect(await selectCandidates(db, cfg, 10)).toEqual([]);
  });
});

describe("findStrandedCycles (#226)", () => {
  it("finds the running cycles nobody holds whose deadline passed or whose attempts ran out, and nothing else", async () => {
    const now = new Date();
    const at = (minutes: number) => Timestamp.fromMillis(now.getTime() + minutes * 60_000);
    const put = (id: string, over: Record<string, unknown>) =>
      db.collection(cfg.cycleCollection).doc(id).set({
        incidentId: id.replace(/_r\d+$/, ""),
        environment: "demo",
        recurrence: 0,
        state: "running",
        attempts: 1,
        owner: null,
        leaseExpiresAt: null,
        deadlineAt: at(60),
        updatedAt: at(-5),
        ...over,
      });
    await put("late_r0", { deadlineAt: at(-1) });
    await put("spent_r0", { attempts: 3 });
    await put("paused_r0", { attempts: 3, resumeUncounted: true }); // released by the kill switch: no attempt used
    await put("held_r0", { deadlineAt: at(-1), owner: "w", leaseExpiresAt: at(2) }); // its holder's to finish
    await put("retry_r0", { attempts: 2 }); // a later pass resumes it
    await put("done_r0", { state: "done", deadlineAt: at(-1) });
    await put("prod_r0", { environment: "prod", deadlineAt: at(-1) });
    await put("misnamed_r0", { incidentId: "other", deadlineAt: at(-1) });
    const found = await findStrandedCycles(db, cfg, now);
    expect(found.map((k) => k.incidentId).sort()).toEqual(["late", "spent"]);
    expect(found[0]).toMatchObject({ environment: "demo", recurrence: 0 });
  });
});

describe("countCyclesStartedToday", () => {
  it("counts this environment's cycles started on the UTC day, each once", async () => {
    const now = new Date("2026-10-06T10:00:00Z");
    const put = (id: string, environment: string, startDays: string[]) => db.collection(cfg.cycleCollection).doc(id).set({ environment, startDays, state: "done" });
    await put("a_r0", "demo", ["2026-10-06"]);
    await put("b_r0", "demo", ["2026-10-05", "2026-10-06"]);
    await put("c_r0", "demo", ["2026-10-05"]);
    await put("d_r0", "prod", ["2026-10-06"]);
    await db.collection(cfg.cycleCollection).doc("legacy_r0").set({ environment: "demo", state: "done" });
    expect(await countCyclesStartedToday(db, cfg, now)).toBe(2);
    expect(await countCyclesStartedToday(db, cfg, new Date("2026-10-07T00:00:00Z"))).toBe(0);
  });
});
