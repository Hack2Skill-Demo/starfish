import { describe, expect, it } from "vitest";
import {
  countCycles,
  countIncidents,
  countUntriaged,
  errorRate,
  headline,
  hourlySeries,
  latestActivity,
  parseActivity,
  parsePublicActivity,
  runKpis,
  stageTitle,
  type ActivityRow,
} from "./overviewModel";
import type { IncidentRow } from "./incidents";
import { parseCycle, type CycleRow } from "./runsModel";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 4, 12, 30, 0);
const hourOf = (ms: number) => String(Math.floor(ms / HOUR));
const ts = (ms: number) => ({ toDate: () => new Date(ms) });

const cycle = (over: Record<string, unknown> = {}): CycleRow =>
  parseCycle("c", {
    incidentId: "i",
    environment: "demo",
    state: "done",
    createdAt: ts(NOW - 60_000),
    updatedAt: ts(NOW - 1000),
    leaseExpiresAt: null,
    ...over,
  })!;

const incident = (over: Partial<IncidentRow> = {}): IncidentRow => ({
  id: "i",
  functionName: "f",
  service: "s",
  environment: "demo",
  errorType: "E",
  errorMessage: "m",
  occurrenceCount: 1,
  windowedCount: 1,
  firstOccurredAt: "",
  lastOccurredAt: "",
  status: "new",
  recurrenceCount: 0,
  ...over,
});

describe("countCycles", () => {
  it("counts waiting runs, live runs and runs whose worker is gone, separately", () => {
    const counts = countCycles(
      [
        cycle({ state: "waiting-human", path: "pr" }),
        cycle({ state: "waiting-human", path: "notify" }),
        cycle({ state: "running", leaseExpiresAt: ts(NOW + 60_000) }),
        cycle({ state: "running", leaseExpiresAt: ts(NOW - 60_000) }),
        cycle({ state: "declined", path: "decline" }),
        cycle({ state: "failed", path: "failed" }),
      ],
      NOW
    );
    expect(counts).toMatchObject({ waitingHuman: 2, healed: 0, inProgress: 1, stalled: 1, total: 6 });
    expect(counts.byPath).toEqual({ decline: 1, notify: 1, draft: 0, pr: 1, human: 0, failed: 1, index: 0 });
  });

  it("is all zeros for no cycles", () => {
    expect(countCycles([], NOW)).toMatchObject({ waitingHuman: 0, inProgress: 0, stalled: 0, total: 0 });
  });
});

describe("headline", () => {
  it("says nothing is recorded, rather than that all is well, when there are no runs", () => {
    expect(headline(countCycles([], NOW))).toBe("No agent runs are recorded for this environment.");
  });
  it("counts the runs waiting on a human, singular and plural", () => {
    expect(headline(countCycles([cycle({ state: "waiting-human" })], NOW))).toBe("One run is waiting on a human.");
    expect(headline(countCycles([cycle({ state: "waiting-human" }), cycle({ state: "waiting-human" })], NOW))).toBe("2 runs are waiting on a human.");
    expect(headline(countCycles([cycle()], NOW))).toBe("No run is waiting on a human.");
  });
});

describe("hourlySeries", () => {
  it("sums buckets across incidents into the last N hours, oldest first, current hour included", () => {
    const rows = [
      incident({ occurrencesByHour: { [hourOf(NOW)]: 3, [hourOf(NOW - 2 * HOUR)]: 5 } }),
      incident({ occurrencesByHour: { [hourOf(NOW)]: 4 } }),
    ];
    const series = hourlySeries(rows, NOW, 4);
    expect(series.map((b) => b.count)).toEqual([0, 5, 0, 7]);
    expect(series[3]!.startMs).toBe(Math.floor(NOW / HOUR) * HOUR);
    expect(series[0]!.startMs).toBe(Math.floor(NOW / HOUR) * HOUR - 3 * HOUR);
  });

  it("ignores buckets outside the window, in the future, or malformed", () => {
    const rows = [
      incident({
        occurrencesByHour: { [hourOf(NOW - 10 * HOUR)]: 9, [hourOf(NOW + 2 * HOUR)]: 9, junk: 9, "1.5": 9, [hourOf(NOW)]: Number.NaN },
      }),
      incident(),
    ];
    expect(hourlySeries(rows, NOW, 4).map((b) => b.count)).toEqual([0, 0, 0, 0]);
  });
});

describe("countIncidents", () => {
  it("counts open incidents and, among them, regressions", () => {
    const rows = [
      incident({ status: "new" }),
      incident({ status: "recurred", recurrenceCount: 2 }),
      incident({ status: "resolved", recurrenceCount: 1 }),
      incident({ status: "ignored" }),
      incident({ status: "acknowledged", recurrenceCount: 1 }),
    ];
    expect(countIncidents(rows)).toEqual({ open: 3, regressions: 2 });
  });
});

