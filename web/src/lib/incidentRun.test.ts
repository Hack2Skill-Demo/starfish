import { describe, expect, it } from "vitest";
import { incidentRunView, runHref, runIdFor } from "./incidentRun";
import { parseCycle, type CycleRow } from "./runsModel";

const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const now = Date.parse("2026-10-08T00:30:00Z");

function cycle(over: Record<string, unknown> = {}): CycleRow {
  return parseCycle("inc1_r0", {
    incidentId: "inc1",
    environment: "demo",
    recurrence: 0,
    state: "declined",
    path: "decline",
    outcome: "model-decline",
    attempts: 2,
    eventCount: 1,
    createdAt: ts(now - 600_000),
    updatedAt: ts(now - 300_000),
    leaseExpiresAt: null,
    deadlineAt: null,
    summary: { triage: { decision: "decline", rule: "model-decline", reason: "A single 404 from a demo stub; no user impact." } },
    ...over,
  })!;
}

describe("incidentRunView", () => {
  it("names the run for the incident's current recurrence, and links the Runs page to it", () => {
    expect(runIdFor("inc1", 0)).toBe("inc1_r0");
    expect(runIdFor("inc1", 2)).toBe("inc1_r2");
    expect(runHref("a b_r1")).toBe("/runs?run=a%20b_r1");
  });

  it("shows the run's state in the Runs page's words, triage's decision, its reason and rule", () => {
    expect(incidentRunView(cycle(), true, now)).toEqual({
      kind: "run",
      runId: "inc1_r0",
      href: "/runs?run=inc1_r0",
      status: { label: "Declined", tone: "neutral", live: false },
      decision: "Decline",
      reason: "A single 404 from a demo stub; no user impact.",
      rule: "model-decline",
    });
  });

  it("falls back to what the run ended in when triage recorded no reason (the index path has no triage)", () => {
    const v = incidentRunView(cycle({ state: "done", path: "index", summary: {} }), true, now);
    expect(v).toMatchObject({ kind: "run", status: { label: "Done" }, reason: "Missing index: READY, evidence recorded" });
    expect(v).not.toHaveProperty("decision");
  });

  it("says 'no run' only when it knows: the run read by id is missing, or every run was read", () => {
    expect(incidentRunView(null, false, now)).toEqual({ kind: "none" });
    expect(incidentRunView(undefined, true, now)).toEqual({ kind: "none" });
    expect(incidentRunView(undefined, false, now)).toEqual({ kind: "unknown" });
  });
});
