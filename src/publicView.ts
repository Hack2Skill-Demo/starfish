/**
 * The TRIMMED COPY guests read (#18). Guests are anonymous sessions on the public demo (#12); they never read the stored
 * incident, cycle or run-event documents. For each of those in a public environment (`publicEnvironments`, `demo` by
 * default) the engine also writes a projection built here, and firestore.rules lets guests read only the projections.
 *
 * Redaction is pattern matching (src/ingest/redact.ts), so free-form personal data and credential formats it does not
 * know still get through it. The projection is what closes that for the public link: it is an ALLOWLIST, never a
 * denylist. Each function below names every field it copies, and checks each value's shape on the way (a rule is a
 * token, a hash is hex, a link is an https URL with no credentials, a time is a timestamp), so a value that is not what
 * the field should hold is left out rather than copied. A field added to a stored document later is not in the copy
 * until someone adds it here.
 *
 * What a copy holds: ids, status, counts, times, the function and service names, the error type, a bounded one-line
 * title, the issue and pull-request number, link and state, and from the run record only its enumerated, numeric and
 * hash values. What it never holds: error detail, stack traces, raw samples, tenant ids, the counter-check's log
 * filter, model answers (triage's reason and suspected cause, the fix's root cause, risk and rejected alternatives,
 * the review's attacks), patches, and event payloads (`data`). An event keeps its one-line summary only for the
 * stages whose summaries the engine writes itself; triage, fix, verify, review and "before" carry model or tool text,
 * so theirs is left out.
 *
 * The copies keep the stored field names, so the UI reads them with the same parsers; `publicView: 1` marks one, so
 * the UI does not read a field the copy leaves out as one the engine never recorded.
 *
 * Pure: reads and writes nothing (src/publicViewStore.ts does the writing).
 */
import { Timestamp } from "firebase-admin/firestore";
import type { StarfishConfig } from "./config.js";
import { redactPii, sliceWellFormed, toWellFormed } from "./ingest/redact.js";
import { OCCURRENCE_BUCKET_RETENTION_HOURS } from "./ingest/buckets.js";
import { RUNTIME_BASES } from "./indexheal/runtimeBasis.js";

export type PublicViewConfig = Pick<StarfishConfig, "publicEnvironments" | "publicIncidentCollection" | "publicCycleCollection" | "publicEventCollection">;

/** The marker every copy carries. */
export const PUBLIC_VIEW_MARKER = 1;

/** Whether records of `environment` get a trimmed copy. */
export function isPublicEnvironment(pub: Pick<PublicViewConfig, "publicEnvironments">, environment: unknown): environment is string {
  return typeof environment === "string" && environment !== "" && pub.publicEnvironments.includes(environment);
}

// ---- Value shapes ------------------------------------------------------------------------------

/** An enumerated value or a rule name: `act`, `model-decline`, `notify:counter-check-zero`, `24h`. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** A cycle's outcome: a rule, or `notify:<rule>`. */
const OUTCOME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
/** A JavaScript error name: `TypeError`, `FirebaseError`. */
const ERROR_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;
/** An error code: `permission-denied`, `auth/invalid-credential`, `13`. */
const ERROR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
/** An error type the classifier writes: `UnknownError`, `MissingIndexError`. */
const ERROR_TYPE_RE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
/** A git or content hash. */
const HEX_RE = /^[0-9a-f]{7,64}$/;
/** A document id. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** An identifier the engine composed (index spec parts, an operation's name, check names): no quotes, no @, no brackets. */
const IDENT_RE = /^[A-Za-z0-9 _.,:()/=-]{1,300}$/;
/** A GCP project id. */
const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** A Cloud Monitoring metric type or resource type. */
const METRIC_RE = /^[A-Za-z0-9._/-]{1,200}$/;

const MAX_TITLE = 200;
const MAX_NAME = 128;
const MAX_EVENT_SUMMARY = 160;
const MAX_URL = 300;
/** The engine keeps at most 8 Monitoring readings per incident (store.ts). */
const MAX_READINGS = 8;

type Out = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A time as Firestore stores it (a Timestamp, or anything with `toMillis`), copied as a Timestamp; otherwise undefined. */
function time(v: unknown): Timestamp | undefined {
  const ms = (v as { toMillis?: () => unknown } | null | undefined)?.toMillis?.();
  return typeof ms === "number" && Number.isFinite(ms) ? Timestamp.fromMillis(ms) : undefined;
}

const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const nonNegative = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const matching = (re: RegExp) => (v: unknown): string | undefined => (typeof v === "string" && re.test(v) ? v : undefined);
const token = matching(TOKEN_RE);
const hex = matching(HEX_RE);
const ident = matching(IDENT_RE);

