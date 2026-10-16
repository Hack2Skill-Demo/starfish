/**
 * Cycles, leases and run events against the real Firestore emulator: the contention, crash and
 * takeover cases a fake cannot express. Time is passed in, so nothing here sleeps.
 * Run via `pnpm test:emulator`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { acquireLease, appendEventsInTransaction, countSpend, cycleId, finishCycle, recordEvent, recordPrState, releaseLease, renewLease, sanitizeEvent, type CycleConfig, type CycleKey, type PrStateRecord } from "./cycle.js";
import { SEEDED_SECRETS } from "../ingest/testSecrets.js";
import { causeClass } from "./reconsider.js";
import { PUBLIC_VIEW_OFF } from "../testConfig.js";

/** The structural cause class of the test incident below, which carries no error class, code or trace. */
const CAUSE = causeClass({});

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
  cfg = { cycleCollection: `cycles_${randomUUID().slice(0, 8)}`, leaseSeconds: 300, cycleDeadlineMinutes: 60, maxCycleAttempts: 3, ...PUBLIC_VIEW_OFF };
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

  it("released uncounted (the kill switch, #133), the next start is not another attempt, even at the cap; the next counted one is", async () => {
    cfg = { ...cfg, maxCycleAttempts: 1 };
    await acquireLease(db, cfg, key, "a", t0);
    await releaseLease(db, cfg, "inc1_r0", "a", at(1), "automation-disabled", { uncounted: true });
    expect(await cycle()).toMatchObject({ owner: null, resumeUncounted: true });
    expect(await acquireLease(db, cfg, key, "b", at(2))).toMatchObject({ acquired: true, attempt: 1, resumed: true });
    expect(await cycle()).toMatchObject({ attempts: 1, resumeUncounted: false });
    await releaseLease(db, cfg, "inc1_r0", "b", at(3), "model-call-failed");
    expect(await acquireLease(db, cfg, key, "c", at(4))).toEqual({ acquired: false, reason: "retries-exhausted" });
  });

  it("still ends at the deadline however often it is paused", async () => {
    cfg = { ...cfg, cycleDeadlineMinutes: 10 };
    await acquireLease(db, cfg, key, "a", t0);
    await releaseLease(db, cfg, "inc1_r0", "a", at(1), "automation-disabled", { uncounted: true });
    expect(await acquireLease(db, cfg, key, "b", new Date(t0.getTime() + 601_000))).toEqual({ acquired: false, reason: "deadline-passed" });
  });

  it("is fenced: only the current holder can release", async () => {
    await acquireLease(db, cfg, key, "a", t0);
    expect(await releaseLease(db, cfg, "inc1_r0", "intruder", at(1), "x")).toEqual({ ok: false, reason: "lease-lost" });
    expect((await cycle()).owner).toBe("a");
  });
});

