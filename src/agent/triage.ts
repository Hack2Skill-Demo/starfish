/**
 * Stage 1 of the agent loop (#8): decide what to do with one incident.
 *
 *   act      worth a code fix: hand it to the fixer
 *   notify   a human should know, but no code change helps (a disabled API, an exhausted quota,
 *            a credential someone has to rotate)
 *   decline  not worth acting on: noise, a one-off, a fault already gone
 *
 * Three more outcomes belong to the engine, not the model, and none of them calls it:
 *   skip     the incident is not open (an operator resolved or ignored it): never act on it
 *   defer    the independent log counter-check is missing: the evidence is unavailable, which is
 *            not the same as the logs reading zero, so wait rather than decide
 *   error    the model failed or answered in a shape that cannot be trusted: fail closed
 *
 * A counter-check of zero is declined without asking the model. The logs show no error at all for
 * the function, so there is nothing to fix, and a model that is shown an incident and asked
 * "urgent?" tends to say yes. Every result names the rule that produced it, for the UI.
 *
 * A Monitoring-only incident (#19: Cloud Monitoring counted failed invocations of a function that
 * logged no ERROR) is the exception to that rule, both ways:
 *   - it is never declined because the counter-check is zero: a zero log count is what it IS, not a
 *     sign the failures stopped, so it goes to the model like any other incident;
 *   - it is never `act` without cause evidence on the incident (an underlying cause or a stack
 *     trace): a count of failures says that something broke, not where, so there is nothing for a
 *     fixer to aim at. A model's `act` is turned into `notify`, so a human looks instead.
 *
 * Everything shown to the model is redacted and bounded, and everything the model returns is
 * checked here and redacted again before it is stored, because it is shown to people (guests,
 * on the public demo) and a model can echo what it was shown.
 *
 * HOW FAR TO GO (docs/design/auto-merge-policy.md) is triage's call too: decline is noise, notify is "log" (an issue and an
 * alert, a person fixes it), act is "log + fix" (a verified pull request a person merges). When an admin has listed merge
 * cases, the model may also name one for an `act`: "log + fix + merge", Starfish merging the fix itself. The engine
 * keeps only a case that is listed and only on `act`; anything else is dropped, so the level falls back to "fix" and a
 * person merges. Naming a case is the model's decision; whether the merge then happens is still the switches', the
 * safety floor's (blastRadius.ts `assessMergeFloor`) and the required checks' (autoMerge.ts).
 *
 * Run by the agent job (`pnpm agent`), and not on Google's Agent Development Kit yet: this is the stage's
 * contract, testable with a stubbed model, so the orchestration can be put around it.
 */
import { askJson } from "../vertex.js";
import { clipWellFormed, sanitize } from "../ingest/redact.js";
import type { ErrorLogSample } from "../ingest/counterCheck.js";
import { OPEN_INCIDENT_STATUSES, type Incident, type IncidentStatus } from "../types.js";
import { INDEX_MERGE_CASE, MAX_MERGE_CASE_DESCRIPTION, type MergeCase } from "../settingsSchema.js";
import { capHolds, capSource, levelCap, type ClassRule, type IncidentCorrection, type LevelCap } from "../triageRules.js";

export type TriageDecision = "act" | "notify" | "decline" | "defer" | "skip" | "error";

/** Which rule produced the decision. Stored with it and shown by the UI (#8, "the matched rule"). */
export type TriageRule =
  | "status-not-open"
  | "counter-check-missing"
  | "counter-check-zero"
  | "model-act"
  | "model-notify"
  | "model-decline"
  | "model-call-failed"
  | "model-output-invalid"
  | "monitoring-only-no-cause"
  | "high-cardinality-overflow"
  | "platform-quota"
  | "rule-cap"
  | "correction-cap";

export interface TriageResult {
  decision: TriageDecision;
  rule: TriageRule;
  /** Redacted and bounded: safe to store and to show. */
  reason: string;
  /** Present when the model chose act or notify and named one. Redacted and bounded. */
  suspectedCause?: string;
  /**
   * The admin's merge case the model said this incident is, kept only on `act` and only when that case is listed: the
   * model's decision to go as far as "log + fix + merge". Absent: a person merges whatever is fixed.
   */
  mergeCase?: string;
  /**
   * The rules engine's cap on the incident (src/triageRules.ts: an admin's class rule or an operator's correction), when
   * one applied. The rule is `rule-cap` or `correction-cap` only when the cap changed the decision.
   */
  cap?: LevelCap;
}

/** How far Starfish goes with an incident, in the words the UI and the docs use. Null: nothing was decided yet. */
export type TriageLevel = "noise" | "log" | "fix" | "merge";

