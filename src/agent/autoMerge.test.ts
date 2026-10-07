/**
 * Auto-merge's pure parts (#9): the switches, gate 2 over a run record, what the loop records when it opens the pull
 * request, and the evidence comment. The merge step itself is tested against the emulator (autoMerge.emulator.test.ts).
 */
import { describe, expect, it } from "vitest";
import { SEEDED_SECRETS } from "../ingest/testSecrets.js";
import { testConfig } from "../testConfig.js";
import { assessBlastRadius } from "./blastRadius.js";
import { certaintyGate, mergeBlockedBy, mergeEvidenceText, mergeRecordAtOpen } from "./autoMerge.js";

const P = "a".repeat(64);
const HEAD = "b".repeat(40);

/** A run record every check of gate 2 passes on. */
function provenSummary(over: Record<string, Record<string, unknown>> = {}): Record<string, Record<string, unknown>> {
  const base: Record<string, Record<string, unknown>> = {
    triage: { decision: "act", rule: "model-act", counterCount: 42, counterWindow: "24h" },
    fix: { outcome: "proposed", rule: "fixer-proposed", testAdded: true, rootCause: "couponCode is written as undefined." },
    before: { status: "failed", rule: "command-failed", patchSha256: "c".repeat(64), forPatchSha256: P },
    verify: { status: "passed", rule: "command-passed", patchSha256: P },
    review: { verdict: "approve", rule: "reviewed", held: 3, flagged: 0, broken: 0, patchSha256: P },
    pr: { opened: true, number: 7, patchSha256: P },
    merge: { state: "pending", number: 7, patchSha256: P, headSha: HEAD, gate1: "pass", fixClass: "firestore-undefined-field", sourceFile: "functions/src/orders/createOrder.ts", causeFrame: true },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
  return base;
}

describe("mergeBlockedBy: the switches", () => {
  const on = testConfig({ automationEnabled: true, dryRun: false, autoMerge: true, mergeFreeze: false, githubRepo: "acme/demo-shop", autoMergeTargets: ["acme/demo-shop"] });

  it("allows merging only when every switch says so", () => {
    expect(mergeBlockedBy(on)).toBeNull();
    expect(mergeBlockedBy({ ...on, githubRepo: "Acme/Demo-Shop" })).toBeNull(); // GitHub names are case-insensitive
  });

  it.each([
    ["the kill switch", { automationEnabled: false }, "automation-disabled"],
    ["a dry run", { dryRun: true }, "dry-run"],
    ["the merge freeze", { mergeFreeze: true }, "merge-freeze"],
    ["auto-merge off (the default)", { autoMerge: false }, "auto-merge-off"],
    ["a target not on the allowlist", { githubRepo: "acme/prod-shop" }, "target-not-allowed"],
    ["an empty allowlist (the default)", { autoMergeTargets: [] }, "target-not-allowed"],
    ["no target at all", { githubRepo: "", autoMergeTargets: [""] }, "target-not-allowed"],
  ])("blocks on %s", (_name, over, reason) => {
    expect(mergeBlockedBy({ ...on, ...over })).toBe(reason);
  });

  it("blocks with the engine's defaults: a non-demo deployment never merges", () => {
    expect(mergeBlockedBy(testConfig({ githubRepo: "acme/prod-shop" }))).not.toBeNull();
    expect(mergeBlockedBy(testConfig({ githubRepo: "acme/prod-shop", dryRun: false, autoMerge: true }))).toBe("target-not-allowed");
  });

  it("puts the global off switch above the per-target switch", () => {
    expect(mergeBlockedBy({ ...on, mergeFreeze: true, autoMerge: true })).toBe("merge-freeze");
  });
});

describe("certaintyGate: gate 2 over the run record", () => {
  it("passes a record with every piece of evidence", () => {
    expect(certaintyGate(provenSummary())).toEqual({ pass: true, failedChecks: [] });
  });

  it.each([
    ["a cause that is not structural (no stack frame names the file)", { merge: { causeFrame: false } }, "structural-cause"],
    ["a triage that did not act", { triage: { decision: "notify", rule: "model-notify" } }, "structural-cause"],
    ["a fixer that did not propose", { fix: { outcome: "declined", rule: "fixer-declined" } }, "structural-cause"],
    ["no test added", { fix: { testAdded: false } }, "fails-before"],
    ["a test that passed before the fix", { before: { status: "passed", rule: "command-passed" } }, "fails-before"],
    ["a before-run that could not run", { before: { status: "unavailable", rule: "no-test-in-patch" } }, "fails-before"],
    ["a before-run of another patch", { before: { forPatchSha256: "d".repeat(64) } }, "fails-before"],
    ["a before-run that timed out", { before: { status: "timeout", rule: "command-timeout" } }, "fails-before"],
    ["a failed verify", { verify: { status: "failed", rule: "command-failed" } }, "verify-passed"],
    ["a pull request of another patch", { pr: { patchSha256: "d".repeat(64) } }, "verify-passed"],
    ["a merge candidate of another patch", { merge: { patchSha256: "d".repeat(64) } }, "verify-passed"],
    ["approve with flags", { review: { verdict: "approve-with-flags", flagged: 1 } }, "review-approve"],
    ["a flagged attack under approve", { review: { flagged: 1 } }, "review-approve"],
    ["a broken attack", { review: { broken: 1 } }, "review-approve"],
    ["a review of another patch", { review: { patchSha256: "d".repeat(64) } }, "review-approve"],
    ["a counter-check of zero", { triage: { counterCount: 0 } }, "counter-check"],
    ["a missing counter-check", { triage: { counterCount: null } }, "counter-check"],
  ])("fails on %s", (_name, over, check) => {
    const r = certaintyGate(provenSummary(over as Record<string, Record<string, unknown>>));
    expect(r.pass).toBe(false);
    expect(r.failedChecks).toContain(check);
  });

  it("fails every check on a record with nothing in it, and on nonsense", () => {
    const all = ["structural-cause", "fails-before", "verify-passed", "review-approve", "counter-check"];
    expect(certaintyGate({}).failedChecks).toEqual(all);
    expect(certaintyGate(null).failedChecks).toEqual(all);
    expect(certaintyGate("approve").failedChecks).toEqual(all);
  });

  it("fails when there was no review at all (review not required)", () => {
    const s = provenSummary();
    delete s.review;
    expect(certaintyGate(s).failedChecks).toEqual(["review-approve"]);
  });

  it("does not take a string for a number", () => {
    expect(certaintyGate(provenSummary({ triage: { counterCount: "42" }, review: { broken: "0" } })).failedChecks).toEqual(["review-approve", "counter-check"]);
  });
});

describe("mergeRecordAtOpen", () => {
  const SRC = "functions/src/orders/createOrder.ts";
  const patch = `--- a/${SRC}\n+++ b/${SRC}\n@@ -1,3 +1,4 @@\n   const o = get(id);\n+  if (!o) return null;\n   return o;\n }\n`;
  const gate1 = assessBlastRadius(patch, { excludedPaths: [] });
  const now = new Date("2026-10-06T12:00:00.000Z");
  const stack = "Error: x\n    at createOrder (/workspace/lib/orders/createOrder.js:12:5)";
  const repoFiles = [SRC, "functions/src/orders/createOrder.test.ts", "functions/src/index.ts"];

  it("is a pending candidate when gate 1 passed and the head is known, with the stack frame tying the cause to the file", () => {
    expect(gate1.allowed).toBe(true);
    expect(mergeRecordAtOpen({ gate1, pr: { number: 7, url: "u", headSha: HEAD }, patchSha256: P, incident: { stackTrace: stack }, repoFiles, now })).toEqual({
      state: "pending",
      number: 7,
      patchSha256: P,
      headSha: HEAD,
      gate1: "pass",
      fixClass: "null-guard",
      sourceFile: SRC,
      causeFrame: true,
      causeCode: false,
      pendingSince: now.toISOString(),
    });
  });

  it("records no structural cause when the stack names another file, or there is none", () => {
    expect(mergeRecordAtOpen({ gate1, pr: { number: 7, url: "u", headSha: HEAD }, patchSha256: P, incident: { stackTrace: "at other (/workspace/lib/x/other.js:1:1)" }, repoFiles, now }).causeFrame).toBe(false);
    expect(mergeRecordAtOpen({ gate1, pr: { number: 7, url: "u", headSha: HEAD }, patchSha256: P, incident: {}, repoFiles, now }).causeFrame).toBe(false);
  });

  it("matches the frame against the checkout's whole file list: a frame of another file with the same tail is not the changed file (#203)", () => {
    const changed = "functions/src/orders/index.ts";
    const other = "functions/src/admin/orders/index.ts";
    const g = assessBlastRadius(`--- a/${changed}\n+++ b/${changed}\n@@ -1,3 +1,4 @@\n   const o = get(id);\n+  if (!o) return null;\n   return o;\n }\n`, { excludedPaths: [] });
    expect(g.allowed).toBe(true);
    const at = (frame: string, files: string[]) =>
      mergeRecordAtOpen({ gate1: g, pr: { number: 7, url: "u", headSha: HEAD }, patchSha256: P, incident: { stackTrace: `Error: x\n    at h (${frame}:12:20)` }, repoFiles: files, now }).causeFrame;
    expect(at("/workspace/lib/admin/orders/index.js", [changed, other])).toBe(false);
    expect(at("/workspace/lib/orders/index.js", [changed, other])).toBe(false); // the same tail as both: a tie
    expect(at("/workspace/functions/lib/orders/index.js", [changed, other])).toBe(true);
    // Without the checkout's list nothing ties the frame to the file.
    expect(at("/workspace/functions/lib/orders/index.js", [])).toBe(false);
  });

  it("is skipped when gate 1 failed, or when the opener cannot vouch for the head", () => {
    const bad = assessBlastRadius(`--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-a\n+b\n`, { excludedPaths: [] });
    expect(mergeRecordAtOpen({ gate1: bad, pr: { number: 7, url: "u", headSha: HEAD }, patchSha256: P, incident: {}, repoFiles, now })).toMatchObject({ state: "skipped", gate1: "fail" });
    expect(mergeRecordAtOpen({ gate1, pr: { number: 7, url: "u" }, patchSha256: P, incident: {}, repoFiles, now })).toMatchObject({ state: "skipped", reason: "head-unknown", headSha: null });
    expect(mergeRecordAtOpen({ gate1, pr: { number: 7, url: "u", headSha: "not-a-sha" }, patchSha256: P, incident: {}, repoFiles, now })).toMatchObject({ state: "skipped", reason: "head-unknown" });
  });
});

describe("mergeEvidenceText", () => {
  const checks = [
    { id: 11, name: "verify", status: "completed", conclusion: "success", url: "https://github.com/acme/demo-shop/actions/runs/1", app: "github-actions", title: "", summary: "" },
    { id: 12, name: "unrelated", status: "completed", conclusion: "failure", url: "", app: "github-actions", title: "", summary: "" },
  ];

  it("states every gate's evidence, the CI run on the head, and the fast-revert promise", () => {
    const text = mergeEvidenceText({ cycleId: "inc1_r0", summary: provenSummary(), checks, requiredChecks: ["verify"], headSha: HEAD, fastRevertMinutes: 60 });
    for (const s of ["Gate 1", "firestore-undefined-field", "Gate 2", "Test before the fix: **failed**", "Test after the fix: **passed**", P, "**approve**", "0 broken", "42 errors over 24h", "check run 11", "within 60 minutes", "inc1_r0", HEAD]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain("unrelated"); // only the named checks are evidence
  });

  it("keeps model text inert and secrets out", () => {
    const text = mergeEvidenceText({
      cycleId: "inc1_r0",
      summary: provenSummary({ fix: { rootCause: `@octocat [click](https://evil.example) fixes #1 ${SEEDED_SECRETS.github}` } }),
      checks,
      requiredChecks: ["verify"],
      headSha: HEAD,
      fastRevertMinutes: 60,
    });
    expect(text).not.toContain("@octocat");
    expect(text).not.toContain("](https://");
    expect(text).not.toContain("fixes #1");
    expect(text).not.toContain(SEEDED_SECRETS.github);
  });
});
