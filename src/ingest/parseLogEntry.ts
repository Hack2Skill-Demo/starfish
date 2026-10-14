/**
 * Cloud Logging entry → structured error.
 *
 * Most of the length here is false-positive suppression, and every guard is
 * scar tissue from a real incident-store poisoning. Getting this wrong doesn't
 * just add noise — it feeds the model garbage and burns the human review budget
 * the whole loop depends on.
 */
import { DEFAULT_IGNORED_MESSAGES, type StarfishConfig } from "../config.js";
import { canonicalFunctionName } from "./fingerprint.js";
import { messageTitle, splitMessageStack } from "./messageStack.js";

/** Minimal structural shape of a Cloud Logging entry. */
export interface RawLogEntry {
  metadata?: {
    timestamp?: string | Date;
    logName?: string;
    resource?: { labels?: Record<string, string> };
    labels?: Record<string, string>;
    /** The request's Cloud Trace resource name, `projects/<p>/traces/<32 hex>`, when the runtime stamped one. */
    trace?: string;
  };
  data?: unknown;
}

export interface ParsedLogEntry {
  functionName: string;
  /** The message's title: a message that carried a stack trace is cut at its first frame line (#361). */
  errorMessage: string;
  /** The entry's `stack`/`stackTrace` field, else the whole message when the message carried frames (#361). */
  stackTrace?: string;
  errorName?: string;
  errorCode?: string;
  /**
   * `jsonPayload.error` when it differs from the message. The message is the
   * log's title ("send failed"); this is usually the actual cause
   * ("FAILED_PRECONDITION: the query requires an index…"). Kept separate so the
   * fingerprint stays keyed on the stable title.
   */
  errorDetail?: string;
  /** Coarse class the handler asserted at the source. */
  sourceErrorClass?: string;
  httpStatus?: number;
  /** Service the handler asserted; beats name-based detection when present. */
  serviceTag?: string;
  timestamp: Date;
  requestId?: string;
  /** The request's Cloud Trace id (32 hex, lower case): joins the incident to every log line of that request. */
  traceId?: string;
  tenantId?: string;
  sourceProjectId?: string;
}

/** The slice of config that decides which log entries count as incidents. */
export type LogSource = Pick<StarfishConfig, "logResourceTypes" | "ignoredMessages"> & {
  /** Functions and services never read (see `StarfishConfig.excludedServices`). */
  excludedServices?: readonly string[];
};

/**
 * A prefix entry: `control-*` names every service that starts with `control-`. Only a trailing `*` counts, and the
 * prefix must not be empty, so one stray `*` cannot exclude everything.
 */
function prefixOf(entry: string): string | undefined {
  const e = entry.trim();
  if (!e.endsWith("*")) return undefined;
  const prefix = canonicalFunctionName(e.replace(/\*+$/, ""));
  return prefix === "" ? undefined : prefix;
}

/** True when `name` is one of `excluded` (or starts with a `prefix-*` entry), compared on the canonical spelling. */
export function isExcludedService(name: string | undefined, excluded: readonly string[]): boolean {
  if (!name || excluded.length === 0) return false;
  const canonical = canonicalFunctionName(name);
  return excluded.some((e) => {
    const prefix = prefixOf(e);
    return prefix !== undefined ? canonical.startsWith(prefix) : canonicalFunctionName(e) === canonical;
  });
}

/**
 * Pull a readable string out of a `jsonPayload.error` value. Handlers usually log
 * a bare string, but some log the Error object itself, which Cloud Logging
 * serialises to `{ message, stack, … }` — take its message rather than
 * `[object Object]`. Any other non-empty value (a gRPC `{ code, details }`, a
 * number) is stringified, never dropped: it is often the only real cause.
 */
export function extractErrorDetail(raw: unknown): string | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const m = (raw as Record<string, unknown>).message;
    if (typeof m === "string" && m) return m;
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

/**
 * The title text of a `jsonPayload.message` value. A string (the usual case), number or boolean reads
 * as it always has: the title keys the fingerprint, so its spelling must not move. A plain object (a
 * handler that logs `{ code, text }` as the message) went through `String()` and became
 * "[object Object]", so every such error from one function shared one fingerprint and unrelated
 * bugs merged into one incident (#131); it now reads like `jsonPayload.error` does.
 */