export function triageLevel(r: Pick<TriageResult, "decision" | "mergeCase">): TriageLevel | null {
  if (r.decision === "decline") return "noise";
  if (r.decision === "notify") return "log";
  if (r.decision === "act") return r.mergeCase !== undefined ? "merge" : "fix";
  return null;
}

export interface TriageOptions {
  /** The merge cases an admin listed (config `mergeCases`). The index path's reserved case is never offered: no model decides it. */
  mergeCases?: readonly MergeCase[];
  /** The admin's class rules (config `classRules`): with the subject's correction, the cap on how far triage may go. */
  classRules?: readonly ClassRule[];
}

export interface TriageSubject {
  incident: Incident;
  /** The operator-owned status. Triage only ever looks at open incidents. */
  status: IncidentStatus;
  samples?: ErrorLogSample[];
  /** An operator's correction of this incident (src/triageRules.ts). Never shown to the model: it only caps the result. */
  correction?: IncidentCorrection;
}

/** The part of the model client triage needs; askJson satisfies it, a test stubs it. */
export type AskJson = <T>(prompt: string, systemInstruction: string, schema: Record<string, unknown>) => Promise<T>;

export const MAX_REASON_LEN = 1000;
const MAX_FIELD_LEN = 1500;
const MAX_SAMPLE_FIELD_LEN = 600;

const MODEL_DECISIONS = ["act", "notify", "decline"] as const;
type ModelDecision = (typeof MODEL_DECISIONS)[number];

export const TRIAGE_SYSTEM = `You are an on-call engineer for a small team with no dedicated ops staff.
You are shown one production incident. Choose exactly one decision:

- "act": a defect in the team's own code that a small, well-scoped code change would fix, and that
  is hurting users or climbing. Only choose this when the evidence points at code you could change.
- "notify": a human should know, but no code change helps: a disabled or unenabled API, an exhausted
  quota, a credential or permission someone has to fix, an outage at a provider.
- "decline": not worth acting on: monitoring noise, a one-off, an error with no user impact, or
  something that has stopped.

Weigh the occurrence count, the independent log counter-check, the recent samples, and whether the
error describes real user-facing breakage.

Read the counter-check for what it is: every ERROR-severity log entry for the whole FUNCTION over its
window, counted straight from Cloud Logging. The occurrence count is for this one incident, over its
lifetime, so the two will rarely be equal and that alone means nothing.

An incident whose source is "Cloud Monitoring only" was opened from a count of failed invocations
with no ERROR log entry behind it: its counter-check reads zero by construction, and it carries no
message or stack from the code. Judge it on the count and the function.

Declining is a valid and often correct answer. Opening a change that was not needed costs the team
review time they do not have.`;

export const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: [...MODEL_DECISIONS] },
    reasoning: { type: "string", description: "Which signals drove the call." },
    suspectedCause: { type: ["string", "null"], description: "Where the fault lives. Null for decline." },
  },
  required: ["decision", "reasoning", "suspectedCause"],
};

/** The merge cases the model may name: the admin's list without the index path's reserved one. */
export function offeredMergeCases(cases: readonly MergeCase[] | undefined): MergeCase[] {
  return (cases ?? []).filter((c) => c.id !== INDEX_MERGE_CASE);
}

/**
 * The system instruction's merge section, when an admin listed cases. The cases are the admin's configuration, not
 * incident text, but they are redacted and bounded like anything else that reaches the model.
 */
export function mergeCasesInstruction(cases: readonly MergeCase[]): string {
  const listed = cases.map((c) => `- ${c.id}: ${sanitize(c.description, MAX_MERGE_CASE_DESCRIPTION) ?? ""}`).join("\n");
  return `

MERGE CASES
The team lets Starfish merge a fix by itself, with no person reviewing it, only for these kinds of incident:
${listed}

Set "mergeCase" to one of these ids only when you chose "act" AND the incident is clearly that kind: a high-value,
low-risk fault that a small change fixes safely. When in doubt, null: Starfish still drafts and verifies the fix, and a
person merges it. Yours is not the last check: the fix must also pass the team's required CI checks, and Starfish never
merges a change to auth, security rules, money, secrets, schema, dependencies or CI config.`;
}

/** The answer schema with the merge-case field, which the model must then always fill (an id, or null). */
export function triageSchemaWithMergeCase(cases: readonly MergeCase[]): Record<string, unknown> {
  return {
    ...TRIAGE_SCHEMA,
    properties: {
      ...TRIAGE_SCHEMA.properties,
      mergeCase: {
        type: ["string", "null"],
        description: `One of: ${cases.map((c) => c.id).join(", ")}. Only with "act"; null when in doubt.`,
      },
    },
    required: [...TRIAGE_SCHEMA.required, "mergeCase"],
  };
}

