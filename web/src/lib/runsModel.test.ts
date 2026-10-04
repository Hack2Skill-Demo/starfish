import { describe, expect, it } from "vitest";
import {
  buildWaterfall,
  formatDuration,
  parseCycle,
  parseEvent,
  runStatus,
  safeUrl,
  triageRule,
  type CycleRow,
  type EventRow,
} from "./runsModel";

const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);

const cycleDoc = (over: Record<string, unknown> = {}) => ({
  incidentId: "inc-1",
  environment: "demo",
  recurrence: 0,
  state: "running",
  attempts: 1,
  eventCount: 0,
  createdAt: ts(T0),
  updatedAt: ts(T0),
  leaseExpiresAt: ts(T0 + 60_000),
  deadlineAt: ts(T0 + 600_000),
  ...over,
});

const cycle = (over: Partial<CycleRow> = {}): CycleRow => ({
  ...(parseCycle("inc-1_r0", cycleDoc()) as CycleRow),
  ...over,
});

let seq = 0;
const ev = (stage: string, type: string, offsetMs: number, summary = `${stage} ${type}`): EventRow => ({
  id: String(++seq).padStart(6, "0"),
  seq,
  stage,
  type,
  summary,
  at: new Date(T0 + offsetMs),
  data: {},
});

describe("parseCycle / parseEvent", () => {
  it("reads a cycle and keeps the stage records", () => {
    const c = parseCycle("inc-1_r0", cycleDoc({ path: "pr", outcome: "opened", summary: { pr: { url: "https://x.test/1", number: 1, bad: { nested: 1 } } } }));
    expect(c).toMatchObject({ id: "inc-1_r0", state: "running", path: "pr", outcome: "opened" });
    expect(c?.summary.pr).toEqual({ url: "https://x.test/1", number: 1 });
  });

  it("returns null, never throws, for a document it cannot use", () => {
    expect(parseCycle("x", {})).toBeNull();
    expect(parseCycle("x", cycleDoc({ state: "sleeping" }))).toBeNull();
    expect(parseCycle("x", cycleDoc({ createdAt: "yesterday" }))).toBeNull();
    expect(parseCycle("x", cycleDoc({ updatedAt: { toDate: () => new Date("garbage") } }))).toBeNull();
    expect(parseCycle("x", cycleDoc({ summary: "oops" }))?.summary).toEqual({});
  });

  it("drops an unknown path rather than showing it", () => {
    expect(parseCycle("x", cycleDoc({ path: "merge" }))?.path).toBeUndefined();
  });

  it("reads an event, and refuses one without a stage, a time or a whole sequence number", () => {
    expect(parseEvent("000001", { seq: 1, stage: "triage", type: "decision", summary: "act", at: ts(T0), data: { rule: "r" } })).toMatchObject({
      seq: 1,
      stage: "triage",
      data: { rule: "r" },
    });
    expect(parseEvent("a", { seq: 1, type: "x", at: ts(T0) })).toBeNull();
    expect(parseEvent("a", { seq: 1.5, stage: "fix", at: ts(T0) })).toBeNull();
    expect(parseEvent("a", { seq: 1, stage: "fix", at: "now" })).toBeNull();
  });
});

describe("runStatus", () => {
  it("is in progress only while a worker's lease is still good", () => {
    expect(runStatus(cycle(), T0 + 1000)).toMatchObject({ label: "In progress", live: true });
    expect(runStatus(cycle(), T0 + 61_000)).toMatchObject({ label: "Waiting for a worker", live: false });
    expect(runStatus(cycle({ leaseExpiresAt: null }), T0)).toMatchObject({ live: false });
  });

  it("names the other states, and a deadline as a timeout", () => {
    expect(runStatus(cycle({ state: "waiting-human" }), T0).label).toBe("Waiting for a human");
    expect(runStatus(cycle({ state: "declined" }), T0).label).toBe("Declined");
    expect(runStatus(cycle({ state: "done" }), T0).label).toBe("Done");
    expect(runStatus(cycle({ state: "failed", outcome: "deadline-passed" }), T0).label).toBe("Timed out");
    expect(runStatus(cycle({ state: "failed", outcome: "model-error" }), T0).label).toBe("Failed");
  });
});

