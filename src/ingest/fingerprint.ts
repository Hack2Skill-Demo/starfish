import { createHash } from "node:crypto";
import { messageTitle } from "./messageStack.js";
import { sanitize } from "./redact.js";

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
 * fingerprint is not matched by its next occurrence: that would open one fresh incident.
 * After any such change, run `pnpm rekey` (src/rekey.ts, #362): it recomputes every live
 * incident's stored fingerprint with the current code and points its incident key at it.
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

/** At most this many wrappers are taken off one message (`Unhandled error Error: fn failed: ...` is three). */
const MAX_ERROR_WRAPPERS = 8;
/** Firebase's `Unhandled error` log line, which prints the thrown error after it (`Unhandled error Error: ...`). */
const UNHANDLED_ERROR_WRAPPER_RE = /^\s*unhandled error:?\s+/i;
/**
 * A JavaScript error's name as `String(err)` and a stack's first line print it: `Error: `, `TypeError: `,
 * `FirebaseError: `. Case-sensitive on purpose: a class name, not the word "error" in prose (`Request error: ...`
 * and `Errors: ...` are left alone).
 */
const ERROR_NAME_WRAPPER_RE = /^\s*(?:[A-Z][A-Za-z0-9_$]*)?Error:\s+/;
/** `<token> failed: `, stripped only when the token IS the function's own name (checked by the caller). */
const FUNCTION_FAILED_WRAPPER_RE = /^\s*([A-Za-z0-9_.-]+) failed:\s+/i;

/**
 * The error's core text: `errorMessage` with the known WRAPPER prefixes taken off its start (#318). One failure
 * is often logged twice in two shapes, e.g. Firebase's
 *   `Unhandled error Error: Value for argument "data" is not a valid Firestore document. ...`
 * and the handler's own rethrow
 *   `Error: orders-createOrder failed: Value for argument "data" is not a valid Firestore document. ...`
 * The wrappers are the volatile part; hashing them gave one bug two fingerprints, two incidents, two cycles and two
 * competing PRs. Stripped, both read `Value for argument "data" ...`, which is also what an unwrapped log of the same
 * error reads.
 *
 * The wrappers, only at the START of the message, repeatedly (at most {@link MAX_ERROR_WRAPPERS}):
 *   - `Unhandled error ` (also `Unhandled error: `), any case;
 *   - an error name and a colon: `Error: `, `TypeError: `, `FirebaseError: ` (a capitalised identifier ending
 *     in `Error`, then whitespace);
 *   - `<function> failed: `, only when `<function>` is this incident's own function under its canonical spelling
 *     (`orders-createOrder` for `orders-createorder`). Any other `x failed: ` (`Upload failed: timeout`,
 *     `order 1001 failed: ...`, another function's name) is ordinary text and is kept, so two distinct failures
 *     never merge.
 * A wrapper is never taken when nothing but whitespace would remain (`Error: ` alone keeps its text).
 *
 * Before any wrapper is looked for, a stack trace the message carries is cut off (#361, `messageTitle` in
 * messageStack.ts): only the text before its first V8 frame line (`    at fn (file:1:2)`) counts. Kept, the frames
 * entered the hashed 100 characters whenever the core was short, so one bug logged with the app's frames and again
 * with the logger's (`at entryFromArgs (.../firebase-functions/lib/logger/index.js:133:19)`) was two incidents.
 * Ingest now stores the title alone (parseLogEntry.ts); this keeps a record stored before that hashing the same way.
 *
 * A message with no wrapper and no frame comes back unchanged, so its fingerprint is byte-identical to before #318.
 * The title is then cut to the same {@link NORMALIZE_INPUT_CAP} {@link normalizeErrorMessage} reads, which bounds
 * the work. Only the fingerprint uses this: the stored message keeps the text as logged, for display.
 */
export function errorCore(errorMessage: string, functionName: string): string {
  let text = messageTitle(String(errorMessage ?? "")).substring(0, NORMALIZE_INPUT_CAP);
  const fn = canonicalFunctionName(functionName);
  for (let i = 0; i < MAX_ERROR_WRAPPERS; i += 1) {
    const prefix = wrapperPrefix(text, fn);
    if (prefix === undefined || text.slice(prefix).trim() === "") break;
    text = text.slice(prefix);
  }
  return text;
}

/** The length of the one wrapper `text` starts with, or undefined when it starts with none. */
function wrapperPrefix(text: string, canonicalFn: string): number | undefined {
  const plain = UNHANDLED_ERROR_WRAPPER_RE.exec(text) ?? ERROR_NAME_WRAPPER_RE.exec(text);
  if (plain) return plain[0].length;
  const failed = FUNCTION_FAILED_WRAPPER_RE.exec(text);
  return failed && canonicalFn !== "" && canonicalFunctionName(failed[1]!) === canonicalFn ? failed[0].length : undefined;
}

/** sha256 of the canonical function name and the first 100 characters of the normalized text, 16 hex characters. */
function hashNormalized(functionName: string, text: string): string {
  const normalizedFn = canonicalFunctionName(functionName);
  const normalizedMessage = normalizeErrorMessage(text).substring(0, FINGERPRINT_MESSAGE_CHARS);
  return createHash("sha256")
    .update(`${normalizedFn}:${normalizedMessage}`)
    .digest("hex")
    .substring(0, 16);
}

/**
 * Stable dedup key for a log error.
 *
 * Derived from the canonical function name plus the first 100 characters of the
 * NORMALIZED core of the message (see {@link errorCore} and {@link normalizeErrorMessage}),
 * so the same recurring failure hashes identically across runs whatever per-occurrence ids,
 * paths, timestamps or counts its message embeds, and whichever wrapper (`Unhandled error`,
 * `Error: `, `<function> failed: `) it was logged under. Normalization runs BEFORE the 100-char
 * cut: a volatile token's length varies, so cutting the raw text first would put the
 * boundary in a different place for each variant.
 *
 * Inputs are coerced because this also runs against documents read back out of
 * Firestore, where a legacy or malformed row must not crash a whole batch.
 */
export function computeErrorFingerprint(functionName: string, errorMessage: string): string {
  return hashNormalized(functionName, errorCore(errorMessage, functionName));
}

/**
 * The fingerprint ingest gives one parsed log entry: of its SANITIZED message, the one the store keeps and
 * fingerprints (redaction is idempotent, so the store's re-redaction changes nothing the hash reads). Shared by
 * the ingest's grouping (aggregate.ts) and the sample filter (counterCheck.ts, #304), so a log entry is judged to
 * belong to an incident exactly the way ingest decided it did.
 */
export function fingerprintOfLogEntry(functionName: string, rawErrorMessage: string): string {
  return computeErrorFingerprint(functionName, sanitize(rawErrorMessage) ?? "");
}

/**
 * Prefix of every Monitoring-only incident's fingerprint (#19). A log fingerprint is 16 hex
 * characters, so no log-derived incident can ever share a fingerprint, or an incident key, with a
 * Monitoring-only one: the two signals never merge in the store.
 */
export const MONITORING_FINGERPRINT_PREFIX = "mon-";

/**
 * Prefix of every high-cardinality overflow incident's fingerprint (#303). Like the Monitoring prefix, it keeps
 * the overflow namespace apart from the 16-hex log fingerprints, so an overflow incident never merges with a log
 * incident, or with a Monitoring-only one.
 */
export const OVERFLOW_FINGERPRINT_PREFIX = "ovf-";

/**
 * Prefix of every consolidated Cloud Run quota incident's fingerprint (ingest/platformQuota.ts). Its function name is
 * synthetic, so the namespace keeps it from ever sharing a fingerprint with a deployed function's log incident.
 */
export const PLATFORM_QUOTA_FINGERPRINT_PREFIX = "pq-";

/**
 * Where an incident came from. Absent on a stored record means Cloud Logging (every record before #19).
 * `overflow` (#303): a function's log errors past the per-window cap on new incidents, folded into one record.
 * `platform-quota`: Cloud Run's project quota rejections across every function, one record per quota metric.
 */
export type SignalSource = "log" | "monitoring" | "overflow" | "platform-quota";

/**
 * An overflow incident's fingerprint: its canonical function name and its message hashed WITHOUT normalization.
 * The message is fixed text naming the UTC day (aggregate.ts `overflowMessage`), and normalization would collapse
 * the date to `<ts>`, merging every day's overflow into one incident.
 */
function overflowFingerprint(functionName: string, errorMessage: string): string {
  const digest = createHash("sha256")
    .update(`${canonicalFunctionName(functionName)}\n${String(errorMessage ?? "")}`)
    .digest("hex")
    .substring(0, 16);
  return `${OVERFLOW_FINGERPRINT_PREFIX}${digest}`;
}

/**
 * The fingerprint a record holds, recomputed from its content: the one place that knows a
 * Monitoring-only record, a high-cardinality overflow one, or a consolidated quota one, hashes into its own
 * namespace. The store, retire and scrub all recompute through this, so none of them can confuse them.
 */
export function fingerprintOf(functionName: string, errorMessage: string, signalSource?: unknown): string {
  if (signalSource === "overflow") return overflowFingerprint(functionName, errorMessage);
  // The namespaced records hash their fixed message as it always was: no wrapper is ever stripped from it (#318),
  // so no Monitoring-only or quota incident's fingerprint moves.
  if (signalSource === "monitoring") return `${MONITORING_FINGERPRINT_PREFIX}${hashNormalized(functionName, errorMessage)}`;
  if (signalSource === "platform-quota") return `${PLATFORM_QUOTA_FINGERPRINT_PREFIX}${hashNormalized(functionName, errorMessage)}`;
  return computeErrorFingerprint(functionName, errorMessage);
}
