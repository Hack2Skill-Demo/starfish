import { describe, expect, it } from "vitest";
import { judgedOnGitHub, numbered, parseAttack, recordIsTheStep, stepDetail } from "./runStepDetail";
import { parseCycle, type CycleRow, type EventRow, type Step } from "./runsModel";

const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const T = 1_700_000_000_000;

function cycle(summary: Record<string, unknown>): CycleRow {
  return parseCycle("inc_r0", { incidentId: "inc", state: "waiting-human", createdAt: ts(T), updatedAt: ts(T + 60_000), summary })!;
}
const ev = (seq: number, stage: string, atMs: number, data: Record<string, unknown> = {}): EventRow => ({ id: String(seq), seq, stage, type: "x", summary: "", at: new Date(atMs), data: data as EventRow["data"] });
const step = (stage: string, atMs: number, over: Partial<Step> = {}): Step => ({ stage, title: stage, status: "done", at: new Date(atMs), ...over });

describe("parseAttack", () => {
  it("reads the loop's 'outcome: attack | detail' line", () => {
    expect(parseAttack("broken: null cart | the slip prints null")).toEqual({ outcome: "broken", attack: "null cart", detail: "the slip prints null" });
    expect(parseAttack("held: whitespace note")).toEqual({ outcome: "held", attack: "whitespace note" });
    expect(parseAttack("flagged: a | b | c")).toEqual({ outcome: "flagged", attack: "a", detail: "b | c" });
  });
  it("refuses a line that is not that shape", () => {
    expect(parseAttack("maybe: something")).toBeNull();
    expect(parseAttack("")).toBeNull();
  });
});

describe("numbered", () => {
  it("reads prefix1, prefix2... and stops at the first gap", () => {
    expect(numbered({ alternative1: "a", alternative2: "b", alternative4: "d" }, "alternative")).toEqual(["a", "b"]);
    expect(numbered(undefined, "attack")).toEqual([]);
  });
});

describe("recordIsTheStep", () => {
  it("is true only for the stage's latest event", () => {
    const events = [ev(1, "verify", T + 1000), ev(2, "verify", T + 5000)];
    expect(recordIsTheStep(step("verify", T + 5000), events)).toBe(true);
    // A replay paused on the first attempt: the record is the second attempt's.
    expect(recordIsTheStep(step("verify", T + 1000), events)).toBe(false);
    expect(recordIsTheStep({ stage: "verify" }, events)).toBe(false);
  });
});

