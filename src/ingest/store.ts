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
 *
 * Concurrency: every upsert is one Firestore transaction that first reads an
 * incident KEY document, `{incidentKeyCollection}/{hash(environment, fingerprint)}`,
 * naming the incident that fingerprint accrues onto. Reading the key and the
 * incident inside the transaction is what makes the decision safe against
 * everything else that writes them:
 *   - two ingest runs seeing the same new fingerprint both read the absent key;
 *     Firestore lets only one of them commit, and the other (retried, or
 *     serialized after it) finds the key and accrues onto the same document
 *     instead of creating a second one;
 *   - an operator's resolve can't land between the read and the write. Either
 *     it is serialized after the transaction, so the occurrence (which happened
 *     before the resolve) accrues onto the still-open incident, or before it,
 *     so the transaction sees `resolved` and takes the recurrence transition,
 *     exactly once: any later transaction sees `recurred`;
 *   - hourly buckets are merged from a read no other writer can slip past.
 * A RETIRED incident (retire.ts) is invisible to all of this: its key is removed and no lookup returns it,
 * so the same error firing again opens a new incident rather than a `recurred` one.
 *
 * Incidents written before keys existed have none; the first upsert finds them
 * by query, as before, and writes the key that pins them from then on.
 *
 * Replays: a scheduled run reads a bounded window of logs, and a run that fails
 * part-way is retried over the SAME window. Upserts that already committed must
 * not count those occurrences twice, so an input may carry a `windowId`, and the
 * key records the windows it has applied (the last APPLIED_WINDOWS_RETAINED). An
 * upsert for a window the key already holds changes nothing and reports
 * "duplicate". The record and the accrual commit in one transaction, so there is
 * no state where one happened without the other. Callers must give a window the
 * same id every time it is retried, and different windows different ids.
 */
import { createHash } from "node:crypto";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import type { DocumentSnapshot, Firestore, Transaction } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { fingerprintOf } from "./fingerprint.js";
import type { MonitoringObservation } from "./monitoring.js";
import { redactPii, sliceWellFormed } from "./redact.js";
import { hourBucketKey, mergeOccurrenceBuckets } from "./buckets.js";
import {
  OPEN_INCIDENT_STATUSES,
  type IncidentResolution,
  type StoredIncident,
  type StoredMonitoringObservation,
} from "../types.js";

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
  /**
   * The ingest window these occurrences were read from. Makes the upsert replay-safe: the
   * same window applied twice counts once. Omit it and every call counts (nothing to dedupe).
   */
  windowId?: string;
  /**
   * `monitoring` for a Monitoring-only incident (#19): fingerprinted in its own namespace
   * (`fingerprintOf`), so it never accrues onto, or is accrued onto by, a log-derived incident.
   */
  signalSource?: "monitoring";
  /**
   * Cloud Monitoring readings for this function in the same window (#19). On a log incident they
   * annotate it; on a Monitoring-only one they are its evidence. Folded in once per window, like the
   * occurrences: a replayed window is a "duplicate" and changes nothing.
   */
  monitoring?: MonitoringObservation[];
}

/**
 * What upsertIncident did: created a document, accrued onto one, re-opened a resolved one,
 * or recognised a window it had already applied and changed nothing ("duplicate").
 */
export type UpsertOutcome = "new" | "updated" | "recurred" | "duplicate";

/** Applied windows remembered per key. A retry only ever replays the latest window or two. */
export const APPLIED_WINDOWS_RETAINED = 32;

/** Max same-fingerprint resolved documents read when looking for a regression target. */
const RESOLVED_LOOKUP_LIMIT = 10;

/**
 * Attempts per upsert before the contention error surfaces. Each retry re-reads
 * everything, so a retry is always a fresh decision, never a replayed write.
 */
export const UPSERT_MAX_ATTEMPTS = 5;

/** Where upsertIncident reads and writes. */
export type IncidentStoreConfig = Pick<StarfishConfig, "incidentCollection" | "incidentKeyCollection">;

/** The incident key a document lives under. */
interface IncidentKey {
  incidentId: string;
  environment: string;
  fingerprint: string;
  updatedAt: Timestamp;
  /** Ingest windows already applied to this fingerprint, oldest first, bounded. */
  appliedWindows?: string[];
}

