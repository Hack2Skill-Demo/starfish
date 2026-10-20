import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  afterFix,
  afterReview,
  afterVerify,
  counterCheckRecord,
  filesDigest,
  keptTriage,
  MAX_REVISIONS,
  prHandOff,
  readBaseFiles,
  retryWords,
  reusableVerifiedPatch,
  roundOf,
  triageOptionsFor,
  verifiedPatchCheckpoint,
  verifySetupDigest,
} from "./loop.js";
import { sha256 } from "./reviewer.js";
import type { VerifyResult } from "./verifyGate.js";

describe("counterCheckRecord: the recount kept with triage's decision (#39)", () => {
  it("keeps the count, window, cap, time and the exact filter", () => {
    expect(counterCheckRecord({ window: "24h", count: 12, capped: true, filter: 'severity>=ERROR AND resource.labels.function_name="f"', checkedAt: "2026-10-05T10:00:00.000Z" })).toEqual({
      counterCount: 12,
      counterWindow: "24h",
      counterCapped: true,
      counterCheckedAt: "2026-10-05T10:00:00.000Z",
      counterFilter: 'severity>=ERROR AND resource.labels.function_name="f"',
    });
  });

  it("records a missing check as missing, never as zero", () => {
    expect(counterCheckRecord(undefined)).toEqual({ counterCount: null });
    expect(counterCheckRecord({ window: "24h", count: Number.NaN })).toEqual({ counterCount: null });
  });

  it("keeps a realistic filter longer than an ordinary record value whole", () => {
    const filter = `severity>=ERROR AND ${"NOT resource.labels.service_name=\"starfish-ingest\" ".repeat(10)}`;
    expect(filter.length).toBeGreaterThan(300);
    expect(counterCheckRecord({ window: "24h", count: 1, filter }).counterFilter).toBe(filter);
  });

  it("leaves out a filter too long to store whole, rather than keeping a cut one that would count something else", () => {
    const r = counterCheckRecord({ window: "24h", count: 3, filter: "x".repeat(2001) });
    expect(r.counterFilter).toBeUndefined();
    expect(r.counterCount).toBe(3);
  });
});

describe("readBaseFiles: the base content gate 1 judges the enclosing function on (#202)", () => {
  const root = mkdtempSync(join(tmpdir(), "base-files-"));
  const outside = mkdtempSync(join(tmpdir(), "base-outside-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/order.ts"), "export function f() {\n  return 1;\n}\n");
  writeFileSync(join(outside, "secret.ts"), "if (isOwner(x)) return true;\n");
  symlinkSync(join(outside, "secret.ts"), join(root, "src/linked.ts"));
  symlinkSync(outside, join(root, "linkdir"));
  writeFileSync(join(root, "src/binary.ts"), "a\0b");
  const edit = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
  const created = "--- /dev/null\n+++ b/src/new.test.ts\n@@ -0,0 +1 @@\n+x\n";

  it("reads the existing files the patch changes, and nothing else", async () => {
    const got = await readBaseFiles(root, edit("src/order.ts") + created);
    expect([...got.keys()]).toEqual(["src/order.ts"]);
    expect(got.get("src/order.ts")).toContain("return 1;");
  });

  it("leaves out a missing file, a symbolic link, a path through one, and a binary file: gate 1 then refuses", async () => {
    for (const path of ["src/missing.ts", "src/linked.ts", "linkdir/secret.ts", "src/binary.ts"]) {
      expect((await readBaseFiles(root, edit(path))).size, path).toBe(0);
    }
    expect((await readBaseFiles(join(root, "nope"), edit("src/order.ts"))).size).toBe(0);
    expect((await readBaseFiles(root, "garbage")).size).toBe(0);
  });
});

describe("roundOf / retryWords", () => {
  it("counts a run's rounds from its reopenings, reading anything odd as round 1", () => {
    expect(roundOf(undefined)).toBe(1);
    expect(roundOf({})).toBe(1);
    expect(roundOf({ reconsiderCount: 1 })).toBe(2);
    expect(roundOf({ reconsiderCount: 3 })).toBe(4);
    for (const odd of [-1, 0.5, "x", null, Number.NaN]) expect(roundOf({ reconsiderCount: odd }), String(odd)).toBe(1);
  });

  it("words a retry from round 2 only, with why in Starfish's own words, never a stored string it does not know", () => {
    expect(retryWords(1, "operator")).toEqual({});
    expect(retryWords(2, "operator")).toEqual({ round: 2, retriedBecause: "an operator asked for a retriage" });
    expect(retryWords(2, "<!channel> injected")).toEqual({ round: 2 });
    expect(retryWords(3, "toString")).toEqual({ round: 3 });
    expect(retryWords(2, undefined)).toEqual({ round: 2 });
  });
});