describe("countSpend: the budget and the revision are the cycle's (#182)", () => {
  it("counts under the fence, and a resumed attempt starts from what earlier ones spent", async () => {
    const r = await acquireLease(db, cfg, key, "worker-a", t0);
    expect(r).toMatchObject({ acquired: true, modelCalls: 0, revisions: 0 });
    expect(await countSpend(db, cfg, "inc1_r0", "worker-a", at(1), "modelCalls")).toEqual({ ok: true, count: 1 });
    expect(await countSpend(db, cfg, "inc1_r0", "worker-a", at(2), "modelCalls")).toEqual({ ok: true, count: 2 });
    expect(await countSpend(db, cfg, "inc1_r0", "worker-a", at(3), "revisions")).toEqual({ ok: true, count: 1 });
    // Another worker takes over once the lease runs out: it goes on from the cycle's counts, and the old one counts nothing.
    const b = await acquireLease(db, cfg, key, "worker-b", at(400));
    expect(b).toMatchObject({ acquired: true, attempt: 2, modelCalls: 2, revisions: 1 });
    expect(await countSpend(db, cfg, "inc1_r0", "worker-a", at(401), "modelCalls")).toEqual({ ok: false, reason: "lease-lost" });
    expect(await cycle()).toMatchObject({ modelCalls: 2, revisions: 1 });
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

describe("recordPrState: a finished cycle's pull request, read back later (#17)", () => {
  const SHA = "b".repeat(40);
  const obs = (over: Partial<PrStateRecord> = {}): PrStateRecord => ({
    number: 7,
    state: "open",
    mergedAt: null,
    closedAt: null,
    headSha: SHA,
    checks: "pending",
    checksPassed: 0,
    checksRequired: 1,
    checkedAt: at(100).toISOString(),
    ...over,
  });
  /** A cycle that opened PR #7 and finished. */
  const prCycle = async () => {
    const r = await acquireLease(db, cfg, key, "a", t0);
    if (!r.acquired) throw new Error("no lease");
    await recordEvent(db, cfg, r.cycleId, "a", at(1), { stage: "pr", type: "opened", summary: "opened", record: { opened: true, number: 7, url: "https://github.com/acme/shop/pull/7" } });
    await finishCycle(db, cfg, r.cycleId, "a", at(2), "done", "pr-opened", "pr");
    return r.cycleId;
  };

  it("records the state on the run record and changes nothing else about the cycle", async () => {
    const id = await prCycle();
    const before = await cycle();
    expect(await recordPrState(db, cfg, id, obs({ checks: "failed", failedChecks: "verify" }))).toEqual({ ok: true, applied: true });
    const after = await cycle();
    expect(after.summary.prState).toEqual(obs({ checks: "failed", failedChecks: "verify" }));
    for (const k of ["state", "outcome", "path", "owner", "attempts", "eventCount"]) expect(after[k], k).toEqual(before[k]);
    expect(after.updatedAt.toMillis()).toBe(before.updatedAt.toMillis());
    expect(after.summary.pr).toEqual(before.summary.pr);
    expect(await events()).toHaveLength(1);
  });

  it("ignores an observation no newer than the recorded one: a duplicate, or a slow reader landing late", async () => {
    const id = await prCycle();
    await recordPrState(db, cfg, id, obs({ state: "closed", checkedAt: at(200).toISOString() }));
    expect(await recordPrState(db, cfg, id, obs({ state: "closed", checkedAt: at(200).toISOString() }))).toEqual({ ok: true, applied: false, reason: "stale" });
    expect(await recordPrState(db, cfg, id, obs({ state: "open", checkedAt: at(150).toISOString() }))).toEqual({ ok: true, applied: false, reason: "stale" });
    expect((await cycle()).summary.prState.state).toBe("closed");
    // A closed PR may really be reopened: a newer read says so.
    expect(await recordPrState(db, cfg, id, obs({ state: "open", checkedAt: at(300).toISOString() }))).toEqual({ ok: true, applied: true });
  });

  it("never takes a merged pull request back to open or closed, but keeps updating its checks", async () => {
    const id = await prCycle();
    await recordPrState(db, cfg, id, obs({ state: "merged", mergedAt: at(150).toISOString(), checkedAt: at(200).toISOString() }));
    expect(await recordPrState(db, cfg, id, obs({ state: "open", checkedAt: at(300).toISOString() }))).toEqual({ ok: true, applied: false, reason: "merged-is-final" });
    const later = obs({ state: "merged", mergedAt: at(150).toISOString(), checks: "passed", checksPassed: 1, checkedAt: at(400).toISOString() });
    expect(await recordPrState(db, cfg, id, later)).toEqual({ ok: true, applied: true });
    expect((await cycle()).summary.prState).toMatchObject({ state: "merged", checks: "passed" });
  });

  it("lands the newest of many concurrent observations, whatever order the writes commit in", async () => {
    const id = await prCycle();
    const seen = [
      obs({ checkedAt: at(110).toISOString() }),
      obs({ state: "merged", mergedAt: at(100).toISOString(), checkedAt: at(130).toISOString() }),
      obs({ state: "closed", checkedAt: at(120).toISOString() }),
    ];
    await Promise.all([...seen, ...seen].map((o) => recordPrState(db, cfg, id, o)));
    expect((await cycle()).summary.prState).toMatchObject({ state: "merged", checkedAt: at(130).toISOString() });
  });

  it("writes only to a done cycle that recorded opening THIS pull request", async () => {
    expect(await recordPrState(db, cfg, "inc1_r0", obs())).toEqual({ ok: false, reason: "no-such-cycle" });
    const r = await acquireLease(db, cfg, key, "a", t0);
    expect(await recordPrState(db, cfg, "inc1_r0", obs())).toEqual({ ok: false, reason: "not-a-pr-cycle" }); // still running
    if (r.acquired) await finishCycle(db, cfg, r.cycleId, "a", at(1), "waiting-human", "dry-run", "draft");
    expect(await recordPrState(db, cfg, "inc1_r0", obs())).toEqual({ ok: false, reason: "not-a-pr-cycle" }); // opened none
    expect((await cycle()).summary).toBeUndefined();
  });

  it("refuses another PR's number and a malformed observation, writing nothing", async () => {
    const id = await prCycle();
    expect(await recordPrState(db, cfg, id, obs({ number: 8 }))).toEqual({ ok: false, reason: "not-a-pr-cycle" });
    for (const bad of [obs({ headSha: "nope" }), obs({ checkedAt: "yesterday" }), obs({ state: "healed" as never }), obs({ number: 0 })]) {
      expect(await recordPrState(db, cfg, id, bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await recordPrState(db, cfg, "a/b", obs())).toEqual({ ok: false, reason: "invalid" });
    expect((await cycle()).summary.prState).toBeUndefined();
  });
});

describe("reconsidering a declined cycle (#8)", () => {
  const incidents = () => `${cfg.cycleCollection}_incidents`;
  const policy = () => ({ incidentCollection: incidents(), reconsiderCooldownMinutes: 30, reconsiderMaxPerDay: 3, reconsiderBurstOccurrences: 20 });
  const setIncident = (data: Record<string, unknown>) =>
    db.collection(incidents()).doc(key.incidentId).set({ environment: "demo", status: "new", occurrenceCount: 5, ...data });
  const mins = (m: number) => at(m * 60);

  /** A cycle declined at t0 + 1 s on 5 occurrences, with an issue already recorded on it. */
  async function declineAtStart() {
    await setIncident({});
    const r = await acquireLease(db, cfg, key, "a", t0);
    if (!r.acquired) throw new Error("setup");
    await countSpend(db, cfg, r.cycleId, "a", t0, "modelCalls");
    await recordEvent(db, cfg, r.cycleId, "a", t0, { stage: "triage", type: "decision", summary: "transient", record: { decision: "decline" } });
    await recordEvent(db, cfg, r.cycleId, "a", t0, { stage: "issue", type: "opened", summary: "Issue #7 filed", record: { state: "opened", number: 7, url: "https://x/7" } });
    await finishCycle(db, cfg, r.cycleId, "a", at(1), "declined", "model-decline", "decline", {
      rule: "model-decline",
      reason: "one-off",
      occurrenceCount: 5,
      counterCount: 5,
      counterWindow: "1h",
      causeClass: CAUSE,
    });
  }

  it("retries an exhausted run on request with fresh bounds, preserving its issue and index operation", async () => {
    await declineAtStart();
    const operation = "projects/demo-app-1/databases/(default)/operations/ABC123";
    await db.collection(cfg.cycleCollection).doc("inc1_r0").update({ state: "failed", attempts: 3, outcome: "retries-exhausted", path: "failed", "summary.index": { state: "building", operation, attemptedAt: t0.toISOString() } });
    expect(await acquireLease(db, cfg, key, "b", mins(61), { reconsider: policy() })).toMatchObject({ acquired: false });
    await setIncident({ retriageRequestedAt: Timestamp.fromDate(mins(61)) });
    const r = await acquireLease(db, cfg, key, "b", mins(62), { reconsider: policy() });
    expect(r).toMatchObject({ acquired: true, cycleId: "inc1_r0", attempt: 1, reconsidered: "operator", reopenedFrom: "failed" });
    const c = await cycle();
    expect(c.summary.issue.number).toBe(7);
    expect(c.summary.index.operation).toBe(operation);
    expect(c.deadlineAt.toMillis()).toBe(mins(122).getTime());
    expect(c.history[0].outcome).toBe("retries-exhausted");
    expect(await acquireLease(db, cfg, key, "c", mins(62), { reconsider: policy() })).toMatchObject({ acquired: false, reason: "held" });
  });

  it("keeps what the decline was decided on: when, the rule, the evidence and its window", async () => {
    await declineAtStart();
    const c = await cycle();
    expect(c.decision).toMatchObject({ rule: "model-decline", reason: "one-off", occurrenceCount: 5, counterCount: 5, counterWindow: "1h", causeClass: CAUSE });
    expect(c.decision.at.toMillis()).toBe(at(1).getTime());
  });

  it("without a policy, or without new evidence, a decline stays closed", async () => {
    await declineAtStart();
    expect(await acquireLease(db, cfg, key, "b", mins(60))).toEqual({ acquired: false, reason: "closed" });
    expect(await acquireLease(db, cfg, key, "b", mins(60), { reconsider: policy() })).toEqual({ acquired: false, reason: "closed" });
  });

  it("reopens the SAME cycle on a burst after the cooldown: fresh deadline and attempts, history kept, issue kept", async () => {
    await declineAtStart();
    await setIncident({ occurrenceCount: 40 });
    expect(await acquireLease(db, cfg, key, "b", mins(10), { reconsider: policy() })).toEqual({ acquired: false, reason: "closed" }); // cooldown
    const r = await acquireLease(db, cfg, key, "b", mins(31), { reconsider: policy() });
    expect(r).toMatchObject({ acquired: true, cycleId: "inc1_r0", attempt: 1, resumed: false, reconsidered: "burst" });
    const c = await cycle();
    expect(c).toMatchObject({ state: "running", owner: "b", attempts: 1, reconsiderCount: 1, reconsideredBecause: "burst", eventCount: 2, modelCalls: 0, revisions: 0 });
    expect(c.deadlineAt.toMillis()).toBe(mins(31 + 60).getTime());
    expect(c.decision).toBeUndefined();
    expect(c.outcome).toBeUndefined();
    expect(c.history).toHaveLength(1);
    expect(c.history[0]).toMatchObject({ rule: "model-decline", occurrenceCount: 5, outcome: "model-decline" });
    expect(c.summary.issue).toMatchObject({ number: 7 }); // one issue per recurrence, still
    expect(c.summary.triage).toBeUndefined(); // the earlier decision is in history and the events, not shown as current
    expect(c.startDays).toEqual(["2026-10-04"]);
    // The events go on after the earlier ones.
    if (r.acquired) expect((await recordEvent(db, cfg, r.cycleId, "b", mins(32), ev("again"))).seq).toBe(3);
  });

  it("an operator's request reopens it within the cooldown; a request older than the decision does not", async () => {
    await declineAtStart();
    await setIncident({ retriageRequestedAt: t0 });
    expect(await acquireLease(db, cfg, key, "b", mins(2), { reconsider: policy() })).toEqual({ acquired: false, reason: "closed" });
    await setIncident({ retriageRequestedAt: mins(1) });
    expect(await acquireLease(db, cfg, key, "b", mins(2), { reconsider: policy() })).toMatchObject({ acquired: true, reconsidered: "operator" });
  });

  it("only one of many concurrent reconsiderations gets it", async () => {
    await declineAtStart();
    await setIncident({ retriageRequestedAt: mins(1) });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => acquireLease(db, cfg, key, `w${i}`, mins(2), { reconsider: policy() })));
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
    expect(results.filter((r) => !r.acquired).every((r) => !r.acquired && r.reason === "held")).toBe(true);
    expect((await cycle()).reconsiderCount).toBe(1);
  });

  it("never reopens over an operator's ignore", async () => {
    await declineAtStart();
    await setIncident({ status: "ignored", occurrenceCount: 500, retriageRequestedAt: mins(1) });
    expect(await acquireLease(db, cfg, key, "b", mins(40), { reconsider: policy() })).toEqual({ acquired: false, reason: "closed" });
    expect((await cycle()).state).toBe("declined");
  });

  it("is capped per 24 hours: the fourth reconsideration in a day is refused", async () => {
    await declineAtStart();
    let count = 5;
    let t = 1;
    for (let i = 0; i < 3; i++) {
      t += 31;
      count += 20;
      await setIncident({ occurrenceCount: count });
      const r = await acquireLease(db, cfg, key, `w${i}`, mins(t), { reconsider: policy() });
      expect(r).toMatchObject({ acquired: true, reconsidered: "burst" });
      if (r.acquired) await finishCycle(db, cfg, r.cycleId, `w${i}`, mins(t), "declined", "model-decline", "decline", { rule: "model-decline", occurrenceCount: count, causeClass: CAUSE });
    }
    t += 31;
    await setIncident({ occurrenceCount: count + 100, retriageRequestedAt: mins(t - 1) });
    expect(await acquireLease(db, cfg, key, "late", mins(t), { reconsider: policy() })).toEqual({ acquired: false, reason: "closed" });
    expect((await cycle()).history).toHaveLength(3);
    // A day after the first reconsideration there is room again.
    expect(await acquireLease(db, cfg, key, "next-day", mins(33 + 24 * 60), { reconsider: policy() })).toMatchObject({ acquired: true });
    expect((await cycle()).startDays).toEqual(["2026-10-04", "2026-10-05"]);
  });
});

describe("retrying a cycle that ended waiting-human, on a person's request (#317)", () => {
  const incidents = () => `${cfg.cycleCollection}_incidents`;
  const policy = () => ({ incidentCollection: incidents(), reconsiderCooldownMinutes: 30, reconsiderMaxPerDay: 3, reconsiderBurstOccurrences: 20 });
  const setIncident = (data: Record<string, unknown>) =>
    db.collection(incidents()).doc(key.incidentId).set({ environment: "demo", status: "new", occurrenceCount: 5, ...data });
  const mins = (m: number) => at(m * 60);

  /** A fix the gate refused: the issue filed, the team alerted, a person told, then the cycle waits for them. */
  async function refusedFix() {
    await setIncident({});
    const r = await acquireLease(db, cfg, key, "a", t0);
    if (!r.acquired) throw new Error("setup");
    await recordEvent(db, cfg, r.cycleId, "a", t0, { stage: "triage", type: "decision", summary: "act", record: { decision: "act" } });
    await recordEvent(db, cfg, r.cycleId, "a", t0, { stage: "issue", type: "opened", summary: "Issue #7 filed", record: { state: "opened", number: 7, url: "https://x/7" } });
    await recordEvent(db, cfg, r.cycleId, "a", t0, { stage: "alert", type: "sent", summary: "The team was alerted", record: { state: "sent", attempts: 1 } });
    await recordEvent(db, cfg, r.cycleId, "a", t0, { stage: "verify", type: "rejected", summary: "The patch does not apply", record: { status: "rejected", rule: "patch-does-not-apply" } });
    await recordEvent(db, cfg, r.cycleId, "a", t0, { stage: "notify", type: "sent", summary: "A person was told", record: { state: "sent", attempts: 1 } });
    await finishCycle(db, cfg, r.cycleId, "a", at(1), "waiting-human", "verify-patch-does-not-apply", "human");
  }

  it("without a request it stays closed, however often it is asked", async () => {
    await refusedFix();
    for (const m of [5, 60, 600]) {
      expect(await acquireLease(db, cfg, key, "b", mins(m), { reconsider: policy() })).toEqual({ acquired: false, reason: "waiting-human" });
    }
    expect((await cycle()).state).toBe("waiting-human");
  });

  it("reopens the same cycle on a request, and keeps the issue, the alert and the message already sent", async () => {
    await refusedFix();
    await setIncident({ retriageRequestedAt: mins(2) });
    const r = await acquireLease(db, cfg, key, "b", mins(3), { reconsider: policy() });
    expect(r).toMatchObject({ acquired: true, cycleId: "inc1_r0", attempt: 1, resumed: false, reconsidered: "operator" });
    const c = await cycle();
    expect(c).toMatchObject({ state: "running", owner: "b", reconsiderCount: 1, reconsideredBecause: "operator", modelCalls: 0, revisions: 0 });
    // What was already done is not done twice: the loop reuses the issue and never resends a recorded delivery.
    expect(c.summary.issue).toMatchObject({ state: "opened", number: 7 });
    expect(c.summary.alert).toMatchObject({ state: "sent" });
    expect(c.summary.notify).toMatchObject({ state: "sent" });
    // What the refused attempt concluded is cleared so the retry decides afresh; it is in the events and `history`.
    expect(c.summary.verify).toBeUndefined();
    expect(c.outcome).toBeUndefined();
    expect(c.history).toHaveLength(1);
  });

  it("is idempotent: the same request does not reopen it a second time, and the same state is reached again", async () => {
    await refusedFix();
    await setIncident({ retriageRequestedAt: mins(2) });
    const r = await acquireLease(db, cfg, key, "b", mins(3), { reconsider: policy() });
    if (!r.acquired) throw new Error("setup");
    // The retry ends the way the first attempt did (nothing in Starfish changed): the same state and outcome.
    await finishCycle(db, cfg, r.cycleId, "b", mins(4), "waiting-human", "verify-patch-does-not-apply", "human");
    expect((await cycle())).toMatchObject({ state: "waiting-human", outcome: "verify-patch-does-not-apply" });
    // The request that caused the retry is older than this settle: it is spent. Only a new one starts it again.
    expect(await acquireLease(db, cfg, key, "c", mins(5), { reconsider: policy() })).toEqual({ acquired: false, reason: "waiting-human" });
    await setIncident({ retriageRequestedAt: mins(6) });
    expect(await acquireLease(db, cfg, key, "c", mins(7), { reconsider: policy() })).toMatchObject({ acquired: true, reconsidered: "operator" });
    expect((await cycle()).reconsiderCount).toBe(2);
  });

  // #365: the phone escalation (and Twilio's webhooks) append events to the waiting cycle, which moves its updatedAt. A
  // retry asked before such an event was read as older than the cycle and lost.
  it("still reopens on a request made before an escalation event landed on the waiting cycle (#365)", async () => {
    await refusedFix();
    expect((await cycle()).settledAt.toMillis()).toBe(at(1).getTime());
    await setIncident({ retriageRequestedAt: mins(2) });
    const ref = db.collection(cfg.cycleCollection).doc("inc1_r0");
    const appended = await db.runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data();
      return appendEventsInTransaction(tx, ref, d, mins(2.5), [{ stage: "escalation", type: "call-placed", summary: "Called the primary on-call" }], PUBLIC_VIEW_OFF);
    });
    expect(appended).toBe(true);
    const settled = await cycle();
    expect(settled.updatedAt.toMillis()).toBe(mins(2.5).getTime());
    expect(settled.settledAt.toMillis()).toBe(at(1).getTime());
    expect(await acquireLease(db, cfg, key, "b", mins(3), { reconsider: policy() })).toMatchObject({ acquired: true, reconsidered: "operator" });
    // Still once only: the retried run settles after the request, so the same request does not start it again.
    await finishCycle(db, cfg, "inc1_r0", "b", mins(4), "waiting-human", "verify-patch-does-not-apply", "human");
    expect(await acquireLease(db, cfg, key, "c", mins(5), { reconsider: policy() })).toEqual({ acquired: false, reason: "waiting-human" });
  });

  it("never reopens over an ignored or resolved incident, or one whose pull request is open", async () => {
    await refusedFix();
    await setIncident({ status: "resolved", retriageRequestedAt: mins(2) });
    expect(await acquireLease(db, cfg, key, "b", mins(3), { reconsider: policy() })).toEqual({ acquired: false, reason: "waiting-human" });
    await setIncident({ retriageRequestedAt: mins(2) });
    await db.collection(cfg.cycleCollection).doc("inc1_r0").update({ "summary.pr": { opened: true, number: 9 } });
    expect(await acquireLease(db, cfg, key, "b", mins(3), { reconsider: policy() })).toEqual({ acquired: false, reason: "waiting-human" });
  });
});
