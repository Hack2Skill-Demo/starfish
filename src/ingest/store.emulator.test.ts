/**
 * upsertIncident against the real Firestore emulator: the races the unit tests'
 * fake can't express. Each test gets its own collections, so tests never see
 * each other's documents. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_VIEW_OFF } from "../testConfig.js";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { upsertIncident, type IncidentInput, type UpsertOutcome } from "./store.js";
import { hourBucketKey } from "./buckets.js";
import type { MonitoringObservation } from "./monitoring.js";

// Never let this suite reach a real project with ambient credentials.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("store.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "store-emulator-tests");
// Its own named database, apart from the one the rules suite clears.
const db: Firestore = getFirestore(app, "store-tests");
afterAll(() => deleteApp(app));

let store: { incidentCollection: string; incidentKeyCollection: string } & typeof PUBLIC_VIEW_OFF;
beforeEach(() => {
  const run = randomUUID().slice(0, 8);
  store = { incidentCollection: `incidents_${run}`, incidentKeyCollection: `keys_${run}`, ...PUBLIC_VIEW_OFF };
});

const HOUR = 3600_000;
const base = Date.now() - 6 * HOUR;
const occurrence = (atMs: number, count = 1): IncidentInput => ({
  functionName: "mailDrainer",
  service: null,
  environment: "prod",
  errorType: "UnknownError",
  errorMessage: "email send failed",
  occurrenceCount: count,
  firstOccurredAt: new Date(atMs),
  lastOccurredAt: new Date(atMs),
});

const upsert = (input: IncidentInput) => upsertIncident(db, store, input, Timestamp.now());
const incidents = async () => (await db.collection(store.incidentCollection).get()).docs;
const keys = async () => (await db.collection(store.incidentKeyCollection).get()).docs;
const tally = (outcomes: UpsertOutcome[]) =>
  outcomes.reduce<Record<string, number>>((acc, o) => ({ ...acc, [o]: (acc[o] ?? 0) + 1 }), {});
const bucketTotal = (buckets: Record<string, number>) => Object.values(buckets).reduce((a, b) => a + b, 0);

/**
 * Run `during` once, in the middle of the first attempt of the next upsert's
 * transaction: after it has read the incident, before it writes. That is the
 * window the pre-transaction store left open. Returns the promise of `during`.
 */
function interleave(during: () => Promise<unknown>): { done: () => Promise<unknown> } {
  const original = db.runTransaction.bind(db);
  let pending: Promise<unknown> = Promise.resolve();
  let fired = false;
  db.runTransaction = (<T>(fn: (tx: Transaction) => Promise<T>, options?: object) =>
    original(async (tx) => {
      const get = tx.get.bind(tx) as (target: unknown) => Promise<unknown>;
      (tx as unknown as { get: typeof get }).get = async (target) => {
        const result = await get(target);
        const isIncident = (target as { path?: string }).path?.startsWith(`${store.incidentCollection}/`);
        if (!fired && isIncident) {
          fired = true;
          // Not awaited: the transaction holds the document, so the write waits on it.
          pending = during();
          await new Promise((r) => setTimeout(r, 200));
        }
        return result;
      };
      return fn(tx);
    }, options)) as typeof db.runTransaction;
  return {
    done: async () => {
      db.runTransaction = original;
      return pending;
    },
  };
}

