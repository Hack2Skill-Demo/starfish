import { describe, expect, it } from "vitest";
import { countCycles, countIncidents, headline, hourlySeries } from "./overviewModel";
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
    expect(counts).toMatchObject({ waitingHuman: 2, inProgress: 1, stalled: 1, total: 6 });
    expect(counts.byPath).toEqual({ decline: 1, notify: 1, draft: 0, pr: 1, human: 0, failed: 1 });
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
