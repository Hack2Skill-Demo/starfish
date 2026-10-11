/**
 * The phone escalation (#37) end to end against the real Firestore emulator and a fake Twilio: the call sequence, every
 * keypress, voicemail, acknowledgement mid-sequence, quiet hours, the daily cap, the opt-in, signature checks, and
 * idempotency under concurrent passes. Time is passed in, so nothing here sleeps. Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { testConfig } from "../testConfig.js";
import type { StarfishConfig } from "../config.js";
import { MAX_SCAN, runEscalationTick, readPolicy, stepEscalation, type EscalationDeps } from "./escalation.js";
import { createTwilioWebhooks, type TwilioWebhookResponse } from "./webhooks.js";
import { twilioSignature, type TwilioClient } from "./twilio.js";
import { CODE_TTL_MS, codeHash, confirmNumber, sendConfirmationCode, textCountDocId } from "./optIn.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("escalation.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "escalation-emulator-tests");
const db: Firestore = getFirestore(app, "escalation-tests");
afterAll(() => deleteApp(app));

const AUTH_TOKEN = "e".repeat(32);
const BASE = "https://admin.example.test";
const AUDIO = "https://storage.example.test/oncall.mp3";
const UI = "https://starfish.example.test";
const T0 = new Date("2026-10-06T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const PHONES = { p1: "+15550000101", p2: "+15550000202", p3: "+15550000303", pending: "+15550000999" };
const CYCLE = "inc1_r0";

let cfg: StarfishConfig;
let clock: Date;
let placed: { to: string; voiceUrl: string; statusUrl: string }[];
let texts: { to: string; body: string }[];
let twilio: TwilioClient;
let refuseCalls: boolean;
let refuseTexts: boolean;

beforeEach(async () => {
  const p = randomUUID().slice(0, 8);
  cfg = testConfig({
    environment: "demo",
    dryRun: false,
    phoneEscalation: true,
    cycleCollection: `cycles_${p}`,
    incidentCollection: `incidents_${p}`,
    onCallCollection: `oncall_${p}`,
    onCallPeopleCollection: `people_${p}`,
    escalationCollection: `esc_${p}`,
    onCallCodeCollection: `codes_${p}`,
    usersCollection: `users_${p}`,
    auditCollection: `audit_${p}`,
    onCallAudioUrl: AUDIO,
    twilioWebhookUrl: BASE,
    uiBaseUrl: UI,
  });
  clock = T0;
  placed = [];
  texts = [];
  refuseCalls = false;
  refuseTexts = false;
  kickConfig = {};
  let n = 0;
  twilio = {
    placeCall: (to, urls) => {
      placed.push({ to, ...urls });
      n += 1;
      return Promise.resolve(refuseCalls ? { ok: false, reason: "http-400:21211" } : { ok: true, callSid: `CA${String(n).padStart(32, "0")}` });
    },
    sendSms: (to, body) => {
      texts.push({ to, body });
      return Promise.resolve(refuseTexts ? { ok: false, reason: "http-400:21211" } : { ok: true });
    },
  };
  await seed();
});

async function seed(opts: { cycleId?: string; incidentId?: string; occurrenceCount?: number; status?: string } = {}) {
  const incidentId = opts.incidentId ?? "inc1";
  await db.collection(cfg.cycleCollection).doc(opts.cycleId ?? CYCLE).set({
    incidentId,
    environment: "demo",
    recurrence: 0,
    state: "waiting-human",
    path: "notify",
    eventCount: 0,
    summary: { triage: { decision: "notify", rule: "model-notify" }, notify: { state: "sent", attempts: 1, at: T0.toISOString() } },
    createdAt: Timestamp.fromDate(T0),
    updatedAt: Timestamp.fromDate(T0),
  });
  await db.collection(cfg.incidentCollection).doc(incidentId).set({ status: opts.status ?? "new", occurrenceCount: opts.occurrenceCount ?? 3, environment: "demo" });
}

async function seedPeople(people: { id: string; role: string; state: string; phone: string; created: number }[]) {
  for (const p of people) {
    await db.collection(cfg.onCallPeopleCollection).doc(p.id).set({ name: `Person ${p.id}`, role: p.role, phone: p.phone, state: p.state, createdAt: Timestamp.fromMillis(p.created) });
  }
}

const ROTA = [
  { id: "p0", role: "primary", state: "pending", phone: PHONES.pending, created: 1 },
  { id: "p1", role: "primary", state: "confirmed", phone: PHONES.p1, created: 2 },
  { id: "p2", role: "secondary", state: "confirmed", phone: PHONES.p2, created: 3 },
  { id: "p3", role: "support-lead", state: "confirmed", phone: PHONES.p3, created: 4 },
];

async function setPolicy(over: Record<string, unknown> = {}) {
  await db.collection(cfg.onCallCollection).doc("policy").set({ enabled: true, waitMinutes: 10, timeZone: "UTC", dailyCapPerPerson: 5, criticalOccurrences: 100, ...over });
}

const deps = (over: Partial<EscalationDeps> = {}): EscalationDeps => ({ db, config: cfg, now: () => clock, owner: "worker-a", twilio, ...over });
const tick = (over: Partial<EscalationDeps> = {}) => runEscalationTick(deps(over));

const kicks: string[] = [];
/** The admin API's own config for its kick, as adminApiCli.ts wires it; the deploy may not give it the agent's switches (#225). */
let kickConfig: Partial<StarfishConfig> = {};
const hooks = () =>
  createTwilioWebhooks({
    db,
    config: cfg,
    authToken: AUTH_TOKEN,
    twilio,
    now: () => clock,
    kick: async (id) => {
      kicks.push(id);
      const config = { ...cfg, ...kickConfig };
      const policy = await readPolicy(db, config);
      if (policy) await stepEscalation(deps({ config, owner: "admin-api" }), id, policy, { kick: true });
    },
  });

