/**
 * The synthetic demo history against the real Firestore emulator: seeding twice leaves the same documents,
 * `removeDemoHistory` deletes only what is marked synthetic, and nothing is written outside the demo
 * environment or over a document that is not synthetic. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { applyDemoHistory, buildDemoPlan, removeDemoHistory, SYNTHETIC_ID_PREFIX, type SeedConfig } from "./seedDemo.js";
import { publicEventId } from "./publicView.js";

// Never let this suite reach a real project with ambient credentials.
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("seedDemo.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "seed-demo-emulator-tests");
const db: Firestore = getFirestore(app, "seed-demo-tests");
afterAll(() => deleteApp(app));

let cfg: SeedConfig;
beforeEach(() => {
  const run = randomUUID().slice(0, 8);
  cfg = {
    environment: "demo",
    incidentCollection: `incidents_${run}`,
    cycleCollection: `cycles_${run}`,
    publicEnvironments: ["demo"],
    publicIncidentCollection: `pub_incidents_${run}`,
    publicCycleCollection: `pub_cycles_${run}`,
    publicEventCollection: `pub_events_${run}`,
  };
});

const NOW = new Date("2026-10-06T12:00:00Z");

/** The guest copies (#18), as path -> data. */
async function copies(): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of [cfg.publicIncidentCollection, cfg.publicCycleCollection, cfg.publicEventCollection]) {
    for (const d of (await db.collection(name).get()).docs) out[d.ref.path] = d.data();
  }
  return out;
}

/** Every document under the two collections, events included, as path -> data. */
async function dump(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const d of (await db.collection(cfg.incidentCollection).get()).docs) out[d.ref.path] = d.data();
  for (const c of (await db.collection(cfg.cycleCollection).get()).docs) {
    out[c.ref.path] = c.data();
    for (const e of (await c.ref.collection("events").get()).docs) out[e.ref.path] = e.data();
  }
  return out;
}

describe("seed-demo against the emulator", () => {
  it("seeding twice gives the same documents, and a later run moves them in time instead of adding more", async () => {
    const plan = buildDemoPlan(NOW);
    const first = await applyDemoHistory(db, cfg, plan);
    expect(first.ok).toBe(true);
    const once = await dump();
    expect(await applyDemoHistory(db, cfg, plan)).toEqual(first);
    expect(await dump()).toEqual(once);

    const later = await applyDemoHistory(db, cfg, buildDemoPlan(new Date(NOW.getTime() + 3600_000)));
    expect(later.ok).toBe(true);
    expect(Object.keys(await dump()).sort()).toEqual(Object.keys(once).sort());
  });

  it("--apply writes a guest copy of every incident, cycle and event, trimmed, and --remove takes them away (#18)", async () => {
    const plan = buildDemoPlan(NOW);
    await applyDemoHistory(db, cfg, plan);
    const got = await copies();
    const want = [
      ...plan.incidents.map((i) => `${cfg.publicIncidentCollection}/${i.id}`),
      ...plan.cycles.map((c) => `${cfg.publicCycleCollection}/${c.id}`),
      ...plan.cycles.flatMap((c) => c.events.map((e) => `${cfg.publicEventCollection}/${publicEventId(c.id, e.id)}`)),
    ];
    expect(Object.keys(got).sort()).toEqual(want.sort());
    for (const doc of Object.values(got)) {
      expect(doc.publicView).toBe(1);
      expect(doc.synthetic).toBe(true);
      // Trimmed: no free text beyond the title and the engine's own event lines.
      expect(doc).not.toHaveProperty("errorDetail");
      expect(doc).not.toHaveProperty("stackTrace");
      expect(doc).not.toHaveProperty("data");
      expect(doc).not.toHaveProperty("fingerprint");
    }
    const triaged = Object.values(got).find((d) => (d.summary as Record<string, Record<string, unknown>> | undefined)?.triage);
    expect((triaged!.summary as Record<string, Record<string, unknown>>).triage).not.toHaveProperty("reason");

    await removeDemoHistory(db, cfg, plan);
    expect(await copies()).toEqual({});
  });

  it("removes events an earlier, longer plan wrote", async () => {
    const plan = buildDemoPlan(NOW);
    await applyDemoHistory(db, cfg, plan);
    const cycle = plan.cycles[0]!;
    const extra = db.collection(cfg.cycleCollection).doc(cycle.id).collection("events").doc("000099");
    await extra.set({ seq: 99, environment: "demo", synthetic: true });
    const r = await applyDemoHistory(db, cfg, plan);
    expect(r).toMatchObject({ ok: true, staleEventsRemoved: 1 });
    expect((await extra.get()).exists).toBe(false);
  });

  it("--remove deletes exactly the synthetic documents and leaves everything else", async () => {
    const plan = buildDemoPlan(NOW);
    await applyDemoHistory(db, cfg, plan);
    const real = db.collection(cfg.incidentCollection).doc("real-incident");
    await real.set({ environment: "demo", status: "new", errorMessage: "a real one" });
    const realCycle = db.collection(cfg.cycleCollection).doc("real-incident_r0");
    await realCycle.set({ environment: "demo", state: "done", incidentId: "real-incident" });
    await realCycle.collection("events").doc("000001").set({ seq: 1, environment: "demo" });

    const r = await removeDemoHistory(db, cfg, plan);
    expect(r).toEqual({ ok: true, incidents: plan.incidents.length, cycles: plan.cycles.length, events: plan.cycles.reduce((n, c) => n + c.events.length, 0) });
    expect(Object.keys(await dump()).sort()).toEqual(
      [real.path, realCycle.path, realCycle.collection("events").doc("000001").path].sort()
    );
    // Removing again finds nothing to remove.
    expect(await removeDemoHistory(db, cfg, plan)).toEqual({ ok: true, incidents: 0, cycles: 0, events: 0 });
  });

  it("neither overwrites nor deletes a document at a seeded id that is not marked synthetic", async () => {
    const plan = buildDemoPlan(NOW);
    const squatter = db.collection(cfg.incidentCollection).doc(`${SYNTHETIC_ID_PREFIX}pr`);
    await squatter.set({ environment: "demo", status: "new", errorMessage: "not ours" });

    const r = await applyDemoHistory(db, cfg, plan);
    expect(r).toMatchObject({ ok: false, reason: "id-taken" });
    expect(Object.keys(await dump())).toEqual([squatter.path]); // nothing written at all

    await removeDemoHistory(db, cfg, plan);
    expect((await squatter.get()).data()).toEqual({ environment: "demo", status: "new", errorMessage: "not ours" });
  });

  it("refuses a non-demo environment and writes or deletes nothing", async () => {
    const plan = buildDemoPlan(NOW, "prod");
    const prod = { ...cfg, environment: "prod" };
    expect(await applyDemoHistory(db, prod, plan)).toMatchObject({ ok: false, reason: "not-demo-environment" });
    expect(await dump()).toEqual({});

    await applyDemoHistory(db, cfg, buildDemoPlan(NOW));
    const before = await dump();
    expect(await removeDemoHistory(db, prod, buildDemoPlan(NOW))).toMatchObject({ ok: false, reason: "not-demo-environment" });
    expect(await dump()).toEqual(before);
  });
});
