import { describe, expect, it } from "vitest";
import { narrowWindow, planWindow, windowOf, type WindowPlan } from "./window.js";

const HOUR = 3600_000;
const now = new Date("2026-10-04T12:00:00.000Z");
const plan = (over: Partial<WindowPlan> = {}): WindowPlan => ({
  checkpoint: undefined,
  now,
  lookbackHours: 24,
  lagMinutes: 5,
  maxWindowHours: 6,
  ...over,
});

describe("planWindow", () => {
  it("ends the window behind the clock by the lag, so late-arriving entries are in it", () => {
    const w = planWindow(plan({ checkpoint: new Date(now.getTime() - HOUR) }))!;
    expect(w.end.toISOString()).toBe("2026-10-04T11:55:00.000Z");
  });

  it("the first window starts a lookback before the horizon", () => {
    const w = planWindow(plan({ lookbackHours: 2 }))!;
    expect(w.start.toISOString()).toBe("2026-10-04T09:55:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-04T11:55:00.000Z");
  });

  it("starts at the checkpoint: consecutive windows leave no gap and no overlap", () => {
    const first = planWindow(plan({ lookbackHours: 2 }))!;
    const next = planWindow(plan({ checkpoint: first.end, now: new Date(now.getTime() + HOUR) }))!;
    expect(next.start.getTime()).toBe(first.end.getTime());
    expect(next.end.getTime()).toBe(first.end.getTime() + HOUR);
  });

  it("never covers more than the maximum, so a long outage is caught up in bounded reads", () => {
    const w = planWindow(plan({ checkpoint: new Date(now.getTime() - 48 * HOUR) }))!;
    expect(w.end.getTime() - w.start.getTime()).toBe(6 * HOUR);
    expect(w.start.getTime()).toBe(now.getTime() - 48 * HOUR);
  });

  it("has nothing to read until the horizon passes the checkpoint", () => {
    expect(planWindow(plan({ checkpoint: new Date("2026-10-04T11:55:00.000Z") }))).toBeNull();
    expect(planWindow(plan({ checkpoint: new Date(now.getTime() + HOUR) }))).toBeNull();
  });

  it("gives the same boundaries the same id, and different ones different ids", () => {
    const a = new Date("2026-10-04T00:00:00.000Z");
    const b = new Date("2026-10-04T06:00:00.000Z");
    expect(windowOf(a, b).id).toBe(windowOf(new Date(a), new Date(b)).id);
    expect(windowOf(a, b).id).not.toBe(windowOf(a, new Date(b.getTime() + 1)).id);
    expect(windowOf(a, b).id).not.toBe(windowOf(new Date(a.getTime() + 1), b).id);
  });
});

describe("narrowWindow (#127)", () => {
  const w = windowOf(new Date(now.getTime() - 6 * HOUR), now);

  it("keeps the start and ends a millisecond before the last entry read, which may share its millisecond with unread ones", () => {
    const last = new Date(now.getTime() - 2 * HOUR);
    const n = narrowWindow(w, last)!;
    expect(n.start).toEqual(w.start);
    expect(n.end.getTime()).toBe(last.getTime() - 1);
    expect(n.id).not.toBe(w.id);
  });

  it("refuses when there is nothing to narrow to: a capped first millisecond, a bound outside the window, a bad date", () => {
    expect(narrowWindow(w, new Date(w.start.getTime() + 1))).toBeNull();
    expect(narrowWindow(w, new Date(w.end.getTime() + 1))).toBeNull();
    expect(narrowWindow(w, new Date(Number.NaN))).toBeNull();
  });
});