/**
 * What the model is shown. A whitelist, so a field added to Incident later is not sent by accident.
 *
 * Never the incident's `environment`: that is Starfish's own store label (`STARFISH_ENV`), not the watched app's tier.
 * The public demo must label its records `demo`, and a model shown "environment: demo" declined a checkout failing on
 * every order as "no real user impact" (#311). A deployment watching a non-production project holds incidents back with
 * class rules instead.
 */
export function renderForTriage(subject: TriageSubject): string {
  const { incident: i, samples = [] } = subject;
  const clip = (text: string | undefined, max = MAX_FIELD_LEN) => sanitize(text, max) ?? "";
  const lines = [
    "INCIDENT",
    `function: ${clip(i.functionName, 200)}`,
    `service: ${clip(i.service, 100)}`,
    `errorType: ${clip(i.errorType, 100)}`,
    ...(i.errorCode ? [`errorCode: ${clip(i.errorCode, 100)}`] : []),
    ...(i.httpStatus != null ? [`httpStatus: ${Number(i.httpStatus)}`] : []),
    ...(i.signalSource === "monitoring"
      ? ["source: Cloud Monitoring only (failed invocations counted with no ERROR log entry; the log counter-check is zero by construction)"]
      : []),
    `occurrences (lifetime of this incident): ${Number(i.occurrenceCount ?? 0)}`,
    ...(Number.isFinite(i.monitoringCount) ? [`failed invocations counted by Cloud Monitoring: ${Number(i.monitoringCount)}`] : []),
    `first seen: ${clip(i.firstOccurredAt, 40)}`,
    `last seen: ${clip(i.lastOccurredAt, 40)}`,
    counterCheckLine(i),
    `message: ${clip(i.message)}`,
    ...(i.errorDetail ? [`underlying cause: ${clip(i.errorDetail)}`] : []),
    ...(i.stackTrace ? [`stack:\n${clip(i.stackTrace)}`] : []),
  ];
  if (samples.length > 0) {
    lines.push("", "RECENT SAMPLES");
    samples.forEach((s, n) => {
      lines.push(
        `#${n + 1} ${clip(s.timestamp, 40)}: ${clip(s.message, MAX_SAMPLE_FIELD_LEN)}`,
        ...(s.error ? [`   cause: ${clip(s.error, MAX_SAMPLE_FIELD_LEN)}`] : []),
        ...(s.stack ? [`   stack: ${clip(s.stack, MAX_SAMPLE_FIELD_LEN)}`] : [])
      );
    });
  }
  return lines.join("\n");
}

function counterCheckLine(i: Incident): string {
  const c = i.logCounterCheck;
  if (!c) return "log counter-check: not available";
  return `log counter-check: ${Number(c.count)} error entries for the function in ${sanitize(c.window, 20) ?? "the window"}${
    c.capped ? " (at least: counting stopped at the cap)" : ""
  }`;
}

const bound = (text: string, max = MAX_REASON_LEN) => clipWellFormed(text, max);

function result(decision: TriageDecision, rule: TriageRule, reason: string, suspectedCause?: string, mergeCase?: string, cap?: LevelCap): TriageResult {
  return {
    decision,
    rule,
    reason: bound(reason),
    ...(suspectedCause ? { suspectedCause: bound(suspectedCause) } : {}),
    ...(mergeCase !== undefined && { mergeCase }),
    ...(cap !== undefined && { cap }),
  };
}

/** A model answer that is the shape asked for, or null. Anything else is not trusted. */
function parseModelAnswer(raw: unknown): { decision: ModelDecision; reasoning: string; suspectedCause?: string; mergeCase?: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (!MODEL_DECISIONS.includes(a.decision as ModelDecision)) return null;
  if (typeof a.reasoning !== "string" || a.reasoning.trim() === "") return null;
  if (a.suspectedCause != null && typeof a.suspectedCause !== "string") return null;
  return {
    decision: a.decision as ModelDecision,
    reasoning: a.reasoning,
    ...(typeof a.suspectedCause === "string" && a.suspectedCause.trim() !== "" && { suspectedCause: a.suspectedCause }),
    // Not a string: no case. A malformed merge choice costs the merge, never the triage.
    ...(typeof a.mergeCase === "string" && { mergeCase: a.mergeCase }),
  };
}

/**
 * Cause evidence on the incident itself: an underlying cause or a stack trace, the things a fix can be
 * aimed at. A Monitoring-only incident has neither by construction (there was no log entry to read
 * them from); samples are not counted, because they are the function's ERROR logs, which belong to
 * other incidents.
 */
export function hasCauseEvidence(incident: Incident): boolean {
  return Boolean(incident.errorDetail?.trim() || incident.stackTrace?.trim());
}

