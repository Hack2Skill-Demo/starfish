import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GithubError, type CheckAnnotation, type CheckRun } from "../integrations/githubPr.js";
import { createCiVerifier, CI_SLACK_SECONDS, type CiClient } from "./verifyCi.js";
import type { VerifyRequest, VerifyResult } from "./verifyGate.js";
import { VerifyRunnerError } from "./verifyProtocol.js";

const PATCH = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const COMMIT = "c".repeat(40);
const BASE = "b".repeat(40);

const run = (over: Partial<CheckRun> = {}): CheckRun => ({ id: 1, name: "verify", status: "completed", conclusion: "success", url: "https://github.com/acme/shop/runs/1", title: "", summary: "", ...over });
const request = (over: Partial<VerifyRequest> = {}): VerifyRequest => ({
  cycleId: "inc1_r0",
  sourceDir: "/unused",
  patch: PATCH,
  baseRevision: BASE,
  config: { verifyCommand: "", verifyTimeoutSeconds: 600, patchExcludedPaths: [] },
  ...over,
});
const passedLocally: VerifyResult = { status: "passed", rule: "command-passed", reason: "ok", patchSha256: "x", changedFiles: ["a.ts"], output: "", durationMs: 1 };

function harness(opts: { runs?: (poll: number) => CheckRun[]; local?: VerifyResult; annotations?: CheckAnnotation[] | Error; push?: () => Promise<{ branch: string; commit: string }>; deleteFails?: boolean; checks?: string[] } = {}) {
  const calls: string[] = [];
  let poll = 0;
  let t = 0;
  const client: CiClient = {
    async pushPatchBranch(req) {
      calls.push(`push:${req.cycleId}:${req.baseRevision}:${req.patchSha256}`);
      return opts.push ? opts.push() : { branch: `starfish/${req.cycleId}`, commit: COMMIT };
    },
    async deleteBranch(id) {
      calls.push(`delete:${id}`);
      if (opts.deleteFails) throw new Error("boom");
    },
    async listCheckRuns(commit) {
      calls.push(`list:${commit}`);
      return (opts.runs ?? (() => [run()]))(poll++);
    },
    async annotations(id) {
      calls.push(`annotations:${id}`);
      if (opts.annotations instanceof Error) throw opts.annotations;
      return opts.annotations ?? [];
    },
  };
  const verify = createCiVerifier(
    { verifyTimeoutSeconds: 600, verifyChecks: opts.checks ?? ["verify"] },
    { client, check: async () => opts.local ?? passedLocally, now: () => t, sleep: async (ms) => void (t += ms), pollMs: 10_000 }
  );
  return { verify, calls, clock: () => t };
}

