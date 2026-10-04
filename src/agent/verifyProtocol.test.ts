import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VerifyRunnerError, parseRunnerRequest, parseRunnerResult, transferUrlOk } from "./verifyProtocol.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PATCH_SHA = sha("patch");
const good = {
  v: 1,
  bundleUrl: "https://storage.googleapis.com/b/verify/r/bundle.tgz?X-Goog-Signature=abc",
  resultUrl: "https://storage.googleapis.com/b/verify/r/result.json?X-Goog-Signature=def",
  patchSha256: PATCH_SHA,
  command: "pnpm test",
  timeoutSeconds: 600,
  excludedPaths: [".github/"],
  baseRevision: "a".repeat(40),
};
const req = (over: Record<string, unknown> = {}) => JSON.stringify({ ...good, ...over });

describe("transferUrlOk", () => {
  it.each([
    ["https://storage.googleapis.com/b/o?sig=1", true],
    ["https://b.storage.googleapis.com/o?sig=1", true],
    ["http://127.0.0.1:9000/o", true],
    ["http://localhost/o", true],
    ["http://storage.googleapis.com/o", false],
    ["https://evil.example/o", false],
    ["https://storage.googleapis.com.evil.example/o", false],
    ["https://evilstorage.googleapis.com/o", false],
    ["http://169.254.169.254/computeMetadata/v1/", false],
    ["file:///etc/passwd", false],
    ["not a url", false],
    [`https://storage.googleapis.com/${"a".repeat(5000)}`, false],
  ])("%s -> %s", (url, ok) => expect(transferUrlOk(url)).toBe(ok));
});

describe("parseRunnerRequest", () => {
  it("accepts a well-formed request", () => {
    expect(parseRunnerRequest(req())).toMatchObject({ v: 1, command: "pnpm test", timeoutSeconds: 600, patchSha256: PATCH_SHA });
  });

  it.each([
    ["not json", "{"],
    ["a different version", req({ v: 2 })],
    ["a bundle url off Cloud Storage", req({ bundleUrl: "https://evil.example/x" })],
    ["a result url to the metadata server", req({ resultUrl: "http://169.254.169.254/x" })],
    ["a patch hash that is not one", req({ patchSha256: "abc" })],
    ["an empty command", req({ command: "  " })],
    ["a command that is far too long", req({ command: "x".repeat(5000) })],
    ["a timeout of zero", req({ timeoutSeconds: 0 })],
    ["a timeout over an hour", req({ timeoutSeconds: 7200 })],
    ["a timeout that is a string", req({ timeoutSeconds: "600" })],
    ["excluded paths that are not strings", req({ excludedPaths: [1] })],
    ["too many excluded paths", req({ excludedPaths: Array.from({ length: 201 }, () => "x") })],
    ["a base revision that is a number", req({ baseRevision: 5 })],
  ])("refuses %s", (_what, raw) => {
    expect(() => parseRunnerRequest(raw)).toThrow(VerifyRunnerError);
  });

  it("never puts a signed URL in the error", () => {
    try {
      parseRunnerRequest(req({ resultUrl: "https://evil.example/x?X-Goog-Signature=SECRET" }));
    } catch (err) {
      expect((err as Error).message).not.toContain("SECRET");
      expect((err as Error).message).toContain("resultUrl");
    }
  });
});

describe("parseRunnerResult", () => {
  const result = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      status: "passed",
      rule: "command-passed",
      reason: "The verify command passed.",
      patchSha256: PATCH_SHA,
      changedFiles: ["a.ts"],
      exitCode: 0,
      output: "ok",
      durationMs: 1200,
      ...over,
    });

  it("returns the result, bound to the patch and the revision the agent sent", () => {
    expect(parseRunnerResult(result(), PATCH_SHA, "rev1")).toMatchObject({ status: "passed", rule: "command-passed", exitCode: 0, baseRevision: "rev1", patchSha256: PATCH_SHA, changedFiles: ["a.ts"] });
  });

  it("accepts a failure, a timeout and a rejection as results (they are the patch's outcome, not an outage)", () => {
    expect(parseRunnerResult(result({ status: "failed", rule: "command-failed", exitCode: 1 }), PATCH_SHA).status).toBe("failed");
    expect(parseRunnerResult(result({ status: "timeout", rule: "command-timeout", exitCode: null }), PATCH_SHA).status).toBe("timeout");
    expect(parseRunnerResult(result({ status: "rejected", rule: "excluded-path", exitCode: undefined }), PATCH_SHA).rule).toBe("excluded-path");
  });

  it.each([
    ["a result for another patch", result({ patchSha256: sha("other") })],
    ["an unknown status", result({ status: "maybe" })],
    ["an unknown rule", result({ rule: "trust-me" })],
    ["a prototype key as a rule", result({ rule: "constructor" })],
    ["a pass that is not command-passed", result({ rule: "setup-failed" })],
    ["a pass with a non-zero exit", result({ exitCode: 1 })],
    ["a pass with no exit code", result({ exitCode: undefined })],
    ["command-passed with a failing status", result({ status: "failed", rule: "command-passed", exitCode: 1 })],
    ["text that is missing", result({ output: undefined })],
    ["too many changed files", result({ changedFiles: Array.from({ length: 50 }, (_, i) => `f${i}`) })],
    ["not json", "nope"],
    ["null", "null"],
    ["a result that is far too large", result({ output: "x".repeat(300_000) })],
  ])("refuses %s", (_what, raw) => {
    expect(() => parseRunnerResult(raw, PATCH_SHA)).toThrow(VerifyRunnerError);
  });

  it("redacts and bounds the text again: the runner ran untrusted code", () => {
    const r = parseRunnerResult(result({ output: `contact alice@example.com ${"y".repeat(100_000)}`, reason: "bob@example.com", changedFiles: ["x/carol@example.com.ts"] }), PATCH_SHA);
    expect(JSON.stringify(r)).not.toMatch(/alice@example\.com|bob@example\.com|carol@example\.com/);
    expect(r.output.length).toBeLessThanOrEqual(20_000);
  });

  it("treats a bad duration as zero rather than trusting it", () => {
    expect(parseRunnerResult(result({ durationMs: -5 }), PATCH_SHA).durationMs).toBe(0);
    expect(parseRunnerResult(result({ durationMs: "soon" }), PATCH_SHA).durationMs).toBe(0);
  });
});
