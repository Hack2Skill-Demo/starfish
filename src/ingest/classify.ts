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
};

export interface ClassificationHints {
  /** Coarse class the handler decided at the source. */
  sourceErrorClass?: string;
  /** Structured string code, e.g. "permission-denied". */
  errorCode?: string;
  /** Numeric transport status, e.g. a provider 401. */
  httpStatus?: number;
}

/**
 * Preference order, most trustworthy first:
 *   1. source-asserted class
 *   2. structured error code
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
