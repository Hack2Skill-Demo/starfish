/**
 * Cycles, leases and run events against the real Firestore emulator: the contention, crash and
 * takeover cases a fake cannot express. Time is passed in, so nothing here sleeps.
 * Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { acquireLease, cycleId, finishCycle, recordEvent, releaseLease, renewLease, sanitizeEvent, type CycleConfig, type CycleKey } from "./cycle.js";
import { SEEDED_SECRETS } from "../ingest/testSecrets.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("cycle.emulator.test.ts needs the Firestore emulator: run `pnpm test:emulator`");
}

const app = initializeApp({ projectId: "demo-starfish-rules" }, "cycle-emulator-tests");
const db: Firestore = getFirestore(app, "cycle-tests");
afterAll(() => deleteApp(app));

const t0 = new Date("2026-10-04T12:00:00.000Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
const key: CycleKey = { incidentId: "inc1", environment: "demo", recurrence: 0 };

let cfg: CycleConfig;
beforeEach(() => {
  cfg = { cycleCollection: `cycles_${randomUUID().slice(0, 8)}`, leaseSeconds: 300, cycleDeadlineMinutes: 60, maxCycleAttempts: 3 };
});

const cycle = async (k: CycleKey = key) => (await db.collection(cfg.cycleCollection).doc(cycleId(k)!).get()).data()!;
const events = async (k: CycleKey = key) =>
  (await db.collection(cfg.cycleCollection).doc(cycleId(k)!).collection("events").orderBy("seq").get()).docs.map((d) => d.data());
const ev = (summary = "did a thing") => ({ stage: "triage", type: "decision", summary });

describe("acquireLease", () => {
  it("creates a running cycle for the incident and recurrence, held by the caller", async () => {
    const r = await acquireLease(db, cfg, key, "worker-a", t0);
    expect(r).toMatchObject({ acquired: true, cycleId: "inc1_r0", attempt: 1, resumed: false });
    expect(await cycle()).toMatchObject({ incidentId: "inc1", environment: "demo", recurrence: 0, state: "running", attempts: 1, owner: "worker-a", eventCount: 0 });
  });

  it("gives a regression its own cycle, and leaves the earlier one alone", async () => {
    const first = await acquireLease(db, cfg, key, "worker-a", t0);
    if (first.acquired) await finishCycle(db, cfg, first.cycleId, "worker-a", at(1), "done", "pr-opened");
    const again = await acquireLease(db, cfg, { ...key, recurrence: 1 }, "worker-a", at(2));
    expect(again).toMatchObject({ acquired: true, cycleId: "inc1_r1", attempt: 1 });
    expect((await cycle()).state).toBe("done");
  });

  it("lets exactly one of many concurrent workers have it", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireLease(db, cfg, key, `worker-${i}`, t0)));
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
    expect(results.filter((r) => !r.acquired).every((r) => !r.acquired && r.reason === "held")).toBe(true);
    expect((await cycle()).attempts).toBe(1);
  });

  it("refuses another worker while the lease is live, and treats the holder's own call as a renewal", async () => {
    await acquireLease(db, cfg, key, "worker-a", t0);
    expect(await acquireLease(db, cfg, key, "worker-b", at(10))).toEqual({ acquired: false, reason: "held" });
    const renewed = await acquireLease(db, cfg, key, "worker-a", at(10));
    expect(renewed).toMatchObject({ acquired: true, attempt: 1, resumed: false });
  });

  it("lets another worker resume the cycle once the lease has run out, counting another attempt", async () => {
    await acquireLease(db, cfg, key, "worker-a", t0);
    const resumed = await acquireLease(db, cfg, key, "worker-b", at(301));
    expect(resumed).toMatchObject({ acquired: true, attempt: 2, resumed: true });
    expect(await cycle()).toMatchObject({ owner: "worker-b", attempts: 2, state: "running" });
  });

  it("gives up after the configured number of starts instead of retrying forever", async () => {
    cfg = { ...cfg, maxCycleAttempts: 2 };
    await acquireLease(db, cfg, key, "a", t0);
    await acquireLease(db, cfg, key, "b", at(301));
    expect(await acquireLease(db, cfg, key, "c", at(700))).toEqual({ acquired: false, reason: "retries-exhausted" });
    expect(await cycle()).toMatchObject({ state: "failed", outcome: "retries-exhausted" });
    expect(await acquireLease(db, cfg, key, "d", at(1000))).toEqual({ acquired: false, reason: "closed" });
  });

  it("never extends a lease past the cycle's deadline", async () => {
    cfg = { ...cfg, leaseSeconds: 3600, cycleDeadlineMinutes: 10 };
    const r = await acquireLease(db, cfg, key, "a", t0);
    expect(r.acquired && r.leaseExpiresAt.getTime()).toBe(at(600).getTime());
    const renewed = await renewLease(db, cfg, "inc1_r0", "a", at(500));
    expect(renewed.ok && renewed.leaseExpiresAt?.getTime()).toBe(at(600).getTime());
  });

  it("fails a cycle that is past its deadline, whoever asks", async () => {
    cfg = { ...cfg, cycleDeadlineMinutes: 10 };
    await acquireLease(db, cfg, key, "a", t0);
    expect(await acquireLease(db, cfg, key, "b", at(601))).toEqual({ acquired: false, reason: "deadline-passed" });
    expect(await cycle()).toMatchObject({ state: "failed", outcome: "deadline-passed" });
  });

  it("does not hand out a finished cycle, or one waiting for a person", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    await finishCycle(db, cfg, "inc1_r0", "a", at(1), "waiting-human", "needs review");
    expect(await acquireLease(db, cfg, key, "b", at(2))).toEqual({ acquired: false, reason: "waiting-human" });

    const k2 = { ...key, incidentId: "inc2" };
    await acquireLease(db, cfg, k2, "a", t0);
    await finishCycle(db, cfg, "inc2_r0", "a", at(1), "declined", "noise");
    expect(await acquireLease(db, cfg, k2, "b", at(2))).toEqual({ acquired: false, reason: "closed" });
  });

  it.each([
    ["an id with a slash", { ...key, incidentId: "a/b" }],
    ["an empty id", { ...key, incidentId: "" }],
    ["a negative recurrence", { ...key, recurrence: -1 }],
    ["a fractional recurrence", { ...key, recurrence: 1.5 }],
  ])("refuses %s", async (_name, k) => {
    expect(await acquireLease(db, cfg, k, "a", t0)).toEqual({ acquired: false, reason: "invalid-key" });
  });
});

describe("fencing: a worker that lost its lease can do nothing", () => {
  it("cannot record events or finish after another worker took over", async () => {
    await acquireLease(db, cfg, key, "worker-a", t0);
    await recordEvent(db, cfg, "inc1_r0", "worker-a", at(5), ev("first"));
    await acquireLease(db, cfg, key, "worker-b", at(301));

    expect(await recordEvent(db, cfg, "inc1_r0", "worker-a", at(302), ev("late write from the old worker"))).toEqual({ ok: false, reason: "lease-lost" });
    expect(await finishCycle(db, cfg, "inc1_r0", "worker-a", at(302), "done", "pr-opened")).toEqual({ ok: false, reason: "lease-lost" });
    expect(await renewLease(db, cfg, "inc1_r0", "worker-a", at(302))).toEqual({ ok: false, reason: "lease-lost" });

    expect((await events()).map((e) => e.summary)).toEqual(["first"]);
    expect(await cycle()).toMatchObject({ state: "running", owner: "worker-b" });
  });

  it("an expired lease counts as lost even if nobody has taken over yet", async () => {
    await acquireLease(db, cfg, key, "worker-a", t0);
    expect(await recordEvent(db, cfg, "inc1_r0", "worker-a", at(301), ev())).toEqual({ ok: false, reason: "lease-lost" });
    expect(await renewLease(db, cfg, "inc1_r0", "worker-a", at(301))).toEqual({ ok: false, reason: "lease-lost" });
  });

  it("a worker that never held the lease cannot write", async () => {
    await acquireLease(db, cfg, key, "worker-a", t0);
    expect(await recordEvent(db, cfg, "inc1_r0", "intruder", at(5), ev())).toEqual({ ok: false, reason: "lease-lost" });
    expect(await events()).toHaveLength(0);
  });

  it("says so for a cycle that does not exist", async () => {
    expect(await recordEvent(db, cfg, "nope_r0", "a", t0, ev())).toEqual({ ok: false, reason: "no-such-cycle" });
    expect(await finishCycle(db, cfg, "nope_r0", "a", t0, "done", "x")).toEqual({ ok: false, reason: "no-such-cycle" });
    expect(await renewLease(db, cfg, "nope_r0", "a", t0)).toEqual({ ok: false, reason: "no-such-cycle" });
  });

  it("finishing releases the lease", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    expect(await finishCycle(db, cfg, "inc1_r0", "a", at(1), "done", "pr-opened")).toEqual({ ok: true });
    expect(await cycle()).toMatchObject({ state: "done", outcome: "pr-opened", owner: null, leaseExpiresAt: null });
    expect(await recordEvent(db, cfg, "inc1_r0", "a", at(2), ev())).toEqual({ ok: false, reason: "lease-lost" });
  });
});

describe("releaseLease", () => {
  it("lets another worker take the cycle straight away, as another attempt", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    expect(await releaseLease(db, cfg, "inc1_r0", "a", at(1), "counter-check missing")).toEqual({ ok: true });
    expect(await cycle()).toMatchObject({ state: "running", owner: null, releasedBecause: "counter-check missing" });
    expect(await acquireLease(db, cfg, key, "b", at(2))).toMatchObject({ acquired: true, attempt: 2, resumed: true });
  });

  it("is bounded by the attempts cap, so a cycle that keeps being released ends", async () => {
    cfg = { ...cfg, maxCycleAttempts: 2 };
    await acquireLease(db, cfg, key, "a", t0);
    await releaseLease(db, cfg, "inc1_r0", "a", at(1), "x");
    await acquireLease(db, cfg, key, "b", at(2));
    await releaseLease(db, cfg, "inc1_r0", "b", at(3), "x");
    expect(await acquireLease(db, cfg, key, "c", at(4))).toEqual({ acquired: false, reason: "retries-exhausted" });
  });

  it("is fenced: only the current holder can release", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    expect(await releaseLease(db, cfg, "inc1_r0", "intruder", at(1), "x")).toEqual({ ok: false, reason: "lease-lost" });
    expect((await cycle()).owner).toBe("a");
  });
});

describe("run events", () => {
  it("get contiguous sequence numbers, under concurrency too", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => recordEvent(db, cfg, "inc1_r0", "a", at(i), ev(`event ${i}`))));
    expect(results.every((r) => r.ok)).toBe(true);
    const stored = await events();
    expect(stored.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(stored.map((e) => e.summary)).size).toBe(8);
    expect((await cycle()).eventCount).toBe(8);
  });

  it("continue the sequence when another worker resumes the cycle after a crash", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    await recordEvent(db, cfg, "inc1_r0", "a", at(1), ev("a1"));
    await recordEvent(db, cfg, "inc1_r0", "a", at(2), ev("a2"));
    await acquireLease(db, cfg, key, "b", at(400));
    await recordEvent(db, cfg, "inc1_r0", "b", at(401), ev("b3"));
    expect((await events()).map((e) => [e.seq, e.summary])).toEqual([[1, "a1"], [2, "a2"], [3, "b3"]]);
  });

  it("carry the environment, the stage and the time, for the screens that read them", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    await recordEvent(db, cfg, "inc1_r0", "a", at(7), { stage: "verify", type: "passed", summary: "ok", data: { exitCode: 0 } });
    const [e] = await events();
    expect(e).toMatchObject({ seq: 1, environment: "demo", stage: "verify", type: "passed", summary: "ok", data: { exitCode: 0 } });
    expect(e!.at.toMillis()).toBe(at(7).getTime());
    expect((await cycle()).stage).toBe("verify");
  });

  it("are redacted before they are stored", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    await recordEvent(db, cfg, "inc1_r0", "a", at(1), {
      stage: "fix",
      type: "proposed",
      summary: `used ${SEEDED_SECRETS.github}`,
      data: { note: `key ${SEEDED_SECRETS.stripe}`, apiToken: "should-be-dropped" },
    });
    const stored = JSON.stringify(await events());
    expect(stored).not.toContain(SEEDED_SECRETS.github);
    expect(stored).not.toContain(SEEDED_SECRETS.stripe);
    expect(stored).not.toContain("should-be-dropped");
  });
});

describe("the run record on the cycle", () => {
  const rec = (stage: string, record: Record<string, string | number | boolean | null>) => ({ stage, type: "x", summary: "s", record });

  it("keeps each stage's part under summary.<stage>, replacing that stage's earlier entry", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    await recordEvent(db, cfg, "inc1_r0", "a", at(1), rec("triage", { decision: "act", rule: "model-act" }));
    await recordEvent(db, cfg, "inc1_r0", "a", at(2), rec("verify", { status: "failed", files: 1 }));
    await recordEvent(db, cfg, "inc1_r0", "a", at(3), rec("verify", { status: "passed", files: 1 }));
    expect((await cycle()).summary).toEqual({ triage: { decision: "act", rule: "model-act" }, verify: { status: "passed", files: 1 } });
  });

  it("has no entry for a stage that did not run, rather than a faked one", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    await recordEvent(db, cfg, "inc1_r0", "a", at(1), rec("triage", { decision: "decline" }));
    expect(Object.keys((await cycle()).summary)).toEqual(["triage"]);
  });

  it("is written only by the lease holder, in the same transaction as the event", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    await acquireLease(db, cfg, key, "b", at(400));
    expect(await recordEvent(db, cfg, "inc1_r0", "a", at(401), rec("triage", { decision: "act" }))).toEqual({ ok: false, reason: "lease-lost" });
    expect((await cycle()).summary).toBeUndefined();
    expect(await events()).toHaveLength(0);
  });

  it("is redacted and bounded like the event, and drops sensitive keys", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    await recordEvent(db, cfg, "inc1_r0", "a", at(1), rec("fix", { rootCause: `leak ${SEEDED_SECRETS.github} ` + "x".repeat(2000), apiToken: "drop-me" }));
    const stored = (await cycle()).summary.fix;
    expect(JSON.stringify(stored)).not.toContain(SEEDED_SECRETS.github);
    expect(JSON.stringify(stored)).not.toContain("drop-me");
    expect(stored.rootCause.length).toBeLessThanOrEqual(300);
  });

  it("is not stored for a stage name that is not a plain word", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    await recordEvent(db, cfg, "inc1_r0", "a", at(1), rec("a.b/c", { x: 1 }));
    expect((await cycle()).summary).toBeUndefined();
  });

  it("records which way the cycle went when it finishes, and for the two failures the lease can cause", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    await finishCycle(db, cfg, "inc1_r0", "a", at(1), "done", "pr-opened", "pr");
    expect(await cycle()).toMatchObject({ state: "done", path: "pr" });

    cfg = { ...cfg, cycleDeadlineMinutes: 10 };
    const k2 = { ...key, incidentId: "inc2" };
    await acquireLease(db, cfg, k2, "a", t0);
    await acquireLease(db, cfg, k2, "b", at(601));
    expect(await cycle(k2)).toMatchObject({ state: "failed", outcome: "deadline-passed", path: "failed" });
  });
});

describe("sanitizeEvent", () => {
  it("drops sensitive-looking keys, odd keys and nested values, and bounds everything", () => {
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const clean = sanitizeEvent({
      stage: "s".repeat(500),
      type: "t",
      summary: "x".repeat(5000),
      data: { ok: "fine", password: "p", "bad key!": "v", nested: { a: 1 } as unknown as string, n: Number.NaN, big: "y".repeat(5000), ...wide },
    });
    expect(clean.stage.length).toBeLessThanOrEqual(40);
    expect(clean.summary.length).toBeLessThanOrEqual(300);
    expect(clean.data.ok).toBe("fine");
    expect(clean.data).not.toHaveProperty("password");
    expect(clean.data).not.toHaveProperty("bad key!");
    expect(clean.data).not.toHaveProperty("nested");
    expect(clean.data).not.toHaveProperty("n");
    expect(String(clean.data.big).length).toBeLessThanOrEqual(300);
    expect(Object.keys(clean.data).length).toBeLessThanOrEqual(20);
  });
});