/**
 * Document id of the key for (environment, fingerprint). Hashed because an
 * environment label is free text and may hold a `/`, which a document id can't.
 */
export function incidentKeyId(environment: string, fingerprint: string): string {
  return createHash("sha256").update(`${environment}\n${fingerprint}`).digest("hex");
}

/** Epoch ms of a Timestamp-ish field, or undefined. Tolerates partial and legacy documents. */
function tsMillis(value: unknown): number | undefined {
  const v = value as { toMillis?: unknown } | null | undefined;
  return typeof v?.toMillis === "function" ? (v.toMillis() as number) : undefined;
}

/** True when `date` is later than the stored timestamp, or nothing is stored. */
function isAfter(date: Date, stored: unknown): boolean {
  const ms = tsMillis(stored);
  return ms == null || date.getTime() > ms;
}

/** True when `date` is earlier than the stored timestamp, or nothing is stored. */
function isBefore(date: Date, stored: unknown): boolean {
  const ms = tsMillis(stored);
  return ms == null || date.getTime() < ms;
}

/** The most readings kept per window on a document: one per configured signal is all a window produces. */
const MAX_STORED_OBSERVATIONS = 8;

/** Readings as stored: provenance and count only, Firestore timestamps, no undefined. */
function storedObservations(observations: readonly MonitoringObservation[]): StoredMonitoringObservation[] {
  return observations.slice(0, MAX_STORED_OBSERVATIONS).map((o) => ({
    source: o.source,
    metricType: o.metricType,
    resourceType: o.resourceType,
    projectId: o.projectId,
    windowStart: Timestamp.fromDate(o.windowStart),
    windowEnd: Timestamp.fromDate(o.windowEnd),
    failureCount: o.failureCount,
    ...(o.capped && { capped: true }),
  }));
}

