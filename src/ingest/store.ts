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
 * A RETIRED incident (retire.ts) keeps its key as a tombstone: the key still names it and still holds
 * the windows it applied, so a window replayed after the retire is still a "duplicate". Occurrences
 * dated at or before `retiredAt` (ingest reads behind the clock, so a batch can hold some) are the
 * failure that was retired: while the key still names the retired incident they accrue onto it, and it
 * stays closed. Anything later opens a NEW incident (never a `recurred` one) and the key moves to it;
 * windows are read in order, so an earlier occurrence arriving after that would have to be later than
 * the ingest lag allows for. No lookup by query ever returns a retired incident.
 *
 * Incidents written before keys existed have none; the first upsert finds them
 * by query, as before, and writes the key that pins them from then on.
 *
 * A fingerprint change (a new FINGERPRINT_VERSION, fingerprint.ts) leaves every stored incident keyed under its old
 * fingerprint. On a key miss the store therefore also reads the keys of the fingerprints earlier versions gave the same
 * occurrence (`earlierFingerprints`), in the same transaction: an incident one of them names that hashes to the current
 * fingerprint is this bug, so the key of the current fingerprint is pointed at it, carrying the windows the old key had
 * applied, and the record takes the current fingerprint (#432). So a deploy that changes the fingerprint forks nothing,
 * with or without `pnpm rekey`. Which incident, when several qualify, is convergence.ts `convergeOn`: the one rule the
 * store, rekey and scrub share.
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
import type { DocumentReference, DocumentSnapshot, Firestore, Transaction } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { earlierFingerprints, fingerprintOf } from "./fingerprint.js";
import {
  APPLIED_WINDOWS_RETAINED,
  appliedWindowsOf,
  candidateOf,
  convergeOn,
  mergeAppliedWindows,
  tsMillis,
} from "./convergence.js";
import { TRACE_ID_RE } from "./parseLogEntry.js";
import type { MonitoringObservation } from "./monitoring.js";
import { redactPii, sliceWellFormed } from "./redact.js";
import { hourBucketKey, mergeOccurrenceBuckets } from "./buckets.js";
import {
  OPEN_INCIDENT_STATUSES,
  type IncidentResolution,
  type StoredIncident,
  type StoredMonitoringObservation,
} from "../types.js";
import type { IncidentKindId } from "../incidentKinds.js";
import type { PublicViewConfig } from "../publicView.js";
import { refreshPublicIncident } from "../publicViewStore.js";

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
  /** The newest occurrence's Cloud Trace id (32 hex, lower case). Anything else is not stored. */
  traceId?: string;
  sourceProjectId?: string;
  /**
   * The ingest window these occurrences were read from. Makes the upsert replay-safe: the
   * same window applied twice counts once. Omit it and every call counts (nothing to dedupe).
   */
  windowId?: string;
  /**
   * The incident's kind when it is not a log incident (src/incidentKinds.ts): each is fingerprinted in a namespace of
   * its own (`fingerprintOf`), so it never accrues onto, or is accrued onto by, an incident of another kind.
   */
  signalSource?: Exclude<IncidentKindId, "log">;
  /**
   * Cloud Monitoring readings for this function in the same window (#19). On a log incident they
   * annotate it; on a Monitoring-only one they are its evidence. Folded in once per window, like the
   * occurrences: a replayed window is a "duplicate" and changes nothing.
   */
  monitoring?: MonitoringObservation[];
}

/**
 * What upsertIncident did: created a document, accrued onto one, re-opened a resolved one,
 * or recognised a window it had already applied and changed nothing ("duplicate"). "absent" only
 * with `newIncidentCap`: the occurrence would have opened a new incident past the cap, so nothing was written.
 */
export type UpsertOutcome = "new" | "updated" | "recurred" | "duplicate" | "absent";

export interface UpsertOptions {
  /**
   * The per-function daily cap on new incidents (#434). Where the upsert would open an incident, it first counts it
   * on the key document of `fingerprint` (aggregate.ts passes the function's overflow incident for the UTC day), in the
   * same transaction, and once `limit` are counted there it refuses: nothing is written (not even the window on the
   * key) and it returns "absent", which the aggregator folds into that overflow incident. An occurrence that accrues
   * onto an existing incident (open, resolved, or the retired one an earlier occurrence belongs to) never counts.
   * The count lives in the store, not in the run, so neither narrowing a window nor completing many in one run (#296)
   * can multiply it, and a replayed window never counts an incident twice (its creation committed with its key).
   */
  newIncidentCap?: { fingerprint: string; limit: number };
}

