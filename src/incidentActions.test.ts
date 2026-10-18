import { describe, expect, it } from "vitest";
import { INCIDENT_ACTIONS, TRIAGE_STATUSES, isIncidentAction, nextStatus, type TriageStatus } from "./incidentActions.js";
import { INCIDENT_STATUSES } from "./types.js";

describe("incidentActions: the one transition table", () => {
  it("knows the same statuses as src/types.ts", () => {
    const all: TriageStatus[] = ["new", "acknowledged", "logged", "resolved", "recurred", "ignored"];
    expect([...INCIDENT_STATUSES].sort()).toEqual([...all].sort());
    expect([...TRIAGE_STATUSES].sort()).toEqual([...all].sort());
  });

  it("matches firestore.rules' validTransition: never to logged or recurred, never out of resolved", () => {
    for (const from of INCIDENT_STATUSES) {
      for (const action of INCIDENT_ACTIONS) {
        const to = nextStatus(from, action);
        if (to === null) continue;
        expect(["acknowledged", "resolved", "ignored", "new"]).toContain(to);
        expect(from).not.toBe("resolved");
        if (to === "new") expect(from).toBe("ignored");
        if (to === "acknowledged") expect(["new", "logged", "recurred"]).toContain(from);
      }
    }
  });

  it("accepts only the four actions", () => {
    for (const a of INCIDENT_ACTIONS) expect(isIncidentAction(a)).toBe(true);
    for (const a of ["delete", "retire", "", null, 1]) expect(isIncidentAction(a)).toBe(false);
  });
});
