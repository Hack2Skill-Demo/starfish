/**
 * Scrub incidents stored BEFORE the redaction policy (issue #18).
 *
 * The store redacts every write now (store.ts), but a record written earlier keeps whatever
 * credential or email its log carried. This rewrites those records in place, with the same
 * `redactPii` the store applies, so the data can be exposed (a public demo, a shared UI)
 * without clearing the store and losing its history.
 *
 * Two things make it more than a find-and-replace:
 *
 *   - The store fingerprints the REDACTED message. A legacy record's fingerprint was hashed
 *     from the raw text, so scrubbing the text alone would leave a fingerprint the next
 *     occurrence never produces, and that occurrence would open a duplicate incident. The
 *     fingerprint is recomputed, and the key of the new one is pointed at the incident the store
 *     converges on (ingest/convergence.ts `convergeOn`, the rule the store and `pnpm rekey` use),
 *     carrying the windows the old key had applied, in the same transaction as the record's rewrite.
 *     The old key is left as it is (the store re-checks content, so it no longer matches anything).
 *     It used to be deleted (#433): that lost its applied windows (a replayed window then counted
 *     twice, #197) and, for a retired incident, its tombstone (retire.ts), and the delete raced
 *     ingest. A retired record keeps its tombstone under its new fingerprint.
 *   - It must be safe to run twice, and to stop halfway: every change is a function of the
 *     record alone, so a rerun finishes the job and changes nothing already done.
 *
 * What it does not do: scrub Firestore exports or backups, logs, or anything outside the
 * incident collection. Redaction is pattern matching (README "Redaction limits"): a credential
 * in a format nobody listed, and free-form PII, are not found.
 */
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import type { DocumentReference, DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import { appliedWindowsOf, candidateOf, convergeOn, mergeAppliedWindows, type ConvergenceCandidate } from "./ingest/convergence.js";
import { fingerprintOf } from "./ingest/fingerprint.js";
import { redactPii } from "./ingest/redact.js";
import { abortIfClosed, incidentKeyDoc, incidentKeyId, redactShortField, type IncidentStoreConfig } from "./ingest/store.js";

/** The fields the store redacts on every write (store.ts redactInput). */
export const SCRUBBED_FIELDS = [
  "errorMessage",
  "errorDetail",
  "stackTrace",
  "errorName",
  "service",
  "errorCode",
  "tenantId",
  "requestId",
] as const;
export type ScrubbedField = (typeof SCRUBBED_FIELDS)[number];

/** The identifier-like fields, which the store also bounds (#130, errorName #309): scrubbed the same way, so a rerun is a no-op. */
const SHORT_FIELDS: ReadonlySet<ScrubbedField> = new Set(["errorName", "service", "errorCode", "tenantId", "requestId"]);

const PAGE_SIZE = 200;

export interface DocumentScrub {
  /** The redacted value of each field that changed. */
  updates: Partial<Record<ScrubbedField, string>>;
  /** The recomputed fingerprint, when the message changed and the fingerprint with it. */
  fingerprint?: string;
}

/**
 * What scrubbing one stored record would change, or null if it is already clean. Pure: no
 * Firestore. Non-string values are left alone (a legacy record can hold anything).
 */
export function scrubDocument(data: Record<string, unknown>): DocumentScrub | null {
  const updates: Partial<Record<ScrubbedField, string>> = {};
  for (const field of SCRUBBED_FIELDS) {
    const value = data[field];
    if (typeof value !== "string") continue;
    const clean = SHORT_FIELDS.has(field) ? redactShortField(value) : redactPii(value);
    if (clean !== value) updates[field] = clean;
  }
  if (Object.keys(updates).length === 0) return null;

  let fingerprint: string | undefined;
  const message = updates.errorMessage;
  if (message !== undefined && typeof data.functionName === "string") {
    const next = fingerprintOf(data.functionName, message, data.signalSource);
    if (next !== data.fingerprint) fingerprint = next;
  }
  return { updates, ...(fingerprint !== undefined && { fingerprint }) };
}

export interface ScrubReport {
  scanned: number;
  /** Records that held something to redact. */
  changed: number;
  /** How many records had each field redacted. */
  byField: Record<ScrubbedField, number>;
  /** Records whose fingerprint was recomputed. */
  refingerprinted: number;
  /** Keys of a recomputed fingerprint written or re-pointed (applied runs only). */
  keysRepointed: number;
  applied: boolean;
}

/**
 * Scrub every incident in the collection. With `apply: false` (the default for the CLI) it
 * only counts. It reports counts and never the text it finds: a "found secret" report that
 * prints the secret would defeat the point. Applied, each record is re-read and rewritten in a
 * transaction of its own, with its key (see the file comment), so it can run beside the ingest.
 */
export async function scrubCollection(
  db: Firestore,
  store: IncidentStoreConfig,
  opts: { apply: boolean; now?: Timestamp }
): Promise<ScrubReport> {
  const report: ScrubReport = {
    scanned: 0,
    changed: 0,
    byField: Object.fromEntries(SCRUBBED_FIELDS.map((f) => [f, 0])) as Record<ScrubbedField, number>,
    refingerprinted: 0,
    keysRepointed: 0,
    applied: opts.apply,
  };
  const incidents = db.collection(store.incidentCollection);

  let last: string | undefined;
  for (;;) {
    let query = incidents.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (last !== undefined) query = query.startAfter(last);
    const page = await query.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      report.scanned += 1;
      const scrub = opts.apply ? await scrubRecord(db, store, doc.ref, opts.now ?? Timestamp.now()) : scrubDocument(doc.data());
      if (!scrub) continue;
      report.changed += 1;
      for (const field of Object.keys(scrub.updates) as ScrubbedField[]) report.byField[field] += 1;
      if (scrub.fingerprint !== undefined) report.refingerprinted += 1;
      if ("keyRepointed" in scrub && scrub.keyRepointed) report.keysRepointed += 1;
    }
    last = page.docs[page.docs.length - 1]!.id;
  }
  return report;
}