describe("the loop's decisions after each stage, which the replay takes too (#418, #420)", () => {
  const verified = (status: "passed" | "failed"): VerifyResult =>
    ({ status, rule: status === "passed" ? "command-passed" : "command-failed", reason: "r", patchSha256: "h", changedFiles: [], output: "", durationMs: 1 }) as VerifyResult;

  it("retries only what a later attempt may do better at; everything else goes to a person", () => {
    expect(afterFix({ outcome: "error", rule: "model-call-failed", rootCause: "x" })).toEqual({ next: "retry", rule: "model-call-failed" });
    expect(afterFix({ outcome: "error", rule: "model-output-invalid", rootCause: "x" })).toEqual({ next: "retry", rule: "model-output-invalid" });
    for (const rule of ["model-output-truncated", "model-output-blocked", "patch-too-large", "patch-malformed"] as const) {
      expect(afterFix({ outcome: "error", rule, rootCause: "why" })).toEqual({ next: "person", rule, reason: "why" });
    }
    expect(afterFix({ outcome: "declined", rule: "fixer-declined", rootCause: "no" })).toMatchObject({ next: "person" });
    expect(afterFix({ outcome: "proposed", rule: "fixer-proposed", rootCause: "c", patch: "p" })).toEqual({ next: "verify", patch: "p" });
  });

  it("hands a review refused for its evidence to a person: a logic error no retry corrects", () => {
    expect(afterReview({ rule: "evidence-mismatch", reason: "another patch" }, "p", 0)).toEqual({ next: "person", rule: "evidence-mismatch", reason: "another patch" });
    expect(afterReview({ rule: "evidence-not-passed", reason: "x" }, "p", 0)).toMatchObject({ next: "person" });
    expect(afterReview({ rule: "model-output-blocked", reason: "x" }, "p", 0)).toMatchObject({ next: "person" });
    expect(afterReview({ rule: "model-call-failed", reason: "x" }, "p", 0)).toEqual({ next: "retry", rule: "model-call-failed" });
    expect(afterReview({ rule: "review-empty", reason: "x" }, "p", 0)).toEqual({ next: "retry", rule: "review-empty" });
  });

  it("gives a failed verify or a blocking review the one revision, then a person", () => {
    expect(afterVerify(verified("passed"), "p", 0)).toEqual({ next: "review" });
    expect(afterVerify(verified("failed"), "p", 0)).toMatchObject({ next: "revise", feedback: { kind: "verify", previousPatch: "p" } });
    expect(afterVerify(verified("failed"), "p", MAX_REVISIONS)).toEqual({ next: "person", rule: "verify-command-failed", reason: "r" });
    const blocked = { rule: "reviewed" as const, verdict: "block" as const, attacks: [{ attack: "a", outcome: "broken" as const, detail: "d" }] };
    expect(afterReview(blocked, "p", 0)).toMatchObject({ next: "revise", feedback: { kind: "review", broken: ["a: d"] } });
    expect(afterReview(blocked, "p", MAX_REVISIONS)).toMatchObject({ next: "person", rule: "review-blocked" });
    expect(afterReview({ rule: "reviewed", verdict: "approve-with-flags", attacks: [] }, "p", 0)).toEqual({ next: "pr", verdict: "approve-with-flags" });
  });

  it("gives triage the admin's merge cases and class rules, and the files the fixer will see", () => {
    const files = [{ path: "a.ts", content: "x", foundBy: "frame" as const }];
    const mergeCases = [{ id: "null-guard", description: "d" }];
    expect(triageOptionsFor({ mergeCases, classRules: [] }, files)).toEqual({ mergeCases, classRules: [], source: { files } });
  });
});


