import { describe, expect, it } from "vitest";
import { buildEvidence, currentCycleId } from "./evidence";
import type { IncidentRow } from "./incidents";
import { parseCycle, type CycleRow } from "./runsModel";

const row: IncidentRow = {
  id: "inc-1",
  functionName: "orders-create",
  service: "orders",
  environment: "demo",
  errorType: "TypeError",
  errorMessage: "x is undefined",
  occurrenceCount: 12,
  windowedCount: 12,
  firstOccurredAt: "2026-10-04T10:00:00.000Z",
  lastOccurredAt: "2026-10-04T11:00:00.000Z",
  status: "new",
  recurrenceCount: 0,
};

const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const cycle = (summary: Record<string, unknown>): CycleRow =>
  parseCycle("inc-1_r0", {
    incidentId: "inc-1",
    environment: "demo",
    state: "waiting-human",
    createdAt: ts(0),
    updatedAt: ts(1000),
    summary,
  })!;

const stage = (e: ReturnType<typeof buildEvidence>, id: string) => e.stages.find((s) => s.id === id)!;
const HASH = "a".repeat(64);

describe("buildEvidence", () => {
  it("with no run, records what was detected and shows every later stage as not reached", () => {
    const e = buildEvidence(row, null);
    expect(stage(e, "detected").status).toBe("recorded");
    for (const id of ["triage", "fix", "verify", "review", "pr"]) {
      expect(stage(e, id)).toMatchObject({ status: "not-reached", fields: [] });
    }
    expect(stage(e, "triage").note).toMatch(/no agent run/i);
    expect(e.cycleId).toBeNull();
    expect(e.samePatch).toBeNull();
  });

  it("never fills a stage in from the one before it: a run that stopped at triage has nothing after it", () => {
    const e = buildEvidence(row, cycle({ triage: { decision: "decline", rule: "upstream-fault", reason: "not our code", suspectedCause: null } }));
    expect(stage(e, "triage")).toMatchObject({ status: "recorded" });
    expect(stage(e, "triage").fields.map((f) => f.label)).toEqual(["Decision", "Rule", "Reason"]);
    for (const id of ["fix", "verify", "review", "pr"]) expect(stage(e, id).status).toBe("not-reached");
    expect(stage(e, "fix").note).toMatch(/has not recorded/);
    expect(e.cycleId).toBe("inc-1_r0");
  });

  it("shows each recorded stage's own fields, and says the patch text is not stored", () => {
    const e = buildEvidence(
      row,
      cycle({
        triage: { decision: "act", rule: "model-act", reason: "r", suspectedCause: "c" },
        fix: { outcome: "proposed", rule: "ok", rootCause: "missing await", testAdded: "orders.test.ts", risk: null, revisions: 0 },
        verify: { status: "passed", rule: "passed", patchSha256: HASH, baseRevision: "abc123", files: 2, exitCode: 0, durationMs: 4200 },
        review: { verdict: "approve", rule: "ok", attacks: 4, held: 3, flagged: 1, broken: 0, patchSha256: HASH },
        pr: { opened: true, number: 42, url: "https://github.com/o/r/pull/42", patchSha256: HASH },
      })
    );
    expect(stage(e, "fix").note).toMatch(/patch text is not stored; its SHA-256 is recorded/);
    expect(stage(e, "fix").fields.map((f) => f.label)).toEqual(["Outcome", "Rule", "Root cause", "Test added", "Revisions"]);
    // A null risk is left out, not shown as "null".
    expect(stage(e, "verify").fields.find((f) => f.label === "Exit code")?.value).toBe("0");
    expect(stage(e, "review").fields.find((f) => f.label === "Broken")?.value).toBe("0");
    expect(stage(e, "pr").fields.find((f) => f.label === "Link")).toMatchObject({ href: "https://github.com/o/r/pull/42" });
    expect(e.samePatch).toBe(true);
  });

  it("flags a patch hash that differs between stages", () => {
    const e = buildEvidence(row, cycle({ verify: { status: "passed", patchSha256: HASH }, review: { verdict: "approve", patchSha256: "b".repeat(64) } }));
    expect(e.samePatch).toBe(false);
  });

  it("does not point at a hash that was never recorded", () => {
    const e = buildEvidence(row, cycle({ fix: { outcome: "proposed", rule: "ok", rootCause: "x" } }));
    expect(stage(e, "fix").note).toBe("The patch text is not stored.");
  });

  it("claims nothing about patch agreement from a single recorded hash", () => {
    expect(buildEvidence(row, cycle({ verify: { status: "passed", patchSha256: HASH } })).samePatch).toBeNull();
  });

  it("does not link a pull request URL that isn't https", () => {
    const e = buildEvidence(row, cycle({ pr: { opened: true, number: 1, url: "javascript:alert(1)" } }));
    expect(stage(e, "pr").fields.some((f) => f.label === "Link")).toBe(false);
  });

  it("says the counter-check is not stored, rather than showing a number", () => {
    const e = buildEvidence(row, null);
    expect(stage(e, "counter-check")).toMatchObject({ status: "not-stored", fields: [] });
  });

  it("shows regressions only when there were some", () => {
    expect(stage(buildEvidence(row, null), "detected").fields.some((f) => f.label === "Regressions")).toBe(false);
    expect(stage(buildEvidence({ ...row, recurrenceCount: 2 }, null), "detected").fields.find((f) => f.label === "Regressions")?.value).toBe("2");
  });

  it("names the current recurrence's cycle", () => {
    expect(currentCycleId({ id: "inc-1", recurrenceCount: 0 })).toBe("inc-1_r0");
    expect(currentCycleId({ id: "inc-1", recurrenceCount: 3 })).toBe("inc-1_r3");
  });
});
