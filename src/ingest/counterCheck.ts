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
 * before it can reach the model.
 */
import type { LogCounterCheck } from "../types.js";
import { buildLogFilter, extractErrorDetail, type LogSource } from "./parseLogEntry.js";
import { redactPii } from "./redact.js";

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
 * Keys that plausibly hold credentials — never handed to the model. Deliberately
 * broad: dropping a harmless field costs a little context, leaking one costs a
 * credential. `key$` catches accessKey/privateKey/signingKey without matching
 * every field that merely contains "key".
 */
const SENSITIVE_KEY_RE =
  /token|secret|passw|auth|api[-_]?key|key$|cookie|credential|jwt|bearer|signature|session/i;

/**
 * Credential-shaped VALUES, whatever key they sit under: a JWT, a bearer header,
 * a Google API key. Key names are a convention; these shapes are not.
 */
const SECRET_VALUE_RE = /\beyJ[\w-]{8,}\.[\w-]+\.[\w-]*|\bBearer\s+[\w.~+/-]+=*|\bAIza[\w-]{30,}/g;

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
  return redactPii(text).replace(SECRET_VALUE_RE, "[redacted-secret]").slice(0, max);
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
    message = String(json.message || detail || "");
    if (detail && detail !== message) error = clip(detail, SAMPLE_ERROR_MAX);
    const rawStack = json.stack ?? json.stackTrace;
    if (typeof rawStack === "string") stack = rawStack;
    for (const [k, v] of Object.entries(json)) {
      if (Object.keys(context).length >= MAX_CONTEXT_KEYS) break;
      if (SAMPLE_SKIP_KEYS.has(k) || SENSITIVE_KEY_RE.test(k)) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        context[k] = clip(String(v), MAX_CONTEXT_VALUE);
      }
    }
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
 * The few most recent error entries for `functionName`. Never throws — a
 * Logging failure returns [] and the incident goes forward without samples.
 */
export async function fetchRecentErrorSamples(
  logging: EntryReader,
  source: LogSource,
  functionName: string,
  opts: CheckOptions = {}
): Promise<ErrorLogSample[]> {
  const windowHours = opts.windowHours ?? COUNTER_CHECK_WINDOW_HOURS;
  const since = new Date((opts.nowMs ?? Date.now()) - windowHours * MS_PER_HOUR);
  try {
    const [entries] = await logging.getEntries({
      filter: buildLogFilter(source, since, functionName),
      pageSize: SAMPLE_COUNT,
      orderBy: "timestamp desc",
      autoPaginate: false,
    });
    return entries
      .map(toSample)
      .filter((s): s is ErrorLogSample => s !== null)
      .slice(0, SAMPLE_COUNT);
  } catch {
    return [];
  }
}
