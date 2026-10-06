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
    expect(stage(e, "fix").note).toMatch(/diff is in the pull request on GitHub/);
    // The diff is a link to the pull request's files, never stored text (#39).
    expect(stage(e, "fix").fields.find((f) => f.label === "Diff")).toMatchObject({ href: "https://github.com/o/r/pull/42/files" });
    expect(stage(e, "fix").fields.map((f) => f.label)).toEqual(["Outcome", "Rule", "Root cause", "Test added", "Revisions", "Diff"]);
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

  it("says there is no diff to link to when verify ran but no pull request was opened", () => {
    const e = buildEvidence(row, cycle({ fix: { outcome: "proposed", rule: "ok", rootCause: "x" }, verify: { status: "passed", patchSha256: HASH } }));
    expect(stage(e, "fix").note).toMatch(/No pull request was opened/);
    expect(stage(e, "fix").fields.some((f) => f.label === "Diff")).toBe(false);
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

  it("shows the recount triage judged on beside the store's count, with the filter to run it again", () => {
    const e = buildEvidence(
      row,
      cycle({ triage: { decision: "act", rule: "model-act", reason: "r", counterCount: 9, counterWindow: "24h", counterCapped: false, counterFilter: 'severity>=ERROR' } })
    );
    const cc = stage(e, "counter-check");
    expect(cc.status).toBe("recorded");
    expect(cc.fields.map((f) => [f.label, f.value])).toEqual([
      ["Raw-log recount", "9"],
      ["Store's count (since first seen)", "12"],
      ["Window", "24h"],
      ["Filter counted", "severity>=ERROR"],
    ]);
    expect(cc.note).toBeUndefined();
  });

  it("says a capped recount is a lower bound, and a filter too long to keep was left out", () => {
    const cc = stage(buildEvidence(row, cycle({ triage: { decision: "act", counterCount: 1000, counterWindow: "24h", counterCapped: true } })), "counter-check");
    expect(cc.fields[0]).toMatchObject({ value: "at least 1000" });
    expect(cc.note).toMatch(/too long/);
  });

  it("says a missing recount is missing, never zero", () => {
    const cc = stage(buildEvidence(row, cycle({ triage: { decision: "defer", counterCount: null } })), "counter-check");
    expect(cc).toMatchObject({ status: "recorded", fields: [] });
    expect(cc.note).toMatch(/missing is not zero/);
  });

  it("does not show a number for a run recorded before the recount was kept, or before triage ran", () => {
    expect(stage(buildEvidence(row, cycle({ triage: { decision: "act" } })), "counter-check")).toMatchObject({ status: "not-stored", fields: [] });
    expect(stage(buildEvidence(row, null), "counter-check")).toMatchObject({ status: "not-reached", fields: [] });
  });

  it("lists the alternatives the fixer rejected and each attack the reviewer tried, in order", () => {
    const e = buildEvidence(
      row,
      cycle({
        fix: { outcome: "proposed", rule: "ok", rootCause: "x", alternative1: "Default to empty", alternative2: "Change the schema" },
        review: { verdict: "approve-with-flags", attacks: 2, attack1: "held: Empty order | Handled.", attack2: "flagged: Zero | Add a test." },
      })
    );
    expect(stage(e, "fix").fields.filter((f) => f.label.startsWith("Rejected")).map((f) => f.value)).toEqual(["Default to empty", "Change the schema"]);
    expect(stage(e, "review").fields.filter((f) => /^Attack \d/.test(f.label)).map((f) => f.label)).toEqual(["Attack 1", "Attack 2"]);
  });

  it("shows regressions only when there were some", () => {
    expect(stage(buildEvidence(row, null), "detected").fields.some((f) => f.label === "Regressions")).toBe(false);
    expect(stage(buildEvidence({ ...row, recurrenceCount: 2 }, null), "detected").fields.find((f) => f.label === "Regressions")?.value).toBe("2");
  });

  it("shows a log incident's Monitoring annotation, and nothing about Monitoring when there is none (#19)", () => {
    const plain = stage(buildEvidence(row, null), "detected");
    expect(plain.fields.some((f) => /Monitoring|Source/.test(f.label))).toBe(false);
    expect(plain.note).toBeUndefined();

    const annotated = stage(
      buildEvidence(
        {
          ...row,
          monitoringCount: 9,
          lastMonitoring: [
            {
              metricType: "run.googleapis.com/request_count",
              resourceType: "cloud_run_revision",
              projectId: "app-proj",
              windowStart: "2026-10-05T10:00:00.000Z",
              windowEnd: "2026-10-05T11:00:00.000Z",
              failureCount: 4,
              capped: true,
            },
          ],
        },
        null
      ),
      "detected"
    );
    expect(annotated.fields.find((f) => f.label === "Failed invocations (Cloud Monitoring)")?.value).toBe("9");
    expect(annotated.fields.find((f) => f.label === "Monitoring reading 1")?.value).toBe(
      "at least 4 failed · run.googleapis.com/request_count on cloud_run_revision in app-proj · 2026-10-05T10:00:00.000Z to 2026-10-05T11:00:00.000Z"
    );
    expect(annotated.fields.some((f) => f.label === "Source")).toBe(false);
  });

  it("says a Monitoring-only incident is one, and that its zero log recount is by construction (#19)", () => {
    const mon = { ...row, monitoringOnly: true as const, monitoringCount: 3 };
    const e = buildEvidence(mon, cycle({ triage: { decision: "notify", counterCount: 0, counterFilter: "f" } }));
    expect(stage(e, "detected").fields.find((f) => f.label === "Source")?.value).toBe("Cloud Monitoring only (no ERROR log entry)");
    expect(stage(e, "detected").note).toMatch(/^Monitoring only/);
    expect(stage(e, "counter-check").note).toMatch(/zero by construction/);
    // A log incident's recount carries no such note.
    expect(stage(buildEvidence(row, cycle({ triage: { counterCount: 0, counterFilter: "f" } })), "counter-check").note).toBeUndefined();
    // Not reached stays not reached: nothing is said about a recount that did not happen.
    expect(stage(buildEvidence(mon, null), "counter-check").note).toMatch(/^Not reached/);
  });

  it("names the current recurrence's cycle", () => {
    expect(currentCycleId({ id: "inc-1", recurrenceCount: 0 })).toBe("inc-1_r0");
    expect(currentCycleId({ id: "inc-1", recurrenceCount: 3 })).toBe("inc-1_r3");
  });
});