/** A webhook as Twilio would send it: signed over the configured URL, the path and the query. */
async function hook(path: string, form: Record<string, string>, step: number, opts: { signature?: string; id?: string } = {}): Promise<TwilioWebhookResponse> {
  const query = `e=${opts.id ?? CYCLE}&s=${step}`;
  const signature = opts.signature ?? twilioSignature(AUTH_TOKEN, `${BASE}${path}?${query}`, form);
  return hooks()({ method: "POST", path, query, form, signature });
}

const esc = async (id = CYCLE) => (await db.collection(cfg.escalationCollection).doc(id).get()).data();
const events = async (id = CYCLE) =>
  (await db.collection(cfg.cycleCollection).doc(id).collection("events").orderBy("seq").get()).docs.map((d) => d.data() as { seq: number; stage: string; type: string; summary: string; data: Record<string, unknown> });
const types = async (id = CYCLE) => (await events(id)).filter((e) => e.stage === "escalation").map((e) => e.type);

describe("when the sequence starts", () => {
  it("waits the policy's minutes after the Slack message, then phones the confirmed primary", async () => {
    await setPolicy();
    await seedPeople(ROTA);
    clock = at(5);
    expect(await tick()).toMatchObject({ armed: 1, placed: 0 });
    expect(placed).toHaveLength(0);
    clock = at(10);
    expect(await tick()).toMatchObject({ armed: 0, placed: 1 });
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1]);
    expect(placed[0]!.voiceUrl).toBe(`${BASE}/twilio/voice?e=${CYCLE}&s=0`);
    expect(placed[0]!.statusUrl).toBe(`${BASE}/twilio/status?e=${CYCLE}&s=0`);
    expect(await types()).toEqual(["armed", "calling", "placed"]);
    expect((await esc())?.state).toBe("calling");
  });

  it("does nothing while the deployment switch or the admin's switch is off", async () => {
    await seedPeople(ROTA);
    await setPolicy({ enabled: false });
    clock = at(30);
    expect(await tick()).toMatchObject({ armed: 0, placed: 0 });
    expect(await tick({ config: { ...cfg, phoneEscalation: false } })).toMatchObject({ skipped: "off" });
    expect(placed).toHaveLength(0);
    expect(await esc()).toBeUndefined();
  });

  it("never rings for a sequence left open more than a day (switched off meanwhile)", async () => {
    await setPolicy();
    await seedPeople(ROTA);
    clock = at(5);
    await tick();
    clock = at(25 * 60);
    await tick();
    expect(placed).toHaveLength(0);
    expect(await esc()).toMatchObject({ open: false, state: "stopped" });
  });

  it("arms a new cycle however many old ones wait: the scan reads the last day's, newest first (#185)", async () => {
    await setPolicy();
    await seedPeople(ROTA);
    // More old waiting cycles than one scan reads, each with an id that sorts before the new one ("inc1_r0").
    const old = at(-3 * 24 * 60);
    for (let i = 0; i < MAX_SCAN + 10; i++) {
      await db.collection(cfg.cycleCollection).doc(`aold${String(i).padStart(3, "0")}_r0`).set({
        incidentId: `aold${i}`,
        environment: "demo",
        recurrence: 0,
        state: "waiting-human",
        path: "notify",
        eventCount: 0,
        summary: { triage: { decision: "notify", rule: "model-notify" }, notify: { state: "sent", attempts: 1, at: old.toISOString() } },
        createdAt: Timestamp.fromDate(old),
        updatedAt: Timestamp.fromDate(old),
      });
    }
    clock = at(5);
    expect(await tick()).toMatchObject({ armed: 1 });
    expect((await esc())?.state).toBe("waiting");
  });

  it("says so when the scan read its cap, never silently (#185)", async () => {
    await setPolicy();
    for (let i = 0; i < MAX_SCAN; i++) {
      await db.collection(cfg.cycleCollection).doc(`recent${String(i).padStart(3, "0")}_r0`).set({
        incidentId: `recent${i}`,
        environment: "demo",
        recurrence: 0,
        state: "waiting-human",
        path: "draft",
        eventCount: 0,
        updatedAt: Timestamp.fromDate(at(1)),
      });
    }
    clock = at(5);
    expect(await tick()).toMatchObject({ scanCapped: true });
  });

  it("never arms a seeded synthetic cycle (#192)", async () => {
    await setPolicy();
    await seedPeople(ROTA);
    await db.collection(cfg.cycleCollection).doc(CYCLE).update({ synthetic: true });
    clock = at(30);
    expect(await tick()).toMatchObject({ armed: 0, placed: 0 });
    expect(await esc()).toBeUndefined();
  });

  it("places no call on an invalid policy", async () => {
    await seedPeople(ROTA);
    await setPolicy({ waitMinutes: "ten" });
    clock = at(30);
    expect(await tick()).toMatchObject({ skipped: "policy-unreadable" });
    expect(placed).toHaveLength(0);
  });

  it("in a dry run places nothing and says what it would have done, with the number masked", async () => {
    await setPolicy();
    await seedPeople(ROTA);
    clock = at(10);
    await tick({ config: { ...cfg, dryRun: true } });
    clock = at(11);
    await tick({ config: { ...cfg, dryRun: true } });
    expect(placed).toHaveLength(0);
    const evs = await events();
    expect(evs.map((e) => e.type)).toEqual(["armed", "dry-run"]);
    expect(evs[1]!.summary).toContain("+1 ••• ••• ••01");
    expect(evs[1]!.summary).toContain("nothing placed (dry run)");
    expect((await esc())).toMatchObject({ open: false, state: "dry-run" });
  });
});

