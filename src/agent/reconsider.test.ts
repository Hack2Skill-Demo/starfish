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

  it("an operator's correction above noise after the decision reopens it at once; one to noise, or before it, does not", () => {
    const cycle = declined({}, { at: at(5) });
    for (const level of ["log", "fix", "merge"]) {
      expect(trigger(cycle, { ...baseIncident, correctedLevel: level, correctedBy: "u1", correctedAt: at(1) }), level).toBe("corrected");
    }
    expect(trigger(cycle, { ...baseIncident, correctedLevel: "noise", correctedBy: "u1", correctedAt: at(1) })).toBeNull();
    expect(trigger(cycle, { ...baseIncident, correctedLevel: "fix", correctedBy: "u1", correctedAt: at(10) })).toBeNull();
    expect(trigger(cycle, { ...baseIncident, correctedLevel: "page", correctedBy: "u1", correctedAt: at(1) })).toBeNull();
    // Still never over a closed incident.
    expect(trigger(cycle, { ...baseIncident, status: "ignored", correctedLevel: "fix", correctedBy: "u1", correctedAt: at(1) })).toBeNull();
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

  it("only a declined cycle of the incident's current recurrence (a waiting-human one only on a request, below)", () => {
    for (const state of ["running", "done"]) {
      expect(trigger(declined({ state }), { ...baseIncident, retriageRequestedAt: at(1) })).toBeNull();
    }
    expect(trigger(declined(), { ...baseIncident, recurrenceCount: 1, retriageRequestedAt: at(1) })).toBeNull();
  });

  describe.each(["waiting-human", "failed"])("a cycle that ended %s (a retry on a person's request)", (state) => {
    const waiting = (over: Record<string, unknown> = {}) => ({
      state,
      recurrence: 0,
      updatedAt: at(30),
      outcome: "verify-patch-does-not-apply",
      decision: { at: at(40), rule: "model-act", occurrenceCount: 5, causeClass: causeClass(baseIncident) },
      summary: { issue: { state: "opened", number: 7 }, notify: { state: "sent" } },
      ...over,
    });

    it("is reopened by a request made after it settled, and by nothing else", () => {
      expect(trigger(waiting(), { ...baseIncident, retriageRequestedAt: at(1) })).toBe("operator");
      // No request, or one from before it settled (already answered by it): the same replay, so the same result.
      expect(trigger(waiting())).toBeNull();
      expect(trigger(waiting(), { ...baseIncident, retriageRequestedAt: at(60) })).toBeNull();
      // Not a burst, not a new cause, not a correction: a person was told, and only a person starts it over.
      expect(trigger(waiting(), { ...baseIncident, occurrenceCount: 500, errorCode: "X", correctedLevel: "fix", correctedBy: "u1", correctedAt: at(1) })).toBeNull();
    });

    it("a request counts once: reopening writes the cycle, so the same request is then older than it", () => {
      const asked = { ...baseIncident, retriageRequestedAt: at(10) };
      expect(trigger(waiting({ updatedAt: at(20) }), asked)).toBe("operator");
      expect(trigger(waiting({ updatedAt: at(5) }), asked)).toBeNull();
    });

    it("compares the request with when the cycle settled, not its last write: an escalation event after the request does not lose it (#365)", () => {
      const asked = { ...baseIncident, retriageRequestedAt: at(10) };
      // Settled before the request; an escalation event appended after it moved updatedAt.
      expect(trigger(waiting({ settledAt: at(20), updatedAt: at(5) }), asked)).toBe("operator");
      // Settled after the request: answered already, whatever updatedAt says.
      expect(trigger(waiting({ settledAt: at(5), updatedAt: at(20) }), asked)).toBeNull();
      // A cycle settled before `settledAt` existed falls back to updatedAt (as before).
      expect(trigger(waiting({ updatedAt: at(20) }), asked)).toBe("operator");
    });

    it("is capped per day, never over a closed or retired incident, and never over its pull request", () => {
      const asked = { ...baseIncident, retriageRequestedAt: at(1) };
      const used = waiting({ reconsideredAt: [at(60), at(120), at(180)] });
      expect(trigger(used, asked)).toBeNull();
      expect(trigger(waiting(), { ...asked, status: "resolved" })).toBeNull();
      expect(trigger(waiting(), { ...asked, retired: true })).toBeNull();
      expect(trigger(waiting({ summary: { pr: { opened: true, number: 9 } } }), asked)).toBeNull();
    });
  });

  it("a decline kept before decisions were recorded has no baseline: only an operator can reopen it", () => {
    const legacy = { state: "declined", recurrence: 0, updatedAt: at(120) };
    expect(trigger(legacy, { ...baseIncident, occurrenceCount: 5000, errorCode: "X" })).toBeNull();
    expect(trigger(legacy, { ...baseIncident, retriageRequestedAt: at(1) })).toBe("operator");
    expect(trigger({ state: "declined" }, { ...baseIncident, retriageRequestedAt: at(1) })).toBeNull(); // no time at all
  });

  it("a cycle stopped because the incident was closed is triaged again once a person reopens it, after the cooldown, under the cap (#227)", () => {
    const stopped = (outcome: string, over: Record<string, unknown> = {}) => ({ state: "declined", recurrence: 0, outcome, updatedAt: at(60), ...over });
    // Still closed: the operator's close wins.
    expect(trigger(stopped("incident-ignored"), { ...baseIncident, status: "ignored" })).toBeNull();
    // Reopened (ignored -> new, or a resolve undone).
    expect(trigger(stopped("incident-ignored"), baseIncident)).toBe("reopened");
    expect(trigger(stopped("incident-resolved"), { ...baseIncident, status: "acknowledged" })).toBe("reopened");
    // Within the cooldown of the stop, or past the daily cap: not yet.
    expect(trigger(stopped("incident-ignored", { updatedAt: at(10) }), baseIncident)).toBeNull();
    expect(trigger(stopped("incident-ignored", { reconsideredAt: [at(600), at(300), at(90)] }), baseIncident)).toBeNull();
    // An incident that could not be read was closed by nobody; a model decline without a decision has no baseline.
    expect(trigger(stopped("incident-gone"), baseIncident)).toBeNull();
    expect(trigger(stopped("model-decline"), baseIncident)).toBeNull();
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