describe("keptTriage: the round's decision a resumed attempt keeps (#414)", () => {
  const record = {
    decision: "act",
    rule: "model-act",
    reason: "A defect in the order code.",
    suspectedCause: "createOrder writes undefined",
    level: "merge",
    mergeCase: "null-guard",
    cap: null,
    capBy: null,
    capRule: null,
    round: 2,
  };

  it("keeps the decision, the rule, the reason, the suspected cause and the merge case of this round", () => {
    expect(keptTriage(record, 2, null)).toEqual({
      decision: "act",
      rule: "model-act",
      reason: "A defect in the order code.",
      suspectedCause: "createOrder writes undefined",
      mergeCase: "null-guard",
    });
  });

  it("keeps the cap it was decided under", () => {
    const capped = { ...record, decision: "notify", rule: "rule-cap", level: "log", mergeCase: null, cap: "log", capBy: "rule", capRule: "quota-log" };
    expect(keptTriage(capped, 2, { level: "log", by: "rule", ruleId: "quota-log" })).toMatchObject({ decision: "notify", cap: { level: "log", by: "rule", ruleId: "quota-log" } });
    expect(keptTriage(capped, 2, null)?.mergeCase).toBeUndefined();
  });

  it("asks again for another round's record, or one written without its round", () => {
    expect(keptTriage(record, 3, null)).toBeNull();
    expect(keptTriage({ ...record, round: undefined }, 2, null)).toBeNull();
  });

  it("asks again for a decision that released the cycle, or a record that is not one", () => {
    for (const decision of ["defer", "error", "skip", "nonsense"]) expect(keptTriage({ ...record, decision }, 2, null), decision).toBeNull();
    expect(keptTriage(undefined, 2, null)).toBeNull();
    expect(keptTriage("act", 2, null)).toBeNull();
    expect(keptTriage({ ...record, rule: "" }, 2, null)).toBeNull();
    expect(keptTriage({ ...record, reason: 3 }, 2, null)).toBeNull();
  });

  it("asks again when a cap made since holds the decision back, and keeps it when the cap allows it", () => {
    expect(keptTriage(record, 2, { level: "fix", by: "correction" })).toBeNull();
    expect(keptTriage({ ...record, mergeCase: null, level: "fix" }, 2, { level: "fix", by: "correction" })).toMatchObject({ decision: "act" });
    expect(keptTriage({ ...record, mergeCase: null }, 2, { level: "log", by: "rule", ruleId: "r" })).toBeNull();
    expect(keptTriage({ ...record, decision: "decline", rule: "model-decline", mergeCase: null }, 2, { level: "noise", by: "correction" })).toMatchObject({ decision: "decline" });
  });

  it("keeps a merge case only with act", () => {
    expect(keptTriage({ ...record, decision: "notify", rule: "model-notify" }, 2, null)?.mergeCase).toBeUndefined();
  });
});

