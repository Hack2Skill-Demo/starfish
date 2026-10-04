/**
 * Choosing which incidents get a cycle, against the real Firestore emulator.
 * Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { selectCandidates, type PassConfig } from "./pass.js";

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

  it("leaves out closed incidents, other environments and retired ones", async () => {
    await incident("resolved", { status: "resolved" });
    await incident("ignored", { status: "ignored" });
    await incident("prod", { environment: "prod" });
    await incident("retired", { retired: true });
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

  it("gives a regression a fresh cycle: the old recurrence's settled cycle does not count", async () => {
    await incident("back", { status: "recurred", recurrenceCount: 1 });
    await cycle("back_r0", "done");
    expect(ids(await selectCandidates(db, cfg, 10))).toEqual(["back:1"]);
    await cycle("back_r1", "done");
    expect(await selectCandidates(db, cfg, 10)).toEqual([]);
  });

  it("stops at the limit, and looks past closed incidents to find enough open ones", async () => {
    for (let i = 0; i < 6; i++) await incident(`closed${i}`, { status: "resolved", lastOccurredAt: ts(i) });
    for (let i = 0; i < 4; i++) await incident(`open${i}`, { lastOccurredAt: ts(10 + i) });
    expect(ids(await selectCandidates(db, cfg, 2))).toEqual(["open0:0", "open1:0"]);
  });

  it("treats a bad recurrence count as zero, and asks for nothing when the limit is not a positive whole number", async () => {
    await incident("odd", { recurrenceCount: -2 });
    expect(ids(await selectCandidates(db, cfg, 5))).toEqual(["odd:0"]);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(await selectCandidates(db, cfg, bad)).toEqual([]);
  });

  it("returns nothing for an empty store", async () => {
    expect(await selectCandidates(db, cfg, 5)).toEqual([]);
  });
});
