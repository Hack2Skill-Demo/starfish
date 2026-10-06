/**
 * scrubCollection against the real Firestore emulator: paging, batching, the stale-key
 * cleanup, and the property that matters, that the next real occurrence of a scrubbed
 * incident lands ON it rather than forking a duplicate. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { computeErrorFingerprint } from "./ingest/fingerprint.js";
import { incidentKeyId, upsertIncident, type IncidentInput } from "./ingest/store.js";
import { SEEDED_SECRETS } from "./ingest/testSecrets.js";
import { scrubCollection } from "./scrub.js";

// Never let this suite reach a real project with ambient credentials.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("scrub.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "scrub-emulator-tests");
const db: Firestore = getFirestore(app, "scrub-tests");
afterAll(() => deleteApp(app));

let store: { incidentCollection: string; incidentKeyCollection: string };
beforeEach(() => {
  const run = randomUUID().slice(0, 8);
  store = { incidentCollection: `incidents_${run}`, incidentKeyCollection: `keys_${run}` };
});

const MESSAGE = `auth failed for bob@y.org ${SEEDED_SECRETS.google}`;
const now = Timestamp.fromMillis(Date.now() - 3600_000);

/** A record as it was stored before the redaction policy: raw text, fingerprint of the raw text. */
async function seedLegacy(id: string, overrides: Record<string, unknown> = {}, keyed = true) {
  const fingerprint = computeErrorFingerprint("mailDrainer", MESSAGE);
  await db.collection(store.incidentCollection).doc(id).set({
    functionName: "mailDrainer",
    service: "platform",
    environment: "prod",
    errorType: "UnknownError",
    errorMessage: MESSAGE,
    errorDetail: `password=hunter2 ${SEEDED_SECRETS.bearerHeader}`,
    stackTrace: `at call ${SEEDED_SECRETS.awsId}`,
    occurrenceCount: 3,
    occurrencesByHour: {},
    firstOccurredAt: now,
    lastOccurredAt: now,
    status: "new",
    fingerprint,
    triageState: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  if (keyed) {
    await db.collection(store.incidentKeyCollection).doc(incidentKeyId("prod", fingerprint)).set({
      incidentId: id, environment: "prod", fingerprint, updatedAt: now,
    });
  }
}

const everything = async () => {
  const docs = [
    ...(await db.collection(store.incidentCollection).get()).docs,
    ...(await db.collection(store.incidentKeyCollection).get()).docs,
  ];
  return JSON.stringify(docs.map((d) => d.data()));
};
const liveSecrets = ["bob@y.org", "hunter2", ...Object.values(SEEDED_SECRETS)];
/** The ones seedLegacy actually writes (message, detail, stack). */
const seededSecrets = ["bob@y.org", "hunter2", SEEDED_SECRETS.google!, SEEDED_SECRETS.bearerHeader!, SEEDED_SECRETS.awsId!];

describe("scrubCollection on the emulator", () => {
  it("a dry run counts what it would change and writes nothing", async () => {
    await seedLegacy("legacy-1");
    const before = await everything();

    const report = await scrubCollection(db, store, { apply: false });

    expect(report).toMatchObject({ scanned: 1, changed: 1, refingerprinted: 1, keysRemoved: 0, applied: false });
    expect(report.byField).toEqual({
      errorMessage: 1, errorDetail: 1, stackTrace: 1, errorName: 0, service: 0, errorCode: 0, tenantId: 0, requestId: 0,
    });
    expect(await everything()).toBe(before);
  });

  it("applying removes every seeded secret from the incidents and their keys", async () => {
    await seedLegacy("legacy-1");
    // Precondition: the seeded store really does hold the secrets before the scrub.
    const seeded = await everything();
    for (const needle of seededSecrets) expect(seeded).toContain(needle);

    const report = await scrubCollection(db, store, { apply: true });

    expect(report).toMatchObject({ scanned: 1, changed: 1, refingerprinted: 1, keysRemoved: 1, applied: true });
    const stored = await everything();
    for (const needle of liveSecrets) expect(stored).not.toContain(needle);
    const doc = (await db.collection(store.incidentCollection).doc("legacy-1").get()).data()!;
    expect(doc.fingerprint).toBe(computeErrorFingerprint("mailDrainer", doc.errorMessage as string));
    // Everything that isn't redacted text is untouched, including the timestamps.
    expect(doc).toMatchObject({ occurrenceCount: 3, status: "new", triageState: "pending" });
    expect((doc.updatedAt as Timestamp).toMillis()).toBe(now.toMillis());
  });

  it("is idempotent: a second run changes nothing", async () => {
    await seedLegacy("legacy-1");
    await scrubCollection(db, store, { apply: true });
    const after = await everything();

    const again = await scrubCollection(db, store, { apply: true });

    expect(again).toMatchObject({ scanned: 1, changed: 0, refingerprinted: 0, keysRemoved: 0 });
    expect(await everything()).toBe(after);
  });

  it("the next real occurrence lands on the scrubbed incident instead of forking a duplicate", async () => {
    await seedLegacy("legacy-1");
    await scrubCollection(db, store, { apply: true });

    // The same error fires again; its log still carries the secret, which the store redacts.
    const input: IncidentInput = {
      functionName: "mailDrainer", service: null, environment: "prod", errorType: "UnknownError",
      errorMessage: MESSAGE, occurrenceCount: 2, firstOccurredAt: new Date(), lastOccurredAt: new Date(),
    };
    const outcome = await upsertIncident(db, store, input, Timestamp.now());

    expect(outcome).toBe("updated");
    const docs = (await db.collection(store.incidentCollection).get()).docs;
    expect(docs.map((d) => d.id)).toEqual(["legacy-1"]);
    expect(docs[0]!.get("occurrenceCount")).toBe(5);
    const keys = (await db.collection(store.incidentKeyCollection).get()).docs;
    expect(keys).toHaveLength(1);
    expect(keys[0]!.get("incidentId")).toBe("legacy-1");
    for (const needle of liveSecrets) expect(await everything()).not.toContain(needle);
  });

  it("leaves clean records alone, and keeps a stale key that now belongs to another incident", async () => {
    await seedLegacy("legacy-1", {}, false);
    await seedLegacy("clean-1", { errorMessage: "other failure", errorDetail: "421 busy", stackTrace: "at x", fingerprint: "fp-clean" }, false);
    const oldFp = computeErrorFingerprint("mailDrainer", MESSAGE);
    // The old key was re-pointed at a different incident since: it is not this record's to delete.
    await db.collection(store.incidentKeyCollection).doc(incidentKeyId("prod", oldFp)).set({
      incidentId: "someone-else", environment: "prod", fingerprint: oldFp, updatedAt: now,
    });
    const cleanBefore = JSON.stringify((await db.collection(store.incidentCollection).doc("clean-1").get()).data());

    const report = await scrubCollection(db, store, { apply: true });

    expect(report).toMatchObject({ scanned: 2, changed: 1, keysRemoved: 0 });
    expect(JSON.stringify((await db.collection(store.incidentCollection).doc("clean-1").get()).data())).toBe(cleanBefore);
    const key = await db.collection(store.incidentKeyCollection).doc(incidentKeyId("prod", oldFp)).get();
    expect(key.get("incidentId")).toBe("someone-else");
  });

  it("pages through a collection larger than one page, and batches its writes", async () => {
    const total = 450;
    for (let from = 0; from < total; from += 200) {
      const batch = db.batch();
      for (let i = from; i < Math.min(from + 200, total); i++) {
        const dirty = i % 3 === 0;
        batch.set(db.collection(store.incidentCollection).doc(`inc-${String(i).padStart(4, "0")}`), {
          functionName: "f", environment: "prod", fingerprint: `fp-${i}`,
          errorMessage: dirty ? `bad ${SEEDED_SECRETS.stripe} ${i}` : `fine ${i}`,
        });
      }
      await batch.commit();
    }

    const dry = await scrubCollection(db, store, { apply: false });
    const applied = await scrubCollection(db, store, { apply: true });

    expect(dry).toMatchObject({ scanned: total, changed: 150 });
    expect(applied).toMatchObject({ scanned: total, changed: 150, refingerprinted: 150 });
    expect(await everything()).not.toContain(SEEDED_SECRETS.stripe);
    expect(await scrubCollection(db, store, { apply: true })).toMatchObject({ scanned: total, changed: 0 });
  });
});