export { APPLIED_WINDOWS_RETAINED };

/** Max same-fingerprint open documents read when looking for an incident with no key. */
const OPEN_LOOKUP_LIMIT = 10;
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
  /** On an overflow incident's key: how many incidents its function opened that UTC day (#434, `newIncidentCap`). */
  newIncidentsOpened?: number;
}

/** The field of a key document that counts the per-function daily cap (#434). */
const NEW_INCIDENTS_OPENED = "newIncidentsOpened";

/** The count a key document holds for the daily cap; 0 when it holds none (or anything else). */
function newIncidentsOpenedOf(key: DocumentSnapshot): number {
  const raw: unknown = key.exists ? key.get(NEW_INCIDENTS_OPENED) : undefined;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0;
}

/**
 * A key document as every writer writes it (the store, rekey, scrub): replaced whole, so a window list it no longer
 * holds is gone, but with the daily cap's count carried over from `previous`, the key as read in the same
 * transaction, so a writer that only moves the pointer never resets the cap.
 */
export function incidentKeyDoc(
  previous: DocumentSnapshot | undefined,
  key: { incidentId: string; environment: string; fingerprint: string; updatedAt: Timestamp; appliedWindows: readonly string[] }
): IncidentKey {
  const opened = previous ? newIncidentsOpenedOf(previous) : 0;
  return {
    incidentId: key.incidentId,
    environment: key.environment,
    fingerprint: key.fingerprint,
    updatedAt: key.updatedAt,
    ...(key.appliedWindows.length > 0 && { appliedWindows: [...key.appliedWindows] }),
    ...(opened > 0 && { newIncidentsOpened: opened }),
  };
}

/**
 * Document id of the key for (environment, fingerprint). Hashed because an
 * environment label is free text and may hold a `/`, which a document id can't.
 */
export function incidentKeyId(environment: string, fingerprint: string): string {
  return createHash("sha256").update(`${environment}\n${fingerprint}`).digest("hex");
}

/** True when `date` is later than the stored timestamp, or nothing is stored. */
function isAfter(date: Date, stored: unknown): boolean {
  const ms = tsMillis(stored);
  return ms == null || date.getTime() > ms;
}

/** True when `date` is no earlier than the stored timestamp, or nothing is stored. */
function isNotBefore(date: Date, stored: unknown): boolean {
  const ms = tsMillis(stored);
  return ms == null || date.getTime() >= ms;
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
    // The newest request's trace: a delayed batch of older logs must not replace it with an older one.
    ...(input.traceId != null && isNotBefore(input.lastOccurredAt, data.lastOccurredAt) && { traceId: input.traceId }),
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
    // Short fields a handler fills from its own payload (#130): a tenantId that is an email, an errorCode
    // or service that carries a token. Shown to guests on the demo, so redacted like the text, and bounded.
    // errorName too (#309): a class name is short, but it comes from the log entry and was stored unbounded.
    ...(input.errorName != null && { errorName: redactShortField(input.errorName) }),
    ...(input.service != null && { service: redactShortField(input.service) }),
    ...(input.errorCode != null && { errorCode: redactShortField(input.errorCode) }),
    ...(input.tenantId != null && { tenantId: redactShortField(input.tenantId) }),
    ...(input.requestId != null && { requestId: redactShortField(input.requestId) }),
    // Not redacted but checked: an id that is not 32 lower-case hex digits is dropped.
    traceId: input.traceId != null && TRACE_ID_RE.test(input.traceId) ? input.traceId : undefined,
  };
}

/** Cap on an identifier-like field (tenantId, errorCode, service, requestId, errorName); real ones are far shorter. */
export const MAX_SHORT_FIELD_LEN = 256;

/**
 * Redact, then bound without a suffix, so applying it twice changes nothing (`pnpm scrub` reapplies it).
 * The cut never splits a surrogate pair (#126).
 */
export function redactShortField(value: string): string {
  return sliceWellFormed(redactPii(value), MAX_SHORT_FIELD_LEN);
}

/**
 * With the public-view settings (src/publicView.ts, #18): after the upsert commits, the guest copy of the incident it
 * wrote is brought up to date from what was stored, when its environment is public. That refresh never throws.
 */
