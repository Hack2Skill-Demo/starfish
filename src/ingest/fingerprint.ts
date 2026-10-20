import { createHash } from "node:crypto";
import { INCIDENT_KINDS, incidentKindOf, type IncidentKindId } from "../incidentKinds.js";
import { messageTitle, splitMessageStack } from "./messageStack.js";
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
 * volatile token (or irregular whitespace). Such a change is a new {@link FINGERPRINT_VERSION}, with the old way kept
 * in {@link FINGERPRINT_VERSIONS}: the store then finds an incident stored under the old fingerprint by itself (#432).
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
/** `<token> failed: `, stripped only when the token names the function itself ({@link namesFunction}, checked by the caller). */
const FUNCTION_FAILED_WRAPPER_RE = /^\s*([A-Za-z0-9_.-]+) failed:\s+/i;

/**
 * Which names a `<name> failed: ` wrapper may carry to be the function's own: `full` only its whole canonical name
 * (versions 2 to 4), `grouped` also what follows one of its `-` (version 5, #463).
 */
type OwnNames = "full" | "grouped";

/**
 * Whether `token` (canonical) names the function `canonicalFn`: its whole name, or, with `grouped`, what follows one of
 * its `-` (#463). A grouped Firebase export `reports.weeklyDigest` deploys as `reports-weeklyDigest`, while its own
 * code logs under the name it knows, `weeklyDigest failed: ...`; nested groups (`admin-reports-weeklyDigest`) may log
 * either tail. Only a whole tail counts: `digest`, the group `reports`, or another export of the group never do.
 * The canonical spelling maps `_` to `-`, so `send_mail` also takes `mail failed: `: a tail of the function's own name,
 * folding only two lines of the same function whose cores are the same text.
 */
function namesFunction(token: string, canonicalFn: string, ownNames: OwnNames): boolean {
  if (canonicalFn === "" || token === "") return false;
  if (token === canonicalFn) return true;
  return ownNames === "grouped" && canonicalFn.endsWith(`-${token}`);
}

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
 *     (`orders-createOrder` for `orders-createorder`), or the part of its name after a group separator, which is
 *     what a grouped export's own code calls it (`weeklyDigest` for `reports-weeklyDigest`, #463). Any other
 *     `x failed: ` (`Upload failed: timeout`, `order 1001 failed: ...`, another function's name, the group's own
 *     name) is ordinary text and is kept, so two distinct failures never merge.
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
  return coreOf(errorMessage, functionName, "grouped");
}

/** {@link errorCore}, with `<name> failed: ` taken off under the names `ownNames` allows. */
function coreOf(errorMessage: string, functionName: string, ownNames: OwnNames): string {
  return withoutWrappers(messageTitle(String(errorMessage ?? "")).substring(0, NORMALIZE_INPUT_CAP), functionName, ownNames);
}

/** `text` with the wrappers {@link errorCore} names taken off its start. */
function withoutWrappers(text: string, functionName: string, ownNames: OwnNames): string {
  const fn = canonicalFunctionName(functionName);
  for (let i = 0; i < MAX_ERROR_WRAPPERS; i += 1) {
    const prefix = wrapperPrefix(text, fn, ownNames);
    if (prefix === undefined || text.slice(prefix).trim() === "") break;
    text = text.slice(prefix);
  }
  return text;
}

