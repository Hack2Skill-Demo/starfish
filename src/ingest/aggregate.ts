/**
 * The ingestion job: Cloud Logging → grouped, classified, deduped incidents.
 *
 * Runs on a schedule. Groups a window of raw ERROR entries by fingerprint before
 * writing, so a failure that fired four hundred times becomes one incident with
 * a count of four hundred — not four hundred incidents.
 */
import { Logging } from "@google-cloud/logging";
import { Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { buildLogFilter, parseLogEntry, type RawLogEntry } from "./parseLogEntry.js";
import { detectErrorType, extractErrorCode, detectService } from "./classify.js";
import { canonicalFunctionName, computeErrorFingerprint } from "./fingerprint.js";
import { createRestMonitoringReader, readMonitoringFailures, type MonitoringObservation, type MonitoringReader } from "./monitoring.js";
import { sanitize } from "./redact.js";
import { upsertIncident, type IncidentInput, type UpsertOutcome } from "./store.js";
import { narrowWindow, type IngestWindow } from "./window.js";

const PAGE_SIZE = 500;
/**
 * Upper bound on entries read per window. `getEntries` auto-paginates by default,
 * so without this a sustained burst reads every entry in the window into memory
 * and runs the job into its timeout — during exactly the incident it exists to
 * catch. The read is oldest first, so a capped read has covered a prefix of the
 * window in full: it writes nothing and hands back that prefix to replay instead
 * (`narrowWindow`), and the rest is read by the windows after it (#127), unless an
 * earlier attempt already wrote under the window's id (`WindowWrites`, #199). Reading
 * the newest entries and completing the window anyway lost every older one.
 */
export const MAX_ENTRIES_PER_RUN = 5000;
/**
 * Upsert transactions in flight at once. Each grouped input has its own
 * fingerprint, so they never contend with each other; the bound keeps a burst
 * of distinct errors from opening hundreds of transactions together.
 */
const UPSERT_CONCURRENCY = 8;

export interface AggregationResult {
  entriesProcessed: number;
  incidentsCreated: number;
  incidentsUpdated: number;
  /** Resolved incidents re-opened as `recurred`: regressions. */
  incidentsRecurred: number;
  /** Incidents whose window had already been applied, so this run changed nothing for them. */
  incidentsReplayed: number;
  /**
   * Distinct errors (fingerprints) folded into a high-cardinality overflow incident (#303): past the per-function cap
   * on new incidents, matching no stored incident. Their occurrences are counted on the overflow incident.
   */
  errorsFoldedIntoOverflow: number;
  /**
   * True when the read stopped at MAX_ENTRIES_PER_RUN and the window could not be narrowed (more
   * entries than that in its first millisecond, or an earlier attempt already wrote under its id: see
   * `WindowWrites`): it was processed as read, and the rest of it is lost,
   * so occurrence counts are a floor.
   */
  capped: boolean;
  /**
   * Set when the read stopped at the cap and nothing was written: the part of the window the read
   * covered in full. The caller replays this narrower window in place of the one it asked for.
   */
  narrowedTo?: IngestWindow;
  /**
   * Set when `writes.beginWrites` said the window is no longer the pending one (another run narrowed
   * or completed it): nothing was written, and the caller must not complete it.
   */
  superseded?: true;
  /**
   * The Cloud Monitoring signal for this window (#19), absent when it is off. `unavailable` means the
   * read failed: the window's failures without an ERROR log are UNKNOWN, not zero.
   */
  monitoring?: MonitoringSummary;
}

export interface MonitoringSummary {
  /** Functions with failures that Monitoring reported. */
  observations: number;
  /** Log inputs annotated with a reading for their function. */
  annotated: number;
  /** Monitoring-only inputs: failures of a function that logged no ERROR in the window. */
  monitoringOnly: number;
  unavailable: boolean;
}

export interface AggregateDeps {
  /** The Monitoring reader. Default: the REST adapter, created only when the signal is on. */
  monitoring?: MonitoringReader;
  /** How the window's writes are coordinated with the run's state (run.ts). Absent: narrow freely, write at once. */
  writes?: WindowWrites;
}

/**
 * What the run that owns the pending window tells the aggregator about it (#199). Narrowing gives the
 * window a NEW id, and the store recognises a replay only by id: if an earlier attempt at this window
 * already committed upserts under its id, the narrowed window would apply those occurrences again under
 * its own. So a window may be narrowed only while nothing has been written under its id.
 */
export interface WindowWrites {
  /**
   * False when an earlier attempt at this window reached its writes: some of its upserts may have
   * committed. A capped read is then processed as read, under this window's own id, and flagged capped
   * (its counts are a floor), never narrowed.
   */
  mayNarrow: boolean;
  /**
   * Called once, before the first upsert, to record that writes under this window's id are beginning.
   * Resolves false when the window is no longer the pending one: nothing is written then.
   */
  beginWrites: () => Promise<boolean>;
}

/** The errorType of a Monitoring-only incident: there is no log to classify, only a count of failures. */
export const MONITORING_ONLY_ERROR_TYPE = "UnloggedFailure";

/**
 * Folds one window's Monitoring readings into its log inputs (#19). A reading for a function that
 * also LOGGED an error in this window annotates every log input of that function (`monitoring`); one
 * for a function with no log input in the window becomes a Monitoring-only input, fingerprinted in its
 * own namespace so it can never merge with a log incident. Returns the Monitoring-only inputs and how
 * many log inputs were annotated (it sets `monitoring` on those in place).
 *
 * Correlation is per window and per function (canonical spelling), not per incident: Monitoring
 * counts invocations, not error messages, so it cannot say which of a function's log incidents a
 * failure belongs to. A log incident from an EARLIER window is not annotated; this window's failures
 * without a log then open a Monitoring-only incident, which is the conservative direction (an extra
 * incident, never a hidden failure).
 */
export function correlateMonitoring(
  logInputs: IncidentInput[],
  observations: readonly MonitoringObservation[],
  config: Pick<StarfishConfig, "environment" | "servicePatterns">,
  windowId: string
): { monitoringOnly: IncidentInput[]; annotated: number } {
  const byFunction = new Map<string, IncidentInput[]>();
  for (const input of logInputs) {
    const key = canonicalFunctionName(input.functionName);
    byFunction.set(key, [...(byFunction.get(key) ?? []), input]);
  }
  const annotatedInputs = new Set<IncidentInput>();
  const monitoringOnly: IncidentInput[] = [];
  for (const obs of observations) {
    const logged = byFunction.get(canonicalFunctionName(obs.functionName));
    if (logged) {
      for (const input of logged) {
        input.monitoring = [...(input.monitoring ?? []), obs];
        annotatedInputs.add(input);
      }
      continue;
    }
    monitoringOnly.push({
      functionName: obs.functionName,
      service: detectService(obs.functionName, config.servicePatterns),
      environment: config.environment,
      errorType: MONITORING_ONLY_ERROR_TYPE,
      // Fixed text from the signal's definition, never data: it keys the fingerprint, so it must not vary.
      errorMessage: obs.description,
      occurrenceCount: obs.failureCount,
      firstOccurredAt: obs.firstAt,
      lastOccurredAt: obs.lastAt,
      sourceProjectId: obs.projectId,
      signalSource: "monitoring",
      monitoring: [obs],
      windowId,
    });
  }
  return { monitoringOnly, annotated: annotatedInputs.size };
}

/**
 * Read one window of the watched project's ERROR logs and fold it into the store. Every upsert
 * carries the window's id, so running the same window again (after a run that failed part-way)
 * counts each incident once; see the "Replays" note in store.ts.
 */
export async function aggregateErrors(
  db: Firestore,
  config: StarfishConfig,
  window: IngestWindow,
  deps: AggregateDeps = {}
): Promise<AggregationResult> {
  const result: AggregationResult = {
    entriesProcessed: 0,
    incidentsCreated: 0,
    incidentsUpdated: 0,
    incidentsRecurred: 0,
    incidentsReplayed: 0,
    errorsFoldedIntoOverflow: 0,
    capped: false,
  };

  // Scope to the configured project explicitly. Defaulting to ambient project
  // resolution is how a log reader ends up silently watching the wrong project
  // and reporting "no errors" forever while production burns.
  const logging = new Logging({ projectId: config.watchedProjectId });
  const [entries] = await logging.getEntries({
    filter: buildLogFilter(config, window.start, undefined, window.end),
    pageSize: PAGE_SIZE,
    maxResults: MAX_ENTRIES_PER_RUN,
    orderBy: "timestamp asc",
  });

  if (entries.length >= MAX_ENTRIES_PER_RUN) {
    const lastReadAt = latestTimestamp(entries as RawLogEntry[]);
    // Not when an earlier attempt may have written under this window's id (see WindowWrites): the
    // narrowed window would count those occurrences a second time under its own id.
    const narrowed = deps.writes?.mayNarrow !== false && lastReadAt && narrowWindow(window, lastReadAt);
    // Nothing is written: the narrowed window gets its own id, and the store must not see these
    // entries under this window's id and again under that one's.
    if (narrowed) return { ...result, narrowedTo: narrowed };
    result.capped = true;
  }

  result.entriesProcessed = entries.length;

  // Group by fingerprint before writing anything.
  const grouped = new Map<string, { input: IncidentInput }>();

  for (const entry of entries) {
    const parsed = parseLogEntry(entry as RawLogEntry, config.ignoredMessages, config.excludedServices);
    if (!parsed) continue;

    // Group on the SANITIZED message — the one the store fingerprints and keeps.
    // Grouping on the raw text split "No user for alice@x.com" and "No user for
    // bob@y.org" into two groups that both sanitize to one fingerprint; both
    // upserts then missed against the same uncommitted batch and one run created
    // two open documents for a single incident.
    const errorMessage = sanitize(parsed.errorMessage) ?? "";
    const fingerprint = computeErrorFingerprint(parsed.functionName, errorMessage);
    const found = grouped.get(fingerprint);

    if (found) {
      found.input.occurrenceCount += 1;
      if (parsed.timestamp < found.input.firstOccurredAt) {
        found.input.firstOccurredAt = parsed.timestamp;
      }
      if (parsed.timestamp > found.input.lastOccurredAt) {
        found.input.lastOccurredAt = parsed.timestamp;
      }
      continue;
    }

    grouped.set(fingerprint, {
      input: {
        functionName: parsed.functionName,
        // A service the handler named beats guessing from the function id.
        service: parsed.serviceTag ?? detectService(parsed.functionName, config.servicePatterns),
        environment: config.environment,
        errorType: detectErrorType(parsed.errorMessage, {
          sourceErrorClass: parsed.sourceErrorClass,
          errorCode: parsed.errorCode,
          httpStatus: parsed.httpStatus,
          errorDetail: parsed.errorDetail,
        }),
        errorMessage,
        occurrenceCount: 1,
        firstOccurredAt: parsed.timestamp,
        lastOccurredAt: parsed.timestamp,
        errorCode: parsed.errorCode ?? extractErrorCode(parsed.errorMessage),
        errorName: parsed.errorName,
        errorDetail: sanitize(parsed.errorDetail),
        httpStatus: parsed.httpStatus,
        stackTrace: sanitize(parsed.stackTrace),
        tenantId: parsed.tenantId,
        requestId: parsed.requestId,
        sourceProjectId: parsed.sourceProjectId,
        windowId: window.id,
      },
    });
  }

  // The Monitoring signal is read even when the logs were empty: a function that failed without an
  // ERROR log is exactly what it is for. Only for a window that is going to be written (a narrowed
  // read returned above), so its readings are folded in once, under this window's id.
  const queue = [...grouped.values()].map((g) => g.input);
  // Decided before Monitoring adds its inputs: the cap is on log errors (a Monitoring-only input is one per function).
  const accrueOnly = inputsPastNewIncidentCap(grouped, config.maxNewIncidentsPerFunctionPerWindow);
  if (config.monitoringEnabled) {
    const reader = deps.monitoring ?? createRestMonitoringReader();
    const observations = await readMonitoringFailures(reader, config, window);
    if (observations === null) {
      result.monitoring = { observations: 0, annotated: 0, monitoringOnly: 0, unavailable: true };
    } else {
      const { monitoringOnly, annotated } = correlateMonitoring(queue, observations, config, window.id);
      queue.push(...monitoringOnly);
      result.monitoring = { observations: observations.length, annotated, monitoringOnly: monitoringOnly.length, unavailable: false };
    }
  }
  if (queue.length === 0) return result;
  // Recorded before the first upsert, so a later attempt at this window knows it may not narrow it.
  if (deps.writes && !(await deps.writes.beginWrites())) {
    return {
      entriesProcessed: 0,
      incidentsCreated: 0,
      incidentsUpdated: 0,
      incidentsRecurred: 0,
      incidentsReplayed: 0,
      errorsFoldedIntoOverflow: 0,
      capped: false,
      superseded: true,
    };
  }

  const now = Timestamp.now();
  const total = queue.length;

  // One transaction per incident (see store.ts), a few at a time. Every upsert
  // is awaited before the run reports: a failure throws only after the rest
  // have settled, and the incidents that committed are accrued onto next run.
  const failures: unknown[] = [];
  // Errors past the cap that matched no stored incident, by canonical function: folded into its overflow incident.
  const absent = new Map<string, IncidentInput[]>();
  const count = (outcome: UpsertOutcome) => {
    if (outcome === "new") result.incidentsCreated += 1;
    else if (outcome === "recurred") result.incidentsRecurred += 1;
    else if (outcome === "duplicate") result.incidentsReplayed += 1;
    else result.incidentsUpdated += 1;
  };
  const worker = async () => {
    for (let input = queue.shift(); input; input = queue.shift()) {
      try {
        if (!accrueOnly.has(input)) {
          count(await upsertIncident(db, config, input, now));
          continue;
        }
        // Past the cap: accrue onto an incident that exists, never open one.
        const outcome = await upsertIncident(db, config, input, now, { createIfAbsent: false });
        if (outcome === "absent") {
          const key = canonicalFunctionName(input.functionName);
          absent.set(key, [...(absent.get(key) ?? []), input]);
        } else count(outcome);
      } catch (err) {
        failures.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPSERT_CONCURRENCY, queue.length) }, worker));
  // Not folded when an upsert failed: a fold of part of them would mark the window applied on the overflow
  // incident, and the replay of the window would then drop the rest. The replay folds them all (an absent one
  // wrote nothing, so it comes back absent again).
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} of ${total} incident upserts failed`);
  }

  for (const folded of absent.values()) {
    const outcome = await upsertIncident(db, config, buildOverflowInput(folded, config, window), now);
    count(outcome);
    // A replayed window folded these already: the overflow incident holds them, and they are not counted twice.
    if (outcome !== "duplicate") result.errorsFoldedIntoOverflow += folded.length;
  }

  return result;
}

/** The errorType of a high-cardinality overflow incident (#303): many distinct errors of one function, folded. */
export const OVERFLOW_ERROR_TYPE = "HighCardinalityOverflow";

/**
 * The inputs of a window past the per-function cap on new incidents (#303): for every function (canonical spelling)
 * with more than `cap` distinct errors in the window, all but its `cap` most frequent (ties by fingerprint, so the
 * choice depends only on the window's own entries and a replay makes the same one). Those are upserted accrue-only:
 * one that matches a stored incident still accrues onto it; one that does not is folded into the overflow incident.
 * The `cap` most frequent upsert as usual, so a function opens at most `cap` incidents per window from them.
 */
export function inputsPastNewIncidentCap(grouped: ReadonlyMap<string, { input: IncidentInput }>, cap: number): Set<IncidentInput> {
  const byFunction = new Map<string, { fingerprint: string; input: IncidentInput }[]>();
  for (const [fingerprint, { input }] of grouped) {
    const key = canonicalFunctionName(input.functionName);
    const list = byFunction.get(key);
    if (list) list.push({ fingerprint, input });
    else byFunction.set(key, [{ fingerprint, input }]);
  }
  const past = new Set<IncidentInput>();
  for (const list of byFunction.values()) {
    if (list.length <= cap) continue;
    list.sort(
      (a, b) =>
        b.input.occurrenceCount - a.input.occurrenceCount ||
        (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0)
    );
    for (const { input } of list.slice(cap)) past.add(input);
  }
  return past;
}

/**
 * The fixed message of a function's overflow incident for one UTC day. It keys the fingerprint (`fingerprintOf`
 * hashes it unnormalized in the `ovf-` namespace), so it holds no data, only the day: one overflow incident per
 * function and day.
 */
export function overflowMessage(day: string): string {
  return `High-cardinality overflow on ${day} (UTC): distinct errors of this function past the per-window cap on new incidents, each matching no stored incident, are counted here instead of opening one incident each`;
}

/**
 * One function's folded errors as the overflow input (#303), dated by the UTC day the window ends in. The most
 * frequent folded error lends its (already sanitized) message, as an example, and its stack trace, so a person or the
 * agent can find the code that echoes the varying text.
 */
export function buildOverflowInput(
  folded: readonly IncidentInput[],
  config: Pick<StarfishConfig, "environment">,
  window: IngestWindow
): IncidentInput {
  const sorted = [...folded].sort(
    (a, b) => b.occurrenceCount - a.occurrenceCount || (a.errorMessage < b.errorMessage ? -1 : a.errorMessage > b.errorMessage ? 1 : 0)
  );
  const top = sorted[0]!;
  let occurrences = 0;
  let first = top.firstOccurredAt;
  let last = top.lastOccurredAt;
  for (const f of sorted) {
    occurrences += f.occurrenceCount;
    if (f.firstOccurredAt < first) first = f.firstOccurredAt;
    if (f.lastOccurredAt > last) last = f.lastOccurredAt;
  }
  const detail = sanitize(`${sorted.length} distinct errors folded in one window; the most frequent: ${top.errorMessage}`);
  return {
    functionName: top.functionName,
    service: top.service,
    environment: config.environment,
    errorType: OVERFLOW_ERROR_TYPE,
    errorMessage: overflowMessage(window.end.toISOString().slice(0, 10)),
    occurrenceCount: occurrences,
    firstOccurredAt: first,
    lastOccurredAt: last,
    ...(detail !== undefined && { errorDetail: detail }),
    ...(top.stackTrace !== undefined && { stackTrace: top.stackTrace }),
    ...(top.sourceProjectId !== undefined && { sourceProjectId: top.sourceProjectId }),
    ...(top.monitoring !== undefined && { monitoring: top.monitoring }),
    signalSource: "overflow",
    windowId: window.id,
  };
}

/**
 * The latest readable timestamp among `entries`, or undefined when none has one. The latest, not the
 * last: the read is oldest first, but taking the maximum does not depend on that.
 */
function latestTimestamp(entries: readonly RawLogEntry[]): Date | undefined {
  let latest: number | undefined;
  for (const e of entries) {
    const ts = e?.metadata?.timestamp;
    if (ts === undefined) continue;
    const t = new Date(ts).getTime();
    if (Number.isFinite(t) && (latest === undefined || t > latest)) latest = t;
  }
  return latest === undefined ? undefined : new Date(latest);
}