describe("opt-in", () => {
  it("never calls a number its owner has not confirmed", async () => {
    await setPolicy();
    await seedPeople([{ id: "p0", role: "primary", state: "pending", phone: PHONES.pending, created: 1 }]);
    clock = at(10);
    await tick();
    expect(placed).toHaveLength(0);
    expect(await types()).toEqual(["armed", "skipped", "skipped", "skipped", "skipped", "exhausted"]);
    expect(await esc()).toMatchObject({ open: false, state: "exhausted" });
  });

  it("confirms a number only with the code texted to it, sent on an admin's request, and then it is called", async () => {
    await db.collection(cfg.usersCollection).doc("admin1").set({ roles: ["admin"] });
    await db.collection(cfg.usersCollection).doc("op1").set({ roles: ["operator"] });
    await seedPeople([{ id: "p0", role: "primary", state: "pending", phone: PHONES.pending, created: 1 }]);
    expect(await sendConfirmationCode(db, cfg, twilio, "p0", "op1", T0, () => "424242")).toEqual({ ok: false, reason: "not-admin" });
    expect(await sendConfirmationCode(db, { ...cfg, phoneEscalation: false }, twilio, "p0", "admin1", T0, () => "424242")).toEqual({ ok: false, reason: "off" });
    expect(texts).toHaveLength(0);
    expect(await sendConfirmationCode(db, cfg, twilio, "p0", "admin1", T0, () => "424242")).toEqual({ ok: true });
    expect(texts).toEqual([{ to: PHONES.pending, body: expect.stringContaining("424242") as unknown as string }]);
    expect(await sendConfirmationCode(db, cfg, twilio, "p0", "admin1", new Date(T0.getTime() + 10_000))).toEqual({ ok: false, reason: "too-soon" });
    // The code is stored only as a hash.
    expect(JSON.stringify((await db.collection(cfg.onCallPeopleCollection).doc("p0").get()).data())).not.toContain("424242");

    expect(await confirmNumber(db, cfg, "p0", "111111", "admin1", T0)).toEqual({ ok: false, reason: "wrong-code" });
    expect(await confirmNumber(db, cfg, "p0", "424242", "op1", T0)).toEqual({ ok: false, reason: "not-admin" });
    expect(await confirmNumber(db, cfg, "p0", "424242", "admin1", at(11))).toEqual({ ok: false, reason: "expired" });
    expect(await confirmNumber(db, cfg, "p0", "424242", "admin1", T0)).toEqual({ ok: true });
    expect((await db.collection(cfg.onCallPeopleCollection).doc("p0").get()).get("state")).toBe("confirmed");

    await setPolicy();
    clock = at(10);
    await tick();
    expect(placed.map((p) => p.to)).toEqual([PHONES.pending]);
  });

  it("a code sent to one number cannot confirm another, and wrong codes are limited", async () => {
    await db.collection(cfg.usersCollection).doc("admin1").set({ roles: ["admin"] });
    await seedPeople([{ id: "p0", role: "primary", state: "pending", phone: PHONES.pending, created: 1 }]);
    await sendConfirmationCode(db, cfg, twilio, "p0", "admin1", T0, () => "424242");
    await db.collection(cfg.onCallPeopleCollection).doc("p0").update({ phone: PHONES.p2 });
    expect(await confirmNumber(db, cfg, "p0", "424242", "admin1", T0)).toEqual({ ok: false, reason: "wrong-code" });
    for (let i = 0; i < 4; i++) await confirmNumber(db, cfg, "p0", "000000", "admin1", T0);
    expect(await confirmNumber(db, cfg, "p0", "424242", "admin1", T0)).toEqual({ ok: false, reason: "too-many-tries" });
  });

  // #302: the hash of a six-digit code sat on the person's document, which admins read from the browser, and was undone
  // offline in a moment. It now lives in an engine-only collection (firestore.rules closes it to every client).
  it("keeps the code's hash, expiry and tries off the person's document, and drops them once confirmed (#302)", async () => {
    await db.collection(cfg.usersCollection).doc("admin1").set({ roles: ["admin"] });
    await seedPeople([{ id: "p0", role: "primary", state: "pending", phone: PHONES.pending, created: 1 }]);
    expect(await sendConfirmationCode(db, cfg, twilio, "p0", "admin1", T0, () => "424242")).toEqual({ ok: true });
    const person = (await db.collection(cfg.onCallPeopleCollection).doc("p0").get()).data()!;
    expect(Object.keys(person).filter((k) => k.startsWith("code"))).toEqual([]);
    const code = (await db.collection(cfg.onCallCodeCollection).doc("p0").get()).data()!;
    expect(Object.keys(code).sort()).toEqual(["codeHash", "expiresAt", "sentAt", "tries"]);
    expect(JSON.stringify(code)).not.toContain("424242");
    expect(await confirmNumber(db, cfg, "p0", "111111", "admin1", T0)).toEqual({ ok: false, reason: "wrong-code" });
    expect((await db.collection(cfg.onCallCodeCollection).doc("p0").get()).get("tries")).toBe(1);
    expect(await confirmNumber(db, cfg, "p0", "424242", "admin1", T0)).toEqual({ ok: true });
    expect((await db.collection(cfg.onCallCodeCollection).doc("p0").get()).exists).toBe(false);
  });

  it("never believes a hash an older version left on the person's document, and clears it with the next code (#302)", async () => {
    await db.collection(cfg.usersCollection).doc("admin1").set({ roles: ["admin"] });
    await seedPeople([{ id: "p0", role: "primary", state: "pending", phone: PHONES.pending, created: 1 }]);
    const people = db.collection(cfg.onCallPeopleCollection);
    await people.doc("p0").update({
      codeHash: codeHash("p0", PHONES.pending, "424242"),
      codeSentAt: Timestamp.fromDate(T0),
      codeExpiresAt: Timestamp.fromMillis(T0.getTime() + CODE_TTL_MS),
      codeTries: 0,
    });
    expect(await confirmNumber(db, cfg, "p0", "424242", "admin1", T0)).toEqual({ ok: false, reason: "no-code" });
    // The legacy send time still keeps the minute between codes.
    expect(await sendConfirmationCode(db, cfg, twilio, "p0", "admin1", at(0.5), () => "565656")).toEqual({ ok: false, reason: "too-soon" });
    expect(await sendConfirmationCode(db, cfg, twilio, "p0", "admin1", at(1), () => "565656")).toEqual({ ok: true });
    expect(Object.keys((await people.doc("p0").get()).data()!).filter((k) => k.startsWith("code"))).toEqual([]);
    expect(await confirmNumber(db, cfg, "p0", "424242", "admin1", at(1))).toEqual({ ok: false, reason: "wrong-code" });
    expect(await confirmNumber(db, cfg, "p0", "565656", "admin1", at(1))).toEqual({ ok: true });
  });

  // #306: one text a minute per person was the only limit, so a compromised admin account could text without end.
  it("caps the deployment's opt-in texts per UTC day, audits the refusal, and counts concurrent sends exactly (#306)", async () => {
    const capped = { ...cfg, onCallMaxTextsPerDay: 2 };
    await db.collection(cfg.usersCollection).doc("admin1").set({ roles: ["admin"] });
    await seedPeople([
      { id: "p0", role: "primary", state: "pending", phone: PHONES.pending, created: 1 },
      { id: "p1", role: "secondary", state: "pending", phone: PHONES.p1, created: 2 },
      { id: "p2", role: "support-lead", state: "pending", phone: PHONES.p2, created: 3 },
    ]);
    const send = (person: string, now: Date) => sendConfirmationCode(db, capped, twilio, person, "admin1", now, () => "424242");
    const results = await Promise.all(["p0", "p1", "p2"].map((p) => send(p, T0)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "daily-cap" }]);
    expect(texts).toHaveLength(2);
    expect((await db.collection(cfg.onCallCodeCollection).doc(textCountDocId(T0)).get()).get("count")).toBe(2);
    const audit = (await db.collection(cfg.auditCollection).get()).docs.map((d) => d.data());
    expect(audit.filter((d) => d.outcome === "daily-cap")).toEqual([expect.objectContaining({ action: "oncall-send-code", actorUid: "admin1" })]);
    // A new UTC day starts a new count.
    const refusedId = ["p0", "p1", "p2"][results.findIndex((r) => !r.ok)]!;
    expect(await send(refusedId, new Date("2026-10-07T00:00:01Z"))).toEqual({ ok: true });
    expect(texts).toHaveLength(3);
  });

  it("records every send-code and confirm attempt in the audit collection, refusals included, without the number or the code (#172)", async () => {
    await db.collection(cfg.usersCollection).doc("admin1").set({ roles: ["admin"] });
    await db.collection(cfg.usersCollection).doc("op1").set({ roles: ["operator"] });
    await seedPeople([
      { id: "p0", role: "primary", state: "pending", phone: PHONES.pending, created: 1 },
      { id: "p1", role: "secondary", state: "pending", phone: PHONES.p1, created: 2 },
    ]);
    const outcomes: string[] = [];
    const send = (person: string, uid: string, now: Date, c = cfg) => sendConfirmationCode(db, c, twilio, person, uid, now, () => "424242");
    const confirm = (person: string, code: string, uid: string, now: Date) => confirmNumber(db, cfg, person, code, uid, now);
    const run = async (expected: string, attempt: () => Promise<unknown>) => {
      await attempt();
      outcomes.push(expected);
    };
    await run("off", () => send("p0", "admin1", T0, { ...cfg, phoneEscalation: false }));
    // A non-admin is refused and NOT recorded (optIn.ts, isAdminNow): no entry expected.
    expect(await send("p0", "op1", T0)).toEqual({ ok: false, reason: "not-admin" });
    await run("no-such-person", () => send("nobody", "admin1", T0));
    await run("no-code", () => confirm("p0", "424242", "admin1", T0));
    await run("sent", () => send("p0", "admin1", T0));
    await run("too-soon", () => send("p0", "admin1", at(0.5)));
    await run("wrong-code", () => confirm("p0", "111111", "admin1", T0));
    expect(await confirm("p0", "424242", "op1", T0)).toEqual({ ok: false, reason: "not-admin" });
    await run("expired", () => confirm("p0", "424242", "admin1", at(11)));
    await run("confirmed", () => confirm("p0", "424242", "admin1", T0));
    await run("already-confirmed", () => confirm("p0", "424242", "admin1", T0));
    await run("already-confirmed", () => send("p0", "admin1", at(5)));
    refuseTexts = true;
    await run("send-failed", () => send("p1", "admin1", T0));
    await db.collection(cfg.onCallCodeCollection).doc("p1").update({ tries: 5 });
    await run("too-many-tries", () => confirm("p1", "424242", "admin1", T0));

    const docs = (await db.collection(cfg.auditCollection).get()).docs.map((d) => d.data());
    expect(docs).toHaveLength(outcomes.length);
    // `at` alone does not order entries written at the same instant, so compare as multisets.
    expect(docs.map((d) => d.outcome as string).sort()).toEqual([...outcomes].sort());
    for (const d of docs) {
      expect(Object.keys(d).sort()).toEqual(["action", "actorUid", "at", "outcome", "personId"]);
      expect(["oncall-send-code", "oncall-confirm"]).toContain(d.action);
      // Not even the masked tail (`at` is left out of the check: its digits are a time, not a number).
      const text = JSON.stringify({ ...d, at: null });
      for (const secret of [...Object.values(PHONES), "424242", "111111", "0999", "0101"]) expect(text).not.toContain(secret);
    }
    expect(docs.filter((d) => d.outcome === "sent")).toEqual([expect.objectContaining({ action: "oncall-send-code", actorUid: "admin1", personId: "p0" })]);
    expect(docs.filter((d) => d.outcome === "confirmed")).toEqual([expect.objectContaining({ action: "oncall-confirm", actorUid: "admin1", personId: "p0" })]);
  });

  it("a send-code's entry is on record before the text goes out", async () => {
    await db.collection(cfg.usersCollection).doc("admin1").set({ roles: ["admin"] });
    await seedPeople([{ id: "p0", role: "primary", state: "pending", phone: PHONES.pending, created: 1 }]);
    let seenAtSend: unknown[] = [];
    const watching: TwilioClient = {
      ...twilio,
      sendSms: async (to, body) => {
        seenAtSend = (await db.collection(cfg.auditCollection).get()).docs.map((d) => d.data());
        return twilio.sendSms(to, body);
      },
    };
    expect(await sendConfirmationCode(db, cfg, watching, "p0", "admin1", T0, () => "424242")).toEqual({ ok: true });
    expect(seenAtSend).toEqual([expect.objectContaining({ action: "oncall-send-code", personId: "p0", outcome: "sending" })]);
  });
});

