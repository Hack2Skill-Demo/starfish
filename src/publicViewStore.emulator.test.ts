/**
 * The guests' trimmed copies (#18) against the real Firestore emulator: the engine writes each copy alongside the
 * record it copies (an event in the same transaction, an incident or cycle refreshed from what was committed, a retired
 * incident's copy deleted in the retire's own transaction), the sweep picks up a change the engine did not make, and the
 * backfill copies what was stored before and removes what must not be copied. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { upsertIncident, type IncidentInput } from "./ingest/store.js";
import { retireIncident } from "./ingest/retire.js";
import { acquireLease, appendEventsInTransaction, finishCycle, recordEvent, type CycleKey } from "./agent/cycle.js";
import { linkIncident } from "./agent/incidentLinks.js";
import { publicEventId, toPublicCycle, toPublicIncident } from "./publicView.js";
import { backfillPublicView, refreshPublicCycle, refreshPublicIncident, sameDocument, syncRecentPublicView } from "./publicViewStore.js";
import { SEEDED_SECRETS } from "./ingest/testSecrets.js";
import { testConfig } from "./testConfig.js";
import type { StarfishConfig } from "./config.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("publicViewStore.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "public-view-emulator-tests");
const db: Firestore = getFirestore(app, "public-view-tests");
afterAll(() => deleteApp(app));

let cfg: StarfishConfig;
beforeEach(async () => {
  const run = randomUUID().slice(0, 8);
  cfg = testConfig({
    environment: "demo",
    incidentCollection: `incidents_${run}`,
    incidentKeyCollection: `keys_${run}`,
    cycleCollection: `cycles_${run}`,
    usersCollection: `users_${run}`,
    auditCollection: `audit_${run}`,
    publicEnvironments: ["demo"],
    publicIncidentCollection: `pub_incidents_${run}`,
    publicCycleCollection: `pub_cycles_${run}`,
    publicEventCollection: `pub_events_${run}`,
  });
  await db.collection(cfg.usersCollection).doc("admin1").set({ roles: ["admin"] });
});

const NOW = new Date("2026-10-08T12:00:00Z");
const occurrence = (over: Partial<IncidentInput> = {}): IncidentInput => ({
  functionName: "ordersCreate",
  service: "orders",
  environment: "demo",
  errorType: "TypeError",
  errorMessage: "Cannot read properties of undefined (reading 'id')",
  occurrenceCount: 2,
  firstOccurredAt: new Date(NOW.getTime() - 60_000),
  lastOccurredAt: NOW,
  ...over,
});
const incidents = async () => (await db.collection(cfg.incidentCollection).get()).docs;
const copyOf = async (collection: string, id: string) => (await db.collection(collection).doc(id).get()).data();
const all = async (collection: string) => (await db.collection(collection).get()).docs;

describe("incidents", () => {
  it("an upsert in a public environment writes the copy from what it stored; a private one writes none", async () => {
    expect(await upsertIncident(db, cfg, occurrence(), Timestamp.fromDate(NOW))).toBe("new");
    const [stored] = await incidents();
    const copy = await copyOf(cfg.publicIncidentCollection, stored!.id);
    expect(sameDocument(copy, toPublicIncident(stored!.data(), cfg))).toBe(true);
    expect(copy).toMatchObject({ publicView: 1, environment: "demo", status: "new", occurrenceCount: 2 });

    // The next occurrence accrues through increments: the copy follows the committed count, not a guess.
    expect(await upsertIncident(db, cfg, occurrence({ occurrenceCount: 3 }), Timestamp.fromDate(NOW))).toBe("updated");
    expect((await copyOf(cfg.publicIncidentCollection, stored!.id))?.occurrenceCount).toBe(5);

    await upsertIncident(db, cfg, occurrence({ environment: "prod", errorMessage: "a prod error" }), Timestamp.fromDate(NOW));
    expect(await incidents()).toHaveLength(2);
    expect(await all(cfg.publicIncidentCollection)).toHaveLength(1);
  });

  it("writes no copy at all while the copies are off", async () => {
    const off = { ...cfg, publicEnvironments: [] };
    await upsertIncident(db, off, occurrence(), Timestamp.fromDate(NOW));
    expect(await incidents()).toHaveLength(1);
    expect(await all(cfg.publicIncidentCollection)).toHaveLength(0);
  });

  it("seeded secrets in the message, detail and stack reach neither the stored record nor its copy; detail and stack never reach the copy", async () => {
    const secrets = Object.values(SEEDED_SECRETS).join(" ");
    await upsertIncident(
      db,
      cfg,
      occurrence({ errorMessage: `boom ${secrets}`, errorDetail: `Jane Roe at 12 Elm Street ${secrets}`, stackTrace: `at f (Jane Roe) ${secrets}`, tenantId: "jane.roe@example.com" }),
      Timestamp.fromDate(NOW)
    );
    const [stored] = await incidents();
    const copy = JSON.stringify(await copyOf(cfg.publicIncidentCollection, stored!.id));
    for (const s of Object.values(SEEDED_SECRETS)) expect(copy).not.toContain(s.split(/\s+/).sort((a, b) => b.length - a.length)[0]!);
    expect(copy).not.toContain("Jane Roe");
    expect(copy).not.toContain("Elm Street");
    expect(copy).not.toContain("jane.roe");
  });

  it("retiring an incident removes its copy in the same transaction", async () => {
    await upsertIncident(db, cfg, occurrence(), Timestamp.fromDate(NOW));
    const [stored] = await incidents();
    expect(await copyOf(cfg.publicIncidentCollection, stored!.id)).toBeDefined();
    expect(await retireIncident(db, cfg, stored!.id, "admin1", "demo reset", NOW)).toEqual({ ok: true, alreadyRetired: false });
    expect(await copyOf(cfg.publicIncidentCollection, stored!.id)).toBeUndefined();
  });

  it("a link the agent copies onto the incident reaches its copy", async () => {
    await upsertIncident(db, cfg, occurrence(), Timestamp.fromDate(NOW));
    const [stored] = await incidents();
    expect(await linkIncident(db, cfg, { incidentId: stored!.id, environment: "demo", recurrence: 0 }, { kind: "issue", number: 9, url: "https://github.com/o/r/issues/9" })).toBe(true);
    expect(await copyOf(cfg.publicIncidentCollection, stored!.id)).toMatchObject({ githubIssueNumber: 9, githubIssueUrl: "https://github.com/o/r/issues/9" });
  });

  it("a refresh removes the copy of an incident that is gone, and says so; it never touches a private one", async () => {
    await upsertIncident(db, cfg, occurrence(), Timestamp.fromDate(NOW));
    const [stored] = await incidents();
    await stored!.ref.delete();
    expect(await refreshPublicIncident(db, cfg, stored!.id)).toBe("deleted");
    expect(await refreshPublicIncident(db, cfg, stored!.id)).toBe("unchanged");
    expect(await refreshPublicIncident(db, cfg, "x", "prod")).toBe("not-public");
    expect(await refreshPublicIncident(db, { ...cfg, publicEnvironments: [] }, "x")).toBe("off");
  });
});

describe("cycles and their events", () => {
  const key = (incidentId = "inc1"): CycleKey => ({ incidentId, environment: "demo", recurrence: 0 });

  it("each event's copy is written with the event; the cycle's copy follows every write", async () => {
    const lease = await acquireLease(db, cfg, key(), "worker-a", NOW);
    expect(lease.acquired).toBe(true);
    expect(await copyOf(cfg.publicCycleCollection, "inc1_r0")).toMatchObject({ state: "running", incidentId: "inc1", eventCount: 0 });

    await recordEvent(db, cfg, "inc1_r0", "worker-a", NOW, {
      stage: "triage",
      type: "decision",
      summary: "Jane Roe's order failed: the model's own words",
      data: { rule: "model-act", decision: "act" },
      record: { decision: "act", rule: "model-act", reason: "Jane Roe's order failed", suspectedCause: "a missing await" },
    });
    await recordEvent(db, cfg, "inc1_r0", "worker-a", NOW, { stage: "pr", type: "dry-run", summary: "Patch verified; nothing opened (dry run)", record: { opened: false, reason: "dry-run" } });

    const events = (await all(cfg.publicEventCollection)).map((d) => ({ id: d.id, ...d.data() }));
    expect(events.map((e) => e.id)).toEqual([publicEventId("inc1_r0", "000001"), publicEventId("inc1_r0", "000002")]);
    expect(events[0]).not.toHaveProperty("summary"); // a model's words
    expect(events[0]).not.toHaveProperty("data");
    expect(events[1]).toMatchObject({ stage: "pr", type: "dry-run", summary: "Patch verified; nothing opened (dry run)", seq: 2, cycleId: "inc1_r0" });

    const cycleCopy = await copyOf(cfg.publicCycleCollection, "inc1_r0");
    expect(cycleCopy).toMatchObject({ eventCount: 2, stage: "pr", summary: { triage: { decision: "act", rule: "model-act" }, pr: { opened: false, reason: "dry-run" } } });
    expect(JSON.stringify(cycleCopy)).not.toContain("Jane Roe");
    expect(cycleCopy).not.toHaveProperty("owner");

    await finishCycle(db, cfg, "inc1_r0", "worker-a", NOW, "waiting-human", "draft-ready", "draft");
    const stored = (await db.collection(cfg.cycleCollection).doc("inc1_r0").get()).data();
    const finished = await copyOf(cfg.publicCycleCollection, "inc1_r0");
    expect(finished).toMatchObject({ state: "waiting-human", path: "draft", outcome: "draft-ready", leaseExpiresAt: null });
    expect(sameDocument(finished, toPublicCycle(stored, cfg))).toBe(true);
  });

  it("an event appended inside another transaction (the phone escalation's) gets its copy in that transaction", async () => {
    await acquireLease(db, cfg, key(), "worker-a", NOW);
    await finishCycle(db, cfg, "inc1_r0", "worker-a", NOW, "waiting-human", "notify", "notify");
    const ref = db.collection(cfg.cycleCollection).doc("inc1_r0");
    await db.runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data();
      appendEventsInTransaction(tx, ref, d, NOW, [{ stage: "escalation", type: "calling", summary: "Phoning the on-call primary (+1•••0100)" }], cfg);
    });
    const [copy] = await all(cfg.publicEventCollection);
    expect(copy!.id).toBe(publicEventId("inc1_r0", "000001"));
    expect(copy!.data()).toMatchObject({ stage: "escalation", type: "calling" });
    expect(copy!.data()).not.toHaveProperty("summary");
    // The caller refreshes the cycle's copy after its commit.
    expect(await refreshPublicCycle(db, cfg, "inc1_r0")).toBe("written");
    expect(await copyOf(cfg.publicCycleCollection, "inc1_r0")).toMatchObject({ eventCount: 1, stage: "escalation" });
  });

  it("a cycle of a private environment gets no copy, and neither do its events", async () => {
    await acquireLease(db, cfg, { incidentId: "inc2", environment: "prod", recurrence: 0 }, "worker-a", NOW);
    await recordEvent(db, cfg, "inc2_r0", "worker-a", NOW, { stage: "pr", type: "dry-run", summary: "x" });
    expect(await all(cfg.publicCycleCollection)).toHaveLength(0);
    expect(await all(cfg.publicEventCollection)).toHaveLength(0);
  });
});

describe("the sweep after each run", () => {
  it("picks up an operator's triage made in the UI, which the engine's own refreshes cannot see", async () => {
    await upsertIncident(db, cfg, occurrence(), Timestamp.fromDate(NOW));
    const [stored] = await incidents();
    // What the UI writes (web/src/lib/incidents.ts applyAction), straight to the stored incident.
    await stored!.ref.update({ status: "acknowledged", statusChangedBy: "op1", updatedAt: Timestamp.fromDate(NOW) });
    expect((await copyOf(cfg.publicIncidentCollection, stored!.id))?.status).toBe("new");

    const sweep = await syncRecentPublicView(db, cfg);
    expect(sweep).toMatchObject({ incidents: { checked: 1, refreshed: 1 }, failures: 0 });
    expect((await copyOf(cfg.publicIncidentCollection, stored!.id))?.status).toBe("acknowledged");
    // Nothing differs now: nothing is written.
    expect((await syncRecentPublicView(db, cfg)).incidents.refreshed).toBe(0);
  });

  it("copies a cycle written without copies, with its events", async () => {
    const off = { ...cfg, publicEnvironments: [] };
    await acquireLease(db, off, { incidentId: "inc1", environment: "demo", recurrence: 0 }, "worker-a", NOW);
    await recordEvent(db, off, "inc1_r0", "worker-a", NOW, { stage: "cycle", type: "started", summary: "Attempt 1" });
    expect(await all(cfg.publicCycleCollection)).toHaveLength(0);

    const sweep = await syncRecentPublicView(db, cfg);
    expect(sweep).toMatchObject({ cycles: { checked: 1, refreshed: 1 }, events: { written: 1 }, failures: 0 });
    expect(await copyOf(cfg.publicEventCollection, publicEventId("inc1_r0", "000001"))).toMatchObject({ summary: "Attempt 1" });
  });
});

describe("the backfill (pnpm public-view)", () => {
  it("a dry run counts and writes nothing; applied, it copies what was stored before, removes what must not be copied, and a second run finds nothing", async () => {
    const off = { ...cfg, publicEnvironments: [] };
    // Records from before the copies existed.
    await upsertIncident(db, off, occurrence(), Timestamp.fromDate(NOW));
    await acquireLease(db, off, { incidentId: "inc1", environment: "demo", recurrence: 0 }, "worker-a", NOW);
    await recordEvent(db, off, "inc1_r0", "worker-a", NOW, { stage: "cycle", type: "started", summary: "Attempt 1" });
    await recordEvent(db, off, "inc1_r0", "worker-a", NOW, { stage: "triage", type: "decision", summary: "model words" });
    await upsertIncident(db, off, occurrence({ environment: "prod", errorMessage: "prod only" }), Timestamp.fromDate(NOW));
    // Copies that must go: one whose record is gone, one of a private environment, one of an event that never was.
    await db.collection(cfg.publicIncidentCollection).doc("gone").set({ environment: "demo", status: "new" });
    const prod = (await incidents()).find((d) => d.data().environment === "prod")!;
    await db.collection(cfg.publicIncidentCollection).doc(prod.id).set({ environment: "prod", status: "new" });
    await db.collection(cfg.publicEventCollection).doc("inc1_r0_000099").set({ cycleId: "inc1_r0", environment: "demo", seq: 99 });

    const dry = await backfillPublicView(db, cfg, { apply: false });
    expect(dry).toMatchObject({
      applied: false,
      incidents: { write: 1, remove: 2, same: 0 },
      cycles: { write: 1, remove: 0, same: 0 },
      events: { write: 2, remove: 1, same: 0 },
      failures: 0,
    });
    expect(await all(cfg.publicCycleCollection)).toHaveLength(0);

    const applied = await backfillPublicView(db, cfg, { apply: true });
    expect(applied).toMatchObject({ applied: true, incidents: { write: 1, remove: 2 }, cycles: { write: 1 }, events: { write: 2, remove: 1 }, failures: 0 });
    expect((await all(cfg.publicIncidentCollection)).map((d) => d.data().environment)).toEqual(["demo"]);
    expect(await all(cfg.publicCycleCollection)).toHaveLength(1);
    expect((await all(cfg.publicEventCollection)).map((d) => d.id)).toEqual([publicEventId("inc1_r0", "000001"), publicEventId("inc1_r0", "000002")]);

    expect(await backfillPublicView(db, cfg, { apply: false })).toMatchObject({
      incidents: { write: 0, remove: 0, same: 1 },
      cycles: { write: 0, remove: 0, same: 1 },
      events: { write: 0, remove: 0, same: 2 },
    });
  });

  it("with the copies turned off, removes every copy", async () => {
    await upsertIncident(db, cfg, occurrence(), Timestamp.fromDate(NOW));
    const r = await backfillPublicView(db, { ...cfg, publicEnvironments: [] }, { apply: true });
    expect(r.incidents).toMatchObject({ write: 0, remove: 1 });
    expect(await all(cfg.publicIncidentCollection)).toHaveLength(0);
  });
});
