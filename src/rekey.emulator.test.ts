/**
 * rekeyIncidents against the real Firestore emulator (#362): records stored under a fingerprint the current code no
 * longer produces get the current one and a key, and the property that matters, that the next occurrence lands ON the
 * stored incident (accrued, or re-opened as `recurred`) instead of opening a new one. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_VIEW_OFF } from "./testConfig.js";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { computeErrorFingerprint } from "./ingest/fingerprint.js";
import { incidentKeyId, upsertIncident, type IncidentInput } from "./ingest/store.js";
import { rekeyIncidents } from "./rekey.js";

// Never let this suite reach a real project with ambient credentials.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("rekey.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "rekey-emulator-tests");
const db: Firestore = getFirestore(app, "rekey-tests");
afterAll(() => deleteApp(app));

let store: { incidentCollection: string; incidentKeyCollection: string } & typeof PUBLIC_VIEW_OFF;
beforeEach(() => {
  const run = randomUUID().slice(0, 8);
  store = { incidentCollection: `incidents_${run}`, incidentKeyCollection: `keys_${run}`, ...PUBLIC_VIEW_OFF };
});

// #361's demo bug as it was stored before ingest split the stack off the message: one bug, two records, each under
// the fingerprint the code of the day gave it (the frames were hashed, so the two differed).
const FN = "orders-getorder";
const CORE = "Cannot read properties of undefined (reading 'toString')";
const UNHANDLED = `Unhandled error TypeError: ${CORE}\n    at getOrder (/workspace/lib/orders/getOrder.js:22:31)`;
const RETHROW = `Error: orders-getOrder failed: ${CORE}\n    at entryFromArgs (/workspace/node_modules/firebase-functions/lib/logger/index.js:133:19)`;
const NEW_FP = computeErrorFingerprint(FN, CORE);
const ENV = "demo";
const at = (iso: string) => Timestamp.fromDate(new Date(iso));

const incidents = () => db.collection(store.incidentCollection);
const keys = () => db.collection(store.incidentKeyCollection);

/** A record stored under `oldFp`, with the key that named it (and the windows it applied) when `windows` is given. */
async function seed(id: string, oldFp: string, overrides: Record<string, unknown> = {}, windows?: string[]) {
  await incidents()
    .doc(id)
    .set({
      functionName: FN,
      service: "platform",
      environment: ENV,
      errorType: "TypeError",
      errorMessage: UNHANDLED,
      occurrenceCount: 3,
      occurrencesByHour: {},
      firstOccurredAt: at("2026-10-01T00:00:00Z"),
      lastOccurredAt: at("2026-10-02T00:00:00Z"),
      status: "new",
      fingerprint: oldFp,
      triageState: "pending",
      createdAt: at("2026-10-01T00:00:00Z"),
      updatedAt: at("2026-10-02T00:00:00Z"),
      ...overrides,
    });
  if (windows !== undefined) {
    await keys()
      .doc(incidentKeyId(ENV, oldFp))
      .set({ incidentId: id, environment: ENV, fingerprint: oldFp, updatedAt: at("2026-10-02T00:00:00Z"), appliedWindows: windows });
  }
}

const everything = async () =>
  JSON.stringify([...(await incidents().get()).docs, ...(await keys().get()).docs].map((d) => [d.ref.path, d.data()]));

/** The next occurrence as ingest now hands it to the store: the title, the frames as the stack. */
const occurrence = (when: string, windowId?: string): IncidentInput => ({
  functionName: FN,
  service: null,
  environment: ENV,
  errorType: "TypeError",
  errorMessage: `Error: orders-getOrder failed: ${CORE}`,
  stackTrace: RETHROW,
  occurrenceCount: 2,
  firstOccurredAt: new Date(when),
  lastOccurredAt: new Date(when),
  ...(windowId !== undefined && { windowId }),
});

