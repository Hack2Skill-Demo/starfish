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
import { computeErrorFingerprint } from "./fingerprint.js";
import { sanitize } from "./redact.js";
import { upsertIncident, type IncidentInput } from "./store.js";
import type { IngestWindow } from "./window.js";

const PAGE_SIZE = 500;
/**
 * Upper bound on entries read per run. `getEntries` auto-paginates by default,
 * so without this a sustained burst reads every entry in the window into memory
 * and runs the job into its timeout — during exactly the incident it exists to
 * catch. Newest entries are kept (the query is timestamp-desc); the
 * counter-check, not this job, is what reports the true volume.
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
  /** True when the read stopped at MAX_ENTRIES_PER_RUN; occurrence counts are then a floor. */
  capped: boolean;
}

/**
 * Read one window of the watched project's ERROR logs and fold it into the store. Every upsert
 * carries the window's id, so running the same window again (after a run that failed part-way)
 * counts each incident once; see the "Replays" note in store.ts.
 */
export async function aggregateErrors(
  db: Firestore,
  config: StarfishConfig,
  window: IngestWindow
): Promise<AggregationResult> {
  const result: AggregationResult = {
    entriesProcessed: 0,
    incidentsCreated: 0,
    incidentsUpdated: 0,
    incidentsRecurred: 0,
    incidentsReplayed: 0,
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
    orderBy: "timestamp desc",
  });

  result.entriesProcessed = entries.length;
  result.capped = entries.length >= MAX_ENTRIES_PER_RUN;
  if (entries.length === 0) return result;

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

  const now = Timestamp.now();

  // One transaction per incident (see store.ts), a few at a time. Every upsert
  // is awaited before the run reports: a failure throws only after the rest
  // have settled, and the incidents that committed are accrued onto next run.
  const queue = [...grouped.values()].map((g) => g.input);
  const failures: unknown[] = [];
  const worker = async () => {
    for (let input = queue.shift(); input; input = queue.shift()) {
      try {
        const outcome = await upsertIncident(db, config, input, now);
        if (outcome === "new") result.incidentsCreated += 1;
        else if (outcome === "recurred") result.incidentsRecurred += 1;
        else if (outcome === "duplicate") result.incidentsReplayed += 1;
        else result.incidentsUpdated += 1;
      } catch (err) {
        failures.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPSERT_CONCURRENCY, queue.length) }, worker));
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} of ${grouped.size} incident upserts failed`);
  }

  return result;
}
