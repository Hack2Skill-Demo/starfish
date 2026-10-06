import { describe, expect, it } from "vitest";
import { causeClass, reconsiderTrigger, recentReconsiderations, utcDay, type ReconsiderPolicy } from "./reconsider.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const at = (minutesAgo: number) => ({ toMillis: () => NOW.getTime() - minutesAgo * 60_000 });
const policy: ReconsiderPolicy = { reconsiderCooldownMinutes: 30, reconsiderMaxPerDay: 3, reconsiderBurstOccurrences: 20 };

const baseIncident = { status: "new", occurrenceCount: 5, errorType: "TimeoutError" };
const declined = (over: Record<string, unknown> = {}, decision: Record<string, unknown> = {}) => ({
  state: "declined",
  recurrence: 0,
  updatedAt: at(60),
  decision: { at: at(60), rule: "model-decline", occurrenceCount: 5, causeClass: causeClass(baseIncident), ...decision },
  ...over,
});
const trigger = (cycle: Record<string, unknown>, incident: Record<string, unknown> | undefined = baseIncident, now = NOW) =>
  reconsiderTrigger(cycle, incident, policy, now);

describe("reconsiderTrigger", () => {
  it("an unchanged replay is not new evidence: the same incident read again stays declined", () => {
    expect(trigger(declined())).toBeNull();
    expect(trigger(declined(), { ...baseIncident, occurrenceCount: 24 })).toBeNull(); // grew, but under the threshold
  });

  it("an isolated transient that becomes a sustained burst is triaged again", () => {
    expect(trigger(declined(), { ...baseIncident, occurrenceCount: 25 })).toBe("burst");
  });

  it("a new structural cause is new evidence; a different stack or detail text is not", () => {
    expect(trigger(declined(), { ...baseIncident, errorCode: "DEADLINE_EXCEEDED" })).toBe("cause");
    expect(trigger(declined(), { ...baseIncident, httpStatus: 504 })).toBe("cause");
    expect(trigger(declined(), { ...baseIncident, stackTrace: "at f (a.ts:1:1)" })).toBe("cause"); // a stack became available
    const withStack = { ...baseIncident, stackTrace: "at f (a.ts:1:1)", errorDetail: "x" };
    const cycle = declined({}, { causeClass: causeClass(withStack) });
    expect(trigger(cycle, { ...withStack, stackTrace: "at g (b.ts:9:9)", errorDetail: "y" })).toBeNull();
  });

  it("an operator's request after the decision reopens it at once, without waiting for the cooldown", () => {
    const cycle = declined({}, { at: at(5) });
    expect(trigger(cycle, { ...baseIncident, retriageRequestedAt: at(1) })).toBe("operator");
    // A request from before the decision was already answered by it.
    expect(trigger(cycle, { ...baseIncident, retriageRequestedAt: at(10) })).toBeNull();
  });

  it("the automatic triggers wait for the cooldown after the decision", () => {
    const cycle = declined({}, { at: at(10) });
    expect(trigger(cycle, { ...baseIncident, occurrenceCount: 500 })).toBeNull();
    expect(trigger(cycle, { ...baseIncident, occurrenceCount: 500 }, new Date(NOW.getTime() + 20 * 60_000))).toBe("burst");
  });

  it("is capped per 24 hours, whoever asks; reconsiderations older than a day no longer count", () => {
    const capped = declined({ reconsideredAt: [at(600), at(300), at(90)] });
    expect(trigger(capped, { ...baseIncident, occurrenceCount: 500 })).toBeNull();
    expect(trigger(capped, { ...baseIncident, retriageRequestedAt: at(1) })).toBeNull();
    const aged = declined({ reconsideredAt: [at(2000), at(300), at(90)] });
    expect(trigger(aged, { ...baseIncident, occurrenceCount: 500 })).toBe("burst");
  });

  it("never overrides an ignored, resolved or retired incident, even on an operator's request", () => {
    for (const status of ["ignored", "resolved"]) {
      expect(trigger(declined(), { ...baseIncident, status, occurrenceCount: 500, retriageRequestedAt: at(1) })).toBeNull();
    }
    expect(trigger(declined(), { ...baseIncident, retired: true, retriageRequestedAt: at(1) })).toBeNull();
    expect(trigger(declined(), undefined)).toBeNull();
  });

  it("only a declined cycle of the incident's current recurrence", () => {
    for (const state of ["running", "done", "waiting-human", "failed"]) {
      expect(trigger(declined({ state }), { ...baseIncident, retriageRequestedAt: at(1) })).toBeNull();
    }
    expect(trigger(declined(), { ...baseIncident, recurrenceCount: 1, retriageRequestedAt: at(1) })).toBeNull();
  });

  it("a decline kept before decisions were recorded has no baseline: only an operator can reopen it", () => {
    const legacy = { state: "declined", recurrence: 0, updatedAt: at(120) };
    expect(trigger(legacy, { ...baseIncident, occurrenceCount: 5000, errorCode: "X" })).toBeNull();
    expect(trigger(legacy, { ...baseIncident, retriageRequestedAt: at(1) })).toBe("operator");
    expect(trigger({ state: "declined" }, { ...baseIncident, retriageRequestedAt: at(1) })).toBeNull(); // no time at all
  });

  it("ignores malformed counts and request times instead of throwing", () => {
    expect(trigger(declined({}, { occurrenceCount: "5" }), { ...baseIncident, occurrenceCount: 500 })).toBeNull();
    expect(trigger(declined(), { ...baseIncident, retriageRequestedAt: "yesterday" })).toBeNull();
    expect(trigger(declined({ reconsideredAt: "nope" }), { ...baseIncident, occurrenceCount: 500 })).toBe("burst");
  });
});

describe("helpers", () => {
  it("utcDay is the UTC calendar day", () => {
    expect(utcDay(new Date("2026-10-06T23:59:59Z"))).toBe("2026-10-06");
    expect(utcDay(new Date("2026-10-07T00:00:00Z"))).toBe("2026-10-07");
  });

  it("recentReconsiderations keeps the last 24 hours only", () => {
    expect(recentReconsiderations({ reconsideredAt: [at(1500), at(10), "x"] }, NOW)).toEqual([NOW.getTime() - 10 * 60_000]);
  });
});
