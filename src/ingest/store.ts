/**
 * The single write path into the incident store.
 *
 * Dedup rule: an OPEN incident (see OPEN_INCIDENT_STATUSES) with the same fingerprint is
 * updated; anything else creates a new document. A resolved incident is
 * deliberately left alone, so a recurrence opens a fresh one rather than quietly
 * reopening a closed case — "this came back" is a different and more urgent fact
 * than "this is still happening."
 *
 * The fingerprint is derived from (functionName, errorMessage), so a caller that
 * wants recurrences to dedup must keep `errorMessage` stable across runs and
 * carry anything that varies (ids, counts, the underlying cause) elsewhere.
 */
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import type { Firestore, WriteBatch, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { computeErrorFingerprint } from "./fingerprint.js";
import { hourBucketKey, mergeOccurrenceBuckets } from "./buckets.js";
import { OPEN_INCIDENT_STATUSES, type StoredIncident } from "../types.js";

export interface IncidentInput {
  functionName: string;
  /** null when unattributable — stored as "platform", never guessed. */
  service: string | null;
  environment: string;
  errorType: string;
  errorMessage: string;
  occurrenceCount: number;
  firstOccurredAt: Date;
  lastOccurredAt: Date;
  errorCode?: string;
  errorName?: string;
  errorDetail?: string;
  httpStatus?: number;
  stackTrace?: string;
  tenantId?: string;
  requestId?: string;
  sourceProjectId?: string;
}

export async function upsertIncident(
  db: Firestore,
  collection: string,
  batch: WriteBatch,
  input: IncidentInput,
  now: Timestamp
): Promise<"new" | "updated"> {
  const fingerprint = computeErrorFingerprint(input.functionName, input.errorMessage);

  // Query BY the indexed fingerprint field. An earlier version fetched up to 10
  // open incidents for the function and re-hashed them in memory — which is
  // what a busy function breaks: during a burst it has more than 10 open
  // incidents, the match falls outside the window, and every run forks the same
  // incident into another document with the count split across the copies.
  // (Found in production by the pipeline this was ported from.)
  const open = await db
    .collection(collection)
    .where("fingerprint", "==", fingerprint)
    .where("environment", "==", input.environment)
    .where("status", "in", [...OPEN_INCIDENT_STATUSES])
    .limit(10)
    .get();

  // If a past burst already forked several open copies, converge on the
  // earliest so every later run accrues onto one canonical document.
  let existing: QueryDocumentSnapshot | null = null;
  let existingFirstMs = Infinity;
  for (const doc of open.docs) {
    const d = doc.data() as StoredIncident;
    // Re-verify against content rather than trusting the stored field the
    // query filtered on: a stale or rewritten fingerprint can't cause a wrong merge.
    if (computeErrorFingerprint(d.functionName, d.errorMessage) !== fingerprint) continue;
    const firstMs = d.firstOccurredAt?.toMillis?.() ?? Infinity;
    if (existing === null || firstMs < existingFirstMs) {
      existing = doc;
      existingFirstMs = firstMs;
    }
  }

  const bucketKey = hourBucketKey(input.lastOccurredAt.getTime());

  if (existing) {
    const data = existing.data() as StoredIncident;
    batch.update(existing.ref, {
      // Lifetime total; the hourly buckets carry the shape over time.
      occurrenceCount: FieldValue.increment(input.occurrenceCount),
      occurrencesByHour: mergeOccurrenceBuckets(
        data.occurrencesByHour,
        bucketKey,
        input.occurrenceCount,
        Date.now()
      ),
      lastOccurredAt: Timestamp.fromDate(input.lastOccurredAt),
      updatedAt: now,
      service: input.service ?? "platform",
      // Backfill diagnostics on recurrence — an incident often only becomes
      // diagnosable the second time it happens.
      ...(input.errorCode != null && { errorCode: input.errorCode }),
      ...(input.errorName != null && { errorName: input.errorName }),
      ...(input.errorDetail != null && { errorDetail: input.errorDetail }),
      ...(input.httpStatus != null && { httpStatus: input.httpStatus }),
      ...(input.stackTrace != null && { stackTrace: input.stackTrace }),
      ...(input.tenantId != null && { tenantId: input.tenantId }),
      ...(input.sourceProjectId != null && { sourceProjectId: input.sourceProjectId }),
      // Re-queue for triage only when it was never triaged. A decision already
      // taken ("declined", "acting") must not be silently undone by a recurrence.
      ...(data.triageState == null && { triageState: "pending" as const }),
    });
    return "updated";
  }

  const ref = db.collection(collection).doc();
  const doc: StoredIncident = {
    functionName: input.functionName,
    service: input.service ?? "platform",
    environment: input.environment,
    errorType: input.errorType,
    errorMessage: input.errorMessage,
    occurrenceCount: input.occurrenceCount,
    occurrencesByHour: { [bucketKey]: input.occurrenceCount },
    firstOccurredAt: Timestamp.fromDate(input.firstOccurredAt),
    lastOccurredAt: Timestamp.fromDate(input.lastOccurredAt),
    status: "new",
    fingerprint,
    triageState: "pending",
    createdAt: now,
    updatedAt: now,
    // Firestore rejects undefined, so optional fields are spread conditionally.
    ...(input.errorCode != null && { errorCode: input.errorCode }),
    ...(input.errorName != null && { errorName: input.errorName }),
    ...(input.errorDetail != null && { errorDetail: input.errorDetail }),
    ...(input.httpStatus != null && { httpStatus: input.httpStatus }),
    ...(input.stackTrace != null && { stackTrace: input.stackTrace }),
    ...(input.tenantId != null && { tenantId: input.tenantId }),
    ...(input.requestId != null && { requestId: input.requestId }),
    ...(input.sourceProjectId != null && { sourceProjectId: input.sourceProjectId }),
  };
  batch.set(ref, doc);
  return "new";
}