/** An ISO-8601 time string, as the run record stores some times. */
function iso(v: unknown): string | undefined {
  return typeof v === "string" && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v)) ? v : undefined;
}

/** An https link with no credentials in it, bounded; the stored value is data, never trusted to be one. */
export function publicUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > MAX_URL) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password) return undefined;
    // Re-redacted: a token in a query string is a credential however the URL got here.
    return redactPii(v) === v ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Text shown to guests: redacted again, every run of whitespace and control characters made one space, well-formed,
 * bounded. One line, so it can never carry a multi-line dump (a stack trace, a payload).
 */
export function publicLine(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  // `\s` covers the line and paragraph separators; the ranges are the C0 and C1 control characters.
  // eslint-disable-next-line no-control-regex
  const line = redactPii(toWellFormed(v)).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  const out = sliceWellFormed(line, max).trim();
  return out === "" ? undefined : out;
}

/**
 * The first line of a stored title that holds text, never a stack frame (#361): ingest keeps only a message's title
 * now, but a record stored before then holds the frames after it, and {@link publicLine} would flatten them into it.
 */
export function firstLine(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const line = v.split(/\r\n|[\n\r\u2028\u2029]/).find((l) => l.trim() !== "");
  return line === undefined || /^\s+at\s/.test(line) ? undefined : line;
}

/** `{ ...(v !== undefined && { [k]: v }) }`, spelled once: Firestore rejects undefined, so absent stays absent. */
function put(out: Out, key: string, value: unknown): void {
  if (value !== undefined) out[key] = value;
}

// ---- Incidents ---------------------------------------------------------------------------------

const INCIDENT_STATUSES: readonly string[] = ["new", "acknowledged", "logged", "resolved", "recurred", "ignored"];
const TRIAGE_STATES: readonly string[] = ["pending", "acting", "declined", "resolved"];
const PR_STATES: readonly string[] = ["open", "merged", "closed"];

/** The newest buckets the store keeps (168 hours and the current one); a bucket is an epoch hour and a count. */
function buckets(v: unknown): Record<string, number> | undefined {
  if (!isObj(v)) return undefined;
  const kept = Object.entries(v)
    .filter(([k, n]) => /^\d{1,10}$/.test(k) && count(n) !== undefined)
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .slice(0, OCCURRENCE_BUCKET_RETENTION_HOURS + 1);
  return kept.length > 0 ? Object.fromEntries(kept as [string, number][]) : undefined;
}