describe("the call sequence", () => {
  beforeEach(async () => {
    await setPolicy();
    await seedPeople(ROTA);
    clock = at(10);
    await tick();
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1]);
  });

  it("no answer: the primary again two minutes later, then the secondary, then the support lead, then the end", async () => {
    await hook("/twilio/status", { CallStatus: "no-answer" }, 0);
    clock = at(11);
    await tick();
    expect(placed).toHaveLength(1);
    clock = at(12);
    await tick();
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1, PHONES.p1]);
    await hook("/twilio/status", { CallStatus: "busy" }, 1);
    // The next person at once: the webhook takes the sequence on without waiting for a pass.
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1, PHONES.p1, PHONES.p2]);
    await hook("/twilio/status", { CallStatus: "no-answer" }, 2);
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1, PHONES.p1, PHONES.p2, PHONES.p3]);
    await hook("/twilio/status", { CallStatus: "no-answer" }, 3);
    expect(await esc()).toMatchObject({ open: false, state: "exhausted" });
    clock = at(60);
    await tick();
    expect(placed).toHaveLength(4);
    expect((await types()).slice(-2)).toEqual(["no-answer", "exhausted"]);
  });

  it("voicemail: a short message with no incident detail, and the sequence moves on", async () => {
    const r = await hook("/twilio/voice", { CallSid: `CA${"1".padStart(32, "0")}`, AnsweredBy: "machine_end_beep" }, 0);
    expect(r.body).toContain("<Say>This is Starfish. An urgent incident needs a person. The details are in the on-call channel.</Say><Hangup/>");
    expect(r.body).not.toContain("inc1");
    expect(r.body).not.toContain("<Gather");
    await hook("/twilio/status", { CallStatus: "completed" }, 0);
    expect(await esc()).toMatchObject({ open: true, state: "waiting", step: 1, lastOutcome: "voicemail" });
    expect(await types()).toContain("voicemail");
  });

  it("a person who answers hears the one recording and the menu", async () => {
    const r = await hook("/twilio/voice", { CallSid: "CA1", AnsweredBy: "human" }, 0);
    expect(r.body).toContain(`<Play>${AUDIO}</Play>`);
    expect(r.body).toContain(`action="${BASE}/twilio/gather?e=${CYCLE}&amp;s=0"`);
    // Only the callback URL names the cycle; nothing spoken does.
    expect([...r.body.matchAll(/<Say>([^<]*)<\/Say>/g)].map((m) => m[1]).join(" ")).not.toContain("inc1");
    expect(await types()).toContain("answered");
  });

  it("1: takes it; the sequence ends, the incident is acknowledged as that person, and nobody else is called", async () => {
    await hook("/twilio/voice", { AnsweredBy: "human" }, 0);
    const r = await hook("/twilio/gather", { Digits: "1" }, 0);
    expect(r.body).toContain("Thank you. It is yours.");
    expect(await esc()).toMatchObject({ open: false, state: "acknowledged", ackBy: { personId: "p1", role: "primary" } });
    const incident = (await db.collection(cfg.incidentCollection).doc("inc1").get()).data();
    expect(incident).toMatchObject({ status: "acknowledged", statusChangedBy: "oncall:p1" });
    await hook("/twilio/status", { CallStatus: "completed" }, 0);
    clock = at(30);
    await tick();
    expect(placed).toHaveLength(1);
  });

  it("2: texts the link to the incident and nothing else of it, once, then asks again; hanging up moves on", async () => {
    const r = await hook("/twilio/gather", { Digits: "2" }, 0);
    expect(r.body).toContain("The link is on its way.");
    expect(r.body).toContain("<Gather");
    await hook("/twilio/gather", { Digits: "2" }, 0);
    expect(texts).toEqual([{ to: PHONES.p1, body: `Starfish: the incident that needs a person: ${UI}/incidents/inc1` }]);
    await hook("/twilio/status", { CallStatus: "completed" }, 0);
    expect(await esc()).toMatchObject({ state: "waiting", step: 1, lastOutcome: "link-sent" });
    expect(await types()).toContain("link-sent");
  });

  it("2: texts nobody when the number was changed mid-call: the new one is pending and never consented (#187)", async () => {
    await db.collection(cfg.onCallPeopleCollection).doc("p1").update({ phone: "+15550000777", state: "pending" });
    const r = await hook("/twilio/gather", { Digits: "2" }, 0);
    expect(r.body).toContain("<Gather");
    expect(texts).toEqual([]);
    const failed = (await events()).find((e) => e.type === "link-failed");
    expect(failed?.data.reason).toBe("no-confirmed-number");
  });

  it("2: texts nobody when the number is confirmed but is not the one the call was placed to (#187)", async () => {
    await db.collection(cfg.onCallPeopleCollection).doc("p1").update({ phone: "+15550000777" });
    await hook("/twilio/gather", { Digits: "2" }, 0);
    expect(texts).toEqual([]);
    expect(await types()).toContain("link-failed");
  });

  it("2 with nothing texted never records the call as having taken the link (#234)", async () => {
    // The number changed mid-call: no confirmed number to text.
    await db.collection(cfg.onCallPeopleCollection).doc("p1").update({ phone: "+15550000777", state: "pending" });
    await hook("/twilio/gather", { Digits: "2" }, 0);
    const again = await hook("/twilio/gather", { Digits: "2" }, 0);
    expect(again.body).not.toContain("The link is on its way.");
    await hook("/twilio/status", { CallStatus: "completed" }, 0);
    expect(texts).toEqual([]);
    expect(await esc()).toMatchObject({ step: 1, lastOutcome: "no-input" });
    expect(await types()).not.toContain("link-sent");
  });

  it("2 that Twilio refused to text, then silence: the outcome is no input, not the link taken (#234)", async () => {
    refuseTexts = true;
    await hook("/twilio/gather", { Digits: "2" }, 0);
    expect(texts).toHaveLength(1);
    await hook("/twilio/gather", { Digits: "" }, 0);
    expect(await esc()).toMatchObject({ step: 1, lastOutcome: "no-input" });
    expect(await types()).toEqual(expect.arrayContaining(["link-failed", "no-input"]));
    expect(await types()).not.toContain("link-sent");
  });

  it("2 with no UI URL configured texts nothing and records no link taken (#234)", async () => {
    cfg = { ...cfg, uiBaseUrl: "" };
    await hook("/twilio/gather", { Digits: "2" }, 0);
    await hook("/twilio/status", { CallStatus: "completed" }, 0);
    expect(texts).toEqual([]);
    expect((await events()).find((e) => e.type === "link-failed")?.data.reason).toBe("no-ui-url");
    expect(await esc()).toMatchObject({ lastOutcome: "no-input" });
  });

  it("3: passes it to the next PERSON at once (the primary's retry is skipped)", async () => {
    kicks.length = 0;
    const r = await hook("/twilio/gather", { Digits: "3" }, 0);
    expect(r.body).toContain("Passing it to the next person.");
    expect(kicks).toEqual([CYCLE]);
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1, PHONES.p2]);
    expect((await esc())?.step).toBe(2);
    // Twilio's own report of the passed call's end changes nothing: that call is no longer the one in flight.
    await hook("/twilio/status", { CallStatus: "completed" }, 0);
    expect((await esc())?.state).toBe("calling");
  });

  it("the admin API's kick never closes a live sequence on its own dry run; the agent's next tick calls the secondary (#225)", async () => {
    kickConfig = { dryRun: true };
    await hook("/twilio/gather", { Digits: "3" }, 0);
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1]);
    expect(await esc()).toMatchObject({ open: true, state: "waiting", step: 2 });
    expect(await types()).not.toContain("dry-run");
    await tick();
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1, PHONES.p2]);
    expect(await esc()).toMatchObject({ open: true, state: "calling", step: 2 });
  });

  it("the admin API's kick never closes a live sequence on its own phone switch being off (#225)", async () => {
    kickConfig = { phoneEscalation: false };
    await hook("/twilio/status", { CallStatus: "no-answer" }, 0);
    expect(await esc()).toMatchObject({ open: true, state: "waiting", step: 1 });
    expect(await types()).not.toContain("stopped");
    clock = at(12);
    await tick();
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1, PHONES.p1]);
    await hook("/twilio/status", { CallStatus: "no-answer" }, 1);
    expect(await esc()).toMatchObject({ open: true, state: "waiting", step: 2 });
    await tick();
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1, PHONES.p1, PHONES.p2]);
  });

  it("an invalid key: says so and asks again once; a second one moves on like silence", async () => {
    const first = await hook("/twilio/gather", { Digits: "7" }, 0);
    expect(first.body).toContain("That key does nothing.");
    expect((await esc())?.state).toBe("calling");
    const second = await hook("/twilio/gather", { Digits: "#" }, 0);
    expect(second.body).toContain("<Hangup/>");
    expect(await esc()).toMatchObject({ state: "waiting", step: 1, lastOutcome: "invalid-key" });
    expect((await types()).filter((t) => t === "invalid-key")).toHaveLength(3);
  });

  it("no key at all: moves on", async () => {
    const r = await hook("/twilio/gather", { Digits: "" }, 0);
    expect(r.body).toContain("No key was pressed.");
    expect(await esc()).toMatchObject({ step: 1, lastOutcome: "no-input" });
  });

  it("an acknowledgement in the UI mid-sequence stops every further call", async () => {
    await hook("/twilio/status", { CallStatus: "no-answer" }, 0);
    await db.collection(cfg.incidentCollection).doc("inc1").update({ status: "acknowledged", statusChangedBy: "op1" });
    clock = at(13);
    await tick();
    expect(placed).toHaveLength(1);
    expect(await esc()).toMatchObject({ open: false, state: "acknowledged" });
    expect((await types()).at(-1)).toBe("acknowledged");
  });

  it("a call Twilio refused is recorded and the sequence moves on", async () => {
    await hook("/twilio/status", { CallStatus: "no-answer" }, 0);
    refuseCalls = true;
    clock = at(12);
    await tick();
    expect(await types()).toContain("refused");
    expect(await esc()).toMatchObject({ step: 2, lastOutcome: "failed" });
  });

  it("a call whose end is never reported is given up on, not dialled again", async () => {
    clock = at(19);
    await tick();
    expect(placed).toHaveLength(1);
    clock = at(21);
    await tick();
    expect(await esc()).toMatchObject({ lastOutcome: "lost", step: 1 });
    clock = at(23);
    await tick();
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1, PHONES.p1]);
  });

  it("refuses a webhook with a bad signature, or one whose query was changed, and changes nothing", async () => {
    const bad = await hook("/twilio/gather", { Digits: "1" }, 0, { signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    expect(bad.status).toBe(403);
    // Signed for step 1, sent for step 0.
    const signedFor1 = twilioSignature(AUTH_TOKEN, `${BASE}/twilio/gather?e=${CYCLE}&s=1`, { Digits: "1" });
    expect((await hook("/twilio/gather", { Digits: "1" }, 0, { signature: signedFor1 })).status).toBe(403);
    // A signature over different parameters: Digits changed in flight.
    const signedFor3 = twilioSignature(AUTH_TOKEN, `${BASE}/twilio/gather?e=${CYCLE}&s=0`, { Digits: "3" });
    expect((await hook("/twilio/gather", { Digits: "1" }, 0, { signature: signedFor3 })).status).toBe(403);
    expect(await esc()).toMatchObject({ open: true, state: "calling" });
    expect(await types()).toEqual(["armed", "calling", "placed"]);
    // The same request, correctly signed, is accepted.
    expect((await hook("/twilio/gather", { Digits: "1" }, 0)).status).toBe(200);
    expect((await esc())?.state).toBe("acknowledged");
  });

  it("masks every number in the run events, and names people only by role", async () => {
    await hook("/twilio/gather", { Digits: "2" }, 0);
    await hook("/twilio/status", { CallStatus: "no-answer" }, 0);
    const all = JSON.stringify(await events());
    for (const phone of Object.values(PHONES)) expect(all).not.toContain(phone.slice(1));
    expect(all).not.toContain("Person p1");
    expect(all).toContain("+1 ••• ••• ••01");
  });
});

