/**
 * Stage 2 of the agent loop (#8): propose the smallest change that fixes one incident, or say
 * honestly that the source it was given is not enough.
 *
 *   proposed   a unified diff, with the root cause it believes in, whether it added a test, the
 *              risk it sees, and the alternatives it rejected (the UI shows these)
 *   declined   the model returned no patch: it lacks the context, and says so. Guessing is worse
 *              than declining, so this is a first-class outcome and not an error
 *   error      the model failed, answered in a shape that cannot be trusted, or produced a patch
 *              that must not go any further
 *
 * Nothing this stage returns is applied or run here. The verify gate (verifyGate.ts) is the judge;
 * the checks below only refuse what is plainly unfit to hand it: a patch that is not a unified
 * diff, one over the size limit, or one that carries credential-shaped text (whether the model
 * echoed it from what it was shown or recalled it, it must not be stored, shown or proposed).
 *
 * What the model is shown is the incident (a redacted, bounded whitelist, as in triage) and the
 * source files the caller chose to give it, with credential shapes redacted and each bounded. The
 * fixer sees no repository history, no tests the caller withholds, and no other repository files.
 * One round of feedback from a failed verify run may be passed in; how many rounds are allowed is the
 * orchestration's decision, not this function's.
 *
 * Run by the agent job (`pnpm agent`), and not on the Agent Development Kit yet: a stage contract with a stubbed
 * model in its tests.
 */
import { askJson, modelCallFailure } from "../vertex.js";
import { clipWellFormed, redactCredentials, redactTail, sanitize, truncate } from "../ingest/redact.js";
import { renderForTriage } from "./triage.js";
import { renderSourceFiles, sourceNote } from "./sourceContext.js";
import { MAX_REVIEW_PATCH_CHARS } from "./reviewer.js";
import { normalizePatch } from "./patchNormalize.js";
import type { AskJson, TriageSubject } from "./triage.js";

export interface SourceFile {
  /** Repo-relative path, as it appears in the patch. */
  path: string;
  content: string;
}

export interface FixRequest {
  subject: TriageSubject;
  /** Only these files are shown to the model. The caller chose them; the fixer does not look for more. */
  files: SourceFile[];
  /**
   * How the caller found `files` (#259). `function-name`: no stack frame named a repository file, and the file shown is
   * the one that exports the failing function; the model is told so, since the fault may lie in code that file calls.
   */
  sourceRule?: "stack" | "stack-and-function-name" | "function-name" | "none";
  /** With `function-name`: how many of `files`, after the first, are files it imports (#347). */
  sourceImports?: number;
  /** Why the previous patch failed, when this is the revision round: built by `verifyFeedback` or `reviewFeedback`. */
  feedback?: RevisionFeedback;
}

/**
 * One round of feedback for the revision, built only here so the loop and the replay send the model the same thing
 * (#415). It carries the previous patch itself: the revision is asked to change that patch, and at temperature 0 a model
 * that sees only a hash has to rebuild it from nothing.
 */
export type RevisionFeedback =
  | { kind: "verify"; previousPatch: string; output: string }
  | { kind: "review"; previousPatch: string; broken: string[] };

/** Said to the fixer after the review broke its patch (#375): fix what was shown, and nothing else in the file. */
export const REVISION_SCOPE =
  "Fix only what is listed below, with the smallest change to your patch. Do not widen it to fix other problems in the file: those are for a person.";

/** The verify gate refused the patch: its output (whose end is where a test run says what failed) or its reason. */
export function verifyFeedback(previousPatch: string, verified: { output?: string; reason: string }): RevisionFeedback {
  return { kind: "verify", previousPatch, output: verified.output || verified.reason };
}

/** The review broke the patch: only the attacks that broke it (#375), each as `attack: detail`. */
export function reviewFeedback(previousPatch: string, attacks: readonly { outcome: string; attack: string; detail: string }[]): RevisionFeedback {
  return { kind: "review", previousPatch, broken: attacks.filter((a) => a.outcome === "broken").map((a) => `${a.attack}: ${a.detail}`) };
}

export const VERIFY_FEEDBACK_HEADER = "PREVIOUS ATTEMPT FAILED VERIFICATION";
export const REVIEW_FEEDBACK_HEADER = "PREVIOUS ATTEMPT BLOCKED BY REVIEW";

export type FixRule =
  | "fixer-proposed"
  | "fixer-declined"
  | "model-call-failed"
  | "model-output-invalid"
  | "patch-malformed"
  | "patch-too-large"
  | "patch-contains-secret-shape";

export interface FixResult {
  outcome: "proposed" | "declined" | "error";
  rule: FixRule;
  /** The model's account of the cause (or why it declined): redacted and bounded. */
  rootCause: string;
  /** A unified diff. Present only when proposed. */
  patch?: string;
  testAdded?: boolean;
  risk?: string;
  rejectedAlternatives?: string[];
}

/**
 * No larger than what the adversarial review can be shown whole (#136): a patch the reviewer sees only part of could
 * be approved with code nobody reviewed. A minimal fix is far smaller; a larger one goes to a person.
 */
export const MAX_FIX_PATCH_BYTES = MAX_REVIEW_PATCH_CHARS;
const MAX_TEXT = 1500;
const MAX_ALTERNATIVES = 5;
export const MAX_FILE_CHARS = 20_000;
export const MAX_TOTAL_SOURCE_CHARS = 60_000;
const MAX_FEEDBACK_CHARS = 4_000;
const MAX_BROKEN_ATTACK_CHARS = 600;

