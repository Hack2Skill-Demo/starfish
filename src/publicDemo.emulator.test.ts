/**
 * The public demo's open actions (src/publicDemo.ts) and their hourly limits (src/publicDemoLimit.ts) against the real
 * Firestore emulator: what a visitor's action writes, that it is audited without the address, that it does nothing with
 * the switch off or off its environment, and that the counters hold across concurrent claims. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "./config.js";
import { testConfig } from "./testConfig.js";
import {
  PUBLIC_ACCESS_DOC,
  correctTriageAsGuest,
  requestRetriageAsGuest,
  setIncidentStatusAsGuest,
  syncPublicAccess,
  triggerAgentPassAsGuest,
} from "./publicDemo.js";
import { SALT_DOC, claimPublicAction, resetSaltCache } from "./publicDemoLimit.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("publicDemo.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "public-demo-emulator-tests");
const db: Firestore = getFirestore(app, "public-demo-tests");
afterAll(() => deleteApp(app));

const now = new Date("2026-10-15T09:20:00.000Z");
const GUEST = "anonGuest1";
const ADDRESS = "203.0.113.7";

let config: StarfishConfig;
beforeEach(async () => {
  const run = randomUUID().slice(0, 8);
  resetSaltCache();
  config = testConfig({
    projectId: "demo-starfish-rules",
    databaseId: "public-demo-tests",
    environment: "demo",
    publicEnvironments: ["demo"],
    publicDemoActions: true,
    incidentCollection: `incidents_${run}`,
    auditCollection: `audit_${run}`,
    runCollection: `runs_${run}`,
    publicActionCollection: `public_actions_${run}`,
    publicIncidentCollection: `public_incidents_${run}`,
  });
  const col = db.collection(config.incidentCollection);
  await col.doc("demo-1").set({ environment: "demo", status: "new", functionName: "f", errorMessage: "boom", firstOccurredAt: Timestamp.fromDate(now), lastOccurredAt: Timestamp.fromDate(now) });
  await col.doc("prod-1").set({ environment: "prod", status: "new", functionName: "f" });
  await col.doc("retired-1").set({ environment: "demo", status: "resolved", retired: true });
  await col.doc("ignored-1").set({ environment: "demo", status: "ignored" });
});

const incident = async (id: string) => (await db.collection(config.incidentCollection).doc(id).get()).data() ?? {};
const audit = async () => (await db.collection(config.auditCollection).get()).docs.map((d) => d.data());

describe("a visitor's incident actions", () => {
  it("changes status with the fields firestore.rules requires of an operator, audited without the address", async () => {
    expect(await setIncidentStatusAsGuest(db, config, "demo-1", "resolve", GUEST, now)).toEqual({ ok: true });
    const d = await incident("demo-1");
    expect(d).toMatchObject({ status: "resolved", statusChangedBy: GUEST });
    expect(d.updatedAt.toMillis()).toBe(now.getTime());
    expect(d.resolvedAt.toMillis()).toBe(now.getTime());
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: "public-incident-status", actorUid: GUEST, actorKind: "anonymous", incidentId: "demo-1", environment: "demo", before: { status: "new" }, after: { status: "resolved" } });
    expect(JSON.stringify(entry)).not.toContain(ADDRESS);

    // Reopen only an ignored one; `resolvedAt` goes when the incident is no longer resolved.
    expect(await setIncidentStatusAsGuest(db, config, "demo-1", "reopen", GUEST, now)).toEqual({ ok: false, reason: "not-applicable" });
    expect(await setIncidentStatusAsGuest(db, config, "ignored-1", "reopen", GUEST, now)).toEqual({ ok: true });
    expect(await incident("ignored-1")).toMatchObject({ status: "new" });
    expect("resolvedAt" in (await incident("ignored-1"))).toBe(false);
  });

  it("refuses another environment's incident, a retired one and a missing one alike, writing and auditing nothing", async () => {
    for (const id of ["prod-1", "retired-1", "no-such"]) {
      expect(await setIncidentStatusAsGuest(db, config, id, "acknowledge", GUEST, now)).toEqual({ ok: false, reason: "no-such-incident" });
      expect(await requestRetriageAsGuest(db, config, id, GUEST, now)).toEqual({ ok: false, reason: "no-such-incident" });
      expect(await correctTriageAsGuest(db, config, id, "log", "", GUEST, now)).toEqual({ ok: false, reason: "no-such-incident" });
    }
    expect(await incident("prod-1")).toEqual({ environment: "prod", status: "new", functionName: "f" });
    expect(await audit()).toEqual([]);
  });

  it("does nothing with the switch off, or on an environment that is not public", async () => {
    for (const cfg of [{ ...config, publicDemoActions: false }, { ...config, publicEnvironments: ["other"] }]) {
      expect(await setIncidentStatusAsGuest(db, cfg, "demo-1", "acknowledge", GUEST, now)).toEqual({ ok: false, reason: "off" });
      expect(await requestRetriageAsGuest(db, cfg, "demo-1", GUEST, now)).toEqual({ ok: false, reason: "off" });
      expect(await correctTriageAsGuest(db, cfg, "demo-1", "log", "", GUEST, now)).toEqual({ ok: false, reason: "off" });
      let started = false;
      expect(await triggerAgentPassAsGuest(db, cfg, async () => void (started = true), GUEST, now)).toEqual({ ok: false, reason: "off" });
      expect(started).toBe(false);
    }
    expect(await incident("demo-1")).toMatchObject({ status: "new" });
    expect(await audit()).toEqual([]);
  });

  it("requests a retry on an open incident only: the time and who asked", async () => {
    expect(await requestRetriageAsGuest(db, config, "demo-1", GUEST, now)).toEqual({ ok: true });
    const d = await incident("demo-1");
    expect(d.retriageRequestedBy).toBe(GUEST);
    expect(d.retriageRequestedAt.toMillis()).toBe(now.getTime());
    expect(await requestRetriageAsGuest(db, config, "ignored-1", GUEST, now)).toEqual({ ok: false, reason: "not-applicable" });
    expect((await audit()).map((e) => e.action)).toEqual(["public-retriage"]);
  });

  it("writes a correction and its history entry together, the note redacted, one line, bounded", async () => {
    expect(await correctTriageAsGuest(db, config, "demo-1", "fix", "  mail me at a@b.example  ", GUEST, now)).toEqual({ ok: true });
    const d = await incident("demo-1");
    expect(d).toMatchObject({ correctedLevel: "fix", correctedBy: GUEST });
    expect(d.correctionNote).not.toContain("a@b.example");
    const entry = (await db.collection(config.incidentCollection).doc("demo-1").collection("corrections").doc(d.correctionId as string).get()).data();
    expect(entry).toMatchObject({ level: "fix", by: GUEST, note: d.correctionNote });
    expect(entry!.at.toMillis()).toBe(now.getTime());

    // No note: none on either; a bad level or note: refused before anything is read.
    expect(await correctTriageAsGuest(db, config, "demo-1", "noise", "", GUEST, now)).toEqual({ ok: true });
    expect("correctionNote" in (await incident("demo-1"))).toBe(false);
    expect(await correctTriageAsGuest(db, config, "demo-1", "everything", "", GUEST, now)).toEqual({ ok: false, reason: "bad-request" });
    expect(await correctTriageAsGuest(db, config, "demo-1", "log", "x".repeat(301), GUEST, now)).toEqual({ ok: false, reason: "bad-request" });
    expect(await correctTriageAsGuest(db, config, "demo-1", "log", "two\nlines", GUEST, now)).toEqual({ ok: false, reason: "bad-request" });
    expect((await db.collection(config.incidentCollection).doc("demo-1").collection("corrections").get()).size).toBe(2);
  });

  it("lets a visitor tighten a correction but never loosen one, so an operator's hold cannot be lifted anonymously", async () => {
    await db.collection(config.incidentCollection).doc("demo-1").update({ correctedLevel: "log", correctedBy: "operator-uid" });
    expect(await correctTriageAsGuest(db, config, "demo-1", "fix", "", GUEST, now)).toEqual({ ok: false, reason: "not-applicable" });
    expect(await correctTriageAsGuest(db, config, "demo-1", "merge", "", GUEST, now)).toEqual({ ok: false, reason: "not-applicable" });
    expect(await incident("demo-1")).toMatchObject({ correctedLevel: "log", correctedBy: "operator-uid" });
    expect(await correctTriageAsGuest(db, config, "demo-1", "log", "", GUEST, now)).toEqual({ ok: true });
    expect(await correctTriageAsGuest(db, config, "demo-1", "noise", "", GUEST, now)).toEqual({ ok: true });
    expect(await correctTriageAsGuest(db, config, "demo-1", "log", "", GUEST, now)).toEqual({ ok: false, reason: "not-applicable" });
  });

  it("refreshes the guests' trimmed copy after a change", async () => {
    await setIncidentStatusAsGuest(db, config, "demo-1", "acknowledge", GUEST, now);
    expect((await db.collection(config.publicIncidentCollection).doc("demo-1").get()).get("status")).toBe("acknowledged");
  });
});

describe("the gate document firestore.rules reads", () => {
  const gate = async () => (await db.collection(config.runCollection).doc(PUBLIC_ACCESS_DOC).get()).data();

  it("is written on with the switch, turned off without it, and never created by a deployment that never had it", async () => {
    const off = { ...config, publicDemoActions: false };
    expect(await syncPublicAccess(db, off, now)).toBe("unchanged");
    expect(await gate()).toBeUndefined();
    expect(await syncPublicAccess(db, config, now)).toBe("enabled");
    expect(await gate()).toMatchObject({ enabled: true, environment: "demo" });
    expect(await syncPublicAccess(db, config, now)).toBe("unchanged");
    expect(await syncPublicAccess(db, off, now)).toBe("disabled");
    expect(await gate()).toMatchObject({ enabled: false });
    // On a private environment the switch is not honoured: the gate is turned off too.
    await syncPublicAccess(db, config, now);
    expect(await syncPublicAccess(db, { ...config, environment: "prod" }, now)).toBe("disabled");
  });
});

describe("the hourly limits", () => {
  it("allows the per-address actions, then refuses with the seconds left in the hour", async () => {
    const cfg = { ...config, publicActionsPerIpPerHour: 2 };
    expect(await claimPublicAction(db, cfg, "action", ADDRESS, now)).toEqual({ ok: true });
    expect(await claimPublicAction(db, cfg, "action", ADDRESS, now)).toEqual({ ok: true });
    expect(await claimPublicAction(db, cfg, "action", ADDRESS, now)).toEqual({ ok: false, limit: "address", retryAfterSeconds: 40 * 60 });
    // Another address, or the next hour, starts again.
    expect(await claimPublicAction(db, cfg, "action", "198.51.100.1", now)).toEqual({ ok: true });
    expect(await claimPublicAction(db, cfg, "action", ADDRESS, new Date("2026-10-15T10:00:00.000Z"))).toEqual({ ok: true });
  });

  it("counts ingest and agent starts together per address, apart from actions", async () => {
    const cfg = { ...config, publicRunsPerIpPerHour: 2 };
    expect(await claimPublicAction(db, cfg, "ingest", ADDRESS, now)).toEqual({ ok: true });
    expect(await claimPublicAction(db, cfg, "agent", ADDRESS, now)).toEqual({ ok: true });
    expect(await claimPublicAction(db, cfg, "ingest", ADDRESS, now)).toMatchObject({ ok: false, limit: "address" });
    expect(await claimPublicAction(db, cfg, "action", ADDRESS, now)).toEqual({ ok: true });
  });

  it("caps agent passes for the whole deployment, whatever the address", async () => {
    const cfg = { ...config, publicAgentRunsPerHour: 3 };
    for (let i = 0; i < 3; i++) expect(await claimPublicAction(db, cfg, "agent", `192.0.2.${i}`, now)).toEqual({ ok: true });
    expect(await claimPublicAction(db, cfg, "agent", "192.0.2.99", now)).toMatchObject({ ok: false, limit: "deployment" });
    // The cap is on agent passes only: an ingest start from a fresh address still runs.
    expect(await claimPublicAction(db, cfg, "ingest", "192.0.2.99", now)).toEqual({ ok: true });
  });

  it("holds under concurrent claims: never more than the limit, across what would be separate instances", async () => {
    const cfg = { ...config, publicAgentRunsPerHour: 4 };
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claimPublicAction(db, cfg, "agent", `192.0.2.${i}`, now)));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
  });

  it("never stores the address: counters are keyed by a salted hash, and the salt stays put", async () => {
    await claimPublicAction(db, config, "action", ADDRESS, now);
    const docs = (await db.collection(config.publicActionCollection).get()).docs;
    expect(docs.map((d) => d.id).some((id) => id.includes(ADDRESS))).toBe(false);
    expect(JSON.stringify(docs.map((d) => d.data()))).not.toContain(ADDRESS);
    const salt = (await db.collection(config.publicActionCollection).doc(SALT_DOC).get()).get("value");
    resetSaltCache();
    await claimPublicAction(db, config, "action", ADDRESS, now);
    expect((await db.collection(config.publicActionCollection).doc(SALT_DOC).get()).get("value")).toBe(salt);
    const counter = docs.find((d) => d.id.startsWith("ip-actions."));
    expect((await counter!.ref.get()).get("count")).toBe(2);
  });

  it("fails closed on a counter that is not a number", async () => {
    await claimPublicAction(db, config, "agent", ADDRESS, now);
    const deployment = db.collection(config.publicActionCollection).doc("agent-runs.2026-10-15T09");
    await deployment.set({ count: "lots" });
    expect(await claimPublicAction(db, config, "agent", "198.51.100.2", now)).toMatchObject({ ok: false, limit: "deployment" });
  });
});