/**
 * One record scrubbed in one transaction: re-read (an ingest may have written since the page), redacted, and, when its
 * fingerprint moves, the key of the new fingerprint pointed where the store converges, carrying the old key's windows
 * when the old key named this record. Null when the record is clean by now.
 */
async function scrubRecord(
  db: Firestore,
  store: IncidentStoreConfig,
  ref: DocumentReference,
  now: Timestamp
): Promise<(DocumentScrub & { keyRepointed: boolean }) | null> {
  const incidents = db.collection(store.incidentCollection);
  const keys = db.collection(store.incidentKeyCollection);
  return db.runTransaction((tx) =>
    abortIfClosed(async () => {
      const snap = await tx.get(ref);
      const data = snap.data();
      const scrub = data ? scrubDocument(data) : null;
      if (!data || !scrub) return null;
      const update = { ...scrub.updates, ...(scrub.fingerprint !== undefined && { fingerprint: scrub.fingerprint }) };
      const environment = data.environment;
      if (scrub.fingerprint === undefined || typeof environment !== "string") {
        tx.update(ref, update);
        return { ...scrub, keyRepointed: false };
      }

      // Every read before any write.
      const fp = scrub.fingerprint;
      const keyRef = keys.doc(incidentKeyId(environment, fp));
      const oldKeyRef = typeof data.fingerprint === "string" ? keys.doc(incidentKeyId(environment, data.fingerprint)) : undefined;
      const [keySnap, oldKeySnap] = await Promise.all([tx.get(keyRef), oldKeyRef ? tx.get(oldKeyRef) : Promise.resolve(undefined)]);
      const keyedId: unknown = keySnap.get("incidentId");
      let keyed: DocumentSnapshot | undefined;
      if (typeof keyedId === "string" && keyedId !== "" && keyedId !== ref.id) keyed = await tx.get(incidents.doc(keyedId));
      const keyedHolds = keyed !== undefined && holds(keyed.data(), fp);
      const oldKeyNamedThis = oldKeySnap?.exists === true && oldKeySnap.get("incidentId") === ref.id;

      // This record, rewritten; a retired one only as the tombstone its old key made it (retire.ts). And the incident
      // the new fingerprint's key already names, when it holds the fingerprint.
      const self = candidateOf(ref.id, data);
      const candidates: ConvergenceCandidate[] = [
        ...(self.retired !== true || oldKeyNamedThis || keyedId === ref.id ? [self] : []),
        ...(keyed && keyedHolds ? [candidateOf(keyed.id, keyed.data())] : []),
      ];
      const choice = convergeOn(candidates, keyedId === ref.id || keyedHolds ? (keyedId as string) : undefined);

      tx.update(ref, update);
      if (!choice) return { ...scrub, keyRepointed: false };
      const windows = mergeAppliedWindows([appliedWindowsOf(keySnap), oldKeyNamedThis ? appliedWindowsOf(oldKeySnap) : []]);
      const unchanged = keyedId === choice.id && JSON.stringify(appliedWindowsOf(keySnap)) === JSON.stringify(windows);
      if (unchanged) return { ...scrub, keyRepointed: false };
      tx.set(keyRef, incidentKeyDoc(keySnap, { incidentId: choice.id, environment, fingerprint: fp, updatedAt: now, appliedWindows: windows }));
      return { ...scrub, keyRepointed: true };
    })
  );
}

/** True when a stored record's content hashes to `fingerprint` (the store's own check, store.ts `holdsFingerprint`). */
function holds(data: Record<string, unknown> | undefined, fingerprint: string): boolean {
  if (typeof data?.functionName !== "string" || typeof data.errorMessage !== "string") return false;
  return fingerprintOf(data.functionName, data.errorMessage, data.signalSource) === fingerprint;
}