export const FIX_SYSTEM = `You are fixing one production bug in a small team's codebase. Produce the
MINIMAL change that addresses the root cause: not a refactor, not surrounding cleanup, not a new
dependency.

"patch" is a unified diff against the files you were shown, with paths relative to the repository
root as listed. Add or update a test that fails before the fix and passes after it when the codebase
has tests you can extend; say so in "testAdded".

If the source you were given is not enough to fix the problem confidently, say so in "rootCause" and
return an empty "patch". Guessing is worse than declining. Never touch CI configuration, credentials,
or the files that define how the project is tested or verified.`;

export { FOUND_BY_NAME_NOTE, FOUND_BY_NAME_WITH_IMPORTS_NOTE } from "./sourceContext.js";

export const FIX_SCHEMA = {
  type: "object",
  properties: {
    rootCause: { type: "string", description: "Why it fails, or why you cannot fix it from this source." },
    patch: { type: "string", description: "Unified diff, or empty when declining." },
    testAdded: { type: "boolean" },
    risk: { type: "string", description: "What this change could break." },
    rejectedAlternatives: { type: "array", items: { type: "string" } },
  },
  required: ["rootCause", "patch", "testAdded", "risk", "rejectedAlternatives"],
};

/**
 * The revision's section (#415). The verify output is a test or CI log, whose failure is at its END: kept from the tail.
 * The review's scope instruction comes first, so no number of attacks can cut it off. The previous patch is code, so it
 * gets the source's shape-only redaction, bounded as a patch is.
 */
function renderFeedback(f: RevisionFeedback): string[] {
  const patch = ["Your previous patch:", truncate(redactCredentials(f.previousPatch), MAX_FIX_PATCH_BYTES), ""];
  if (f.kind === "verify") {
    return [VERIFY_FEEDBACK_HEADER, ...patch, "The end of the verify command's output:", redactTail(f.output, MAX_FEEDBACK_CHARS)];
  }
  const broken = f.broken.map((b) => `- ${sanitize(b, MAX_BROKEN_ATTACK_CHARS) ?? ""}`).join("\n");
  return [REVIEW_FEEDBACK_HEADER, REVISION_SCOPE, "", ...patch, "What the review showed this patch breaks:", truncate(broken, MAX_FEEDBACK_CHARS)];
}

/** What the model is shown. Source gets shape-only redaction: `token = getToken()` is code, not a leak. */
export function renderForFix(req: FixRequest): string {
  const parts = [renderForTriage(req.subject), "", "SOURCE CONTEXT"];
  const note = sourceNote({ ...(req.sourceRule && { rule: req.sourceRule }), ...(req.sourceImports !== undefined && { imports: req.sourceImports }) }, req.files.length);
  if (note) parts.push(note, "");
  parts.push(...renderSourceFiles(req.files, { maxFileChars: MAX_FILE_CHARS, maxTotalChars: MAX_TOTAL_SOURCE_CHARS }));
  if (req.feedback) parts.push(...renderFeedback(req.feedback));
  return parts.join("\n");
}

const clip = (text: string, max = MAX_TEXT) => clipWellFormed(text, max);

/** A plausible unified diff: file headers and at least one hunk. Not a parser; the gate is the judge. */
function looksLikeUnifiedDiff(patch: string): boolean {
  return /^--- \S/m.test(patch) && /^\+\+\+ \S/m.test(patch) && /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(patch);
}

function error(rule: FixRule, rootCause: string): FixResult {
  return { outcome: "error", rule, rootCause: clip(rootCause) };
}

/** Never throws: a failure is a result, because an unrecorded failure would look like a decision not to fix. */
export async function proposeFix(req: FixRequest, ask: AskJson = askJson): Promise<FixResult> {
  let raw: unknown;
  try {
    raw = await ask<unknown>(renderForFix(req), FIX_SYSTEM, FIX_SCHEMA);
  } catch (err) {
    // An error's message can quote what it was sent, so only names and codes are kept (#334).
    return error("model-call-failed", modelCallFailure(err));
  }

  const a = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const alternatives = a?.rejectedAlternatives;
  if (
    !a ||
    typeof a.rootCause !== "string" ||
    a.rootCause.trim() === "" ||
    typeof a.patch !== "string" ||
    typeof a.testAdded !== "boolean" ||
    typeof a.risk !== "string" ||
    !Array.isArray(alternatives) ||
    !alternatives.every((x) => typeof x === "string")
  ) {
    return error("model-output-invalid", "The model's answer was not in the expected shape, so nothing was proposed.");
  }

  // No patch is the model saying it lacks the context. That is an answer, not a failure.
  if (a.patch.trim() === "") return { outcome: "declined", rule: "fixer-declined", rootCause: clip(a.rootCause) };

  if (!looksLikeUnifiedDiff(a.patch)) return error("patch-malformed", "The proposed patch is not a unified diff.");
  // The model counts hunk lines without line numbers, and miscounts (#317). Its hunks are put where their text is in the
  // files it was shown; this is the patch the gate, the floor and the reviewer all see, and so the one that is hashed.
  const patch = normalizePatch(a.patch, req.files);
  if (Buffer.byteLength(patch) > MAX_FIX_PATCH_BYTES) return error("patch-too-large", "The proposed patch is larger than the limit.");
  // Only what the patch ADDS counts: context lines are the repository's own, which the caller already vets.
  const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  if (redactCredentials(added) !== added) {
    return error("patch-contains-secret-shape", "The proposed patch contains credential-shaped text, so it was dropped.");
  }

  return {
    outcome: "proposed",
    rule: "fixer-proposed",
    rootCause: clip(a.rootCause),
    patch,
    testAdded: a.testAdded,
    risk: clip(a.risk),
    rejectedAlternatives: alternatives.slice(0, MAX_ALTERNATIVES).map((x) => clip(x as string, 400)),
  };
}