/** Never throws: a failure is a result, because an unrecorded failure would look like a decision not to act. */
export async function triageIncident(subject: TriageSubject, ask: AskJson = askJson, options: TriageOptions = {}): Promise<TriageResult> {
  if (!(OPEN_INCIDENT_STATUSES as readonly string[]).includes(subject.status)) {
    return result("skip", "status-not-open", `Incident is ${subject.status}; triage only looks at open incidents.`);
  }

  // The rules engine (src/triageRules.ts): an admin's class rule or an operator's correction holds the incident back.
  // Held to noise, the model is not asked at all.
  const cap = levelCap(subject.incident, options.classRules ?? [], subject.correction) ?? undefined;
  if (cap?.level === "noise") {
    return result("decline", `${cap.by}-cap`, `Declined without asking the model: ${capSource(cap)} holds this incident to noise.`, undefined, undefined, cap);
  }

  // An overflow incident (#303) is the many distinct errors one function logged past the per-window cap, folded into one.
  // It has no single cause to fix, and its text is whatever the flood carried: a person looks, the model is not asked.
  if (subject.incident.signalSource === "overflow") {
    return result(
      "notify",
      "high-cardinality-overflow",
      "This function logged more distinct errors than the per-window cap allows, and the rest were folded into this one incident. That is a flood or an error that echoes its input, not one cause a fix can aim at: a human should look.",
      undefined,
      undefined,
      cap
    );
  }

  // A consolidated Cloud Run quota incident (ingest/platformQuota.ts) is the project's quota, exhausted across every
  // function: requests were rejected before any code ran, so no change to the code fixes it. A person looks.
  if (subject.incident.signalSource === "platform-quota") {
    return result(
      "notify",
      "platform-quota",
      "The project exceeded a Cloud Run quota, and requests to its functions were rejected before any of them ran. That is one project-wide event, not a defect in a function: a human should look at the quota or at what spent it (often a deploy rolling many revisions at once).",
      undefined,
      undefined,
      cap
    );
  }

  const check = subject.incident.logCounterCheck;
  if (!check || !Number.isFinite(check.count)) {
    return result(
      "defer",
      "counter-check-missing",
      "The independent log counter-check is not available, so the evidence is missing (not zero). Try again later.",
      undefined,
      undefined,
      cap
    );
  }
  const monitoringOnly = subject.incident.signalSource === "monitoring";
  if (check.count === 0 && !monitoringOnly) {
    return result(
      "decline",
      "counter-check-zero",
      `The log counter-check found no error entries for this function in ${sanitize(check.window, 20) ?? "its window"}, so there is nothing in the logs to fix.`,
      undefined,
      undefined,
      cap
    );
  }

  // A cap is at most "fix", so a capped incident is never offered a merge case: a person merges whatever is fixed.
  const cases = cap ? [] : offeredMergeCases(options.mergeCases);
  let raw: unknown;
  try {
    raw = await ask<unknown>(
      renderForTriage(subject),
      cases.length > 0 ? TRIAGE_SYSTEM + mergeCasesInstruction(cases) : TRIAGE_SYSTEM,
      cases.length > 0 ? triageSchemaWithMergeCase(cases) : TRIAGE_SCHEMA
    );
  } catch (err) {
    // An error's message can quote the incident text it was given, so only its name is kept.
    return result("error", "model-call-failed", `The model call failed (${err instanceof Error ? err.name : "unknown error"}).`, undefined, undefined, cap);
  }

  const answer = parseModelAnswer(raw);
  if (!answer) {
    return result("error", "model-output-invalid", "The model's answer was not in the expected shape, so nothing was acted on.", undefined, undefined, cap);
  }
  if (answer.decision === "act" && monitoringOnly && !hasCauseEvidence(subject.incident)) {
    return result(
      "notify",
      "monitoring-only-no-cause",
      `Cloud Monitoring counted failed invocations with no ERROR log behind them, so there is no cause evidence for a code fix: a human should look. The model's reasoning: ${answer.reasoning}`,
      answer.suspectedCause,
      undefined,
      cap
    );
  }
  // Kept only on act, and only a case the admin listed: an unknown id, or one on notify or decline, is dropped.
  const mergeCase = answer.decision === "act" && cases.some((c) => c.id === answer.mergeCase) ? answer.mergeCase : undefined;
  // Held to "log": a fix the model wanted becomes an issue a person works on. (Noise was handled before the model, and a
  // cap of "fix" holds back only the merge, which was never offered.)
  if (answer.decision === "act" && cap !== undefined && capHolds(cap, "fix")) {
    return result(
      "notify",
      `${cap.by}-cap`,
      `Gemini chose to fix this, but ${capSource(cap)} holds it to log: an issue, and a person fixes it. The model's reasoning: ${answer.reasoning}`,
      answer.suspectedCause,
      undefined,
      cap
    );
  }
  return result(answer.decision, `model-${answer.decision}`, answer.reasoning, answer.decision === "decline" ? undefined : answer.suspectedCause, mergeCase, cap);
}
