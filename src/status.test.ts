import { describe, expect, it } from "vitest";
import { describeStatus, judgeRun, parseRunRecord, totalIncidents, unmetMinimums, type RunRecord } from "./status.js";

const NOW = new Date("2026-10-10T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  environment: "demo",
  outcome: "ok",
  finishedAt: minutesAgo(3),
  windows: 1,
  capped: false,
  totals: { entriesProcessed: 12, incidentsCreated: 1, incidentsUpdated: 3, incidentsRecurred: 0 },
  problems: [],
  ...over,
});

describe("judgeRun", () => {
  it("is never when nothing was recorded", () => {
    expect(judgeRun(null, "demo", NOW, 90)).toBe("never");
  });

  it("is ok for a recent successful run, and for an idle one", () => {
    expect(judgeRun(run(), "demo", NOW, 90)).toBe("ok");
    expect(judgeRun(run({ outcome: "idle" }), "demo", NOW, 90)).toBe("ok");
  });

  it("puts failed above stale above capped", () => {
    expect(judgeRun(run({ outcome: "failed", finishedAt: minutesAgo(500), capped: true }), "demo", NOW, 90)).toBe("failed");
    expect(judgeRun(run({ finishedAt: minutesAgo(500), capped: true }), "demo", NOW, 90)).toBe("stale");
    expect(judgeRun(run({ capped: true }), "demo", NOW, 90)).toBe("capped");
  });

  it("calls a run stale only past the threshold", () => {
    expect(judgeRun(run({ finishedAt: minutesAgo(90) }), "demo", NOW, 90)).toBe("ok");
    expect(judgeRun(run({ finishedAt: minutesAgo(91) }), "demo", NOW, 90)).toBe("stale");
  });

  it("is never for a run recorded for another environment, however healthy (#190)", () => {
    expect(judgeRun(run({ environment: "staging" }), "demo", NOW, 90)).toBe("never");
    expect(judgeRun(run({ environment: "staging", outcome: "failed" }), "demo", NOW, 90)).toBe("never");
  });
});

describe("parseRunRecord", () => {
  it("reads the document the engine writes", () => {
    const parsed = parseRunRecord({
      environment: "demo",
      outcome: "ok",
      finishedAt: { toDate: () => minutesAgo(3) },
      windows: 2,
      capped: false,
      totals: { entriesProcessed: 5, incidentsCreated: 1 },
      problems: ["environment: too long", 7],
    });
    expect(parsed).toMatchObject({ environment: "demo", outcome: "ok", windows: 2, problems: ["environment: too long"] });
    expect(parsed?.totals).toEqual({ entriesProcessed: 5, incidentsCreated: 1, incidentsUpdated: 0, incidentsRecurred: 0 });
  });

  it("treats a missing or unusable record as no record, never as a good one", () => {
    expect(parseRunRecord(undefined)).toBeNull();
    expect(parseRunRecord({ outcome: "ok" })).toBeNull();
    expect(parseRunRecord({ outcome: "ok", finishedAt: { toDate: () => new Date("garbage") } })).toBeNull();
    expect(parseRunRecord({ finishedAt: { toDate: () => minutesAgo(1) } })).toBeNull();
  });

  it("accepts only the outcomes the engine records, as the UI does (#190)", () => {
    const at = { toDate: () => minutesAgo(1) };
    expect(parseRunRecord({ outcome: "running", finishedAt: at })).toBeNull();
    expect(parseRunRecord({ outcome: "idle", finishedAt: at })?.outcome).toBe("idle");
  });
});

describe("totalIncidents", () => {
  it("sums every status, closed ones included", () => {
    expect(totalIncidents({})).toBe(0);
    expect(totalIncidents({ new: 2, resolved: 3, ignored: 1 })).toBe(6);
  });
});

describe("unmetMinimums", () => {
  it("is empty when nothing is required, even for a quiet project or no run at all", () => {
    expect(unmetMinimums({ run: null, environment: "demo", counts: {} }, { incidents: 0, entries: 0 })).toEqual([]);
  });

  it("says which requirement failed, in plain words", () => {
    const quiet = run({ totals: { entriesProcessed: 0, incidentsCreated: 0, incidentsUpdated: 0, incidentsRecurred: 0 } });
    expect(unmetMinimums({ run: quiet, environment: "demo", counts: {} }, { incidents: 1, entries: 1 })).toEqual([
      "expected at least 1 incident(s), found 0",
      "expected the last run to process at least 1 log entry, it processed 0",
    ]);
  });

  it("counts entries from the last run, not incidents from the store: an old incident proves nothing about the planted one", () => {
    const quiet = run({ totals: { entriesProcessed: 0, incidentsCreated: 0, incidentsUpdated: 0, incidentsRecurred: 0 } });
    expect(unmetMinimums({ run: quiet, environment: "demo", counts: { resolved: 3 } }, { incidents: 1, entries: 1 })).toEqual([
      "expected the last run to process at least 1 log entry, it processed 0",
    ]);
  });

  it("is satisfied by a run that read the entry", () => {
    expect(unmetMinimums({ run: run(), environment: "demo", counts: { new: 1 } }, { incidents: 1, entries: 1 })).toEqual([]);
  });

  it("treats no run as having processed nothing", () => {
    expect(unmetMinimums({ run: null, environment: "demo", counts: { new: 1 } }, { incidents: 0, entries: 2 })).toEqual([
      "expected the last run to process at least 2 log entries, it processed 0",
    ]);
  });

  it("does not count entries a run for another environment read (#190)", () => {
    expect(unmetMinimums({ run: run({ environment: "staging" }), environment: "demo", counts: {} }, { incidents: 0, entries: 1 })).toEqual([
      "expected the last run to process at least 1 log entry, it processed 0",
    ]);
  });
});

describe("describeStatus", () => {
  it("says plainly that nothing has run", () => {
    const r = describeStatus({ run: null, now: NOW, staleMinutes: 90, environment: "demo", counts: {} });
    expect(r.state).toBe("never");
    expect(r.lines[0]).toContain("never recorded a run");
    expect(r.lines[1]).toBe('incidents in "demo": 0 total, 0 open');
  });

  it("counts open incidents by the shared definition of open, not by total", () => {
    const r = describeStatus({
      run: run(),
      now: NOW,
      staleMinutes: 90,
      environment: "demo",
      counts: { new: 2, recurred: 1, resolved: 4, ignored: 1 },
    });
    expect(r.state).toBe("ok");
    expect(r.lines[0]).toContain("finished 3 min ago");
    expect(r.lines[1]).toContain("8 total, 3 open");
  });

  it("explains a failed or capped run without inventing detail", () => {
    const failed = describeStatus({ run: run({ outcome: "failed", error: "DeadlineExceeded" }), now: NOW, staleMinutes: 90, environment: "demo", counts: {} });
    expect(failed.state).toBe("failed");
    expect(failed.lines.join("\n")).toContain("failed with: DeadlineExceeded");
    const capped = describeStatus({ run: run({ capped: true }), now: NOW, staleMinutes: 90, environment: "demo", counts: {} });
    expect(capped.lines.join("\n")).toContain("floor");
  });

  it("says a run for another environment is not this one's, and does not report its counts (#190)", () => {
    const r = describeStatus({ run: run({ environment: "staging" }), now: NOW, staleMinutes: 90, environment: "demo", counts: {} });
    expect(r.state).toBe("never");
    expect(r.lines[0]).toBe('engine: never recorded a run for "demo" (the last run recorded was for "staging")');
  });
});