export async function upsertIncident(
  db: Firestore,
  store: IncidentStoreConfig & PublicViewConfig,
  rawInput: IncidentInput,
  now: Timestamp,
  options: UpsertOptions = {}
): Promise<UpsertOutcome> {
  const input = redactInput(rawInput);
  const fingerprint = fingerprintOf(input.functionName, input.errorMessage, input.signalSource);
  const keyRef = db.collection(store.incidentKeyCollection).doc(incidentKeyId(input.environment, fingerprint));

  // The document the committed attempt wrote (an attempt that is retried may have chosen another).
  let written: string | undefined;
  const outcome = await db.runTransaction(
    (tx) =>
      abortIfClosed(() => {
        written = undefined;
        return upsertInTransaction(db, tx, store, input, fingerprint, keyRef, now, (id) => (written = id), options.newIncidentCap);
      }),
    { maxAttempts: UPSERT_MAX_ATTEMPTS }
  );
  if (written !== undefined) await refreshPublicIncident(db, store, written, input.environment);
  return outcome;
}

/** gRPC status codes this file tells apart (google.rpc.Code). */
const GRPC_INVALID_ARGUMENT = 3;
const GRPC_ABORTED = 10;

/**
 * True for the error a read gets when its transaction has already been closed under it. Seen on the
 * emulator (#151): a transactional read failed before any response (a lock-acquire timeout, which also
 * closes the transaction), the client's streaming layer re-sent the same request on the same
 * transaction id, and that re-send got this. Nothing was committed, so the attempt is safe to redo.
 */
export function isClosedTransactionError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === GRPC_INVALID_ARGUMENT &&
    typeof e.message === "string" &&
    /transaction is invalid or closed/i.test(e.message)
  );
}

/**
 * Run one transaction attempt's body (the upsert here, and every transaction in retire.ts and run.ts, which read
 * the same way); a closed-transaction error leaves it as ABORTED, the code the transaction
 * runner retries, so the attempt is redone under the same `maxAttempts` budget and backoff instead of
 * failing the upsert. Every other error passes through untouched.
 */
export async function abortIfClosed<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!isClosedTransactionError(err)) throw err;
    const message = `transaction closed under a read, retried as aborted: ${(err as Error).message}`;
    throw Object.assign(new Error(message, { cause: err }), { code: GRPC_ABORTED });
  }
}