describe("rekeyIncidents on the emulator (#362)", () => {
  it("a dry run counts what it would change and writes nothing", async () => {
    await seed("a", "old-a", {}, ["w1"]);
    await seed("b", "old-b", { errorMessage: RETHROW }, ["w2"]);
    const before = await everything();

    const report = await rekeyIncidents(db, store, { environment: ENV, apply: false });

    expect(report).toMatchObject({ scanned: 2, refingerprinted: 2, shared: 1, keysWritten: 0, applied: false });
    expect(await everything()).toBe(before);
  });

  it("gives both forks the current fingerprint and keys the earliest open one, with every window either key applied", async () => {
    await seed("late", "old-a", { firstOccurredAt: at("2026-10-03T00:00:00Z") }, ["w1", "w3"]);
    await seed("early", "old-b", { errorMessage: RETHROW }, ["w2", "w3"]);

    const report = await rekeyIncidents(db, store, { environment: ENV, apply: true });

    expect(report).toMatchObject({ scanned: 2, refingerprinted: 2, shared: 1, keysWritten: 1, tombstonesKept: 0 });
    for (const id of ["late", "early"]) {
      const d = (await incidents().doc(id).get()).data()!;
      // Only the fingerprint moved: not the message, the status, the counts or the times.
      expect(d).toMatchObject({ fingerprint: NEW_FP, status: "new", occurrenceCount: 3 });
      expect((d.updatedAt as Timestamp).toMillis()).toBe(Date.parse("2026-10-02T00:00:00Z"));
    }
    const key = (await keys().doc(incidentKeyId(ENV, NEW_FP)).get()).data()!;
    expect(key).toMatchObject({ incidentId: "early", environment: ENV, fingerprint: NEW_FP, appliedWindows: ["w1", "w3", "w2"] });
    // The old keys are left as they were: the store re-checks content, so a key whose incident moved is ignored.
    expect((await keys().doc(incidentKeyId(ENV, "old-a")).get()).get("incidentId")).toBe("late");
  });

  it("the next occurrence accrues onto the stored incident, and a replayed window counts once", async () => {
    await seed("a", "old-a", {}, ["w1"]);

    await rekeyIncidents(db, store, { environment: ENV, apply: true });
    const outcome = await upsertIncident(db, store, occurrence("2026-10-05T00:00:00Z", "w9"), Timestamp.now());
    const replay = await upsertIncident(db, store, occurrence("2026-10-02T00:00:00Z", "w1"), Timestamp.now());

    expect(outcome).toBe("updated");
    expect(replay).toBe("duplicate");
    const docs = (await incidents().get()).docs;
    expect(docs.map((d) => d.id)).toEqual(["a"]);
    expect(docs[0]!.get("occurrenceCount")).toBe(5);
  });

  it("a resolved incident that fires again after the re-key comes back as recurred, not new", async () => {
    await seed("r", "old-r", { status: "resolved", resolvedAt: at("2026-10-03T00:00:00Z") });

    await rekeyIncidents(db, store, { environment: ENV, apply: true });
    const outcome = await upsertIncident(db, store, occurrence("2026-10-05T00:00:00Z"), Timestamp.now());

    expect(outcome).toBe("recurred");
    expect((await incidents().get()).docs.map((d) => d.id)).toEqual(["r"]);
    expect((await incidents().doc("r").get()).get("status")).toBe("recurred");
  });

  it("keys the most recently resolved when none is open, and writes no key when every one is ignored", async () => {
    await seed("r1", "old-1", { status: "resolved", resolvedAt: at("2026-10-03T00:00:00Z") });
    await seed("r2", "old-2", { status: "resolved", resolvedAt: at("2026-10-04T00:00:00Z"), errorMessage: RETHROW });
    await rekeyIncidents(db, store, { environment: ENV, apply: true });
    expect((await keys().doc(incidentKeyId(ENV, NEW_FP)).get()).get("incidentId")).toBe("r2");

    store = { ...store, incidentCollection: `${store.incidentCollection}_ign`, incidentKeyCollection: `${store.incidentKeyCollection}_ign` };
    await seed("i", "old-i", { status: "ignored" });
    const report = await rekeyIncidents(db, store, { environment: ENV, apply: true });
    expect(report).toMatchObject({ refingerprinted: 1, keysWritten: 0 });
    expect((await keys().doc(incidentKeyId(ENV, NEW_FP)).get()).exists).toBe(false);
    expect((await incidents().doc("i").get()).get("fingerprint")).toBe(NEW_FP);
  });

  it("keeps a retired incident's tombstone, and leaves retired incidents and other environments alone", async () => {
    // Retired under the current fingerprint: its key is a tombstone.
    await seed("gone", NEW_FP, { status: "resolved", retired: true, retiredAt: at("2026-10-03T00:00:00Z"), errorMessage: CORE }, ["w0"]);
    await seed("live", "old-live");
    await seed("retired-old", "old-retired", { retired: true, retiredAt: at("2026-10-03T00:00:00Z") });
    await seed("elsewhere", "old-prod", { environment: "prod" });
    const tombstone = JSON.stringify((await keys().doc(incidentKeyId(ENV, NEW_FP)).get()).data());

    const report = await rekeyIncidents(db, store, { environment: ENV, apply: true });

    expect(report).toMatchObject({ scanned: 3, retired: 2, refingerprinted: 1, keysWritten: 0, tombstonesKept: 1 });
    expect(JSON.stringify((await keys().doc(incidentKeyId(ENV, NEW_FP)).get()).data())).toBe(tombstone);
    expect((await incidents().doc("live").get()).get("fingerprint")).toBe(NEW_FP);
    expect((await incidents().doc("retired-old").get()).get("fingerprint")).toBe("old-retired");
    expect((await incidents().doc("elsewhere").get()).get("fingerprint")).toBe("old-prod");
  });

  it("is idempotent: a second run finds nothing and writes nothing", async () => {
    await seed("a", "old-a", {}, ["w1"]);
    await seed("b", "old-b", { errorMessage: RETHROW });
    await rekeyIncidents(db, store, { environment: ENV, apply: true });
    const after = await everything();

    const again = await rekeyIncidents(db, store, { environment: ENV, apply: true });

    expect(again).toMatchObject({ scanned: 2, refingerprinted: 0, keysWritten: 0 });
    expect(await everything()).toBe(after);
  });

  it("pages through more records than one page", async () => {
    const total = 650;
    for (let from = 0; from < total; from += 200) {
      const batch = db.batch();
      for (let i = from; i < Math.min(from + 200, total); i++) {
        batch.set(incidents().doc(`inc-${String(i).padStart(4, "0")}`), {
          functionName: `f${i % 5}`,
          environment: ENV,
          status: "new",
          errorMessage: `boom ${i % 7 === 0 ? "a" : "b"}\n    at x (/workspace/lib/f.js:${i}:1)`,
          fingerprint: `old-${i}`,
          firstOccurredAt: Timestamp.fromMillis(1_000_000 + i),
        });
      }
      await batch.commit();
    }

    const report = await rekeyIncidents(db, store, { environment: ENV, apply: true });

    expect(report).toMatchObject({ scanned: total, refingerprinted: total, shared: 10, keysWritten: 10 });
    const key = (await keys().doc(incidentKeyId(ENV, computeErrorFingerprint("f0", "boom a"))).get()).data()!;
    expect(key.incidentId).toBe("inc-0000");
  });
});