describe("runKpis", () => {
  const run = (state: string, path: string | undefined, ms: number) =>
    cycle({ state, ...(path && { path }), createdAt: ts(NOW - ms - 1000), updatedAt: ts(NOW - 1000) });

  it("keeps the numerator and the denominator, and leaves running runs out of both", () => {
    const k = runKpis([run("waiting-human", "pr", 10_000), run("declined", "decline", 20_000), run("failed", "failed", 30_000), run("running", undefined, 99_000)]);
    expect(k.finished).toBe(3);
    expect(k.pullRequests).toEqual({ count: 1, of: 3 });
    expect(k.failed).toEqual({ count: 1, of: 3 });
    expect(k.medianRunMs).toBe(20_000);
  });

  it("does not count a dry run's draft as a pull request", () => {
    expect(runKpis([run("done", "draft", 5000)]).pullRequests).toEqual({ count: 0, of: 1 });
  });

  it("averages the middle two for an even count", () => {
    expect(runKpis([run("done", "pr", 10_000), run("done", "pr", 20_000)]).medianRunMs).toBe(15_000);
  });

  it("has no median, and a zero denominator, for no finished runs", () => {
    const k = runKpis([run("running", undefined, 1000)]);
    expect(k.medianRunMs).toBeUndefined();
    expect(k.pullRequests).toEqual({ count: 0, of: 0 });
  });
});

describe("countUntriaged", () => {
  it("counts open incidents still pending, not closed ones or ones with no triage state", () => {
    expect(
      countUntriaged([
        incident({ triageState: "pending" }),
        incident({ triageState: "pending", status: "recurred" }),
        incident({ triageState: "pending", status: "resolved" }),
        incident({ triageState: "declined" }),
        incident(),
      ])
    ).toBe(2);
  });
});

describe("errorRate", () => {
  it("sets the current hour against the mean of the hours before it", () => {
    const series = hourlySeries([incident({ occurrencesByHour: { [hourOf(NOW)]: 9, [hourOf(NOW - HOUR)]: 4, [hourOf(NOW - 2 * HOUR)]: 2 } })], NOW, 3);
    expect(errorRate(series)).toEqual({ thisHour: 9, baseline: 3 });
  });

  it("is null when there is no earlier hour to compare with", () => {
    expect(errorRate(hourlySeries([], NOW, 1))).toBeNull();
  });
});

describe("latest activity", () => {
  const event = (over: Record<string, unknown> = {}) => ({ seq: 1, environment: "demo", stage: "triage", type: "decision", summary: "act", at: ts(NOW), ...over });

  it("a guest's event copy (#18) takes its run from its cycleId, and only when its own id is that run's", () => {
    const copy = { ...event(), cycleId: "inc1_r0" };
    expect(parsePublicActivity("demo", "inc1_r0_000001", copy)).toMatchObject({ cycleId: "inc1_r0", id: "000001", seq: 1, stage: "triage" });
    expect(parsePublicActivity("demo", "other_r0_000001", copy)).toBeNull();
    expect(parsePublicActivity("demo", "inc1_r0_", copy)).toBeNull();
    expect(parsePublicActivity("demo", "inc1_r0_000001", { ...copy, cycleId: undefined })).toBeNull();
    expect(parsePublicActivity("prod", "inc1_r0_000001", copy)).toBeNull();
  });

  it("takes the cycle id from a cycle's events path", () => {
    expect(parseActivity("starfish_cycles", "demo", "starfish_cycles/inc1_r0/events/000001", event())).toMatchObject({
      cycleId: "inc1_r0",
      id: "000001",
      seq: 1,
      stage: "triage",
      type: "decision",
      summary: "act",
      at: new Date(NOW),
    });
  });

  it("drops an events document that is not a cycle's: the collection-group query matches any `events`", () => {
    expect(parseActivity("starfish_cycles", "demo", "incidents/i1/events/e1", event())).toBeNull();
    expect(parseActivity("my_cycles", "demo", "starfish_cycles/c/events/000001", event())).toBeNull();
    expect(parseActivity("starfish_cycles", "demo", "a/b/starfish_cycles/c/events/000001", event())).toBeNull();
    expect(parseActivity("starfish_cycles", "demo", "starfish_cycles/c/notes/000001", event())).toBeNull();
  });

  it("drops an event of another environment, or one missing what the feed needs", () => {
    const path = "starfish_cycles/c/events/000001";
    expect(parseActivity("starfish_cycles", "demo", path, event({ environment: "prod" }))).toBeNull();
    expect(parseActivity("starfish_cycles", "demo", path, event({ environment: undefined }))).toBeNull();
    expect(parseActivity("starfish_cycles", "demo", path, event({ at: "yesterday" }))).toBeNull();
    expect(parseActivity("starfish_cycles", "demo", path, event({ stage: "" }))).toBeNull();
    expect(parseActivity("starfish_cycles", "demo", path, event({ seq: "1" }))).toBeNull();
  });

  it("orders newest first, the later event first on a tie, and keeps at most the limit", () => {
    const row = (cycleId: string, seq: number, atMs: number): ActivityRow =>
      parseActivity("starfish_cycles", "demo", `starfish_cycles/${cycleId}/events/${seq}`, event({ seq, at: ts(atMs) }))!;
    const rows = [row("a", 1, NOW - 2000), row("b", 1, NOW), row("a", 2, NOW), row("c", 1, NOW - 5000)];
    expect(latestActivity(rows, 3).map((r) => `${r.cycleId}:${r.seq}`)).toEqual(["a:2", "b:1", "a:1"]);
  });

  it("names a stage the way the Runs page does, and shows an unknown one as stored", () => {
    expect(stageTitle("fix")).toBe("Draft a fix");
    expect(stageTitle("cycle")).toBe("Run");
    expect(stageTitle("notify")).toBe("notify");
  });
});
