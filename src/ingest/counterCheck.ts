/**
 * The counter-check, and the recent samples that go with it.
 *
 * Before anything acts on an incident, re-count its errors straight from Cloud
 * Logging over a fixed window. The aggregated `occurrenceCount` is the store's
 * opinion; this is the raw log's. When the two disagree, the incident is far
 * more likely to be monitoring noise than a live fault — which is exactly the
 * signal triage needs to decline.
 *
 * The samples are what turn an incident from a one-line message into something
 * a fixer can work from: the stack, the underlying cause, and the structured
 * fields that say where it failed. Everything in them is redacted and bounded
 * before it can reach the model. Only entries that hash to the incident's own
 * fingerprint are samples, and they are untrusted text like the rest (#304).
 */
import type { LogCounterCheck } from "../types.js";
import { fingerprintsOfLogEntry } from "./fingerprint.js";
import { splitMessageStack } from "./messageStack.js";
import { buildLogFilter, extractErrorDetail, extractMessageTitle, parseLogEntry, type LogSource, type RawLogEntry } from "./parseLogEntry.js";
import { isSensitiveKey, redactPii, sliceWellFormed } from "./redact.js";

export const COUNTER_CHECK_WINDOW_HOURS = 24;
/**
 * Stop counting here so one very noisy function can't page the check into a
 * timeout. Past this, "a lot" is all anyone needs to know.
 */
export const COUNTER_CHECK_MAX = 1000;
const PAGE_SIZE = 500;
/** The charset of GCP function / Cloud Run service names. */
const FUNCTION_NAME_RE = /^[A-Za-z0-9_-]+$/;
const MS_PER_HOUR = 60 * 60 * 1000;

const SAMPLE_COUNT = 3;
/**
 * How many of the function's newest error entries are read to find `SAMPLE_COUNT` of the incident's own (#304).
 * One page: other errors of the same function sit in between, and a burst of them ends with fewer samples.
 */
export const SAMPLE_SCAN_MAX = 50;
const MAX_CONTEXT_KEYS = 12;
const MAX_CONTEXT_VALUE = 200;
const SAMPLE_MESSAGE_MAX = 500;
const SAMPLE_STACK_MAX = 1500;
/**
 * Larger than a context value because this is usually where the actionable
 * cause lives, and it can be long: a FAILED_PRECONDITION "the query requires an
 * index" line ends in a ~150-char create-index URL — the one part a fixer needs.
 */
const SAMPLE_ERROR_MAX = 1000;

/** Already surfaced as message / error / stack, so not repeated in context. */
const SAMPLE_SKIP_KEYS = new Set(["message", "error", "stack", "stackTrace"]);
/**
 * The slice of the Cloud Logging client used here, declared locally so tests can
 * inject a fake. `getEntries` resolves `[entries, nextPageRequest | null, …]`.
 */
export interface EntryReader {
  getEntries(request: object): Promise<[unknown[], object | null, ...unknown[]]>;
}

export interface CheckOptions {
  windowHours?: number;
  nowMs?: number;
}

/**
 * Count `functionName`'s error entries over the window. Never throws: a Logging
 * failure returns null, and the incident proceeds without a counter-check rather
 * than being lost — triage is told the check is missing, not that it read zero.
 */
export async function runLogCounterCheck(
  logging: EntryReader,
  source: LogSource,
  functionName: string,
  opts: CheckOptions = {}
): Promise<LogCounterCheck | null> {
  const windowHours = opts.windowHours ?? COUNTER_CHECK_WINDOW_HOURS;
  const nowMs = opts.nowMs ?? Date.now();

  // The filter only accepts the charset GCP resource labels allow. A name the
  // sanitizer would have to rewrite can't be a real function, and counting the
  // rewritten one would report a confident count for the wrong thing — missing
  // must stay missing, never become a number.
  if (typeof functionName !== "string" || !FUNCTION_NAME_RE.test(functionName)) return null;

  try {
    const filter = buildLogFilter(source, new Date(nowMs - windowHours * MS_PER_HOUR), functionName);
    let count = 0;
    let capped = false;
    let request: object | null = { filter, pageSize: PAGE_SIZE, orderBy: "timestamp desc", autoPaginate: false };
    while (request) {
      const [entries, next]: [unknown[], object | null, ...unknown[]] = await logging.getEntries(request);
      count += entries.length;
      if (count >= COUNTER_CHECK_MAX) {
        count = COUNTER_CHECK_MAX;
        capped = true;
        break;
      }
      // Re-assert autoPaginate on every page. @google-cloud/logging deletes it
      // from the request it hands to gax, so the next-page request it returns
      // no longer carries it — and gax's default is autoPaginate: TRUE. Passing
      // `next` back as-is makes the second call read every remaining page of the
      // window before the cap above ever runs: an unbounded read during exactly
      // the burst the cap exists for.
      request = next ? { ...next, autoPaginate: false } : null;
    }
    return {
      window: `${windowHours}h`,
      count,
      ...(capped && { capped }),
      filter,
      checkedAt: new Date(nowMs).toISOString(),
    };
  } catch {
    return null;
  }
}

/** One recent error entry, reduced to what a fixer needs. Every string is redacted. */
export interface ErrorLogSample {
  timestamp: string;
  message: string;
  /** The underlying cause, when it says something the message doesn't. */
  error?: string;
  stack?: string;
  /** Scalar payload fields plus the execution id, values truncated. */
  context: Record<string, string>;
}