describe("stepDetail", () => {
  it("reads triage's level, cap and recount, and keeps a failed recount as null, never zero", () => {
    const c = cycle({ triage: { level: "fix", cap: "fix", capBy: "rule", capRule: "r1", counterCount: 11, counterWindow: "24h", counterCapped: false } });
    expect(stepDetail(step("triage", T + 1000), c, [ev(1, "triage", T + 1000)]).triage).toEqual({
      level: "fix",
      levelLabel: expect.stringContaining("Log + fix"),
      cap: { level: "fix", by: "rule", rule: "r1" },
      recount: { count: 11, window: "24h", capped: false },
    });
    const failed = cycle({ triage: { level: "log", counterCount: null } });
    expect(stepDetail(step("triage", T + 1000), failed, [ev(1, "triage", T + 1000)]).triage?.recount).toEqual({ count: null, capped: false });
    // No recount recorded at all: nothing said about one.
    expect(stepDetail(step("triage", T + 1000), cycle({ triage: { level: "log" } }), [ev(1, "triage", T + 1000)]).triage?.recount).toBeUndefined();
  });

  it("names a merge case only for a merge", () => {
    const c = cycle({ triage: { level: "fix", mergeCase: "null-guard" } });
    expect(stepDetail(step("triage", T), c, [ev(1, "triage", T)]).triage?.mergeCase).toBeUndefined();
    const m = cycle({ triage: { level: "merge", mergeCase: "null-guard" } });
    expect(stepDetail(step("triage", T), m, [ev(1, "triage", T)]).triage?.mergeCase).toBe("null-guard");
  });

  it("reads the fix's risk, test, alternatives and the pull request's diff, never a patch text", () => {
    const c = cycle({
      fix: { risk: "Readers of the field", testAdded: true, revisions: 1, source: "stack-frame", alternative1: "Drop the field", alternative2: "Default to empty" },
      pr: { url: "https://github.com/o/r/pull/9/" },
    });
    expect(stepDetail(step("fix", T), c, [ev(1, "fix", T)])).toEqual({
      fix: { risk: "Readers of the field", testAdded: true, alternatives: ["Drop the field", "Default to empty"], source: "stack-frame", revisions: 1 },
      diffUrl: "https://github.com/o/r/pull/9/files",
    });
  });

  it("reads the verify gate's checks, and its refusal from the step's own event even when the record is a later attempt's", () => {
    const c = cycle({ verify: { status: "passed", files: 1, exitCode: 0, rule: "passed", patchSha256: "ab" } });
    const events = [ev(1, "verify", T, { output: "error: patch does not apply" }), ev(2, "verify", T + 9000)];
    expect(stepDetail(step("verify", T + 9000), c, events).verify).toEqual({ files: 1, exitCode: 0, rule: "passed", patchSha256: "ab" });
    const first = stepDetail(step("verify", T, { data: { output: "error: patch does not apply" } }), c, events);
    expect(first.verify).toEqual({ output: "error: patch does not apply" });
  });

  it("says GitHub judged the verify step only when the target's checks there ran on the pushed commit", () => {
    const at = (verify: Record<string, unknown>) => stepDetail(step("verify", T), cycle({ verify }), [ev(1, "verify", T)]).verify;
    expect(at({ rule: "command-passed", isolation: "github-actions" })).toMatchObject({ isolation: "github-actions" });
    expect(judgedOnGitHub(at({ rule: "command-passed", isolation: "github-actions" }))).toBe(true);
    expect(judgedOnGitHub(at({ rule: "command-failed", isolation: "github-actions" }))).toBe(true);
    // Refused by the local checks before anything was pushed: GitHub never saw it.
    expect(judgedOnGitHub(at({ rule: "patch-does-not-apply", isolation: "github-actions" }))).toBe(false);
    expect(judgedOnGitHub(at({ rule: "command-passed", isolation: "cloud-run-job" }))).toBe(false);
    // A record written before the isolation was kept says nothing either way.
    expect(judgedOnGitHub(at({ rule: "command-passed" }))).toBe(false);
    expect(judgedOnGitHub(undefined)).toBe(false);
  });

  it("reads the review's counts and attacks", () => {
    const c = cycle({ review: { verdict: "block", held: 2, flagged: 0, broken: 1, attack1: "held: no note | fine", attack2: "broken: readers | print null", attack3: "garbage" } });
    expect(stepDetail(step("review", T), c, [ev(1, "review", T)]).review).toEqual({
      held: 2,
      flagged: 0,
      broken: 1,
      attacks: [
        { outcome: "held", attack: "no note", detail: "fine" },
        { outcome: "broken", attack: "readers", detail: "print null" },
      ],
    });
  });

  it("reads the model that wrote the fix and the review, and leaves it out of an older record", () => {
    const c = cycle({ fix: { outcome: "proposed", model: "gemini-3.1-pro-preview", revisions: 0 }, review: { verdict: "approve", model: "gemini-3.1-pro-preview", attacks: 1 } });
    expect(stepDetail(step("fix", T), c, [ev(1, "fix", T)]).fix!.model).toBe("gemini-3.1-pro-preview");
    expect(stepDetail(step("review", T), c, [ev(1, "review", T)]).review!.model).toBe("gemini-3.1-pro-preview");
    const old = cycle({ fix: { outcome: "proposed", revisions: 0 }, review: { verdict: "approve", attacks: 1 } });
    expect(stepDetail(step("fix", T), old, [ev(1, "fix", T)]).fix!.model).toBeUndefined();
    expect(stepDetail(step("review", T), old, [ev(1, "review", T)]).review!.model).toBeUndefined();
  });

  it("reads a delivery's attempts and reason", () => {
    const c = cycle({ notify: { state: "failed", attempts: 3, reason: "HTTP 500" } });
    expect(stepDetail(step("notify", T, { status: "failed" }), c, [ev(1, "notify", T)]).delivery).toEqual({ state: "failed", attempts: 3, reason: "HTTP 500" });
  });

  it("reads why the missing-index step stopped, and nothing when a guest's copy kept no text", () => {
    const reason = "The configured query already succeeds, so this index is not what it needs; nothing was created.";
    const stored = cycle({ index: { state: "refused", rule: "probe-not-confirmed", reason } });
    expect(stepDetail(step("index", T), stored, [ev(1, "index", T)]).index).toEqual({ reason });
    const guest = cycle({ index: { state: "refused", rule: "probe-not-confirmed" } });
    expect(stepDetail(step("index", T), guest, [ev(1, "index", T)]).index).toBeUndefined();
    expect(stepDetail(step("index", T), cycle({ index: { state: "ready" } }), [ev(1, "index", T)]).index).toBeUndefined();
  });

  it("gives nothing for a step that was not reached, or a guest's copy that kept no text", () => {
    const c = cycle({ review: { verdict: "block", attacks: 3, held: 3 } });
    expect(stepDetail({ stage: "review", title: "r", status: "not-reached" }, c, [])).toEqual({});
    expect(stepDetail(step("review", T), c, [ev(1, "review", T)]).review).toEqual({ held: 3, attacks: [] });
  });
});