/** The length of the one wrapper `text` starts with, or undefined when it starts with none. */
function wrapperPrefix(text: string, canonicalFn: string, ownNames: OwnNames): number | undefined {
  const plain = UNHANDLED_ERROR_WRAPPER_RE.exec(text) ?? ERROR_NAME_WRAPPER_RE.exec(text);
  if (plain) return plain[0].length;
  const failed = FUNCTION_FAILED_WRAPPER_RE.exec(text);
  return failed && namesFunction(canonicalFunctionName(failed[1]!), canonicalFn, ownNames) ? failed[0].length : undefined;
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
 * Every fingerprint one parsed log entry has had: the current one first, then those earlier versions gave it
 * ({@link earlierFingerprints}), each of the SANITIZED text as ingest stores it. The sample filter (counterCheck.ts)
 * matches an incident stored under an earlier version through these, so a fingerprint change never leaves its samples
 * empty until ingest re-points it.
 */
export function fingerprintsOfLogEntry(functionName: string, rawErrorMessage: string, rawStackTrace?: string): string[] {
  const source: FingerprintSource = {
    functionName,
    errorMessage: sanitize(rawErrorMessage) ?? "",
    ...(rawStackTrace !== undefined && { stackTrace: sanitize(rawStackTrace) }),
  };
  return [fingerprintOf(source.functionName, source.errorMessage), ...earlierFingerprints(source)];
}

/** Prefix of every Monitoring-only incident's fingerprint (#19): the `monitoring` kind's namespace (src/incidentKinds.ts). */
export const MONITORING_FINGERPRINT_PREFIX = INCIDENT_KINDS.monitoring.prefix;

/** Prefix of every high-cardinality overflow incident's fingerprint (#303): the `overflow` kind's namespace. */
export const OVERFLOW_FINGERPRINT_PREFIX = INCIDENT_KINDS.overflow.prefix;

/** Prefix of every consolidated Cloud Run quota incident's fingerprint (ingest/platformQuota.ts): the `platform-quota` kind's. */
export const PLATFORM_QUOTA_FINGERPRINT_PREFIX = INCIDENT_KINDS["platform-quota"].prefix;

/** Where an incident came from (src/incidentKinds.ts). Absent on a stored record means Cloud Logging (every record before #19). */
export type SignalSource = IncidentKindId;

/** sha256 of `text`, 16 hex characters. */
function digest16(text: string): string {
  return createHash("sha256").update(text).digest("hex").substring(0, 16);
}

/** The UTC day an overflow incident's fixed message names (aggregate.ts `overflowMessage`, every version of it). */
const OVERFLOW_DAY_RE = /\bon (\d{4}-\d{2}-\d{2}) \(UTC\)/;

/** The UTC day (`2026-10-18`) an overflow message names, or undefined when it names none. */
export function overflowDayOf(errorMessage: string): string | undefined {
  return OVERFLOW_DAY_RE.exec(String(errorMessage ?? ""))?.[1];
}

/**
 * A `function-day` fingerprint (the overflow kind, version 4): the canonical function name and the UTC day its message
 * names, so a change to the message's wording never moves it again. A message naming no day (nothing ingest writes)
 * falls back to the message itself, hashed unnormalized: normalization would collapse a date to `<ts>`, merging days.
 */
function functionDayFingerprint(prefix: string, functionName: string, errorMessage: string): string {
  const day = overflowDayOf(errorMessage);
  const fn = canonicalFunctionName(functionName);
  return `${prefix}${digest16(day !== undefined ? `${fn}\nday:${day}` : `${fn}\n${String(errorMessage ?? "")}`)}`;
}

/**
 * The fingerprint a record holds, recomputed from its content with the CURRENT version: the one place that knows how
 * each kind (src/incidentKinds.ts) hashes, and into which namespace. The store, retire, rekey and scrub all recompute
 * through this, so none of them can confuse the kinds.
 */
export function fingerprintOf(functionName: string, errorMessage: string, signalSource?: unknown): string {
  const kind = incidentKindOf({ signalSource });
  switch (kind.fold) {
    case "function-day":
      return functionDayFingerprint(kind.prefix, functionName, errorMessage);
    // The namespaced records hash their fixed message as it always was: no wrapper is ever stripped from it (#318),
    // so no Monitoring-only or quota incident's fingerprint moves.
    case "message":
      return `${kind.prefix}${hashNormalized(functionName, errorMessage)}`;
    case "error-core":
      return `${kind.prefix}${computeErrorFingerprint(functionName, errorMessage)}`;
  }
}

/** What a fingerprint version reads of an occurrence: the fields an ingest input (store.ts `IncidentInput`) carries. */
export interface FingerprintSource {
  functionName: string;
  /** The message as ingest stores it now (sanitized; a stack it carried cut off, #361). */
  errorMessage: string;
  /** The stack as ingest stores it now: the whole logged text when the message carried its own frames (#361). */
  stackTrace?: string;
  signalSource?: unknown;
}

/**
 * The messages ingest before #361 stored for an occurrence ingest now stores as `source`: the message as it is, and,
 * when the stack is the message's own (its title is the message: parseLogEntry.ts split it off), the whole text, which
 * is what it kept then. An entry with a stack field of its own may yield a wrong second guess; it only costs a read,
 * since the store adopts nothing that does not hash to the current fingerprint.
 */
function pre361Messages(source: FingerprintSource): string[] {
  const message = String(source.errorMessage ?? "");
  const stack = source.stackTrace;
  if (typeof stack !== "string") return [message];
  const split = splitMessageStack(stack);
  return split.stack !== undefined && split.title === message ? [message, stack] : [message];
}

/** Wrappers taken off as #318 did, before #361: on the text cut to {@link NORMALIZE_INPUT_CAP}, with no stack cut. */
function pre361Core(errorMessage: string, functionName: string): string {
  return withoutWrappers(errorMessage.substring(0, NORMALIZE_INPUT_CAP), functionName, "full");
}

/**
 * {@link fingerprintOf} as versions 3 and 4 computed it: `<name> failed: ` taken off under the function's whole name
 * only (before #463). Only a log error's fingerprint differs; every other kind's is the current one.
 */
function fingerprintBefore463(source: FingerprintSource): string {
  const kind = incidentKindOf({ signalSource: source.signalSource });
  if (kind.fold !== "error-core") return fingerprintOf(source.functionName, source.errorMessage, source.signalSource);
  return `${kind.prefix}${hashNormalized(source.functionName, coreOf(source.errorMessage, source.functionName, "full"))}`;
}

/** The overflow message before version 4 (#434): it keyed the fingerprint verbatim, so its exact text is kept here. */
function overflowMessageBeforeV4(day: string): string {
  return `High-cardinality overflow on ${day} (UTC): distinct errors of this function past the per-window cap on new incidents, each matching no stored incident, are counted here instead of opening one incident each`;
}

/** Up to version 3, an overflow incident hashed its message unnormalized, and the message said "per-window". */
function overflowBeforeV4(source: FingerprintSource): string[] {
  const day = overflowDayOf(source.errorMessage);
  if (day === undefined) return [];
  const text = `${canonicalFunctionName(source.functionName)}\n${overflowMessageBeforeV4(day)}`;
  return [`${INCIDENT_KINDS.overflow.prefix}${digest16(text)}`];
}

/** The `message` kinds never moved: every version hashed them as {@link fingerprintOf} does. */
const unchangedMessageKind = (source: FingerprintSource): string[] => [
  fingerprintOf(source.functionName, source.errorMessage, source.signalSource),
];

/**
 * The fingerprint's history (#432): for each version, the fingerprints ingest AT that version gave an occurrence that
 * ingest now stores as `source`. A fingerprint change adds a version here (and bumps {@link FINGERPRINT_VERSION}),
 * keeping the old way as a function, so the store can find the incidents the old fingerprint keyed and re-point them
 * (store.ts), instead of opening a fork of each on the deploy that changes it.
 *   1. #26 (2026-10-03): the normalized message, as stored then: with any stack it carried.
 *   2. #318 (2026-10-13): wrappers (`Unhandled error`, `Error: `, `<fn> failed: `) taken off first.
 *   3. #361 (2026-10-14): a stack the message carries cut off; ingest stores the title alone.
 *   4. #434: an overflow incident keyed by function and UTC day, not by its message's wording.
 *   5. #463: `<fn> failed: ` also taken off under a grouped export's own name (`weeklyDigest` for `reports-weeklyDigest`).
 */
const FINGERPRINT_VERSIONS: Readonly<Record<number, (source: FingerprintSource) => string[]>> = {
  1: (s) => {
    const kind = incidentKindOf({ signalSource: s.signalSource });
    if (kind.id === "overflow") return overflowBeforeV4(s);
    if (kind.fold !== "error-core") return unchangedMessageKind(s);
    return pre361Messages(s).map((m) => hashNormalized(s.functionName, m));
  },
  2: (s) => {
    const kind = incidentKindOf({ signalSource: s.signalSource });
    if (kind.id === "overflow") return overflowBeforeV4(s);
    if (kind.fold !== "error-core") return unchangedMessageKind(s);
    return pre361Messages(s).map((m) => hashNormalized(s.functionName, pre361Core(m, s.functionName)));
  },
  3: (s) => {
    const kind = incidentKindOf({ signalSource: s.signalSource });
    if (kind.id === "overflow") return overflowBeforeV4(s);
    return [fingerprintBefore463(s)];
  },
  4: (s) => [fingerprintBefore463(s)],
  5: (s) => [fingerprintOf(s.functionName, s.errorMessage, s.signalSource)],
};

/** The version {@link fingerprintOf} computes. */
export const FINGERPRINT_VERSION = 5;

/**
 * The fingerprints earlier versions gave the occurrence `source` that differ from the current one: newest version
 * first, each once. Empty for a kind whose fingerprint never moved. The store reads their keys on a miss (#432).
 */
export function earlierFingerprints(source: FingerprintSource): string[] {
  const current = fingerprintOf(source.functionName, source.errorMessage, source.signalSource);
  const seen = new Set<string>([current]);
  const out: string[] = [];
  for (let v = FINGERPRINT_VERSION - 1; v >= 1; v -= 1) {
    for (const fp of FINGERPRINT_VERSIONS[v]!(source)) {
      if (seen.has(fp)) continue;
      seen.add(fp);
      out.push(fp);
    }
  }
  return out;
}
