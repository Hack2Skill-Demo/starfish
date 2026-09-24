/**
 * Cloud Logging entry → structured error.
 *
 * Most of the length here is false-positive suppression, and every guard is
 * scar tissue from a real incident-store poisoning. Getting this wrong doesn't
 * just add noise — it feeds the model garbage and burns the human review budget
 * the whole loop depends on.
 */
import { DEFAULT_IGNORED_MESSAGES, type StarfishConfig } from "../config.js";

/** Minimal structural shape of a Cloud Logging entry. */
export interface RawLogEntry {
  metadata?: {
    timestamp?: string | Date;
    logName?: string;
    resource?: { labels?: Record<string, string> };
    labels?: Record<string, string>;
  };
  data?: unknown;
}

export interface ParsedLogEntry {
  functionName: string;
  errorMessage: string;
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
  tenantId?: string;
  sourceProjectId?: string;
}

/** The slice of config that decides which log entries count as incidents. */
export type LogSource = Pick<StarfishConfig, "logResourceTypes" | "ignoredMessages">;

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
  ignoredMessages: readonly string[] = DEFAULT_IGNORED_MESSAGES
): ParsedLogEntry | null {
  const labels = entry.metadata?.resource?.labels;
  const functionName = labels?.function_name ?? labels?.service_name;
  if (!functionName) return null;

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
    errorMessage = String(json.message || detail || JSON.stringify(data));
    if (detail && detail !== errorMessage) errorDetail = detail;
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
  if (ignoredMessages.some((m) => errorMessage.includes(m))) return null;

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
 * charset GCP resource labels allow, so it cannot break out of the literal.
 */
export function buildLogFilter(source: LogSource, since: Date, functionName?: string): string {
  const clauses = [
    `(${source.logResourceTypes.map((t) => `resource.type=${quote(t)}`).join(" OR ")})`,
    "severity>=ERROR",
    `timestamp>${quote(since.toISOString())}`,
  ];
  if (functionName !== undefined) {
    const fn = quote(functionName.replace(/[^A-Za-z0-9_-]/g, ""));
    clauses.push(`(resource.labels.function_name=${fn} OR resource.labels.service_name=${fn})`);
  }
  for (const m of source.ignoredMessages) {
    clauses.push(`NOT textPayload:${quote(m)}`, `NOT jsonPayload.message:${quote(m)}`);
  }
  clauses.push(`NOT logName:"cloudaudit.googleapis.com"`);
  return clauses.join("\n");
}