describe("buildWaterfall", () => {
  it("marks a stage without an event as not reached, never done", () => {
    const c = cycle({ state: "declined", leaseExpiresAt: null, updatedAt: new Date(T0 + 5000) });
    const w = buildWaterfall(c, [ev("triage", "decision", 5000)], T0 + 10_000);
    expect(w.steps.map((s) => [s.stage, s.status])).toEqual([
      ["triage", "done"],
      ["fix", "not-reached"],
      ["verify", "not-reached"],
      ["review", "not-reached"],
      ["pr", "not-reached"],
    ]);
  });

  it("shows only the step after the last one done as running, and only while a worker holds the cycle", () => {
    const events = [ev("triage", "decision", 2000), ev("fix", "proposed", 9000)];
    const live = buildWaterfall(cycle(), events, T0 + 10_000);
    expect(live.steps.map((s) => s.status)).toEqual(["done", "done", "running", "not-reached", "not-reached"]);
    const stalled = buildWaterfall(cycle({ leaseExpiresAt: new Date(T0 + 1000) }), events, T0 + 10_000);
    expect(stalled.steps.map((s) => s.status)).toEqual(["done", "done", "not-reached", "not-reached", "not-reached"]);
  });

  it("starts a live run at triage when nothing has been recorded yet", () => {
    const w = buildWaterfall(cycle(), [], T0 + 1000);
    expect(w.steps[0]).toMatchObject({ stage: "triage", status: "running" });
  });

  it("times a step from the end of the one before, on the run's axis", () => {
    const c = cycle({ state: "waiting-human", leaseExpiresAt: null, updatedAt: new Date(T0 + 10_000) });
    const w = buildWaterfall(c, [ev("triage", "decision", 2000), ev("fix", "proposed", 8000), ev("verify", "passed", 10_000)], T0 + 99_000);
    const [triage, fix, verify] = w.steps;
    expect(triage).toMatchObject({ durationMs: 2000, offset: 0 });
    expect(fix).toMatchObject({ durationMs: 6000 });
    expect(fix!.offset).toBeCloseTo(0.2);
    expect(fix!.width).toBeCloseTo(0.6);
    expect(verify!.offset! + verify!.width!).toBeCloseTo(1);
    // A finished run's axis ends at its last update, not at "now".
    expect(w.endMs).toBe(T0 + 10_000);
  });

  it("uses the last event of a stage that ran more than once (a revision)", () => {
    const c = cycle({ state: "done", leaseExpiresAt: null, updatedAt: new Date(T0 + 9000) });
    const w = buildWaterfall(c, [ev("fix", "proposed", 3000), ev("verify", "failed", 4000), ev("fix", "proposed", 8000, "second try")], T0 + 9000);
    expect(w.steps.find((s) => s.stage === "fix")).toMatchObject({ outcome: "proposed", summary: "second try" });
  });

  it("puts the loop's own notes aside and keeps a stage it does not know, after the known ones", () => {
    const w = buildWaterfall(cycle({ state: "done", leaseExpiresAt: null, updatedAt: new Date(T0 + 4000) }), [ev("cycle", "started", 0, "Attempt 1"), ev("merge", "merged", 4000)], T0 + 5000);
    expect(w.notes.map((n) => n.summary)).toEqual(["Attempt 1"]);
    expect(w.steps.map((s) => s.stage).slice(-1)).toEqual(["merge"]);
    expect(w.steps.find((s) => s.stage === "merge")).toMatchObject({ status: "done", title: "merge" });
  });

  it("copes with events out of order and with clock skew (an event before the cycle began)", () => {
    const w = buildWaterfall(cycle({ state: "done", leaseExpiresAt: null }), [ev("fix", "proposed", 5000), ev("triage", "decision", -3000)], T0);
    for (const s of w.steps.filter((x) => x.status === "done")) {
      expect(s.durationMs!).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(s.offset!)).toBe(true);
    }
  });
});

describe("small helpers", () => {
  it("formats durations", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(12_000)).toBe("12 s");
    expect(formatDuration(185_000)).toBe("3 min 5 s");
    expect(formatDuration(-1)).toBe("");
  });

  it("links only to https", () => {
    expect(safeUrl("https://github.com/o/r/pull/1")).toBe("https://github.com/o/r/pull/1");
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("http://x.test")).toBeUndefined();
    expect(safeUrl("not a url")).toBeUndefined();
    expect(safeUrl(5)).toBeUndefined();
  });

  it("reads the triage rule from the run record", () => {
    expect(triageRule(cycle({ summary: { triage: { rule: "exhausted-budget" } } }))).toBe("exhausted-budget");
    expect(triageRule(cycle())).toBeUndefined();
  });
});