describe("upsertIncident on the emulator", () => {
  it("concurrent first occurrences converge on one incident with every occurrence counted", async () => {
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => upsert(occurrence(base, 3))));

    expect(tally(outcomes)).toEqual({ new: 1, updated: 7 });
    const docs = await incidents();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.get("occurrenceCount")).toBe(24);
    expect(bucketTotal(docs[0]?.get("occurrencesByHour") as Record<string, number>)).toBe(24);
    const keyDocs = await keys();
    expect(keyDocs).toHaveLength(1);
    expect(keyDocs[0]?.get("incidentId")).toBe(docs[0]?.id);
  });

  it("concurrent accrual loses no hourly bucket", async () => {
    await upsert(occurrence(base));
    // Different hours, so each write merges a different bucket into the same map.
    await Promise.all(Array.from({ length: 6 }, (_, i) => upsert(occurrence(base + i * HOUR, 2))));

    const [doc] = await incidents();
    const buckets = doc?.get("occurrencesByHour") as Record<string, number>;
    expect(doc?.get("occurrenceCount")).toBe(13);
    expect(bucketTotal(buckets)).toBe(13);
    for (let i = 0; i < 6; i++) expect(buckets[hourBucketKey(base + i * HOUR)]).toBeGreaterThan(0);
  });

  it("adopts an incident stored before keys existed instead of forking it", async () => {
    const legacy = db.collection(store.incidentCollection).doc("legacy");
    await upsert(occurrence(base));
    const [created] = await incidents();
    // Recreate it as a pre-key document: same content, no key pointing at it.
    await legacy.set(created!.data());
    await created!.ref.delete();
    await Promise.all((await keys()).map((k) => k.ref.delete()));

    await Promise.all(Array.from({ length: 4 }, () => upsert(occurrence(base))));

    const docs = await incidents();
    expect(docs.map((d) => d.id)).toEqual(["legacy"]);
    expect(docs[0]?.get("occurrenceCount")).toBe(5);
    expect((await keys())[0]?.get("incidentId")).toBe("legacy");
  });

  it("an operator resolve racing an occurrence never leaves a later occurrence on a resolved incident", async () => {
    await upsert(occurrence(base));
    const [doc] = await incidents();

    // The operator resolves (the fields firestore.rules allows) while the engine
    // is between reading the incident and writing to it.
    const race = interleave(() =>
      doc!.ref.update({
        status: "resolved",
        resolvedAt: FieldValue.serverTimestamp(),
        statusChangedBy: "operator-uid",
        updatedAt: FieldValue.serverTimestamp(),
      })
    );
    const outcome = await upsert(occurrence(Date.now()));
    await race.done();

    const after = (await incidents())[0]!;
    expect(after.get("occurrenceCount")).toBe(2);
    if (after.get("status") === "resolved") {
      // Serialized as accrue-then-resolve: the occurrence predates the resolution.
      expect(outcome).toBe("updated");
      const resolvedAt = after.get("resolvedAt") as Timestamp;
      const last = after.get("lastOccurredAt") as Timestamp;
      expect(resolvedAt.toMillis()).toBeGreaterThanOrEqual(last.toMillis());
    } else {
      // Serialized as resolve-then-occur: a regression.
      expect(outcome).toBe("recurred");
      expect(after.get("status")).toBe("recurred");
    }

    // Whichever order won, the next occurrence after the resolution is a regression.
    if (after.get("status") === "resolved") {
      expect(await upsert(occurrence(Date.now() + 1000))).toBe("recurred");
    }
    const final = (await incidents())[0]!;
    expect(final.get("status")).toBe("recurred");
    expect(final.get("recurrenceCount")).toBe(1);
    expect(final.get("lastResolution")).toMatchObject({ resolvedBy: "operator-uid" });
    expect(final.get("triageState")).toBe("pending");
  });

  it("concurrent occurrences after a resolution recur it exactly once", async () => {
    await upsert(occurrence(base));
    const [doc] = await incidents();
    await doc!.ref.update({ status: "resolved", resolvedAt: Timestamp.fromMillis(base + HOUR), triageState: "resolved" });

    const outcomes = await Promise.all(Array.from({ length: 5 }, () => upsert(occurrence(base + 2 * HOUR))));

    expect(tally(outcomes)).toEqual({ recurred: 1, updated: 4 });
    const after = (await incidents())[0]!;
    expect(after.get("status")).toBe("recurred");
    expect(after.get("recurrenceCount")).toBe(1);
    expect(after.get("occurrenceCount")).toBe(6);
  });

  it("counts delayed pre-resolution logs without re-opening the incident", async () => {
    await upsert(occurrence(base));
    const [doc] = await incidents();
    await doc!.ref.update({ status: "resolved", resolvedAt: Timestamp.fromMillis(base + 2 * HOUR) });

    expect(await upsert(occurrence(base + HOUR))).toBe("updated");

    const after = (await incidents())[0]!;
    expect(after.get("status")).toBe("resolved");
    expect(after.get("occurrenceCount")).toBe(2);
    expect(after.get("recurrenceCount")).toBeUndefined();
  });

  it("a delayed batch never moves lastOccurredAt backwards", async () => {
    await upsert(occurrence(base + 3 * HOUR));
    await upsert(occurrence(base));

    const after = (await incidents())[0]!;
    expect((after.get("lastOccurredAt") as Timestamp).toMillis()).toBe(base + 3 * HOUR);
    expect((after.get("firstOccurredAt") as Timestamp).toMillis()).toBe(base);
  });

  it("leaves an ignored incident alone and opens a fresh one, once, under concurrency", async () => {
    await upsert(occurrence(base));
    const [ignored] = await incidents();
    await ignored!.ref.update({ status: "ignored" });

    const outcomes = await Promise.all(Array.from({ length: 4 }, () => upsert(occurrence(base + HOUR))));

    expect(tally(outcomes)).toEqual({ new: 1, updated: 3 });
    const docs = await incidents();
    expect(docs).toHaveLength(2);
    const old = docs.find((d) => d.id === ignored!.id)!;
    const fresh = docs.find((d) => d.id !== ignored!.id)!;
    expect(old.get("status")).toBe("ignored");
    expect(old.get("occurrenceCount")).toBe(1);
    expect(fresh.get("status")).toBe("new");
    expect(fresh.get("occurrenceCount")).toBe(4);
    expect((await keys())[0]?.get("incidentId")).toBe(fresh.id);
  });

  it("redoes the attempt when its transaction was closed under the unkeyed lookup (#151)", async () => {
    // #151: under contention a transactional query failed before any response (a lock timeout, which
    // closes the transaction), the client's streaming layer re-sent it on the same transaction id, and
    // the re-send got INVALID_ARGUMENT "Transaction is invalid or closed", which the runner does not
    // retry. Reproduced here without the race: the emulator really closes the transaction (a Rollback
    // RPC on its id) just before the first query of the first attempt is sent. Reaching the transaction
    // id and the RPC needs two SDK internals; this test is the only place that touches them.
    type Internals = { _transactionIdPromise?: Promise<Uint8Array> };
    type Rpc = { request: (method: string, req: object, tag: string) => Promise<unknown>; formattedName: string };
    const original = db.runTransaction.bind(db);
    let closed = false;
    db.runTransaction = (<T>(fn: (tx: Transaction) => Promise<T>, options?: object) =>
      original(async (tx) => {
        const get = tx.get.bind(tx) as (target: unknown) => Promise<unknown>;
        (tx as unknown as { get: typeof get }).get = async (target) => {
          const isQuery = !(target as { path?: string }).path;
          if (!closed && isQuery) {
            closed = true;
            const id = await (tx as unknown as Internals)._transactionIdPromise;
            const rpc = db as unknown as Rpc;
            await rpc.request("rollback", { database: rpc.formattedName, transaction: id }, "issue-151");
          }
          return get(target);
        };
        return fn(tx);
      }, options)) as typeof db.runTransaction;

    try {
      expect(await upsert(occurrence(base))).toBe("new");
    } finally {
      db.runTransaction = original;
    }
    expect(closed).toBe(true);
    const docs = await incidents();
    expect(docs).toHaveLength(1);
    expect(docs[0]?.get("occurrenceCount")).toBe(1);
    expect((await keys())[0]?.get("incidentId")).toBe(docs[0]?.id);
  });
});