/** The failures the readings counted, summed. */
function observedFailures(observations: readonly MonitoringObservation[]): number {
  return observations.reduce((sum, o) => sum + o.failureCount, 0);
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
    // Logs arrive late and out of order: a delayed batch can't move the
    // incident's recency backwards, or widen it forwards past what was seen.
    ...(isAfter(input.lastOccurredAt, data.lastOccurredAt) && {
      lastOccurredAt: Timestamp.fromDate(input.lastOccurredAt),
    }),
    ...(isBefore(input.firstOccurredAt, data.firstOccurredAt) && {
      firstOccurredAt: Timestamp.fromDate(input.firstOccurredAt),
    }),
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
    // A window with Monitoring readings for this function: counted once (the window id guards a replay).
    ...(input.monitoring != null &&
      input.monitoring.length > 0 && {
        monitoringCount: FieldValue.increment(observedFailures(input.monitoring)),
        lastMonitoring: storedObservations(input.monitoring),
      }),
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

/**
 * The store is the single write path, so it is where redaction is enforced
 * rather than trusted: whatever a caller passes, no credential or email reaches
 * Firestore. `redactPii` is idempotent, so text the aggregator already sanitized
 * (and bounded) comes back unchanged. Applied before the fingerprint so a
 * secret that varies per request can't split one incident into many.
 */
function redactInput(input: IncidentInput): IncidentInput {
  return {
    ...input,
    errorMessage: redactPii(input.errorMessage),
    ...(input.errorDetail != null && { errorDetail: redactPii(input.errorDetail) }),
    ...(input.stackTrace != null && { stackTrace: redactPii(input.stackTrace) }),
    ...(input.errorName != null && { errorName: redactPii(input.errorName) }),
    // Short fields a handler fills from its own payload (#130): a tenantId that is an email, an errorCode
    // or service that carries a token. Shown to guests on the demo, so redacted like the text, and bounded.
    ...(input.service != null && { service: redactShortField(input.service) }),
    ...(input.errorCode != null && { errorCode: redactShortField(input.errorCode) }),
    ...(input.tenantId != null && { tenantId: redactShortField(input.tenantId) }),
    ...(input.requestId != null && { requestId: redactShortField(input.requestId) }),
  };
}

/** Cap on an identifier-like field (tenantId, errorCode, service, requestId); real ones are far shorter. */
export const MAX_SHORT_FIELD_LEN = 256;

/**
 * Redact, then bound without a suffix, so applying it twice changes nothing (`pnpm scrub` reapplies it).
 * The cut never splits a surrogate pair (#126).
 */
export function redactShortField(value: string): string {
  return sliceWellFormed(redactPii(value), MAX_SHORT_FIELD_LEN);
}

export async function upsertIncident(
  db: Firestore,
  store: IncidentStoreConfig,
  rawInput: IncidentInput,
  now: Timestamp
): Promise<UpsertOutcome> {
  const input = redactInput(rawInput);
  const fingerprint = fingerprintOf(input.functionName, input.errorMessage, input.signalSource);
  const keyRef = db.collection(store.incidentKeyCollection).doc(incidentKeyId(input.environment, fingerprint));

  return db.runTransaction(
    async (tx) => {
      // Every read comes before any write: Firestore transactions require it.
      const keySnap = await tx.get(keyRef);
      const applied = readAppliedWindows(keySnap);
      // A window this fingerprint already took is a replay: write nothing, count nothing.
      if (input.windowId !== undefined && applied.includes(input.windowId)) return "duplicate";
      const keyed = await readKeyedIncident(db, tx, store, keySnap, fingerprint);
      // The key names a document that still holds this fingerprint: it decides.
      // Otherwise (no key yet, or a stale one) fall back to the lookup that
      // predates keys, so incidents stored before them are adopted, not forked.
      const target = keyed ?? (await findUnkeyedIncident(db, tx, store, input.environment, fingerprint));

      // Written when the pointer moves, and whenever a window must be recorded; an
      // unchanged key with nothing to record is left alone (no write for nothing).
      const pointKeyAt = (incidentId: string) => {
        const moved = keySnap.get("incidentId") !== incidentId;
        if (!moved && input.windowId === undefined) return;
        const appliedWindows =
          input.windowId === undefined ? applied : [...applied, input.windowId].slice(-APPLIED_WINDOWS_RETAINED);
        const key: IncidentKey = {
          incidentId,
          environment: input.environment,
          fingerprint,
          updatedAt: now,
          ...(appliedWindows.length > 0 && { appliedWindows }),
        };
        tx.set(keyRef, key);
      };

      const data = target?.data() as StoredIncident | undefined;
      if (target && data && isOpen(data.status)) {
        tx.update(target.ref, {
          ...buildAccrualUpdate(data, input, now),
          // Re-queue for triage only when it was never triaged. A decision already
          // taken ("declined", "acting") must not be silently undone by a recurrence.
          ...(data.triageState == null && { triageState: "pending" as const }),
        });
        pointKeyAt(target.id);
        return "updated";
      }

      if (target && data?.status === "resolved") {
        pointKeyAt(target.id);
        const resolvedAtMs = tsMillis(data.resolvedAt);
        // Logs are aggregated with a lag, so a batch can hold occurrences from
        // BEFORE the incident was resolved. Those are the old failure, not a
        // regression: count them on the resolved incident and leave it resolved.
        if (resolvedAtMs != null && input.lastOccurredAt.getTime() <= resolvedAtMs) {
          tx.update(target.ref, buildAccrualUpdate(data, input, now));
          return "updated";
        }
        tx.update(target.ref, buildRecurrenceUpdate(data, input, now));
        return "recurred";
      }

      // Nothing to accrue onto, or the keyed incident was ignored: an ignored
      // incident is never re-opened, so the occurrence opens a fresh one, and
      // the key moves to it.
      const ref = db.collection(store.incidentCollection).doc();
      tx.set(ref, buildNewIncident(input, fingerprint, now));
      pointKeyAt(ref.id);
      return "new";
    },
    { maxAttempts: UPSERT_MAX_ATTEMPTS }
  );
}

/** The windows a key has applied. Tolerates a missing or malformed field: nothing applied. */
function readAppliedWindows(keySnap: DocumentSnapshot): string[] {
  const raw: unknown = keySnap.get("appliedWindows");
  return Array.isArray(raw) ? raw.filter((w): w is string => typeof w === "string") : [];
}

function isOpen(status: unknown): boolean {
  return (OPEN_INCIDENT_STATUSES as readonly unknown[]).includes(status);
}

/** True for an incident an admin closed for good: it never accrues occurrences and is never reopened. */
function isRetired(snap: DocumentSnapshot): boolean {
  return (snap.data() as Partial<StoredIncident> | undefined)?.retired === true;
}

/** True when the document's own content hashes to `fingerprint`. */
function holdsFingerprint(snap: DocumentSnapshot, fingerprint: string): boolean {
  const d = snap.data() as Partial<StoredIncident> | undefined;
  if (d?.functionName == null || d.errorMessage == null) return false;
  return fingerprintOf(d.functionName, d.errorMessage, d.signalSource) === fingerprint;
}

/** The incident the key points at, when it exists and still holds the fingerprint. */
async function readKeyedIncident(
  db: Firestore,
  tx: Transaction,
  store: IncidentStoreConfig,
  keySnap: DocumentSnapshot,
  fingerprint: string
): Promise<DocumentSnapshot | null> {
  const incidentId: unknown = keySnap.get("incidentId");
  if (typeof incidentId !== "string" || incidentId === "") return null;
  const snap = await tx.get(db.collection(store.incidentCollection).doc(incidentId));
  // Re-verify against content rather than trusting the pointer: a stale key or a
  // rewritten document can't cause a wrong merge.
  // A retired incident has been closed for good and its fingerprint freed (retire.ts): a key that still
  // points at one is stale, and the occurrence opens a new incident instead of reopening it.
  return snap.exists && holdsFingerprint(snap, fingerprint) && !isRetired(snap) ? snap : null;
}

/**
 * The lookup for incidents that have no key: an open one, else a resolved one.
 * Returns null when there is neither.
 */
async function findUnkeyedIncident(
  db: Firestore,
  tx: Transaction,
  store: IncidentStoreConfig,
  environment: string,
  fingerprint: string
): Promise<DocumentSnapshot | null> {
  const incidents = db.collection(store.incidentCollection);

  // Query BY the indexed fingerprint field. An earlier version fetched up to 10
  // open incidents for the function and re-hashed them in memory — which is
  // what a busy function breaks: during a burst it has more than 10 open
  // incidents, the match falls outside the window, and every run forks the same
  // incident into another document with the count split across the copies.
  // (Found in production by the pipeline this was ported from.)
  const open = await tx.get(
    incidents
      .where("fingerprint", "==", fingerprint)
      .where("environment", "==", environment)
      .where("status", "in", [...OPEN_INCIDENT_STATUSES])
      .limit(10)
  );

  // If a past burst already forked several open copies, converge on the
  // earliest so every later run accrues onto one canonical document.
  let earliest: DocumentSnapshot | null = null;
  let earliestMs = Infinity;
  for (const doc of open.docs) {
    if (!holdsFingerprint(doc, fingerprint) || isRetired(doc)) continue;
    const firstMs = tsMillis((doc.data() as StoredIncident).firstOccurredAt) ?? Infinity;
    if (earliest === null || firstMs < earliestMs) {
      earliest = doc;
      earliestMs = firstMs;
    }
  }
  if (earliest) return earliest;

  // No open incident: is this a regression of a RESOLVED one? Equality on every
  // field, so Firestore serves it by merging single-field indexes and no
  // composite index is needed.
  const resolved = await tx.get(
    incidents
      .where("fingerprint", "==", fingerprint)
      .where("environment", "==", environment)
      .where("status", "==", "resolved")
      .limit(RESOLVED_LOOKUP_LIMIT)
  );

  // Several resolved documents can share a fingerprint (before regressions were
  // tracked, every recurrence opened a fresh one): re-open the most recently
  // resolved, which holds the fix that just failed.
  let latest: DocumentSnapshot | null = null;
  let latestMs = -Infinity;
  for (const doc of resolved.docs) {
    const d = doc.data() as StoredIncident;
    if (d.status !== "resolved" || !holdsFingerprint(doc, fingerprint) || isRetired(doc)) continue;
    const ms = tsMillis(d.resolvedAt) ?? tsMillis(d.lastOccurredAt) ?? -Infinity;
    if (latest === null || ms > latestMs) {
      latest = doc;
      latestMs = ms;
    }
  }
  return latest;
}

function buildNewIncident(input: IncidentInput, fingerprint: string, now: Timestamp): StoredIncident {
  const bucketKey = hourBucketKey(input.lastOccurredAt.getTime());
  return {
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
    ...(input.signalSource === "monitoring" && { signalSource: "monitoring" as const }),
    ...(input.monitoring != null &&
      input.monitoring.length > 0 && {
        monitoringCount: observedFailures(input.monitoring),
        lastMonitoring: storedObservations(input.monitoring),
      }),
  };
}
