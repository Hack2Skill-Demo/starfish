import { createHash } from "node:crypto";

/** How much of the normalized message the fingerprint hashes. */
const FINGERPRINT_MESSAGE_CHARS = 100;
/**
 * Raw characters considered by {@link normalizeErrorMessage}. Bounds the regex work
 * on a pathological multi-KB message; the fingerprint only ever uses the first
 * {@link FINGERPRINT_MESSAGE_CHARS} of the (shorter) normalized text.
 */
const NORMALIZE_INPUT_CAP = 1000;

/** A URL with a scheme (`https://...`, `gs://bucket/...`). */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/g;
const EMAIL_TOKEN_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g;
/**
 * A path with at least TWO slashes (`uploads/tenant/docs/x.pdf`, `/tmp/a/b`, a
 * Firestore resource name). One slash is deliberately left alone: `and/or`,
 * `read/write` and `application/json` are prose, not per-occurrence data; a
 * one-slash `collection/docId` still gets its id replaced below.
 */
const PATH_RE = /[^\s"'<>/,;]*\/(?:[^\s"'<>/,;]+\/)+[^\s"'<>/,;]*[^\s"'<>/,;.:)]/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const ISO_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?(?![a-z0-9])/g;
const CLOCK_TIME_RE = /(?<![a-z0-9:])\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?![a-z0-9:])/g;
const HEX_LITERAL_RE = /(?<![a-z0-9])0x[0-9a-f]+(?![a-z0-9])/g;
/**
 * An opaque id: 8+ alphanumerics holding BOTH a letter and a digit (hex ids,
 * Firestore auto-ids, run ids). Requiring both keeps plain words and plain numbers
 * out of it; the 8-char floor keeps short identifiers (`base64`, `utf8`, `http2`).
 */
const OPAQUE_ID_RE = /(?<![a-z0-9])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}(?![a-z0-9])/g;
/** A version suffix: `v1`, `v2.3.4`. */
const VERSION_RE = /(?<![a-z0-9])v\d+(?:\.\d+)*(?![a-z0-9])/g;
/**
 * A bare number (optionally dotted, optionally with a unit: `30000ms`, `4.5mb`).
 * NOT replaced when it directly follows a status/code cue (`status 401`,
 * `status code: 503`, `http 500`, `errno 28`, `exit code 1`): those numbers ARE
 * the failure, and collapsing them would merge a 401 with a 500.
 */
const NUMBER_RE =
  /(?<![a-z0-9_<])(?<!\b(?:status|code|http|errno|exit)(?: code)?[\s:=#]*)\d+(?:\.\d+)*(?:ms|kb|mb|gb|s|m|h|b|%)?(?![a-z0-9_])/g;

/**
 * Collapse the per-occurrence parts of an error message into stable placeholders,
 * so every variant of ONE bug hashes to the same fingerprint. Without it, one
 * failing function opens an incident per document id, run id and version its
 * message happens to mention.
 *
 * Replaced, in this order: URLs, e-mail addresses, multi-segment paths (all but the
 * root segment), UUIDs, ISO timestamps and clock times, hex literals, opaque ids
 * (letters + digits), `vN` version suffixes, and bare numbers (except right after a
 * status/code cue). Everything else (the words of the message, error class names, a
 * quoted property name like `reading 'lrn'`) is kept, so two DISTINCT errors still
 * hash apart. Quoted values are deliberately NOT blanket-collapsed for that reason:
 * `Cannot read properties of undefined (reading 'lrn')` and `(reading 'name')` are
 * different bugs. The cost is that a variant whose only volatile part is a quoted
 * plain word still forks, which is the safe direction (an extra incident, never a
 * hidden bug).
 *
 * Pure, deterministic and idempotent (`f(f(x)) === f(x)`: the placeholders hold no
 * digits, slashes or `@`, so a second pass changes nothing). The input is lowercased
 * and whitespace-collapsed, and coerced from non-strings so a malformed stored row
 * can't crash a batch.
 *
 * Changing what is hashed changes the fingerprint of every message that held a
 * volatile token (or irregular whitespace), so an incident stored under the old
 * fingerprint is not matched by its next occurrence: that opens one fresh incident.
 * There is no migration.
 */
export function normalizeErrorMessage(errorMessage: string): string {
  return String(errorMessage ?? "")
    .substring(0, NORMALIZE_INPUT_CAP)
    .toLowerCase()
    .replace(URL_RE, "<url>")
    .replace(EMAIL_TOKEN_RE, "<email>")
    // Keep the ROOT segment (`uploads/`, `orders/`): it names what failed, so
    // `orders/a/items/b` and `users/a/items/b` stay distinct errors, while
    // the per-occurrence remainder (ids, file names) collapses.
    .replace(PATH_RE, (path) => `${path.slice(0, path.indexOf("/"))}/<path>`)
    .replace(UUID_RE, "<id>")
    .replace(ISO_TIMESTAMP_RE, "<ts>")
    .replace(CLOCK_TIME_RE, "<ts>")
    .replace(HEX_LITERAL_RE, "<id>")
    .replace(OPAQUE_ID_RE, "<id>")
    .replace(VERSION_RE, "v<n>")
    .replace(NUMBER_RE, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The one canonical spelling of a function name used for fingerprinting: lowercase,
 * with `_` mapped to `-`. A first-generation function is labelled by its deployed id
 * (`syncOrders`), while a second-generation one carries the Cloud Run service name,
 * which GCP lowercases and in which it maps `_` to `-` (`sync-orders`). Hashing the
 * raw name would give one function two fingerprints depending on which spelling a
 * log entry carried.
 *
 * Only the fingerprint uses this. The stored `functionName` keeps whichever spelling
 * created the incident, for display.
 */
export function canonicalFunctionName(functionName: string): string {
  return String(functionName ?? "")
    .toLowerCase()
    .replace(/_/g, "-");
}

/**
 * Stable dedup key for an error.
 *
 * Derived from the canonical function name plus the first 100 characters of the
 * NORMALIZED message (see {@link normalizeErrorMessage}), so the same recurring
 * failure hashes identically across runs whatever per-occurrence ids, paths,
 * timestamps or counts its message embeds. Normalization runs BEFORE the 100-char
 * cut: a volatile token's length varies, so cutting the raw text first would put the
 * boundary in a different place for each variant.
 *
 * Inputs are coerced because this also runs against documents read back out of
 * Firestore, where a legacy or malformed row must not crash a whole batch.
 */
export function computeErrorFingerprint(functionName: string, errorMessage: string): string {
  const normalizedFn = canonicalFunctionName(functionName);
  const normalizedMessage = normalizeErrorMessage(errorMessage).substring(0, FINGERPRINT_MESSAGE_CHARS);
  return createHash("sha256")
    .update(`${normalizedFn}:${normalizedMessage}`)
    .digest("hex")
    .substring(0, 16);
}
