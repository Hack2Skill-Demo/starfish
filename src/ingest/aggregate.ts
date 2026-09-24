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

/** Firestore batches cap at 500 writes; stay under it with room for retries. */
const BATCH_SIZE = 400;
const PAGE_SIZE = 500;
/**
 * Upper bound on entries read per run. `getEntries` auto-paginates by default,
 * so without this a sustained burst reads every entry in the window into memory
 * and runs the job into its timeout — during exactly the incident it exists to
 * catch. Newest entries are kept (the query is timestamp-desc); the
 * counter-check, not this job, is what reports the true volume.
 */
export const MAX_ENTRIES_PER_RUN = 5000;

export interface AggregationResult {
  entriesProcessed: number;
  incidentsCreated: number;
  incidentsUpdated: number;
  /** True when the read stopped at MAX_ENTRIES_PER_RUN; occurrence counts are then a floor. */
  capped: boolean;
}

export async function aggregateErrors(
  db: Firestore,
  config: StarfishConfig,
  since: Date
): Promise<AggregationResult> {
  const result: AggregationResult = {
    entriesProcessed: 0,
    incidentsCreated: 0,
    incidentsUpdated: 0,
    capped: false,
  };

  // Scope to the configured project explicitly. Defaulting to ambient project
  // resolution is how a log reader ends up silently watching the wrong project
  // and reporting "no errors" forever while production burns.
  const logging = new Logging({ projectId: config.projectId });
  const [entries] = await logging.getEntries({
    filter: buildLogFilter(config, since),
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
    const parsed = parseLogEntry(entry as RawLogEntry, config.ignoredMessages);
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
      },
    });
  }

  const now = Timestamp.now();
  const inputs = [...grouped.values()].map((g) => g.input);

  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const slice = inputs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    // Track this batch's tallies separately: a commit failure must not leave the
    // caller believing writes landed that did not.
    let created = 0;
    let updated = 0;

    for (const input of slice) {
      const outcome = await upsertIncident(db, config.incidentCollection, batch, input, now);
      if (outcome === "new") created += 1;
      else updated += 1;
    }

    await batch.commit();
    result.incidentsCreated += created;
    result.incidentsUpdated += updated;
  }

  return result;
}
