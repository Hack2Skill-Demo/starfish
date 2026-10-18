/**
 * Project-level Cloud Run quota rejections, folded into one incident per quota metric.
 *
 * When many revisions roll at once (a deploy) or a cold-start burst hits, the project can exceed a regional Cloud Run
 * quota (`run.googleapis.com/cpu_allocation`), and Google's front end rejects requests to EVERY function with
 *   "The request failed because the project exceeded its quota limit for run.googleapis.com/cpu_allocation recently."
 * That is one project-wide event, but the fingerprint is (function, message), so it opened one incident per function,
 * each triaged on its own. The rejection happens before any handler runs: there is no code in any function to fix.
 *
 * Such entries are folded into ONE incident per quota metric under a synthetic function name, in their own fingerprint
 * namespace (`signalSource: "platform-quota"`), with the affected functions listed in its detail. Triage hands it to a
 * person without asking the model. Only Cloud Run's quota text is matched: a "no available instance" abort is a
 * different failure (it can be real saturation of one function) and keeps its per-function incident.
 *
 * The text matched is Google's, the same in every project, so nothing here is deployment-specific.
 */
import { INCIDENT_KINDS } from "../incidentKinds.js";

/** The synthetic `functionName` of a consolidated quota incident. Never a deployed function's id. */
export const PLATFORM_QUOTA_FUNCTION = "cloud-run-platform-quota";

/** The errorType of a consolidated quota incident (the classifier's quota class; the kind's, src/incidentKinds.ts). */
export const PLATFORM_QUOTA_ERROR_TYPE = INCIDENT_KINDS["platform-quota"].errorType!;

/** Affected function ids listed in the incident's detail; the rest are counted. */
const MAX_LISTED_FUNCTIONS = 10;

/**
 * Google's whole message, anchored: a handler that echoes its input into an error ("invalid name: ...exceeded its quota
 * limit for run.googleapis.com/x") must not be able to fold its own error into the quota incident and out of triage.
 */
const CLOUD_RUN_QUOTA_RE =
  /^\s*the request failed because the project exceeded its quota limit for (run\.googleapis\.com\/[a-z0-9_]+)(?: recently)?\.?\s*$/i;

/** The quota metric (`run.googleapis.com/cpu_allocation`) when `message` is a Cloud Run project quota rejection, else null. */
export function parsePlatformQuotaRejection(message: string): { metric: string } | null {
  const match = CLOUD_RUN_QUOTA_RE.exec(String(message ?? ""));
  return match ? { metric: match[1]!.toLowerCase() } : null;
}

/** The fixed message of the consolidated incident: it keys the fingerprint, so it holds only the metric (one incident per metric). */
export function platformQuotaMessage(metric: string): string {
  return `Project exceeded its Cloud Run quota (${metric}); requests were rejected before reaching any function. Typically a deploy rolling many revisions at once.`;
}

/** The detail line: how many requests were rejected in the window, across which functions (sorted, capped). */
export function describePlatformQuotaImpact(functions: ReadonlySet<string>, rejected: number): string {
  const sorted = [...functions].sort();
  const listed = sorted.slice(0, MAX_LISTED_FUNCTIONS).join(", ");
  const more = sorted.length > MAX_LISTED_FUNCTIONS ? ` (+${sorted.length - MAX_LISTED_FUNCTIONS} more)` : "";
  return `In this window: ${rejected} rejected request${rejected === 1 ? "" : "s"} across ${sorted.length} function${sorted.length === 1 ? "" : "s"}: ${listed}${more}`;
}