/** One attempt of upsertIncident, inside its transaction. */
async function upsertInTransaction(
  db: Firestore,
  tx: Transaction,
  store: IncidentStoreConfig,
  input: IncidentInput,
  fingerprint: string,
  keyRef: DocumentReference,
  now: Timestamp,
  wrote: (incidentId: string) => void,
  cap: UpsertOptions["newIncidentCap"]
): Promise<UpsertOutcome> {
  // Every read comes before any write: Firestore transactions require it.
  const keySnap = await tx.get(keyRef);
  const applied = appliedWindowsOf(keySnap);
  // A window this fingerprint already took is a replay: write nothing, count nothing.
  if (input.windowId !== undefined && applied.includes(input.windowId)) return "duplicate";
  // The key names a live document that still holds this fingerprint (or a retired one, its tombstone): it decides.
  const keyed = await readKeyedIncident(db, tx, store, keySnap, fingerprint);
  // Otherwise (no key yet, or a stale one): the keys earlier fingerprint versions wrote for this occurrence (#432),
  // then the lookup that predates keys, so incidents stored under an old fingerprint, or before keys, are adopted,
  // not forked. A window an earlier version's key applied is a replay too.
  const earlier = keyed ? NO_EARLIER_KEYS : await readEarlierKeys(db, tx, store, input, fingerprint);
  if (input.windowId !== undefined && earlier.windows.includes(input.windowId)) return "duplicate";
  const candidates = keyed ? [keyed] : await findUnkeyedIncidents(db, tx, store, input.environment, fingerprint, earlier.incidents);
  const choice = convergeOn(
    candidates.map((s) => candidateOf(s.id, s.data())),
    keyed?.id
  );
  const chosen = choice ? candidates.find((s) => s.id === choice.id) : undefined;

  // Written when the pointer moves, when a window must be recorded, and when an earlier version's key is carried
  // over; an unchanged key with nothing to record is left alone (no write for nothing).
  const pointKeyAt = (incidentId: string) => {
    const moved = keySnap.get("incidentId") !== incidentId;
    if (!moved && input.windowId === undefined && earlier.windows.length === 0) return;
    const base = earlier.windows.length > 0 ? mergeAppliedWindows([applied, earlier.windows]) : applied;
    const appliedWindows = input.windowId === undefined ? base : [...base, input.windowId].slice(-APPLIED_WINDOWS_RETAINED);
    tx.set(keyRef, incidentKeyDoc(keySnap, { incidentId, environment: input.environment, fingerprint, updatedAt: now, appliedWindows }));
  };
  // A record adopted under an earlier fingerprint takes the current one, as `pnpm rekey` would give it (#432): the
  // sample filter (counterCheck.ts) and the stored-field lookup below read it.
  const refingerprinted = (data: StoredIncident) => (data.fingerprint !== fingerprint ? { fingerprint } : {});

  if (chosen && choice?.as === "tombstone") {
    const retired = chosen.data() as StoredIncident;
    const retiredAtMs = tsMillis(retired.retiredAt);
    // Logs are read with a lag, so a batch can hold occurrences from BEFORE the retire. They are the
    // failure that was retired, not a new one: count them on the retired incident, which stays closed
    // (status, triage and recurrence untouched), as the resolved path below does for a resolution.
    if (retiredAtMs != null && input.lastOccurredAt.getTime() <= retiredAtMs) {
      tx.update(chosen.ref, { ...buildAccrualUpdate(retired, input, now), ...refingerprinted(retired) });
      wrote(chosen.id);
      pointKeyAt(chosen.id);
      return "updated";
    }
  }

  const target = choice?.as === "live" ? chosen : undefined;
  const data = target?.data() as StoredIncident | undefined;
  if (target && data && isOpen(data.status)) {
    tx.update(target.ref, {
      ...buildAccrualUpdate(data, input, now),
      // Re-queue for triage only when it was never triaged. A decision already
      // taken ("declined", "acting") must not be silently undone by a recurrence.
      ...(data.triageState == null && { triageState: "pending" as const }),
      ...refingerprinted(data),
    });
    wrote(target.id);
    pointKeyAt(target.id);
    return "updated";
  }

  if (target && data?.status === "resolved") {
    wrote(target.id);
    pointKeyAt(target.id);
    const resolvedAtMs = tsMillis(data.resolvedAt);
    // Logs are aggregated with a lag, so a batch can hold occurrences from
    // BEFORE the incident was resolved. Those are the old failure, not a
    // regression: count them on the resolved incident and leave it resolved.
    if (resolvedAtMs != null && input.lastOccurredAt.getTime() <= resolvedAtMs) {
      tx.update(target.ref, { ...buildAccrualUpdate(data, input, now), ...refingerprinted(data) });
      return "updated";
    }
    tx.update(target.ref, { ...buildRecurrenceUpdate(data, input, now), ...refingerprinted(data) });
    return "recurred";
  }

  // Nothing to accrue onto, the keyed incident was ignored, or it was retired
  // before this occurrence: neither is ever re-opened, so the occurrence opens
  // a fresh one, and the key moves to it. Unless the function's daily cap is reached (#434): then nothing is written,
  // and the window is not recorded on the key either, so a replay of it decides the same way.
  let capRef: DocumentReference | undefined;
  let opened = 0;
  if (cap) {
    capRef = db.collection(store.incidentKeyCollection).doc(incidentKeyId(input.environment, cap.fingerprint));
    opened = newIncidentsOpenedOf(await tx.get(capRef));
    if (opened >= cap.limit) return "absent";
  }
  const ref = db.collection(store.incidentCollection).doc();
  tx.set(ref, buildNewIncident(input, fingerprint, now));
  wrote(ref.id);
  pointKeyAt(ref.id);
  // Merged, so the overflow incident's own key (the same document) keeps its pointer and windows.
  if (capRef) tx.set(capRef, { [NEW_INCIDENTS_OPENED]: opened + 1 }, { merge: true });
  return "new";
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

/**
 * The incident the key points at, when it exists and still holds the fingerprint. A retired one is
 * returned too: the caller treats it as a tombstone, never as a target to reopen.
 */
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
  return snap.exists && holdsFingerprint(snap, fingerprint) ? snap : null;
}

/** What the keys of earlier fingerprint versions name: the incidents that are this bug today, and their windows. */
interface EarlierKeys {
  incidents: DocumentSnapshot[];
  windows: string[];
}

const NO_EARLIER_KEYS: EarlierKeys = { incidents: [], windows: [] };