describe("buildEvidence: the pull request afterwards (#17)", () => {
  const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
  const opened = { opened: true, number: 42, url: "https://github.com/o/r/pull/42" };

  it("says a PR never read back was not checked, rather than guessing it is still open", () => {
    const e = buildEvidence(row, cycle({ pr: opened }), NOW);
    expect(stage(e, "pr").fields.find((f) => f.label === "State now")?.value).toBe("Not checked since it was opened");
    expect(stage(e, "pr").fields.some((f) => f.label === "Read from GitHub")).toBe(false);
  });

  it("shows the state as last read, when, and on which commit, and that a merge is not a heal", () => {
    const prState = { state: "merged", mergedAt: new Date(NOW - 2 * 3600_000).toISOString(), checks: "passed", headSha: "c".repeat(40), checkedAt: new Date(NOW - 60_000).toISOString() };
    const e = buildEvidence(row, cycle({ pr: opened, prState }), NOW);
    const pr = stage(e, "pr");
    expect(pr.fields.find((f) => f.label === "State now")?.value).toBe("merged 2h ago · checks passed");
    expect(pr.fields.find((f) => f.label === "Read from GitHub")?.value).toBe(prState.checkedAt);
    expect(pr.fields.find((f) => f.label === "Head commit")).toMatchObject({ value: "c".repeat(40), mono: true });
    expect(pr.note).toContain("not proof the incident is healed");
  });

  it("adds nothing for a cycle that opened no pull request", () => {
    const e = buildEvidence(row, cycle({ pr: { opened: false, reason: "dry-run" } }), NOW);
    expect(stage(e, "pr").fields.some((f) => f.label === "State now")).toBe(false);
    expect(stage(e, "pr").note).toBeUndefined();
  });
});

describe("buildEvidence: the missing-index path (#11)", () => {
  it("shows the index and its evidence pull request, not triage, a draft, a verify gate or a review", () => {
    const e = buildEvidence(
      { ...row, errorType: "MissingIndexError" },
      cycle({
        index: {
          state: "ready",
          collectionGroup: "orders",
          fields: "status ASCENDING, createdAt DESCENDING",
          created: true,
          probe: "passed",
          runtime: "healed",
          runtimeBasis: "no occurrence since READY",
        },
        pr: { opened: true, number: 11, url: "https://github.com/acme/shop/pull/11", patchSha256: HASH },
      })
    );
    expect(e.stages.map((s) => s.id)).toEqual(["detected", "index", "pr"]);
    const index = stage(e, "index");
    expect(index.fields).toEqual(
      expect.arrayContaining([
        { label: "Collection group", value: "orders", mono: true },
        { label: "Configured query replayed", value: "passed" },
        { label: "Runtime", value: expect.stringContaining("Healed") },
      ])
    );
    expect(index.note).toMatch(/No model wrote this fix/);
    expect(stage(e, "pr").note).toMatch(/already exists in production/);
  });

  it("a dry run on the index path records what it would have done, and no pull request", () => {
    const e = buildEvidence(row, cycle({ index: { state: "dry-run", live: "absent", probe: "needs-index", repoFile: "absent" } }));
    expect(stage(e, "index").fields.map((f) => f.label)).toEqual(["State", "Live inventory (dry run)", "Configured query replayed", "In the repository's index file"]);
    expect(stage(e, "pr").status).toBe("not-reached");
  });
});
