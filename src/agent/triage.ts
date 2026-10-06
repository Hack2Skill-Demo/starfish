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
 * Run by the agent job (`pnpm agent`), and not on Google's Agent Development Kit yet: this is the stage's
 * contract, testable with a stubbed model, so the orchestration can be put around it.
 */
import { askJson } from "../vertex.js";
import { redactPii, sanitize } from "../ingest/redact.js";
import type { ErrorLogSample } from "../ingest/counterCheck.js";
import { OPEN_INCIDENT_STATUSES, type Incident, type IncidentStatus } from "../types.js";

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
  | "monitoring-only-no-cause";

export interface TriageResult {
  decision: TriageDecision;
  rule: TriageRule;
  /** Redacted and bounded: safe to store and to show. */
  reason: string;
  /** Present when the model chose act or notify and named one. Redacted and bounded. */
  suspectedCause?: string;
}

export interface TriageSubject {
  incident: Incident;
  /** The operator-owned status. Triage only ever looks at open incidents. */
  status: IncidentStatus;
  samples?: ErrorLogSample[];
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

Weigh the occurrence count, the independent log counter-check, the environment, the recent samples,
and whether the error describes real user-facing breakage.

Read the counter-check for what it is: every ERROR-severity log entry for the whole FUNCTION over its
window, counted straight from Cloud Logging. The occurrence count is for this one incident, over its
lifetime, so the two will rarely be equal and that alone means nothing.

An incident whose source is "Cloud Monitoring only" was opened from a count of failed invocations
with no ERROR log entry behind it: its counter-check reads zero by construction, and it carries no
message or stack from the code. Judge it on the count, the function and the environment.

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

/** What the model is shown. A whitelist, so a field added to Incident later is not sent by accident. */
export function renderForTriage(subject: TriageSubject): string {
  const { incident: i, samples = [] } = subject;
  const clip = (text: string | undefined, max = MAX_FIELD_LEN) => sanitize(text, max) ?? "";
  const lines = [
    "INCIDENT",
    `environment: ${clip(i.environment, 100)}`,
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

const bound = (text: string, max = MAX_REASON_LEN) => redactPii(text).slice(0, max);

function result(decision: TriageDecision, rule: TriageRule, reason: string, suspectedCause?: string): TriageResult {
  return { decision, rule, reason: bound(reason), ...(suspectedCause ? { suspectedCause: bound(suspectedCause) } : {}) };
}

/** A model answer that is the shape asked for, or null. Anything else is not trusted. */
function parseModelAnswer(raw: unknown): { decision: ModelDecision; reasoning: string; suspectedCause?: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (!MODEL_DECISIONS.includes(a.decision as ModelDecision)) return null;
  if (typeof a.reasoning !== "string" || a.reasoning.trim() === "") return null;
  if (a.suspectedCause != null && typeof a.suspectedCause !== "string") return null;
  return {
    decision: a.decision as ModelDecision,
    reasoning: a.reasoning,
    ...(typeof a.suspectedCause === "string" && a.suspectedCause.trim() !== "" && { suspectedCause: a.suspectedCause }),
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
export async function triageIncident(subject: TriageSubject, ask: AskJson = askJson): Promise<TriageResult> {
  if (!(OPEN_INCIDENT_STATUSES as readonly string[]).includes(subject.status)) {
    return result("skip", "status-not-open", `Incident is ${subject.status}; triage only looks at open incidents.`);
  }

  const check = subject.incident.logCounterCheck;
  if (!check || !Number.isFinite(check.count)) {
    return result(
      "defer",
      "counter-check-missing",
      "The independent log counter-check is not available, so the evidence is missing (not zero). Try again later."
    );
  }
  const monitoringOnly = subject.incident.signalSource === "monitoring";
  if (check.count === 0 && !monitoringOnly) {
    return result(
      "decline",
      "counter-check-zero",
      `The log counter-check found no error entries for this function in ${sanitize(check.window, 20) ?? "its window"}, so there is nothing in the logs to fix.`
    );
  }

  let raw: unknown;
  try {
    raw = await ask<unknown>(renderForTriage(subject), TRIAGE_SYSTEM, TRIAGE_SCHEMA);
  } catch (err) {
    // An error's message can quote the incident text it was given, so only its name is kept.
    return result("error", "model-call-failed", `The model call failed (${err instanceof Error ? err.name : "unknown error"}).`);
  }

  const answer = parseModelAnswer(raw);
  if (!answer) {
    return result("error", "model-output-invalid", "The model's answer was not in the expected shape, so nothing was acted on.");
  }
  if (answer.decision === "act" && monitoringOnly && !hasCauseEvidence(subject.incident)) {
    return result(
      "notify",
      "monitoring-only-no-cause",
      `Cloud Monitoring counted failed invocations with no ERROR log behind them, so there is no cause evidence for a code fix: a human should look. The model's reasoning: ${answer.reasoning}`,
      answer.suspectedCause
    );
  }
  return result(answer.decision, `model-${answer.decision}`, answer.reasoning, answer.decision === "decline" ? undefined : answer.suspectedCause);
}