describe("upsertIncident replays on the emulator", () => {
  const inWindow = (windowId: string, atMs: number, count = 1): IncidentInput => ({ ...occurrence(atMs, count), windowId });
  const other = (windowId: string): IncidentInput => ({
    ...inWindow(windowId, base, 2),
    functionName: "orderSync",
    errorMessage: "order sync timed out",
  });

  it("applying the same window twice counts it once", async () => {
    expect(await upsert(inWindow("w1", base, 5))).toBe("new");
    expect(await upsert(inWindow("w1", base, 5))).toBe("duplicate");

    const [doc] = await incidents();
    expect(doc?.get("occurrenceCount")).toBe(5);
    expect(bucketTotal(doc?.get("occurrencesByHour") as Record<string, number>)).toBe(5);
  });

  it("a different window still counts", async () => {
    await upsert(inWindow("w1", base, 5));
    expect(await upsert(inWindow("w2", base + HOUR, 3))).toBe("updated");
    expect((await incidents())[0]?.get("occurrenceCount")).toBe(8);
  });

  it("a replay of a later window is recognised too, not only the one that opened the incident", async () => {
    await upsert(inWindow("w1", base, 5));
    await upsert(inWindow("w2", base + HOUR, 3));
    expect(await upsert(inWindow("w2", base + HOUR, 3))).toBe("duplicate");

    expect((await incidents())[0]?.get("occurrenceCount")).toBe(8);
    expect((await keys())[0]?.get("appliedWindows")).toEqual(["w1", "w2"]);
  });

  it("concurrent retries of one window count it exactly once", async () => {
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => upsert(inWindow("w1", base, 3))));

    expect(tally(outcomes)).toEqual({ new: 1, duplicate: 7 });
    const [doc] = await incidents();
    expect(doc?.get("occurrenceCount")).toBe(3);
    expect((await keys())[0]?.get("appliedWindows")).toEqual(["w1"]);
  });

  it("a run that failed part-way and is retried over the same window counts every incident once", async () => {
    // First attempt: only the first incident committed before the run died.
    await upsert(inWindow("w1", base, 5));
    // The retry replays the whole window.
    const retry = await Promise.all([upsert(inWindow("w1", base, 5)), upsert(other("w1"))]);

    expect(tally(retry)).toEqual({ duplicate: 1, new: 1 });
    const counts = Object.fromEntries((await incidents()).map((d) => [d.get("functionName"), d.get("occurrenceCount")]));
    expect(counts).toEqual({ mailDrainer: 5, orderSync: 2 });
  });

  it("a replay does not reopen an incident an operator resolved after the first application", async () => {
    await upsert(inWindow("w1", base, 5));
    const [doc] = await incidents();
    await doc!.ref.update({ status: "resolved", resolvedAt: Timestamp.fromMillis(Date.now() - 1000) });

    // Same window, replayed after the resolve: its occurrences are not a regression.
    expect(await upsert(inWindow("w1", Date.now(), 5))).toBe("duplicate");
    expect((await incidents())[0]?.get("status")).toBe("resolved");
  });
});