/** The Cloud Monitoring readings (#19): provenance and a count, nothing from a log. */
function readings(v: unknown): Out[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Out[] = [];
  for (const r of v.slice(0, MAX_READINGS) as unknown[]) {
    if (!isObj(r)) continue;
    const metricType = matching(METRIC_RE)(r.metricType);
    const resourceType = matching(METRIC_RE)(r.resourceType);
    const projectId = matching(PROJECT_RE)(r.projectId);
    const windowStart = time(r.windowStart);
    const windowEnd = time(r.windowEnd);
    const failureCount = count(r.failureCount);
    if (!metricType || !resourceType || !projectId || !windowStart || !windowEnd || failureCount === undefined) continue;
    const reading: Out = { metricType, resourceType, projectId, windowStart, windowEnd, failureCount };
    put(reading, "source", token(r.source));
    if (r.capped === true) reading.capped = true;
    out.push(reading);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The guest copy of a stored incident, or null when there must be none: not a public environment, retired (closed for
 * good, and gone from every list), or missing what every row needs.
 */
export function toPublicIncident(d: Record<string, unknown> | undefined, pub: Pick<PublicViewConfig, "publicEnvironments">): Out | null {
  if (!d || !isPublicEnvironment(pub, d.environment) || d.retired === true) return null;
  const status = typeof d.status === "string" && INCIDENT_STATUSES.includes(d.status) ? d.status : undefined;
  const firstOccurredAt = time(d.firstOccurredAt);
  const lastOccurredAt = time(d.lastOccurredAt);
  if (!status || !firstOccurredAt || !lastOccurredAt) return null;

  const out: Out = { publicView: PUBLIC_VIEW_MARKER, environment: d.environment, status, firstOccurredAt, lastOccurredAt };
  put(out, "functionName", publicLine(d.functionName, MAX_NAME));
  put(out, "service", publicLine(d.service, MAX_NAME));
  put(out, "errorType", matching(ERROR_TYPE_RE)(d.errorType));
  // The first line only (#361): a record stored before ingest split a stack off its message holds the frames after it.
  put(out, "errorMessage", publicLine(firstLine(d.errorMessage), MAX_TITLE));
  put(out, "errorName", matching(ERROR_NAME_RE)(d.errorName));
  put(out, "errorCode", matching(ERROR_CODE_RE)(d.errorCode));
  put(out, "triageState", typeof d.triageState === "string" && TRIAGE_STATES.includes(d.triageState) ? d.triageState : undefined);
  put(out, "occurrenceCount", count(d.occurrenceCount));
  put(out, "occurrencesByHour", buckets(d.occurrencesByHour));
  put(out, "recurrenceCount", count(d.recurrenceCount));
  put(out, "lastRecurredAt", time(d.lastRecurredAt));
  put(out, "githubIssueNumber", count(d.githubIssueNumber));
  put(out, "githubIssueUrl", publicUrl(d.githubIssueUrl));
  put(out, "githubPrNumber", count(d.githubPrNumber));
  put(out, "githubPrUrl", publicUrl(d.githubPrUrl));
  put(out, "githubPrState", typeof d.githubPrState === "string" && PR_STATES.includes(d.githubPrState) ? d.githubPrState : undefined);
  if (isObj(d.lastResolution)) {
    const last: Out = {};
    put(last, "githubIssueNumber", count(d.lastResolution.githubIssueNumber));
    put(last, "githubIssueUrl", publicUrl(d.lastResolution.githubIssueUrl));
    if (Object.keys(last).length > 0) out.lastResolution = last;
  }
  // A Monitoring-only incident (#19) says so without its fingerprint: the copy carries no hash of the message.
  if (d.signalSource === "monitoring" || (typeof d.fingerprint === "string" && d.fingerprint.startsWith("mon-"))) out.signalSource = "monitoring";
  put(out, "monitoringCount", count(d.monitoringCount));
  put(out, "lastMonitoring", readings(d.lastMonitoring));
  if (d.synthetic === true) out.synthetic = true;
  return out;
}

// ---- Cycles ------------------------------------------------------------------------------------

const CYCLE_STATES: readonly string[] = ["running", "waiting-human", "done", "declined", "failed"];
const CYCLE_PATHS: readonly string[] = ["decline", "notify", "draft", "pr", "human", "failed", "index"];

type Shape = (v: unknown) => unknown;

const bool: Shape = (v) => (typeof v === "boolean" ? v : undefined);
const boolOrNull: Shape = (v) => (v === null ? null : bool(v));
const countOrNull: Shape = (v) => (v === null ? null : count(v));
const intOrNull: Shape = (v) => (v === null ? null : typeof v === "number" && Number.isInteger(v) ? v : undefined);
const isoOrNull: Shape = (v) => (v === null ? null : iso(v));
const tokenOrNull: Shape = (v) => (v === null ? null : token(v));

/**
 * The run record (`summary.<stage>`) a guest may see: per stage, the keys and the shape of each value. Only the stages
 * and keys the UI renders; a stage not named here (alert, notify, merge, revert, escalation, before) is left out.
 * `counterCount: null` is kept as null: it means the recount was missing, which is not the same as not recorded.
 */
export const PUBLIC_SUMMARY: Readonly<Record<string, Readonly<Record<string, Shape>>>> = {
  // `level` (noise, log, fix, merge) and `mergeCase` (an admin's case id) are engine tokens, not model text.
  triage: { decision: token, rule: token, model: token, level: tokenOrNull, mergeCase: tokenOrNull, cap: tokenOrNull, capBy: tokenOrNull, capRule: tokenOrNull, counterCount: countOrNull, counterCapped: bool, counterWindow: token, counterCheckedAt: iso },
  // `source`, `sourceSearch`: which rule found the source the fixer was shown (#259), engine tokens; `sourceImports` a count (#347).
  fix: { outcome: token, rule: token, model: token, testAdded: boolOrNull, revisions: count, source: token, sourceFiles: count, sourceSearch: token, sourceImports: count },
  verify: { status: token, rule: token, patchSha256: hex, baseRevision: hex, files: count, exitCode: intOrNull, durationMs: nonNegative, isolation: token },
  review: { verdict: tokenOrNull, rule: token, model: token, attacks: count, held: count, flagged: count, broken: count, patchSha256: hex },
  // The issue Starfish filed: the same number and link the incident's copy already carries (`githubIssueUrl`).
  issue: { state: token, number: count, url: publicUrl },
  pr: { opened: bool, reason: token, number: count, url: publicUrl, patchSha256: hex },
  prState: {
    number: count,
    state: token,
    mergedAt: isoOrNull,
    closedAt: isoOrNull,
    headSha: hex,
    checks: token,
    checksPassed: count,
    checksRequired: count,
    failedChecks: ident,
    checkedAt: iso,
  },
  // Whether a merged fix was deployed and the error stopped (#390, src/agent/recoveryStep.ts): the answer, why, and when. Engine
  // tokens and times only; never the error's rate, the deployment's id or what GitHub could not be read for.
  recovery: { state: token, reason: token, mergeCommitSha: hex, mergedAt: iso, deployedAt: iso, windowStart: iso, windowEnd: iso, expectedOccurrences: nonNegative, recurredAt: iso, checkedAt: iso },
  index: {
    state: token,
    rule: token,
    project: matching(PROJECT_RE),
    database: token,
    collectionGroup: token,
    queryScope: token,
    fields: ident,
    created: bool,
    operation: ident,
    live: token,
    probe: token,
    repoFile: token,
    readyAt: iso,
    observeUntil: iso,
    runtime: token,
    runtimeCheckedAt: iso,
    runtimeBasis: (v) => (typeof v === "string" && RUNTIME_BASES.includes(v) ? v : undefined),
  },
};

function publicSummary(v: unknown): Record<string, Out> {
  const out: Record<string, Out> = {};
  if (!isObj(v)) return out;
  for (const [stage, keys] of Object.entries(PUBLIC_SUMMARY)) {
    const record = v[stage];
    if (!isObj(record)) continue;
    const kept: Out = {};
    for (const [key, shape] of Object.entries(keys)) {
      if (!(key in record)) continue;
      put(kept, key, shape(record[key]));
    }
    // A stage that recorded something keeps its entry even when none of it may be shown: "recorded" stays true.
    out[stage] = kept;
  }
  return out;
}

/** The guest copy of a stored cycle, or null when there must be none (not a public environment, or not a cycle). */
export function toPublicCycle(d: Record<string, unknown> | undefined, pub: Pick<PublicViewConfig, "publicEnvironments">): Out | null {
  if (!d || !isPublicEnvironment(pub, d.environment)) return null;
  const incidentId = matching(ID_RE)(d.incidentId);
  const state = typeof d.state === "string" && CYCLE_STATES.includes(d.state) ? d.state : undefined;
  const createdAt = time(d.createdAt);
  const updatedAt = time(d.updatedAt);
  if (!incidentId || !state || !createdAt || !updatedAt) return null;

  const out: Out = {
    publicView: PUBLIC_VIEW_MARKER,
    incidentId,
    environment: d.environment,
    state,
    createdAt,
    updatedAt,
    // Null when no worker holds the cycle: kept as null, so "no lease" is not read as "not recorded".
    leaseExpiresAt: time(d.leaseExpiresAt) ?? null,
    deadlineAt: time(d.deadlineAt) ?? null,
    summary: publicSummary(d.summary),
  };
  put(out, "recurrence", count(d.recurrence));
  put(out, "stage", token(d.stage));
  put(out, "path", typeof d.path === "string" && CYCLE_PATHS.includes(d.path) ? d.path : undefined);
  put(out, "outcome", matching(OUTCOME_RE)(d.outcome));
  put(out, "attempts", count(d.attempts));
  put(out, "eventCount", count(d.eventCount));
  if (d.synthetic === true) out.synthetic = true;
  return out;
}

// ---- Run events --------------------------------------------------------------------------------

/**
 * The stages whose one-line summary the engine writes from its own words (and rule names, counts, issue and pull-request
 * numbers), never from a model's answer, a tool's output or incident text. Every other stage's event is copied without
 * one, `escalation` included: its summaries name an on-call role and a masked phone number, which is not for the public.
 */
export const PUBLIC_SUMMARY_STAGES: readonly string[] = ["cycle", "issue", "alert", "notify", "pr", "merge", "revert", "index"];

/** The guest copy's document id for an event: one flat collection, so the Overview's feed is one plain query. */
export function publicEventId(cycleId: string, eventId: string): string {
  return `${cycleId}_${eventId}`;
}

/**
 * The guest copy of a run event of cycle `cycleId`, or null when there must be none. Never its `data`; its summary
 * only for the stages above, as one bounded, redacted line.
 */
export function toPublicEvent(cycleId: string, d: Record<string, unknown> | undefined, pub: Pick<PublicViewConfig, "publicEnvironments">): Out | null {
  if (!d || !isPublicEnvironment(pub, d.environment) || !ID_RE.test(cycleId)) return null;
  const seq = count(d.seq);
  const at = time(d.at);
  const stage = token(d.stage);
  if (seq === undefined || !at || !stage) return null;
  const out: Out = { publicView: PUBLIC_VIEW_MARKER, cycleId, environment: d.environment, seq, at, stage };
  put(out, "type", token(d.type));
  // Its round (#436): a plain count the engine wrote, so a guest numbers a run's rounds as the team does.
  put(out, "round", count(d.round));
  if (PUBLIC_SUMMARY_STAGES.includes(stage)) put(out, "summary", publicLine(d.summary, MAX_EVENT_SUMMARY));
  if (d.synthetic === true) out.synthetic = true;
  return out;
}
