import { findCreateIndexUrl } from "../indexheal/createIndexUrl.js";

/**
 * Error classification.
 *
 * The ordering here is the whole value of this file, and it was learned the hard
 * way: trust what the source said before guessing from message text. A handler
 * that caught the real error object knows more than any regex run against its
 * stringified output.
 */

/**
 * Coarse class a well-behaved handler emits alongside its error. When the log
 * carries one, it is trusted verbatim.
 */
const SOURCE_CLASS_TO_TYPE: Record<string, string> = {
  auth: "AuthError",
  invalid_argument: "ValidationError",
  not_found: "NotFoundError",
  quota: "QuotaError",
  timeout: "TimeoutError",
  unavailable: "UnavailableError",
  // A handler that knows a query failed for want of a Firestore index says so. A deployment fault no caller can fix:
  // without this entry it fell to its failed-precondition code and read as a ValidationError, pointing triage at the
  // caller's input. The index path (src/agent/indexPath.ts) still needs Google's create-index URL to act, and hands the
  // incident to a person when the error carries none.
  missing_index: "MissingIndexError",
};

export interface ClassificationHints {
  /** Coarse class the handler decided at the source. */
  sourceErrorClass?: string;
  /** Structured string code, e.g. "permission-denied". */
  errorCode?: string;
  /** Numeric transport status, e.g. a provider 401. */
  httpStatus?: number;
  /** The cause kept apart from the title (`jsonPayload.error`), where Firestore puts its create-index URL. */
  errorDetail?: string;
}

/** gRPC's spelling (`9 FAILED_PRECONDITION: ...`) and the Firebase one (`failed-precondition`). */
const FAILED_PRECONDITION_RE = /\bfailed[-_]precondition\b/i;

/**
 * A missing composite index (#11): Firestore refuses the query with FAILED_PRECONDITION and names the exact
 * index to create in a console URL. Both parts are structure, not keywords: the code (structured, or as gRPC
 * prints it), and Google's own create-index URL. A message that only says "requires an index" is not enough.
 */
function isMissingIndex(errorMessage: string, hints?: ClassificationHints): boolean {
  const text = `${errorMessage}\n${hints?.errorDetail ?? ""}`;
  const code = hints?.errorCode?.toLowerCase();
  const precondition = code === "failed-precondition" || code === "9" || (code === undefined && FAILED_PRECONDITION_RE.test(text));
  return precondition && findCreateIndexUrl(text) !== null;
}

/**
 * Preference order, most trustworthy first:
 *   1. source-asserted class
 *   2. structured error code (a failed precondition carrying Google's create-index URL is a
 *      MissingIndexError, the one class whose fix Google itself specifies)
 *   3. numeric HTTP status
 *   4. message keywords
 *
 * Step 3 exists because of a real failure: a third-party provider returning a
 * bare 401 with the body "unauthorized" classified as UnknownError for months,
 * since no keyword branch matched and no structured code was present.
 */
export function detectErrorType(errorMessage: string, hints?: ClassificationHints): string {
  // Guarded lookup: `sourceErrorClass` comes from an external log payload, so a
  // value like "constructor" must not return an inherited prototype function.
  const fromClass = hints?.sourceErrorClass
    ? SOURCE_CLASS_TO_TYPE[hints.sourceErrorClass]
    : undefined;
  if (typeof fromClass === "string") return fromClass;

  if (isMissingIndex(errorMessage, hints)) return "MissingIndexError";

  const code = hints?.errorCode?.toLowerCase();
  if (code) {
    if (code === "unauthenticated" || code === "permission-denied") return "AuthError";
    if (code === "invalid-argument" || code === "failed-precondition") return "ValidationError";
    if (code === "not-found") return "NotFoundError";
    if (code === "resource-exhausted") return "QuotaError";
    if (code === "deadline-exceeded") return "TimeoutError";
    if (code === "unavailable") return "UnavailableError";
  }

  const status = hints?.httpStatus;
  if (typeof status === "number") {
    if (status === 401 || status === 403) return "AuthError";
    if (status === 404) return "NotFoundError";
    if (status === 408 || status === 504) return "TimeoutError";
    if (status === 429) return "QuotaError";
    if (status >= 400 && status < 500) return "ValidationError";
    if (status >= 500) return "UnavailableError";
  }

  const lower = errorMessage.toLowerCase();
  // Cloud Run's own failures. The platform writes them, not a handler, so they carry no class or code, and each names
  // its own remedy. Checked before the generic keywords, whose looser matches ("limit", a docs URL) they could trip.
  //   "Memory limit of 256 MiB exceeded with 270 MiB used. Consider increasing the memory limit, see https://…"
  if (lower.includes("memory limit of") && lower.includes("exceeded")) return "OutOfMemoryError";
  //   "The request was aborted because there was no available instance."
  if (lower.includes("no available instance")) return "NoInstanceAvailableError";
  if (
    lower.includes("unauthenticated") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("permission")
  ) {
    return "AuthError";
  }
  if (lower.includes("invalid-argument") || lower.includes("validation")) return "ValidationError";
  if (lower.includes("firestore") || lower.includes("database")) return "DatabaseError";
  if (lower.includes("timeout") || lower.includes("deadline")) return "TimeoutError";
  if (lower.includes("not-found") || lower.includes("404")) return "NotFoundError";
  if (lower.includes("quota") || lower.includes("rate limit")) return "QuotaError";
  return "UnknownError";
}

const ERROR_CODE_RE =
  /\b(invalid-argument|permission-denied|unauthenticated|not-found|already-exists|resource-exhausted|failed-precondition|aborted|out-of-range|unimplemented|internal|unavailable|data-loss|cancelled|unknown|deadline-exceeded)\b/i;

/** Last-resort code extraction for logs carrying no structured field. */
export function extractErrorCode(errorMessage: string): string | undefined {
  const match = errorMessage.match(ERROR_CODE_RE);
  return match?.[1]?.toLowerCase();
}

/**
 * Attribute a function to a service via configured substring patterns.
 *
 * Returns null when nothing matches. Callers bucket null as "platform" — they do
 * NOT fall back to the first configured service. That fallback is a real bug we
 * are deliberately not reproducing: a stale pattern table with a default return
 * silently blamed one service for every unattributable error in the system, and
 * the mislabelling survived in dashboards and alerts for weeks.
 */
export function detectService(
  functionName: string,
  patterns: Record<string, string>
): string | null {
  const lower = functionName.toLowerCase();
  for (const [pattern, service] of Object.entries(patterns)) {
    if (lower.includes(pattern)) return service;
  }
  return null;
}
