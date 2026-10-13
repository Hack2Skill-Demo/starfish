import { TRACE_ID_RE } from "../ingest/parseLogEntry.js";

/**
 * Links from an outside message (Slack, a GitHub issue) back to the operator UI. Built here, once, from the
 * configured UI origin and an id that is checked to be a plain id, so text from an incident can never become part of
 * a link. No origin configured: no link.
 */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function incidentUrl(uiBaseUrl: string, incidentId: string): string | null {
  return uiBaseUrl !== "" && PLAIN_ID.test(incidentId) ? `${uiBaseUrl}/incidents/${incidentId}` : null;
}

export function runUrl(uiBaseUrl: string, cycleId: string): string | null {
  return uiBaseUrl !== "" && PLAIN_ID.test(cycleId) ? `${uiBaseUrl}/runs?run=${cycleId}` : null;
}

/** An https URL with no credentials (what GitHub's API returns as `html_url`), or null. For a link in a message. */
export function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A GCP project id as Google allows it (6–30 characters). Anything else, a domain-scoped id included: no link. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** How far back from the last occurrence the Logs Explorer view reaches. */
const TRACE_VIEW_HOURS = 24;

/**
 * Logs Explorer link to EVERY line one request logged (all severities, not only the error): the lines before a failure
 * usually explain it. Built only from a checked project id and a checked trace id, so log text never becomes part of
 * the link; null without either.
 */
export function traceLogsUrl(projectId: string | undefined, traceId: string | undefined, lastOccurredAt?: string): string | null {
  if (projectId === undefined || traceId === undefined || !PROJECT_ID.test(projectId) || !TRACE_ID_RE.test(traceId)) return null;
  const query = encodeURIComponent(`trace="projects/${projectId}/traces/${traceId}"`);
  const end = lastOccurredAt !== undefined ? Date.parse(lastOccurredAt) : NaN;
  const cursor = new Date(Number.isFinite(end) ? end : Date.now()).toISOString();
  return `https://console.cloud.google.com/logs/query;query=${query};cursorTimestamp=${cursor};duration=PT${TRACE_VIEW_HOURS}H?project=${projectId}`;
}
