import { describe, expect, it } from "vitest";
import {
  ago,
  buildWaterfall,
  prStateView,
  formatClock,
  formatDuration,
  groupByDay,
  runSummary,
  splitTrace,
  trackMarks,
  indexRuntimeView,
  isHealedRun,
  parseCycle,
  parseEvent,
  progressText,
  runFilter,
  runStatus,
  safeUrl,
  triageDecision,
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

  it("marks a cycle synthetic only when the document says exactly true", () => {
    expect(parseCycle("x", cycleDoc({ synthetic: true }))?.synthetic).toBe(true);
    expect(parseCycle("x", cycleDoc({ synthetic: "true" }))?.synthetic).toBeUndefined();
    expect(parseCycle("x", cycleDoc())).not.toHaveProperty("synthetic");
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
  it("shows the Slack step, with how it went, only on a cycle that has one", () => {
    const c = cycle({ state: "waiting-human", leaseExpiresAt: null, updatedAt: new Date(T0 + 9000) });
    const without = buildWaterfall(c, [ev("triage", "decision", 5000)], T0 + 10_000);
    expect(without.steps.some((s) => s.stage === "notify")).toBe(false);
    const withIt = buildWaterfall(c, [ev("triage", "decision", 5000), ev("notify", "failed", 8000)], T0 + 10_000);
    const step = withIt.steps.find((s) => s.stage === "notify");
    expect(step).toMatchObject({ title: "Tell a person", status: "done", outcome: "failed" });
    const issue = buildWaterfall(c, [ev("triage", "decision", 5000), ev("issue", "opened", 6000)], T0 + 10_000).steps.find((s) => s.stage === "issue");
    expect(issue).toMatchObject({ title: "GitHub issue", status: "done", outcome: "opened" });
  });

  it("shows the phone escalation (#37) as one step, with its last outcome, only on a cycle that has one", () => {
    const c = cycle({ state: "waiting-human", leaseExpiresAt: null, updatedAt: new Date(T0 + 9000) });
    expect(buildWaterfall(c, [ev("triage", "decision", 5000)], T0 + 10_000).steps.some((s) => s.stage === "escalation")).toBe(false);
    const w = buildWaterfall(c, [ev("triage", "decision", 5000), ev("notify", "sent", 6000), ev("escalation", "calling", 7000), ev("escalation", "acknowledged", 8000)], T0 + 10_000);
    expect(w.steps.find((s) => s.stage === "escalation")).toMatchObject({ title: "Phone the on-call", status: "done", outcome: "acknowledged" });
  });

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
    const w = buildWaterfall(cycle({ state: "done", leaseExpiresAt: null, updatedAt: new Date(T0 + 4000) }), [ev("cycle", "started", 0, "Attempt 1"), ev("canary", "passed", 4000)], T0 + 5000);
    expect(w.notes.map((n) => n.summary)).toEqual(["Attempt 1"]);
    expect(w.steps.map((s) => s.stage).slice(-1)).toEqual(["canary"]);
    expect(w.steps.find((s) => s.stage === "canary")).toMatchObject({ status: "done", title: "canary" });
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

  it("reads how far triage went, with the merge case only for a merge", () => {
    expect(triageDecision(cycle({ summary: { triage: { level: "merge", mergeCase: "missing-await" } } }))).toEqual({
      label: "Log + fix + merge: Starfish merges it on green checks",
      mergeCase: "missing-await",
    });
    expect(triageDecision(cycle({ summary: { triage: { level: "fix", mergeCase: "missing-await" } } }))).toEqual({ label: "Log + fix: a verified pull request; a person merges" });
    expect(triageDecision(cycle({ summary: { triage: { level: "log" } } }))?.label).toContain("a person fixes it");
    expect(triageDecision(cycle({ summary: { triage: { level: "noise" } } }))?.label).toContain("nothing filed");
    expect(triageDecision(cycle({ summary: { triage: { level: "everything" } } }))).toBeUndefined();
    expect(triageDecision(cycle())).toBeUndefined();
  });

  it("says who held Starfish back, when the rules engine capped the decision", () => {
    expect(triageDecision(cycle({ summary: { triage: { level: "log", cap: "log", capBy: "rule", capRule: "payments-human" } } }))?.heldBy).toBe(
      "Held to log by the admin's class rule payments-human"
    );
    expect(triageDecision(cycle({ summary: { triage: { level: "fix", cap: "fix", capBy: "correction", capRule: null } } }))?.heldBy).toBe(
      "Held to fix by an operator's correction"
    );
    expect(triageDecision(cycle({ summary: { triage: { level: "fix", cap: null, capBy: null } } }))?.heldBy).toBeUndefined();
    expect(triageDecision(cycle({ summary: { triage: { level: "fix", cap: "merge", capBy: "rule" } } }))?.heldBy).toBeUndefined();
  });

  it("reads the triage rule from the run record", () => {
    expect(triageRule(cycle({ summary: { triage: { rule: "exhausted-budget" } } }))).toBe("exhausted-budget");
    expect(triageRule(cycle())).toBeUndefined();
  });
});

describe("progressText", () => {
  it("counts only steps with an event as recorded", () => {
    expect(progressText([{ status: "done" }, { status: "running" }, { status: "not-reached" }])).toBe("1 of 3 steps recorded");
    expect(progressText([])).toBe("0 of 0 steps recorded");
  });
});

describe("prStateView: the pull request as the engine last read it back (#17)", () => {
  const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
  const opened = { opened: true, number: 7, url: "https://github.com/o/r/pull/7" };
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const withPr = (prState?: Record<string, string | number | null>) => cycle({ state: "done", summary: { pr: opened, ...(prState && { prState }) } });

  it("is absent for a cycle that opened no pull request", () => {
    expect(prStateView(cycle(), NOW)).toBeUndefined();
    expect(prStateView(cycle({ summary: { pr: { opened: false, reason: "dry-run" } } }), NOW)).toBeUndefined();
  });

  it("says it was never checked rather than guessing", () => {
    expect(prStateView(withPr(), NOW)).toEqual({ text: "Not checked since it was opened", tone: "neutral" });
    expect(prStateView(withPr({ state: "open", checks: "passed", checkedAt: "garbage" }), NOW)?.text).toBe("Not checked since it was opened");
  });

  it("reads merged, closed and open, each with its checks", () => {
    expect(prStateView(withPr({ state: "merged", mergedAt: at(2 * 3600_000), checks: "passed", checkedAt: at(60_000) }), NOW)).toEqual({
      text: "merged 2h ago · checks passed",
      tone: "success",
      checkedAt: new Date(NOW - 60_000),
    });
    expect(prStateView(withPr({ state: "closed", closedAt: at(3 * 86_400_000), checks: "missing", checkedAt: at(0) }), NOW)?.text).toBe("closed without merging 3d ago · checks not reported");
    expect(prStateView(withPr({ state: "open", checks: "pending", checkedAt: at(0) }), NOW)).toMatchObject({ text: "open · checks still running", tone: "info" });
    expect(prStateView(withPr({ state: "open", checks: "failed", failedChecks: "verify, lint", checkedAt: at(0) }), NOW)).toMatchObject({
      text: "open · checks failed (verify, lint)",
      tone: "warning",
    });
    expect(prStateView(withPr({ state: "merged", mergedAt: null, checks: "not-configured", checkedAt: at(0) }), NOW)?.text).toBe("merged · no required checks named");
  });

  it("formats short relative times", () => {
    expect(ago(NOW - 10_000, NOW)).toBe("just now");
    expect(ago(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(ago(NOW + 60_000, NOW)).toBe("just now");
  });
});

describe("the missing-index path (#11)", () => {
  it("reads the index path and shows only its own stages, never triage or verify as not reached", () => {
    const c = parseCycle("inc-1_r0", cycleDoc({ state: "done", path: "index", leaseExpiresAt: null, summary: { index: { state: "ready", runtime: "observing" } } }))!;
    expect(c.path).toBe("index");
    const w = buildWaterfall(c, [ev("index", "started", 100), ev("index", "ready", 2000), ev("pr", "opened", 3000)], T0 + 5000);
    expect(w.steps.map((s) => [s.stage, s.title, s.status])).toEqual([
      ["index", "Missing index", "done"],
      ["pr", "Pull request", "done"],
    ]);
  });

  it("an index cycle still running shows the pull request as the next step", () => {
    const c = cycle({ summary: { index: { state: "building" } } });
    const w = buildWaterfall(c, [ev("index", "building", 100)], T0 + 1000);
    expect(w.steps.map((s) => s.status)).toEqual(["done", "running"]);
  });

  it("says where the heal stands at runtime, and only what the engine recorded", () => {
    const at = (runtime: unknown, extra: Record<string, unknown> = {}) => cycle({ summary: { index: { runtime: runtime as string, ...extra } } as CycleRow["summary"] });
    expect(indexRuntimeView(at("observing", { observeUntil: "2026-10-06T13:00:00.000Z" }))).toMatchObject({ tone: "info", until: new Date("2026-10-06T13:00:00.000Z") });
    expect(indexRuntimeView(at("healed"))).toMatchObject({ tone: "success", text: expect.stringContaining("Healed") });
    expect(indexRuntimeView(at("recurred"))?.tone).toBe("warning");
    expect(indexRuntimeView(at("made-up"))).toBeUndefined();
    expect(indexRuntimeView(cycle())).toBeUndefined();
  });
});

describe("isHealedRun and runFilter (#38)", () => {
  const index = (runtime: string, over: Partial<CycleRow> = {}) => cycle({ state: "done", path: "index", summary: { index: { runtime } }, ...over });

  it("counts only a missing-index run the observer recorded as healed", () => {
    expect(isHealedRun(index("healed"))).toBe(true);
    for (const r of ["observing", "recurred", "query-failing", "unverified", ""]) expect(isHealedRun(index(r)), r).toBe(false);
    // A merged pull request, or a READY index still under watch, is not healed.
    expect(isHealedRun(cycle({ state: "done", path: "pr", summary: { prState: { state: "merged" } } }))).toBe(false);
    expect(isHealedRun(cycle({ state: "done", path: "pr", summary: { triage: { runtime: "healed" } } }))).toBe(false);
    // A synthetic record was written by seed-demo, not by a run.
    expect(isHealedRun(index("healed", { synthetic: true }))).toBe(false);
  });

  it("reads one filter from the URL, and ignores unknown values", () => {
    const f = (q: string) => runFilter(new URLSearchParams(q));
    expect(f("heal=healed")?.test(index("healed"))).toBe(true);
    expect(f("heal=healed")?.test(index("observing"))).toBe(false);
    expect(f("state=waiting-human")?.test(cycle({ state: "waiting-human" }))).toBe(true);
    expect(f("state=running")?.test(cycle({ state: "done" }))).toBe(false);
    expect(f("path=pr")?.label).toBe("Pull request opened");
    for (const q of ["", "heal=yes", "state=done", "path=bogus", "path=toString", "state=__proto__"]) expect(f(q), q).toBeNull();
  });
});

describe("the live track", () => {
  it("dates a running step from the end of the step before, and only a running one", () => {
    const live = buildWaterfall(cycle(), [ev("triage", "decision", 16_000)], T0 + 30_000);
    expect(live.steps[1]).toMatchObject({ stage: "fix", status: "running", since: new Date(T0 + 16_000) });
    expect(live.steps.filter((s) => s.since !== undefined)).toHaveLength(1);
    const first = buildWaterfall(cycle(), [], T0 + 5_000);
    expect(first.steps[0]).toMatchObject({ stage: "triage", status: "running", since: new Date(T0) });
  });

  it("still runs the step after the last one done when a side stage was recorded meanwhile", () => {
    const w = buildWaterfall(cycle(), [ev("triage", "decision", 16_000), ev("issue", "dry-run", 20_000)], T0 + 30_000);
    expect(w.steps.map((s) => [s.stage, s.status])).toEqual([
      ["triage", "done"],
      ["fix", "running"],
      ["verify", "not-reached"],
      ["review", "not-reached"],
      ["pr", "not-reached"],
      ["issue", "done"],
    ]);
  });

  it("formats a running timer", () => {
    expect(formatClock(7_400)).toBe("0:07");
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(3_729_000)).toBe("1:02:09");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });

  it("marks a step recorded beside the run's own path, and none of the path's", () => {
    const w = buildWaterfall(cycle({ state: "waiting-human", leaseExpiresAt: null }), [ev("triage", "decision", 1000), ev("notify", "sent", 2000)], T0 + 5000);
    expect(w.steps.filter((s) => s.side).map((s) => s.stage)).toEqual(["notify"]);
    // On the missing-index path, a triage event is beside the path, not on its track.
    const index = buildWaterfall(cycle({ path: "index", state: "done", leaseExpiresAt: null }), [ev("triage", "decision", 1000), ev("index", "ready", 2000)], T0 + 5000);
    expect(index.steps.filter((s) => !s.side).map((s) => s.stage)).toEqual(["index", "pr"]);
    expect(index.steps.filter((s) => s.side).map((s) => s.stage)).toEqual(["triage"]);
  });

  it("groups runs by the local day they were last updated, keeping their order", () => {
    const now = new Date(2026, 9, 10, 15, 0).getTime();
    const at = (y: number, m: number, d: number, h = 9) => cycle({ updatedAt: new Date(y, m, d, h) });
    const a = { ...at(2026, 9, 10, 14), id: "a" };
    const b = { ...at(2026, 9, 10, 1), id: "b" };
    const c = { ...at(2026, 9, 9), id: "c" };
    const d = { ...at(2026, 9, 8), id: "d" };
    const e = { ...at(2025, 11, 31), id: "e" };
    const days = groupByDay([a, b, c, d, e], now);
    expect(days.map((x) => x.cycles.map((r) => r.id))).toEqual([["a", "b"], ["c"], ["d"], ["e"]]);
    expect(days[0]!.label).toBe("Today");
    expect(days[1]!.label).toBe("Yesterday");
    expect(days[2]!.label).not.toMatch(/2026/);
    expect(days[3]!.label).toMatch(/2025/);
  });
});

describe("the run's summary, its error, and the list's strip", () => {
  it("says what a worker is on, or how the run ended and after which recorded step", () => {
    const live = buildWaterfall(cycle(), [ev("triage", "decision", 1000)], T0 + 5000);
    expect(runSummary(cycle(), live.steps, T0 + 5000)).toBe("Working on draft a fix now.");
    const ended = cycle({ state: "waiting-human", leaseExpiresAt: null, path: "human" });
    const w = buildWaterfall(ended, [ev("triage", "decision", 1000), ev("fix", "declined", 2000), ev("notify", "sent", 3000)], T0 + 5000);
    expect(runSummary(ended, w.steps, T0 + 5000)).toBe("Handed to a person after draft a fix (declined).");
    const pr = cycle({ state: "done", leaseExpiresAt: null, path: "pr" });
    expect(runSummary(pr, buildWaterfall(pr, [ev("triage", "d", 1), ev("fix", "p", 2), ev("verify", "v", 3), ev("review", "r", 4), ev("pr", "opened", 5)], T0 + 9).steps, T0 + 9)).toBe("Pull request opened.");
    const orphan = cycle({ leaseExpiresAt: new Date(T0 - 1) });
    expect(runSummary(orphan, buildWaterfall(orphan, [], T0).steps, T0)).toMatch(/No worker holds this run/);
  });

  it("splits a message that carries its stack, and leaves anything else whole", () => {
    const t = splitTrace("Error: getScenarios failed at entryFromArgs (file:///w/node_modules/ff/logger/index.mjs:119:13) at Module.error (file:///w/node_modules/ff/lib/e");
    expect(t.headline).toBe("getScenarios failed");
    expect(t.frames).toEqual([
      { fn: "entryFromArgs", at: "file:///w/node_modules/ff/logger/index.mjs:119:13", library: true },
      { fn: "Module.error", at: "file:///w/node_modules/ff/lib/e", library: true },
    ]);
    expect(splitTrace("x at handler (/srv/app/src/a.ts:3:1)").frames[0]).toMatchObject({ fn: "handler", library: false });
    expect(splitTrace("Look at the logs for details")).toEqual({ headline: "Look at the logs for details", frames: [] });
    expect(splitTrace("Error: quota hit at noon")).toEqual({ headline: "quota hit at noon", frames: [] });
  });

  it("marks a stage on the strip only on evidence in the cycle document, never from the stage order", () => {
    const c = cycle({ state: "waiting-human", leaseExpiresAt: null, stage: "notify", summary: { triage: { rule: "r" }, fix: { outcome: "declined" } } });
    expect(trackMarks(c, T0)).toEqual(["done", "done", "none", "none", "none"]);
    const gap = cycle({ state: "waiting-human", leaseExpiresAt: null, stage: "review", summary: { triage: { rule: "r" } } });
    expect(trackMarks(gap, T0)).toEqual(["done", "none", "none", "done", "none"]);
    const live = cycle({ stage: "triage", summary: { triage: { rule: "r" } } });
    expect(trackMarks(live, T0)).toEqual(["done", "running", "none", "none", "none"]);
  });
});