export function extractMessageTitle(raw: unknown): string {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return extractErrorDetail(raw) ?? "";
  return String(raw);
}

const TRACE_PATH_RE = /^projects\/[^/]+\/traces\/([0-9a-f]{32})$/i;
/** A trace id as it is kept: checked again wherever it is written or put in a link. */
export const TRACE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * The trace id from the entry's `trace` field, which Cloud Run and Cloud Functions stamp on a request's log lines (and
 * Cloud Logging fills from a structured log's `logging.googleapis.com/trace`). Anything else is dropped, never kept as
 * written: the id is only ever 32 hex digits, stored lower case so it matches the filter Cloud Logging compares exactly.
 */
export function extractTraceId(entry: RawLogEntry): string | undefined {
  const trace = entry.metadata?.trace;
  if (typeof trace !== "string") return undefined;
  return TRACE_PATH_RE.exec(trace)?.[1]?.toLowerCase();
}

function extractProjectId(entry: RawLogEntry): string | undefined {
  const labels = entry.metadata?.resource?.labels;
  if (labels?.project_id) return labels.project_id;
  const logName = entry.metadata?.logName;
  if (typeof logName === "string") {
    return logName.match(/^projects\/([^/]+)\//)?.[1];
  }
  return undefined;
}

export function parseLogEntry(
  entry: RawLogEntry,
  ignoredMessages: readonly string[] = DEFAULT_IGNORED_MESSAGES,
  excludedServices: readonly string[] = []
): ParsedLogEntry | null {
  const labels = entry.metadata?.resource?.labels;
  const functionName = labels?.function_name ?? labels?.service_name;
  if (!functionName) return null;
  // Checked on both labels: an entry can carry a function_name AND a service_name (a gen2 function is
  // both), and either one naming an excluded service keeps it out.
  if (isExcludedService(labels?.function_name, excludedServices) || isExcludedService(labels?.service_name, excludedServices)) {
    return null;
  }

  const data = entry.data;
  let errorMessage = "";
  let stackTrace: string | undefined;
  let errorName: string | undefined;
  let errorCode: string | undefined;
  let errorDetail: string | undefined;
  let sourceErrorClass: string | undefined;
  let httpStatus: number | undefined;
  let serviceTag: string | undefined;
  let tenantId: string | undefined;

  if (typeof data === "string") {
    errorMessage = data;
  } else if (data && typeof data === "object") {
    const json = data as Record<string, unknown>;

    // Cloud Audit Log entries surface at ERROR severity (a denied IAM call, say)
    // and get attributed to whichever service triggered the audit event. Their
    // proto payload would serialise into a meaningless "error message".
    if (typeof json.type_url === "string" && json.type_url.includes("AuditLog")) {
      return null;
    }

    // `message` and `error` are complementary, not alternatives: the title
    // keys the fingerprint, the detail is what a fixer needs. `||`, not `??` —
    // an empty-string title must still fall back.
    const detail = extractErrorDetail(json.error);
    errorMessage = json.message ? extractMessageTitle(json.message) : String(detail || JSON.stringify(data));
    // The title too: a message that carries a stack is split below, and an error equal to its title is no detail.
    if (detail && detail !== errorMessage && detail !== messageTitle(errorMessage)) errorDetail = detail;
    const rawStack = json.stack ?? json.stackTrace;
    if (typeof rawStack === "string") stackTrace = rawStack;
    if (typeof json.errorName === "string") errorName = json.errorName;
    if (typeof json.errorCode === "string") errorCode = json.errorCode;
    if (typeof json.errorClass === "string") sourceErrorClass = json.errorClass;
    if (typeof json.httpStatus === "number") httpStatus = json.httpStatus;
    if (typeof json.service === "string") serviceTag = json.service;
    if (typeof json.tenantId === "string") tenantId = json.tenantId;
  }

  if (!errorMessage) return null;
  // Read on the whole text, as the query side's `jsonPayload.message:` and `textPayload:` match it.
  if (ignoredMessages.some((m) => errorMessage.includes(m))) return null;

  // A message that carries its own stack (#361): the firebase-functions logger writes `new Error(message).stack`
  // for `logger.error("x failed: ...")`, and appends `err.stack` to `logger.error("Unhandled error", err)`. Only the
  // title is the message (the fingerprint, the classifier and the guests' copy read it); the frames are the stack,
  // unless the entry carried one of its own, which is kept as logged.
  const split = splitMessageStack(errorMessage);
  if (split.stack !== undefined) {
    errorMessage = split.title;
    stackTrace ??= split.stack;
  }

  return {
    functionName,
    errorMessage,
    stackTrace,
    errorName,
    errorCode,
    errorDetail,
    sourceErrorClass,
    httpStatus,
    serviceTag,
    timestamp: parseTimestamp(entry.metadata?.timestamp),
    requestId: entry.metadata?.labels?.execution_id,
    traceId: extractTraceId(entry),
    tenantId,
    sourceProjectId: extractProjectId(entry),
  };
}

/**
 * A malformed timestamp must not become an Invalid Date: it would reach
 * `Timestamp.fromDate` and throw, failing the whole write batch over one entry.
 */
function parseTimestamp(ts: string | Date | undefined): Date {
  const d = ts ? new Date(ts) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Escape a value for a double-quoted Cloud Logging filter literal. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The query-side twin of the guards above — cheaper to exclude before reading.
 *
 * Shared by the aggregator and the counter-check. They must measure the same
 * thing, or the counter-check disagrees with the incident for reasons that have
 * nothing to do with the incident.
 *
 * `functionName`, when given, scopes to one function. It is reduced to the
 * charset GCP resource labels allow, so it cannot break out of the literal. It is
 * matched under both spellings the same function carries: a first-generation
 * `function_name` label is the id exactly as deployed, while a second-generation
 * `service_name` is lowercased with `_` mapped to `-` (see `canonicalFunctionName`).
 * Label comparisons are exact, so matching one spelling on both labels would count
 * zero for an incident whose stored name is the other spelling.
 */
export function buildLogFilter(source: LogSource, since: Date, functionName?: string, until?: Date): string {
  const clauses = [
    `(${source.logResourceTypes.map((t) => `resource.type=${quote(t)}`).join(" OR ")})`,
    "severity>=ERROR",
    `timestamp>${quote(since.toISOString())}`,
  ];
  // An ingest window is (since, until]: the boundary entry belongs to exactly one window.
  if (until !== undefined) clauses.push(`timestamp<=${quote(until.toISOString())}`);
  if (functionName !== undefined) {
    const safe = functionName.replace(/[^A-Za-z0-9_-]/g, "");
    // Lowercasing and `_` → `-` stay inside the label charset, so this is literal-safe too.
    clauses.push(
      `(resource.labels.function_name=${quote(safe)} OR resource.labels.service_name=${quote(canonicalFunctionName(safe))})`
    );
  }
  for (const name of source.excludedServices ?? []) {
    const prefix = prefixOf(name);
    if (prefix !== undefined) {
      // A regular expression (RE2, case-insensitive) on both labels; `-` and `_` are one spelling, as everywhere else.
      const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, "");
      if (!safePrefix) continue;
      const re = quote(`(?i)^${safePrefix.replace(/[-_]/g, "[-_]")}`);
      clauses.push(`NOT resource.labels.function_name=~${re}`, `NOT resource.labels.service_name=~${re}`);
      continue;
    }
    // Both spellings on both labels: a first-generation function_name keeps the id as deployed, a
    // service_name is canonical. The charset reduction keeps the literal safe, like `functionName` above.
    const safe = name.replace(/[^A-Za-z0-9_-]/g, "");
    if (!safe) continue;
    for (const spelling of new Set([safe, canonicalFunctionName(safe)])) {
      clauses.push(`NOT resource.labels.function_name=${quote(spelling)}`, `NOT resource.labels.service_name=${quote(spelling)}`);
    }
  }
  for (const m of source.ignoredMessages) {
    clauses.push(`NOT textPayload:${quote(m)}`, `NOT jsonPayload.message:${quote(m)}`);
  }
  clauses.push(`NOT logName:"cloudaudit.googleapis.com"`);
  return clauses.join("\n");
}