describe("upsertIncident: Monitoring readings (#19)", () => {
  const reading = (windowId: string, failureCount: number): MonitoringObservation => ({
    source: "cloud-monitoring",
    metricType: "run.googleapis.com/request_count",
    resourceType: "cloud_run_revision",
    projectId: "watched-app-1",
    functionName: "mailDrainer",
    windowStart: new Date(base - HOUR),
    windowEnd: new Date(base),
    failureCount,
    capped: false,
    firstAt: new Date(base - HOUR),
    lastAt: new Date(base),
    description: `${windowId}: unused`,
  });
  // The SAME function and message as a log occurrence: only the namespace keeps them apart.
  const monitoringOnly = (windowId: string, count: number): IncidentInput => ({
    ...occurrence(base, count),
    errorType: "UnloggedFailure",
    signalSource: "monitoring",
    monitoring: [reading(windowId, count)],
    windowId,
  });

  it("a Monitoring-only incident never merges with a log incident of the same function and message", async () => {
    expect(await upsert(occurrence(base, 2))).toBe("new");
    expect(await upsert(monitoringOnly("w1", 7))).toBe("new");
    expect(await upsert(monitoringOnly("w2", 3))).toBe("updated");
    expect(await upsert(occurrence(base + 1000, 1))).toBe("updated");

    const docs = Object.fromEntries((await incidents()).map((d) => [d.get("signalSource") ?? "log", d.data()]));
    expect(docs.log).toMatchObject({ occurrenceCount: 3 });
    expect(docs.log?.monitoringCount).toBeUndefined();
    expect(docs.monitoring).toMatchObject({ occurrenceCount: 10, monitoringCount: 10 });
    expect(String(docs.monitoring?.fingerprint)).toBe(`mon-${String(docs.log?.fingerprint)}`);
    expect(await keys()).toHaveLength(2);
  });

  it("annotates a log incident once per window: a replay adds nothing", async () => {
    const annotated = (windowId: string, failures: number): IncidentInput => ({
      ...occurrence(base, 1),
      windowId,
      monitoring: [reading(windowId, failures)],
    });
    await upsert(annotated("w1", 4));
    expect(await upsert(annotated("w1", 4))).toBe("duplicate");
    await upsert(annotated("w2", 6));

    const [doc] = await incidents();
    expect(doc?.get("monitoringCount")).toBe(10);
    expect(doc?.get("lastMonitoring")).toEqual([expect.objectContaining({ failureCount: 6, metricType: "run.googleapis.com/request_count" })]);
  });
});

