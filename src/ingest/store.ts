/**
 * The single write path into the incident store.
 *
 * Dedup rule: an OPEN incident (see OPEN_INCIDENT_STATUSES) with the same
 * fingerprint is updated. Failing that, a RESOLVED incident with the same
 * fingerprint is re-opened as `recurred`: a regression, which keeps the
 * resolution that didn't hold (see buildRecurrenceUpdate). Only when neither
 * exists is a new document created. An `ignored` incident is never re-opened.
 *
 * Re-opening the same document, rather than opening a fresh `new` one, is what
 * lets a regression read differently from a first occurrence: "this came back
 * after we fixed it" is a more urgent fact than "this is new", and it needs the
 * history of the fix that failed.
 *
 * The fingerprint is derived from (functionName, errorMessage), so a caller that
 * wants recurrences to dedup must keep `errorMessage` stable across runs and
 * carry anything that varies (ids, counts, the underlying cause) elsewhere.
 */
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import type { Firestore, WriteBatch, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { computeErrorFingerprint } from "./fingerprint.js";
import { hourBucketKey, mergeOccurrenceBuckets } from "./buckets.js";
import { OPEN_INCIDENT_STATUSES, type IncidentResolution, type StoredIncident } from "../types.js";

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

/** What upsertIncident did: created a document, accrued onto one, or re-opened a resolved one. */
export type UpsertOutcome = "new" | "updated" | "recurred";

/** Max same-fingerprint resolved documents read when looking for a regression target. */
const RESOLVED_LOOKUP_LIMIT = 10;

/** Epoch ms of a Timestamp-ish field, or undefined. Tolerates partial and legacy documents. */
function tsMillis(value: unknown): number | undefined {
  const v = value as { toMillis?: unknown } | null | undefined;
  return typeof v?.toMillis === "function" ? (v.toMillis() as number) : undefined;
}

/**
 * The fields every occurrence writes onto an existing document: lifetime and
 * hourly counts, recency, and a backfill of diagnostics.
 */
function buildAccrualUpdate(data: StoredIncident, input: IncidentInput, now: Timestamp): Record<string, unknown> {
  return {
    // Lifetime total; the hourly buckets carry the shape over time.
    occurrenceCount: FieldValue.increment(input.occurrenceCount),
    occurrencesByHour: mergeOccurrenceBuckets(
      data.occurrencesByHour,
      hourBucketKey(input.lastOccurredAt.getTime()),
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
  };
}

/** Snapshot of a resolved document's resolution, absent fields omitted (Firestore rejects undefined). */
function snapshotResolution(d: StoredIncident): IncidentResolution {
  const snap: IncidentResolution = {};
  if (d.resolvedAt != null) snap.resolvedAt = d.resolvedAt;
  if (d.statusChangedBy != null) snap.resolvedBy = d.statusChangedBy;
  if (d.githubIssueNumber != null) snap.githubIssueNumber = d.githubIssueNumber;
  if (d.githubIssueUrl != null) snap.githubIssueUrl = d.githubIssueUrl;
  if (d.githubPrNumber != null) snap.githubPrNumber = d.githubPrNumber;
  if (d.githubPrUrl != null) snap.githubPrUrl = d.githubPrUrl;
  return snap;
}

/**
 * The `resolved` → `recurred` transition: the error fired again after its
 * incident was resolved, so the fix didn't hold. Accrues the occurrence like any
 * update, then:
 *   - sets `status: "recurred"`, bumps `recurrenceCount`, stamps `lastRecurredAt`;
 *   - moves the resolution (when, who, issue, PR) into `lastResolution` and
 *     clears the live resolution fields, so the incident reads as open;
 *   - re-queues it for triage. This is the one place a recurrence resets
 *     `triageState`: the earlier decision ended in a fix that failed, so it has
 *     to be made again with that fact in hand.
 *
 * Exported so the transition is unit-testable on its own.
 */
export function buildRecurrenceUpdate(
  data: StoredIncident,
  input: IncidentInput,
  now: Timestamp
): Record<string, unknown> {
  return {
    ...buildAccrualUpdate(data, input, now),
    status: "recurred",
    recurrenceCount: FieldValue.increment(1),
    lastRecurredAt: Timestamp.fromDate(input.lastOccurredAt),
    lastResolution: snapshotResolution(data),
    resolvedAt: FieldValue.delete(),
    // The old issue and PR belong to the fix that failed; they live on in
    // lastResolution. Left in place, they would read as this regression's own.
    githubIssueNumber: FieldValue.delete(),
    githubIssueUrl: FieldValue.delete(),
    githubPrNumber: FieldValue.delete(),
    githubPrUrl: FieldValue.delete(),
    githubPrState: FieldValue.delete(),
    triageState: "pending",
  };
}

export async function upsertIncident(
  db: Firestore,
  collection: string,
  batch: WriteBatch,
  input: IncidentInput,
  now: Timestamp
): Promise<UpsertOutcome> {
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

  if (existing) {
    const data = existing.data() as StoredIncident;
    batch.update(existing.ref, {
      ...buildAccrualUpdate(data, input, now),
      // Re-queue for triage only when it was never triaged. A decision already
      // taken ("declined", "acting") must not be silently undone by a recurrence.
      ...(data.triageState == null && { triageState: "pending" as const }),
    });
    return "updated";
  }

  // No open incident: is this a regression of a RESOLVED one? Equality on every
  // field, so Firestore serves it by merging single-field indexes and no
  // composite index is needed.
  const resolved = await db
    .collection(collection)
    .where("fingerprint", "==", fingerprint)
    .where("environment", "==", input.environment)
    .where("status", "==", "resolved")
    .limit(RESOLVED_LOOKUP_LIMIT)
    .get();

  // Several resolved documents can share a fingerprint (before regressions were
  // tracked, every recurrence opened a fresh one): re-open the most recently
  // resolved, which holds the fix that just failed.
  let resolvedDoc: QueryDocumentSnapshot | null = null;
  let resolvedMs = -Infinity;
  for (const doc of resolved.docs) {
    const d = doc.data() as StoredIncident;
    if (d.status !== "resolved") continue;
    if (computeErrorFingerprint(d.functionName, d.errorMessage) !== fingerprint) continue;
    const ms = tsMillis(d.resolvedAt) ?? tsMillis(d.lastOccurredAt) ?? -Infinity;
    if (resolvedDoc === null || ms > resolvedMs) {
      resolvedDoc = doc;
      resolvedMs = ms;
    }
  }

  if (resolvedDoc) {
    const data = resolvedDoc.data() as StoredIncident;
    const resolvedAtMs = tsMillis(data.resolvedAt);
    // Logs are aggregated with a lag, so a batch can hold occurrences from
    // BEFORE the incident was resolved. Those are the old failure, not a
    // regression: count them on the resolved incident and leave it resolved.
    if (resolvedAtMs != null && input.lastOccurredAt.getTime() <= resolvedAtMs) {
      batch.update(resolvedDoc.ref, buildAccrualUpdate(data, input, now));
      return "updated";
    }
    batch.update(resolvedDoc.ref, buildRecurrenceUpdate(data, input, now));
    return "recurred";
  }

  const bucketKey = hourBucketKey(input.lastOccurredAt.getTime());
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
