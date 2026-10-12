/**
 * What the agent and the verify runner say to each other (#74), and the checks each side makes on what it
 * receives. The runner is a Cloud Run job whose service account holds NO roles and which runs the target
 * repository's own tests (verifyRunner.ts); the agent holds the credentials (verifyRemote.ts). They share no
 * identity and no network path but two per-run signed URLs on one bucket: the agent writes a bundle (the source
 * snapshot and the patch) the runner can read once, and the runner writes one result the agent reads.
 *
 * Both directions are untrusted. The runner parses what it was asked with the same strictness as the agent
 * parses what it gets back: every field is typed, bounded, and (for the result) bound to the SHA-256 of the exact
 * patch the agent sent, so a result for another patch, a malformed one, or an oversized one is refused.
 */
import { redactHead, redactTail } from "../ingest/redact.js";
import { MAX_CHANGED_FILES, MAX_OUTPUT_CHARS, type VerifyResult, type VerifyRule, type VerifyStatus } from "./verifyGate.js";

/** Thrown for anything wrong with the runner's request or result, or for the runner not answering. Never holds a URL. */
export class VerifyRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyRunnerError";
  }
}

export const BUNDLE_PATCH_FILE = "patch.diff";
export const BUNDLE_TREE_DIR = "tree";
/** A bigger bundle is refused on both sides: a checkout this size is not what a hotfix is written against. */
export const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
export const MAX_RESULT_BYTES = 200_000;

export interface RunnerRequest {
  v: 1;
  /** A signed URL the runner may GET once to read the bundle. */
  bundleUrl: string;
  /** A signed URL the runner may PUT once to write the result. */
  resultUrl: string;
  /** SHA-256 of the patch inside the bundle: the result is only accepted for this patch. */
  patchSha256: string;
  command: string;
  timeoutSeconds: number;
  excludedPaths: string[];
  baseRevision?: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_URL = 4096;
const MAX_COMMAND = 4000;
const MAX_EXCLUDED = 200;

/** https to Cloud Storage, or plain http to this machine (a test double). Nothing else is fetched or written. */
export function transferUrlOk(raw: string): boolean {
  if (raw.length > MAX_URL) return false;
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return u.hostname === "storage.googleapis.com" || u.hostname.endsWith(".storage.googleapis.com");
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

const isStrings = (v: unknown, max: number, each: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length <= each);

/** The request as the runner received it, or a VerifyRunnerError saying which field was wrong (never its value). */
export function parseRunnerRequest(raw: string): RunnerRequest {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new VerifyRunnerError("the request is not JSON");
  }
  if (v === null || typeof v !== "object" || v.v !== 1) throw new VerifyRunnerError("the request is not version 1");
  const bad = (field: string) => new VerifyRunnerError(`the request field ${field} is missing or invalid`);
  if (typeof v.bundleUrl !== "string" || !transferUrlOk(v.bundleUrl)) throw bad("bundleUrl");
  if (typeof v.resultUrl !== "string" || !transferUrlOk(v.resultUrl)) throw bad("resultUrl");
  if (typeof v.patchSha256 !== "string" || !SHA256_RE.test(v.patchSha256)) throw bad("patchSha256");
  if (typeof v.command !== "string" || v.command.trim() === "" || v.command.length > MAX_COMMAND) throw bad("command");
  if (typeof v.timeoutSeconds !== "number" || !Number.isFinite(v.timeoutSeconds) || v.timeoutSeconds < 1 || v.timeoutSeconds > 3600) throw bad("timeoutSeconds");
  if (!isStrings(v.excludedPaths, MAX_EXCLUDED, 200)) throw bad("excludedPaths");
  if (v.baseRevision !== undefined && (typeof v.baseRevision !== "string" || v.baseRevision.length > 100)) throw bad("baseRevision");
  return {
    v: 1,
    bundleUrl: v.bundleUrl,
    resultUrl: v.resultUrl,
    patchSha256: v.patchSha256,
    command: v.command,
    timeoutSeconds: v.timeoutSeconds,
    excludedPaths: v.excludedPaths,
    ...(v.baseRevision !== undefined && { baseRevision: v.baseRevision }),
  };
}

const STATUSES: Record<VerifyStatus, true> = { passed: true, failed: true, timeout: true, rejected: true };
/** Every rule, kept exhaustive by the type: a rule added to the gate and not here fails to compile. */
const RULES: Record<VerifyRule, true> = {
  "no-verify-command": true,
  "empty-patch": true,
  "patch-too-large": true,
  "patch-not-text": true,
  "patch-does-not-apply": true,
  "too-many-files": true,
  "excluded-path": true,
  symlink: true,
  "file-mode": true,
  "tree-too-large": true,
  "command-passed": true,
  "command-failed": true,
  "command-timeout": true,
  "setup-failed": true,
};
const has = (table: Record<string, true>, key: unknown): boolean => typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);

/**
 * The result as the agent received it. The runner is credential-less but it runs candidate code, so the result is
 * data from an untrusted source: typed, bounded, tied to the patch the agent sent, internally consistent (a pass
 * can only be `command-passed` with exit 0), and its text redacted again before it is stored or shown.
 */
export function parseRunnerResult(text: string, expectedPatchSha256: string, baseRevision?: string): VerifyResult {
  if (text.length > MAX_RESULT_BYTES) throw new VerifyRunnerError("the verify result is too large");
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new VerifyRunnerError("the verify result is not JSON");
  }
  if (v === null || typeof v !== "object") throw new VerifyRunnerError("the verify result is not an object");
  if (v.patchSha256 !== expectedPatchSha256) throw new VerifyRunnerError("the verify result is for a different patch");
  if (!has(STATUSES, v.status)) throw new VerifyRunnerError("the verify result has an unknown status");
  if (!has(RULES, v.rule)) throw new VerifyRunnerError("the verify result has an unknown rule");
  if (typeof v.reason !== "string" || typeof v.output !== "string") throw new VerifyRunnerError("the verify result is missing its text");
  if (!isStrings(v.changedFiles, MAX_CHANGED_FILES + 1, 500)) throw new VerifyRunnerError("the verify result lists too many changed files");
  const durationMs = typeof v.durationMs === "number" && Number.isFinite(v.durationMs) && v.durationMs >= 0 ? v.durationMs : 0;
  const exitCode = v.exitCode === null || typeof v.exitCode === "number" ? v.exitCode : undefined;
  const status = v.status as VerifyStatus;
  const rule = v.rule as VerifyRule;
  if (status === "passed" && (rule !== "command-passed" || exitCode !== 0)) throw new VerifyRunnerError("the verify result claims a pass that is not one");
  if (rule === "command-passed" && status !== "passed") throw new VerifyRunnerError("the verify result is inconsistent");
  return {
    status,
    rule,
    // Bound BEFORE redacting: this text comes from a process that ran untrusted code, and redaction's cost grows with it
    // (#96). Each helper also drops what its cut could have left of a secret (#18).
    reason: redactHead(v.reason, 500),
    patchSha256: expectedPatchSha256,
    ...(baseRevision !== undefined && { baseRevision }),
    changedFiles: v.changedFiles.map((f) => redactHead(f, 500)),
    ...(exitCode !== undefined && { exitCode }),
    output: redactTail(v.output, MAX_OUTPUT_CHARS),
    durationMs,
  };
}
