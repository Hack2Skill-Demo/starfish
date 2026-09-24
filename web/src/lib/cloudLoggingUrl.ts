/**
 * cloudLoggingUrl — build a Cloud Logging deep-link for an incident row.
 * ============================================================================
 * Assembles the Google Cloud Logging "Logs Explorer" URL an operator would
 * otherwise build by hand to jump from an incident row straight to that
 * function's error lines: a windowed, function-level query centred on the row's
 * last occurrence. The region comes from config.
 */

import { webConfig } from "./config";

const LOGS_EXPLORER_BASE = "https://console.cloud.google.com/logs/query";

export interface CloudLoggingUrlParams {
  /** Cloud Function id, camelCase as deployed (e.g. `mailQueueDrainer`). */
  functionName: string;
  /** GCP project the function runs in — `err.sourceProjectId`. */
  projectId: string | undefined;
  /** ISO timestamp the view ends at (the row's `lastOccurredAt`). */
  lastOccurredAt: string;
  /** Look-back window in hours, matching the page's selected time window. */
  windowHours: number;
  /** Deploy region; defaults to the configured functions region. */
  region?: string;
}

/**
 * Build the Cloud Logging query text covering both gen1 (`cloud_function`) and
 * gen2 (`cloud_run_revision`) resource shapes at `severity>=ERROR`. Firebase
 * gen2 deploys the Cloud Run service under a name conforming to Cloud Run's
 * constraints (lowercase alphanumerics + hyphens only), so an underscore in the
 * function id becomes a hyphen; the gen2 branch mirrors that transform
 * (lowercase + `_`→`-`) so it matches every naming style.
 *
 * The two resource clauses are wrapped in an outer `(... OR ...)` group so the
 * trailing `severity>=ERROR` applies to BOTH. Cloud Logging's implicit `AND`
 * binds tighter than `OR`, so an ungrouped `(gen1) OR (gen2) severity>=ERROR`
 * would parse as `(gen1) OR ((gen2) AND severity>=ERROR)` and match gen1 logs
 * of any severity.
 *
 * Kept on a SINGLE line (spaces, not newlines): the Logs Explorer accepts
 * multi-line queries when typed, but the console's own "Share link" builder
 * keeps the query on one line, and the encoded newlines the previous multi-line
 * form emitted (`%0A`) did not round-trip through the console's URL parser — the
 * query opened blank. This matches the share-link shape exactly.
 */
function buildQuery(functionName: string, region: string): string {
  const gen2Service = functionName.toLowerCase().replace(/_/g, "-");
  return (
    "(" +
    `(resource.type="cloud_function" resource.labels.function_name="${functionName}" resource.labels.region="${region}")` +
    " OR " +
    `(resource.type="cloud_run_revision" resource.labels.service_name="${gen2Service}" resource.labels.location="${region}")` +
    ") severity>=ERROR"
  );
}

/**
 * Encode the query for the `;query=` matrix segment the way the Logs Explorer's
 * own share-link does: parens are pre-escaped to `%28`/`%29` BEFORE the whole
 * segment is percent-encoded, so they arrive double-encoded (`%2528`/`%2529`)
 * and survive the console's two decode passes as literal parens in the query.
 *
 * `encodeURIComponent` alone leaves `(`/`)` untouched (they are unreserved in
 * its table), and literal parens in the matrix segment made the console parse
 * the query as empty — the errors view's link "opened without its query" for
 * exactly this reason. Pre-escaping them fixes that and reproduces the exact
 * byte-shape of a console-generated link.
 */
function encodeQuery(query: string): string {
  const parenEscaped = query.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return encodeURIComponent(parenEscaped);
}

/**
 * Assemble the Logs Explorer deep-link for an incident row, or return
 * `null` when the row has no resolvable project (legacy docs may lack
 * `sourceProjectId`) — the caller hides the link in that case.
 *
 * The link is a windowed query, not a per-occurrence permalink: the aggregator
 * only stores counts + first/last timestamps, so there's no single log entry to
 * point at. We express the window by anchoring the view's cursor at
 * `lastOccurredAt` and looking back `windowHours` (`duration`), so the newest
 * matching line is in view.
 *
 * URL SHAPE (why this form): the Logs Explorer reads its state from the
 * `;key=value` MATRIX segment of the path (only `project` is a real
 * query-string param). The shape the console's own "Share link" emits — and the
 * ONLY shape verified to open the errors view with its query + time window
 * applied — is `query` + `cursorTimestamp=<end>` + `duration=PT{n}H`, anchoring
 * the view at the row's last occurrence and looking back `windowHours`.
 *
 * This helper briefly emitted an absolute `timeRange=<start>/<end>` instead. It
 * regressed hard: the `/` between the two timestamps has to be encoded as `%2F`
 * to stay inside one path segment, but the console's client-side router decodes
 * `%2F`→`/` BEFORE matching the route, which splits the segment, fails the route
 * match, and bounces the whole link to `/welcome` — the query never opens at
 * all. `cursorTimestamp`+`duration` carries no `/`, so it routes cleanly; ISO
 * timestamps (with their `:`) and `PT{n}H` are valid path characters left
 * unencoded, exactly as a console share-link leaves them. A fresh link — never
 * carry `rapt`/`authuser`/`hl` from a copied URL.
 */
export function buildCloudLoggingUrl(params: CloudLoggingUrlParams): string | null {
  const { functionName, projectId, lastOccurredAt, windowHours } = params;
  if (!projectId) return null;

  const region = params.region ?? webConfig().functionsRegion;
  const query = encodeQuery(buildQuery(functionName, region));

  // End the view at the row's last occurrence and look back `windowHours`.
  // Guard a missing/unparseable lastOccurredAt by falling back to "now" so the link
  // still resolves to a sane window instead of an "Invalid Date" (or a
  // 1969→1970) cursor. `lastOccurredAt` is typed `string` but can be null at
  // runtime; gate on truthiness first, because `new Date(null)` is epoch 0 — a
  // finite number that would slip past the finiteness check below.
  const parsedEnd = lastOccurredAt ? Date.parse(lastOccurredAt) : NaN;
  const endMs = Number.isFinite(parsedEnd) ? parsedEnd : Date.now();
  const cursorIso = new Date(endMs).toISOString();

  const matrix =
    `;query=${query}` +
    `;cursorTimestamp=${cursorIso}` +
    `;duration=PT${windowHours}H`;

  return `${LOGS_EXPLORER_BASE}${matrix}?project=${encodeURIComponent(projectId)}`;
}