describe("the verified-patch checkpoint a resumed attempt reuses (#450)", () => {
  const PATCH = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-hello old\n+hello new\n";
  const HASH = sha256(PATCH);
  const at = {
    round: 1,
    revisions: 0,
    baseRevision: "rev1",
    filesSha256: filesDigest([{ path: "greeting.txt", content: "hello old\n" }]),
    verifySetup: verifySetupDigest({ verifyIsolation: "in-process", verifyCommand: "pnpm test", patchExcludedPaths: [".github/"] }),
  };
  const passed: VerifyResult = { status: "passed", rule: "command-passed", reason: "Passed.", patchSha256: HASH, baseRevision: "rev1", changedFiles: ["greeting.txt"], exitCode: 0, output: "ok", durationMs: 12 };
  const claimed = { rootCause: "The greeting is old.", risk: "None." };
  const checkpoint = () => verifiedPatchCheckpoint(PATCH, claimed, passed, at)!;
  const cycle = (over: Record<string, unknown> = {}) => ({ summary: { verify: { status: "passed", patchSha256: HASH, baseRevision: "rev1" }, ...over } });

  it("keeps exactly the patch the gate passed, with its verify result, bound to the hash the run record holds", () => {
    const kept = reusableVerifiedPatch(checkpoint(), cycle(), at);
    expect(kept).toEqual({ patch: PATCH, rootCause: claimed.rootCause, risk: claimed.risk, verified: passed, beforeRecorded: false });
    expect(reusableVerifiedPatch(checkpoint(), cycle({ before: { status: "failed", forPatchSha256: HASH } }), at)?.beforeRecorded).toBe(true);
  });

  it("keeps nothing that is not a pass, or is too large to keep", () => {
    expect(verifiedPatchCheckpoint(PATCH, claimed, { ...passed, status: "failed", rule: "command-failed" }, at)).toBeNull();
    expect(verifiedPatchCheckpoint(PATCH, claimed, { ...passed, patchSha256: "b".repeat(64) }, at)).toBeNull();
    expect(verifiedPatchCheckpoint(PATCH + "x".repeat(40_000), claimed, { ...passed, patchSha256: sha256(PATCH + "x".repeat(40_000)) }, at)).toBeNull();
  });

  it("drafts again when the stored text or the run record's verify does not match", () => {
    expect(reusableVerifiedPatch(undefined, cycle(), at)).toBeNull();
    expect(reusableVerifiedPatch({ ...checkpoint(), patch: PATCH.replace("new", "newer") }, cycle(), at)).toBeNull();
    expect(reusableVerifiedPatch(checkpoint(), { summary: {} }, at)).toBeNull();
    expect(reusableVerifiedPatch(checkpoint(), cycle({ verify: { status: "failed", patchSha256: HASH, baseRevision: "rev1" } }), at)).toBeNull();
    expect(reusableVerifiedPatch(checkpoint(), cycle({ verify: { status: "passed", patchSha256: "c".repeat(64), baseRevision: "rev1" } }), at)).toBeNull();
    expect(reusableVerifiedPatch({ ...checkpoint(), version: 2 }, cycle(), at)).toBeNull();
    expect(reusableVerifiedPatch({ ...checkpoint(), verify: { ...(checkpoint().verify as object), changedFiles: [] } }, cycle(), at)).toBeNull();
  });

  it("drafts again in another round, after a revision, on another base, from other files or under another verify setup", () => {
    expect(reusableVerifiedPatch(checkpoint(), cycle(), { ...at, round: 2 })).toBeNull();
    expect(reusableVerifiedPatch(checkpoint(), cycle(), { ...at, revisions: 1 })).toBeNull();
    expect(reusableVerifiedPatch(checkpoint(), cycle({ verify: { status: "passed", patchSha256: HASH, baseRevision: "rev2" } }), { ...at, baseRevision: "rev2" })).toBeNull();
    expect(reusableVerifiedPatch(checkpoint(), cycle(), { ...at, filesSha256: filesDigest([{ path: "greeting.txt", content: "hello older\n" }]) })).toBeNull();
    expect(reusableVerifiedPatch(checkpoint(), cycle(), { ...at, verifySetup: verifySetupDigest({ verifyIsolation: "github-actions", verifyCommand: "pnpm test", patchExcludedPaths: [".github/"] }) })).toBeNull();
  });

  it("never reuses a patch the review already blocked", () => {
    expect(reusableVerifiedPatch(checkpoint(), cycle({ review: { verdict: "block", patchSha256: HASH } }), at)).toBeNull();
    expect(reusableVerifiedPatch(checkpoint(), cycle({ review: { verdict: null, rule: "model-call-failed", patchSha256: HASH } }), at)).not.toBeNull();
  });
});

describe("prHandOff: the word a person is owed about an open pull request (#412)", () => {
  it("owes nothing for a plain pull request or a pending candidate", () => {
    expect(prHandOff(undefined)).toBeNull();
    expect(prHandOff({ state: "pending" })).toBeNull();
    expect(prHandOff({ state: "merged" })).toBeNull();
  });

  it("names the rule a skipped candidate's message carries, from the record's reason", () => {
    expect(prHandOff({ state: "skipped", reason: "floor:excluded:configured" })?.rule).toBe("auto-merge-floor");
    expect(prHandOff({ state: "skipped", reason: "head-unknown" })?.rule).toBe("auto-merge-floor");
    expect(prHandOff({ state: "skipped", reason: "incident-merge-watched" })?.rule).toBe("auto-merge-incident-merge-watched");
    expect(prHandOff({ state: "skipped", reason: "incident-reverted-before" })?.rule).toBe("auto-merge-incident-reverted-before");
    expect(prHandOff({ state: "skipped", reason: "resumed-without-candidate" })?.rule).toBe("auto-merge-resumed");
    // A skipped record whose reason is unreadable still owes a person a word: Starfish will not merge it.
    expect(prHandOff({ state: "skipped" })).toMatchObject({ rule: "auto-merge-floor" });
    expect(prHandOff({ state: "skipped", reason: "head-unknown" })?.reason).toContain("A person decides.");
  });
});