function clip(text: string, max: number): string {
  return sliceWellFormed(redactPii(text), max);
}

export function toSample(entry: unknown): ErrorLogSample | null {
  const e = entry as {
    metadata?: { timestamp?: unknown; labels?: Record<string, string> };
    data?: unknown;
  };
  const data = e?.data;
  const context: Record<string, string> = {};
  let message = "";
  let error: string | undefined;
  let stack: string | undefined;

  // Seeded first so it always survives the MAX_CONTEXT_KEYS cap: it is the key
  // that lets a human find this exact request in the console.
  const executionId = e?.metadata?.labels?.execution_id;
  if (executionId) context.execution_id = executionId;

  if (typeof data === "string") {
    message = data;
  } else if (data && typeof data === "object") {
    const json = data as Record<string, unknown>;
    if (typeof json.type_url === "string" && json.type_url.includes("AuditLog")) return null;
    const detail = extractErrorDetail(json.error);
    message = json.message ? extractMessageTitle(json.message) : detail || "";
    if (detail && detail !== message) error = clip(detail, SAMPLE_ERROR_MAX);
    const rawStack = json.stack ?? json.stackTrace;
    if (typeof rawStack === "string") stack = rawStack;
    for (const [k, v] of Object.entries(json)) {
      if (Object.keys(context).length >= MAX_CONTEXT_KEYS) break;
      if (SAMPLE_SKIP_KEYS.has(k) || isSensitiveKey(k)) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        context[k] = clip(String(v), MAX_CONTEXT_VALUE);
      }
    }
  }
  // As ingest reads it (#361): a message that carries its own stack is its title, the frames its stack unless the
  // entry had one. The message is clipped short, so frames kept in it would crowd out the stack the fixer needs.
  const split = splitMessageStack(message);
  if (split.stack !== undefined) {
    message = split.title;
    stack ??= split.stack;
  }
  if (!message && !stack) return null;

  const ts = e?.metadata?.timestamp;
  return {
    timestamp: ts instanceof Date ? ts.toISOString() : String(ts ?? "unknown"),
    message: clip(message, SAMPLE_MESSAGE_MAX),
    ...(error && { error }),
    ...(stack && { stack: clip(stack, SAMPLE_STACK_MAX) }),
    context,
  };
}

/**
 * The few most recent error entries that are THIS incident: of `functionName`, whose fingerprint, recomputed the
 * way ingest computes it (`fingerprintOfLogEntry` over `parseLogEntry`), equals the incident's `fingerprint` (or did, by an earlier version of the fingerprint).
 *
 * Why the fingerprint and not just the function (#304): anyone who can make the function log an error (a crafted
 * request) controlled the newest entries, so the samples, and through their fake stack frames which repository
 * files the fixer was shown. Now an entry must hash to the incident to be a sample, and the samples never choose
 * files (assemble.ts reads only the incident's own stack). One bounded page is read (`SAMPLE_SCAN_MAX`, newest
 * first, no auto-paging), so a burst of other errors in the function leaves fewer samples, never an unbounded read.
 *
 * A Monitoring-only incident (`mon-…`) has no log message to match, so it gets none. Never throws: a Logging
 * failure, or a function name no filter could hold, is null (missing), and no match is [] (#304).
 */
export async function fetchRecentErrorSamples(
  logging: EntryReader,
  source: LogSource,
  functionName: string,
  fingerprint: string,
  opts: CheckOptions = {}
): Promise<ErrorLogSample[] | null> {
  // Same rule as the counter-check: buildLogFilter would strip a bad character
  // and query a different function ("my.fn" becomes "myfn"), handing the fixer
  // another function's stack traces as if they were this incident's.
  if (typeof functionName !== "string" || !FUNCTION_NAME_RE.test(functionName)) return null;
  if (typeof fingerprint !== "string" || fingerprint === "") return null;

  const windowHours = opts.windowHours ?? COUNTER_CHECK_WINDOW_HOURS;
  const since = new Date((opts.nowMs ?? Date.now()) - windowHours * MS_PER_HOUR);
  try {
    const [entries] = await logging.getEntries({
      filter: buildLogFilter(source, since, functionName),
      pageSize: SAMPLE_SCAN_MAX,
      orderBy: "timestamp desc",
      autoPaginate: false,
    });
    const samples: ErrorLogSample[] = [];
    // `slice`: the reader is asked for one page, but nothing here trusts it to have honoured the size.
    for (const entry of entries.slice(0, SAMPLE_SCAN_MAX)) {
      if (samples.length >= SAMPLE_COUNT) break;
      if (!isEntryOf(entry, source, fingerprint)) continue;
      const sample = toSample(entry);
      if (sample) samples.push(sample);
    }
    return samples;
  } catch {
    return null;
  }
}

/**
 * Whether ingest would have filed `entry` under `fingerprint`: parsed (noise dropped) and hashed as aggregate.ts does,
 * by the current fingerprint version or an earlier one (#432): an incident stored before a fingerprint change keeps
 * its old fingerprint until ingest's next occurrence of it re-points it, and its samples must not go empty meanwhile.
 */
function isEntryOf(entry: unknown, source: LogSource, fingerprint: string): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const parsed = parseLogEntry(entry as RawLogEntry, source.ignoredMessages, source.excludedServices ?? []);
  return parsed !== null && fingerprintsOfLogEntry(parsed.functionName, parsed.errorMessage, parsed.stackTrace).includes(fingerprint);
}