/**
 * The keys earlier fingerprint versions gave this occurrence (#432, fingerprint.ts `earlierFingerprints`): each
 * incident one of them names that hashes to the CURRENT fingerprint (a retired one included, as a tombstone), and the
 * windows those keys applied. An old key whose incident hashes to anything else names another bug and is ignored, so an
 * earlier version can never make the store adopt a record today's fingerprint would not. A handful of reads, only on a
 * key miss, and none for a kind whose fingerprint never moved.
 */
async function readEarlierKeys(
  db: Firestore,
  tx: Transaction,
  store: IncidentStoreConfig,
  input: IncidentInput,
  fingerprint: string
): Promise<EarlierKeys> {
  const fingerprints = earlierFingerprints(input);
  if (fingerprints.length === 0) return NO_EARLIER_KEYS;
  const keys = db.collection(store.incidentKeyCollection);
  const keySnaps = await Promise.all(fingerprints.map((fp) => tx.get(keys.doc(incidentKeyId(input.environment, fp)))));
  const named = await Promise.all(
    keySnaps.map(async (keySnap) => {
      const incidentId: unknown = keySnap.get("incidentId");
      if (typeof incidentId !== "string" || incidentId === "") return undefined;
      const snap = await tx.get(db.collection(store.incidentCollection).doc(incidentId));
      return snap.exists && holdsFingerprint(snap, fingerprint) ? { keySnap, snap } : undefined;
    })
  );
  const found = named.filter((n): n is { keySnap: DocumentSnapshot; snap: DocumentSnapshot } => n !== undefined);
  if (found.length === 0) return NO_EARLIER_KEYS;
  const incidents: DocumentSnapshot[] = [];
  for (const { snap } of found) if (!incidents.some((s) => s.id === snap.id)) incidents.push(snap);
  return { incidents, windows: mergeAppliedWindows(found.map(({ keySnap }) => appliedWindowsOf(keySnap))) };
}

/**
 * The candidates on a key miss: `adopted` (what earlier versions' keys named), then the lookup for incidents that
 * have no key: the open ones, and, when nothing so far is open, the resolved ones. `convergeOn` chooses among them.
 *
 * The lookup reads at most 10 of each. With more forks than that and no key, the store chooses among the ones it
 * read; the key then records the choice, and `pnpm rekey` keeps a key that names a live incident (convergence.ts rule
 * 1), so the two never move occurrences off the incident the other chose (#432).
 */
async function findUnkeyedIncidents(
  db: Firestore,
  tx: Transaction,
  store: IncidentStoreConfig,
  environment: string,
  fingerprint: string,
  adopted: readonly DocumentSnapshot[]
): Promise<DocumentSnapshot[]> {
  const incidents = db.collection(store.incidentCollection);
  const candidates = [...adopted];
  const add = (doc: DocumentSnapshot) => {
    // A retired incident found by query is not a tombstone (only a key that names it is): it is never a candidate.
    if (!holdsFingerprint(doc, fingerprint) || isRetired(doc) || candidates.some((c) => c.id === doc.id)) return;
    candidates.push(doc);
  };
  const liveOpen = () => candidates.some((c) => !isRetired(c) && isOpen((c.data() as Partial<StoredIncident>).status));

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
      .limit(OPEN_LOOKUP_LIMIT)
  );
  for (const doc of open.docs) if (isOpen((doc.data() as Partial<StoredIncident>).status)) add(doc);
  if (liveOpen()) return candidates;

  // No open incident: is this a regression of a RESOLVED one? Equality on every
  // field, so Firestore serves it by merging single-field indexes and no
  // composite index is needed. Several resolved documents can share a fingerprint
  // (before regressions were tracked, every recurrence opened a fresh one).
  const resolved = await tx.get(
    incidents
      .where("fingerprint", "==", fingerprint)
      .where("environment", "==", environment)
      .where("status", "==", "resolved")
      .limit(RESOLVED_LOOKUP_LIMIT)
  );
  for (const doc of resolved.docs) if ((doc.data() as Partial<StoredIncident>).status === "resolved") add(doc);
  return candidates;
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
    ...(input.traceId != null && { traceId: input.traceId }),
    ...(input.sourceProjectId != null && { sourceProjectId: input.sourceProjectId }),
    ...(input.signalSource !== undefined && { signalSource: input.signalSource }),
    ...(input.monitoring != null &&
      input.monitoring.length > 0 && {
        monitoringCount: observedFailures(input.monitoring),
        lastMonitoring: storedObservations(input.monitoring),
      }),
  };
}