describe("createCiVerifier", () => {
  it("passes when every named check succeeded on the pushed commit, and keeps the branch for the pull request", async () => {
    const h = harness();
    const r = await h.verify(request());
    expect(r).toMatchObject({ status: "passed", rule: "command-passed", exitCode: 0, baseRevision: BASE, changedFiles: ["a.ts"] });
    expect(r.patchSha256).toBe(createHash("sha256").update(PATCH).digest("hex"));
    expect(r.reason).toContain(COMMIT.slice(0, 12));
    expect(h.calls).toEqual([`push:inc1_r0:${BASE}:${r.patchSha256}`, `list:${COMMIT}`]);
  });

  it("returns the gate's own refusal without pushing anything: nothing leaves the process for a patch the gate refused", async () => {
    const refusal: VerifyResult = { ...passedLocally, status: "rejected", rule: "excluded-path", reason: "touches .github/", changedFiles: [".github/ci.yml"] };
    const h = harness({ local: refusal });
    expect(await h.verify(request())).toEqual(refusal);
    expect(h.calls).toEqual([]);
  });

  it("fails, with what the checks said, when a named check did not succeed, and deletes the branch so the next draft can use it", async () => {
    const h = harness({
      runs: () => [run({ id: 7, conclusion: "failure", title: "3 tests failed", summary: "see log" })],
      annotations: [{ path: "src/a.test.ts", line: 12, level: "failure", message: "expected 1 to be 2" }],
    });
    const r = await h.verify(request());
    expect(r).toMatchObject({ status: "failed", rule: "command-failed", exitCode: 1 });
    expect(r.output).toContain("verify: failure");
    expect(r.output).toContain("3 tests failed - see log");
    expect(r.output).toContain("src/a.test.ts:12 expected 1 to be 2");
    expect(h.calls).toContain("delete:inc1_r0");
  });

  it.each(["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"])("does not count a check that concluded %s as a pass", async (conclusion) => {
    const r = await harness({ runs: () => [run({ conclusion })] }).verify(request());
    expect(r.status).toBe("failed");
  });

  it("waits while the check appears, queues and runs, and judges only once it has finished", async () => {
    const h = harness({
      runs: (n) => [[], [run({ status: "queued", conclusion: null })], [run({ status: "in_progress", conclusion: null })], [run()]][Math.min(n, 3)]!,
    });
    const r = await h.verify(request());
    expect(r.status).toBe("passed");
    expect(h.calls.filter((c) => c.startsWith("list:"))).toHaveLength(4);
    expect(h.clock()).toBe(30_000);
  });

  it("ignores the target's other checks: only the named ones judge", async () => {
    const r = await harness({ runs: () => [run(), run({ id: 2, name: "deploy-preview", conclusion: "failure" })] }).verify(request());
    expect(r.status).toBe("passed");
  });

  it("needs every named check, and waits for all of them", async () => {
    const h = harness({
      checks: ["verify", "lint"],
      runs: (n) => (n < 2 ? [run()] : [run(), run({ id: 2, name: "lint" })]),
    });
    expect((await h.verify(request())).status).toBe("passed");
    expect(h.calls.filter((c) => c.startsWith("list:")).length).toBe(3);
    const bad = await harness({ checks: ["verify", "lint"], runs: () => [run(), run({ id: 2, name: "lint", conclusion: "failure" })] }).verify(request());
    expect(bad).toMatchObject({ status: "failed" });
    expect(bad.reason).toContain("lint failure");
  });

  it("reports a check still running at the deadline as a timeout (a result), and deletes the branch", async () => {
    const h = harness({ runs: () => [run({ status: "in_progress", conclusion: null })] });
    const r = await h.verify(request());
    expect(r).toMatchObject({ status: "timeout", rule: "command-timeout", exitCode: null });
    expect(h.clock()).toBeGreaterThanOrEqual((600 + CI_SLACK_SECONDS) * 1000);
    expect(h.calls).toContain("delete:inc1_r0");
  });

  it("THROWS when the named check never appears: the target's workflow is not running, which is not the patch's fault", async () => {
    const h = harness({ runs: () => [run({ name: "something-else" })] });
    await expect(h.verify(request())).rejects.toThrow(/no check named "verify".*push to starfish\/\*\*/);
    expect(h.calls).toContain("delete:inc1_r0");
  });

  it("THROWS when the check is still only queued at the deadline: no runner is not a verdict", async () => {
    await expect(harness({ runs: () => [run({ status: "queued", conclusion: null })] }).verify(request())).rejects.toThrow(/not started .*"verify"/);
  });

  it("lets a failed push escape, and still tries to remove what it may have left", async () => {
    const h = harness({
      push: async () => {
        throw new GithubError("branch-conflict", "A pull request already exists");
      },
    });
    await expect(h.verify(request())).rejects.toThrow("pull request already exists");
    expect(h.calls).toContain("delete:inc1_r0");
  });

  it("does not let a failed branch deletion or failed annotations change the verdict", async () => {
    const h = harness({ runs: () => [run({ conclusion: "failure" })], annotations: new Error("rate limited"), deleteFails: true });
    expect((await h.verify(request())).status).toBe("failed");
  });

  it("bounds and redacts what it reports", async () => {
    const h = harness({
      runs: () => [run({ conclusion: "failure", summary: "x".repeat(50) })],
      annotations: [{ path: "a.ts", line: 1, level: "failure", message: `mail alice@example.com ${"y".repeat(100_000)}` }],
    });
    const r = await h.verify(request());
    expect(r.output.length).toBeLessThanOrEqual(20_000);
    expect(r.output).not.toContain("alice@example.com");
  });

  it("needs the cycle and the pinned revision, and refuses to be built without a judge", async () => {
    const h = harness();
    await expect(h.verify(request({ cycleId: undefined }))).rejects.toThrow(VerifyRunnerError);
    await expect(h.verify(request({ baseRevision: undefined }))).rejects.toThrow(VerifyRunnerError);
    expect(h.calls).toEqual([]);
    expect(() => createCiVerifier({ verifyTimeoutSeconds: 1, verifyChecks: [] }, { client: {} as CiClient })).toThrow(VerifyRunnerError);
  });
});