describe("upsertIncident: accrue-only and the overflow namespace (#303)", () => {
  const accrueOnly = (input: IncidentInput) => upsertIncident(db, store, input, Timestamp.now(), { createIfAbsent: false });

  it("writes nothing for an error with no incident, not even the window on a key", async () => {
    expect(await accrueOnly({ ...occurrence(base, 3), windowId: "w1" })).toBe("absent");
    expect(await incidents()).toHaveLength(0);
    expect(await keys()).toHaveLength(0);
    // The window was not recorded, so a normal upsert of it still applies (it is not a "duplicate").
    expect(await upsert({ ...occurrence(base, 3), windowId: "w1" })).toBe("new");
  });

  it("still accrues onto an open incident, recurs a resolved one, and records the window", async () => {
    expect(await upsert(occurrence(base, 2))).toBe("new");
    expect(await accrueOnly({ ...occurrence(base + 1000, 5), windowId: "w2" })).toBe("updated");
    expect(await accrueOnly({ ...occurrence(base + 1000, 5), windowId: "w2" })).toBe("duplicate");
    const [doc] = await incidents();
    expect(doc?.get("occurrenceCount")).toBe(7);

    await doc!.ref.update({ status: "resolved", resolvedAt: Timestamp.fromMillis(base + 2000) });
    expect(await accrueOnly({ ...occurrence(base + 3000, 1), windowId: "w3" })).toBe("recurred");
    expect((await incidents())[0]?.get("status")).toBe("recurred");
  });

  it("never opens a fresh incident behind an ignored one", async () => {
    expect(await upsert(occurrence(base, 1))).toBe("new");
    await (await incidents())[0]!.ref.update({ status: "ignored" });
    expect(await accrueOnly(occurrence(base + 1000, 1))).toBe("absent");
    expect(await incidents()).toHaveLength(1);
  });

  it("keeps an overflow incident apart from a log incident with the same function and message", async () => {
    expect(await upsert(occurrence(base, 1))).toBe("new");
    expect(await upsert({ ...occurrence(base, 4), signalSource: "overflow" })).toBe("new");
    expect(await upsert({ ...occurrence(base + 1000, 2), signalSource: "overflow" })).toBe("updated");
    const docs = Object.fromEntries((await incidents()).map((d) => [d.get("signalSource") ?? "log", d.data()]));
    expect(docs.overflow).toMatchObject({ occurrenceCount: 6, signalSource: "overflow" });
    expect(String(docs.overflow?.fingerprint)).toMatch(/^ovf-[0-9a-f]{16}$/);
    expect(docs.log).toMatchObject({ occurrenceCount: 1 });
  });
});