describe("quiet hours and the daily cap", () => {
  it("holds a non-critical incident through the quiet hours, then calls", async () => {
    await setPolicy({ quietStart: "11:00", quietEnd: "13:00", timeZone: "UTC" });
    await seedPeople(ROTA);
    clock = at(10);
    await tick();
    await tick();
    expect(placed).toHaveLength(0);
    expect((await types()).filter((t) => t === "held")).toHaveLength(1);
    clock = at(61);
    await tick();
    expect(placed.map((p) => p.to)).toEqual([PHONES.p1]);
  });

  it("a critical incident (a regression, or enough occurrences) rings during the quiet hours", async () => {
    await setPolicy({ quietStart: "11:00", quietEnd: "13:00", timeZone: "UTC", criticalOccurrences: 50 });
    await seedPeople(ROTA);
    await seed({ occurrenceCount: 50 });
    await seed({ cycleId: "inc2_r0", incidentId: "inc2", status: "recurred" });
    clock = at(10);
    await tick();
    expect(placed).toHaveLength(2);
    expect((await events()).find((e) => e.type === "calling")?.summary).toContain("critical");
  });

  it("skips a person who reached the daily cap and calls the next", async () => {
    await setPolicy({ dailyCapPerPerson: 1 });
    await seedPeople(ROTA);
    await seed({ cycleId: "inc2_r0", incidentId: "inc2" });
    clock = at(10);
    await tick();
    // One call to the primary for the first cycle; the second finds the primary capped and phones the secondary.
    expect(placed.map((p) => p.to).sort()).toEqual([PHONES.p1, PHONES.p2].sort());
    const skipped = [...(await events(CYCLE)), ...(await events("inc2_r0"))].filter((e) => e.type === "skipped");
    expect(skipped.some((e) => e.summary.includes("call cap"))).toBe(true);
  });
});

describe("idempotency", () => {
  it("two (or five) concurrent passes start one sequence and place one call", async () => {
    await setPolicy();
    await seedPeople(ROTA);
    clock = at(10);
    await Promise.all(Array.from({ length: 5 }, (_, i) => tick({ owner: `worker-${i}` })));
    expect(placed).toHaveLength(1);
    expect((await types()).filter((t) => t === "armed")).toHaveLength(1);
    expect((await types()).filter((t) => t === "calling")).toHaveLength(1);
    const seqs = (await events()).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    await Promise.all(Array.from({ length: 5 }, (_, i) => tick({ owner: `worker-${i}` })));
    expect(placed).toHaveLength(1);
    const caps = await db.collection(cfg.escalationCollection).where("personId", "==", "p1").get();
    expect(caps.docs.map((d) => d.get("count"))).toEqual([1]);
  });
});
