/**
 * retireIncident against the real Firestore emulator, together with the real store, since the point is
 * what the NEXT occurrence does. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { retireIncident, type RetireConfig } from "./retire.js";
import { upsertIncident, type IncidentInput, type IncidentStoreConfig } from "./store.js";
import { SEEDED_SECRETS } from "./testSecrets.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("retire.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "retire-emulator-tests");
const db: Firestore = getFirestore(app, "retire-tests");
afterAll(() => deleteApp(app));

let cfg: RetireConfig & IncidentStoreConfig;
beforeEach(async () => {
  const run = randomUUID().slice(0, 8);
  cfg = { incidentCollection: `incidents_${run}`, incidentKeyCollection: `keys_${run}`, usersCollection: `users_${run}`, auditCollection: `audit_${run}` };
  await db.collection(cfg.usersCollection).doc("admin1").set({ roles: ["admin"] });
  await db.collection(cfg.usersCollection).doc("op1").set({ roles: ["operator"] });
  await db.collection(cfg.usersCollection).doc("nobody").set({ roles: [] });
});

const t0 = new Date("2026-10-04T12:00:00.000Z");
const occurrence = (atMs = t0.getTime(), count = 1): IncidentInput => ({
  functionName: "orders-createOrder",
  service: null,
  environment: "demo",
  errorType: "DatabaseError",
  errorMessage: "undefined is not a Firestore value",
  occurrenceCount: count,
  firstOccurredAt: new Date(atMs),
  lastOccurredAt: new Date(atMs),
});
const upsert = (i: IncidentInput) => upsertIncident(db, cfg, i, Timestamp.now());
const incidents = async () => (await db.collection(cfg.incidentCollection).get()).docs;
const keys = async () => (await db.collection(cfg.incidentKeyCollection).get()).docs;
const audit = async () => (await db.collection(cfg.auditCollection).get()).docs.map((d) => d.data());
const resolve = (id: string, atMs: number) =>
  db.collection(cfg.incidentCollection).doc(id).update({ status: "resolved", resolvedAt: Timestamp.fromMillis(atMs), statusChangedBy: "op1" });
const retire = (id: string, uid = "admin1", reason = "demo reset") => retireIncident(db, cfg, id, uid, reason, new Date(t0.getTime() + 60_000));

describe("retireIncident", () => {
  it("closes the incident for good, keeping its history, and keeps its key as a tombstone (#197)", async () => {
    await upsert(occurrence(t0.getTime(), 5));
    const [doc] = await incidents();

    expect(await retire(doc!.id)).toEqual({ ok: true, alreadyRetired: false });

    const after = (await db.collection(cfg.incidentCollection).doc(doc!.id).get()).data()!;
    expect(after).toMatchObject({ status: "resolved", retired: true, retiredBy: "admin1", statusChangedBy: "admin1", occurrenceCount: 5 });
    expect(after.retiredAt.toMillis()).toBe(t0.getTime() + 60_000);
    expect(after.resolvedAt.toMillis()).toBe(t0.getTime() + 60_000);
    expect((await keys()).map((k) => k.get("incidentId"))).toEqual([doc!.id]);
  });

  it("counts a window replayed after the retire once: no second incident (#197)", async () => {
    // A run commits a window, the incident is retired, and the run's retry replays that same window.
    expect(await upsert({ ...occurrence(t0.getTime(), 5), windowId: "w1" })).toBe("new");
    const [doc] = await incidents();
    await retire(doc!.id);

    expect(await upsert({ ...occurrence(t0.getTime(), 5), windowId: "w1" })).toBe("duplicate");

    const docs = await incidents();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.get("occurrenceCount")).toBe(5);
  });

  it("counts occurrences from before the retire on the retired incident, without reopening it (#197)", async () => {
    await upsert({ ...occurrence(t0.getTime(), 2), windowId: "w1" });
    const [doc] = await incidents();
    await retire(doc!.id); // at t0 + 60 s

    // Ingest reads behind the clock: the next window still holds an occurrence from before the retire.
    expect(await upsert({ ...occurrence(t0.getTime() + 30_000, 3), windowId: "w2" })).toBe("updated");

    const docs = await incidents();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.data()).toMatchObject({ status: "resolved", retired: true, occurrenceCount: 5 });
    expect(docs[0]!.data().recurrenceCount).toBeUndefined();
    // Its window is recorded too, so replaying it changes nothing.
    expect(await upsert({ ...occurrence(t0.getTime() + 30_000, 3), windowId: "w2" })).toBe("duplicate");
    // An occurrence after the retire still opens a new incident.
    expect(await upsert({ ...occurrence(t0.getTime() + 90_000), windowId: "w3" })).toBe("new");
    expect(await incidents()).toHaveLength(2);
  });

  it("makes the same error open a NEW incident instead of reopening this one as a regression", async () => {
    await upsert(occurrence());
    const [first] = await incidents();
    await retire(first!.id);

    const outcome = await upsert(occurrence(t0.getTime() + 3_600_000, 2));

    expect(outcome).toBe("new");
    const docs = await incidents();
    expect(docs).toHaveLength(2);
    const old = docs.find((d) => d.id === first!.id)!.data();
    const fresh = docs.find((d) => d.id !== first!.id)!.data();
    expect(old).toMatchObject({ status: "resolved", retired: true, occurrenceCount: 1 });
    expect(old.recurrenceCount).toBeUndefined();
    expect(fresh).toMatchObject({ status: "new", occurrenceCount: 2 });
    expect(fresh.retired).toBeUndefined();
    // The key now points at the new incident, and a further occurrence accrues onto it.
    expect((await keys())[0]?.get("incidentId")).toBe(docs.find((d) => d.id !== first!.id)!.id);
    expect(await upsert(occurrence(t0.getTime() + 7_200_000))).toBe("updated");
  });

  it("still opens a new incident if an operator reopens a retired, ignored one", async () => {
    await upsert(occurrence());
    const [doc] = await incidents();
    await db.collection(cfg.incidentCollection).doc(doc!.id).update({ status: "ignored" });
    await retire(doc!.id);
    // The operator action firestore.rules allows from ignored.
    await db.collection(cfg.incidentCollection).doc(doc!.id).update({ status: "new" });

    expect(await upsert(occurrence(t0.getTime() + 3_600_000))).toBe("new");
    expect(await incidents()).toHaveLength(2);
    expect((await db.collection(cfg.incidentCollection).doc(doc!.id).get()).data()!.occurrenceCount).toBe(1);
  });

  it("leaves a normally resolved incident to come back as recurred, as before", async () => {
    await upsert(occurrence());
    const [doc] = await incidents();
    await resolve(doc!.id, t0.getTime() + 1000);
    expect(await upsert(occurrence(t0.getTime() + 3_600_000))).toBe("recurred");
    expect(await incidents()).toHaveLength(1);
  });

  it("closes an incident that is still open, resolved or ignored alike", async () => {
    for (const status of ["new", "acknowledged", "ignored", "resolved"]) {
      const o = { ...occurrence(), functionName: `fn-${status}` };
      await upsert(o);
      const doc = (await incidents()).find((d) => d.get("functionName") === `fn-${status}`)!;
      if (status !== "new") await db.collection(cfg.incidentCollection).doc(doc.id).update({ status, ...(status === "resolved" && { resolvedAt: Timestamp.now() }) });
      expect(await retire(doc.id)).toEqual({ ok: true, alreadyRetired: false });
      const after = (await db.collection(cfg.incidentCollection).doc(doc.id).get()).data()!;
      expect(after.retired).toBe(true);
      // Open becomes resolved; resolved and ignored keep what they were.
      expect(after.status).toBe(status === "new" || status === "acknowledged" ? "resolved" : status);
    }
  });

  it("is idempotent: retiring twice changes and records nothing the second time", async () => {
    await upsert(occurrence());
    const [doc] = await incidents();
    await retire(doc!.id);
    expect(await retire(doc!.id)).toEqual({ ok: true, alreadyRetired: true });
    expect(await audit()).toHaveLength(1);
  });

  it("does not touch a key that has already moved on to a newer incident", async () => {
    await upsert(occurrence());
    const [first] = await incidents();
    await retire(first!.id);
    await upsert(occurrence(t0.getTime() + 3_600_000));
    const newKey = (await keys())[0]!.get("incidentId");

    // A second admin retires the OLD one again (it is already retired): the new key stays.
    await retire(first!.id);
    expect((await keys())[0]?.get("incidentId")).toBe(newKey);
  });
});

describe("retireIncident: who may, and what is recorded", () => {
  it.each([
    ["an operator", "op1"],
    ["a user with no roles", "nobody"],
    ["someone with no operator record", "stranger"],
  ])("refuses %s, and changes nothing", async (_name, uid) => {
    await upsert(occurrence());
    const [doc] = await incidents();
    expect(await retire(doc!.id, uid)).toEqual({ ok: false, reason: "not-admin" });
    expect((await db.collection(cfg.incidentCollection).doc(doc!.id).get()).data()!.retired).toBeUndefined();
    expect(await keys()).toHaveLength(1);
    expect(await audit()).toHaveLength(0);
  });

  it.each([["an id with a slash", "a/b"], ["an empty id", ""]])("refuses %s", async (_name, id) => {
    expect(await retire(id)).toEqual({ ok: false, reason: "invalid-id" });
    expect(await retire("inc1", "a/b")).toEqual({ ok: false, reason: "invalid-id" });
  });

  it("says so for an incident that does not exist", async () => {
    expect(await retire("missing")).toEqual({ ok: false, reason: "no-such-incident" });
    expect(await audit()).toHaveLength(0);
  });

  it("records who did it, to what, when and why, with the before and after", async () => {
    await upsert(occurrence());
    const [doc] = await incidents();
    await retire(doc!.id, "admin1", `reset ${SEEDED_SECRETS.github} ` + "x".repeat(500));
    const [entry] = await audit();
    expect(entry).toMatchObject({
      action: "retire-incident",
      incidentId: doc!.id,
      environment: "demo",
      actorUid: "admin1",
      before: { status: "new" },
      after: { status: "resolved", retired: true },
    });
    expect(entry!.at.toMillis()).toBe(t0.getTime() + 60_000);
    expect(JSON.stringify(entry)).not.toContain(SEEDED_SECRETS.github);
    expect(entry!.reason.length).toBeLessThanOrEqual(200);
  });

  it("stores a reason with an emoji at the cut or a lone surrogate, rather than failing the write (#126)", async () => {
    await upsert(occurrence());
    const [doc] = await incidents();
    // "😀" straddles unit 199/200, and "\ud83d" alone is what a JSON body can carry.
    const result = await retire(doc!.id, "admin1", "\ud83d " + "x".repeat(197) + "😀");
    expect(result).toMatchObject({ ok: true });
    const [entry] = await audit();
    expect(entry!.reason).toBe("� " + "x".repeat(197));
  });
});

describe("retireIncident racing the engine", () => {
  it("never loses or splits occurrences: every one lands on the old or the new incident", async () => {
    await upsert(occurrence());
    const [doc] = await incidents();
    const total = 1 + 8;

    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => upsert(occurrence(t0.getTime() + 1000 + i, 1))),
      retire(doc!.id),
    ]);

    const docs = await incidents();
    expect(docs.reduce((n, d) => n + Number(d.get("occurrenceCount")), 0)).toBe(total);
    // At most one live incident, and the old one stays retired.
    expect(docs.filter((d) => d.get("retired") !== true)).toHaveLength(docs.length === 1 ? 0 : 1);
    expect(docs.find((d) => d.id === doc!.id)!.get("retired")).toBe(true);
    expect((await audit())).toHaveLength(1);
  });
});
