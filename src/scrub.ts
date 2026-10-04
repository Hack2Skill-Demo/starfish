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
 *     fingerprint is recomputed, and the stale incident key (which names the old one) is
 *     removed, so the next occurrence finds the scrubbed record and keys it.
 *   - It must be safe to run twice, and to stop halfway: every change is a function of the
 *     record alone, so a rerun finishes the job and changes nothing already done.
 *
 * What it does not do: scrub Firestore exports or backups, logs, or anything outside the
 * incident collection. Redaction is pattern matching (README "Redaction limits"): a credential
 * in a format nobody listed, and free-form PII, are not found.
 */
import { FieldPath } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { computeErrorFingerprint } from "./ingest/fingerprint.js";
import { redactPii } from "./ingest/redact.js";
import { incidentKeyId, type IncidentStoreConfig } from "./ingest/store.js";

/** The text fields the store redacts on every write (store.ts redactInput). */
export const SCRUBBED_FIELDS = ["errorMessage", "errorDetail", "stackTrace", "errorName"] as const;
export type ScrubbedField = (typeof SCRUBBED_FIELDS)[number];

const PAGE_SIZE = 200;
/** Firestore caps a batch at 500 writes; each record can need up to 2 (update + key delete). */
const WRITES_PER_BATCH = 400;

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
    const clean = redactPii(value);
    if (clean !== value) updates[field] = clean;
  }
  if (Object.keys(updates).length === 0) return null;

  let fingerprint: string | undefined;
  const message = updates.errorMessage;
  if (message !== undefined && typeof data.functionName === "string") {
    const next = computeErrorFingerprint(data.functionName, message);
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
  /** Stale incident keys removed (applied runs only). */
  keysRemoved: number;
  applied: boolean;
}

/**
 * Scrub every incident in the collection. With `apply: false` (the default for the CLI) it
 * only counts. It reports counts and never the text it finds: a "found secret" report that
 * prints the secret would defeat the point.
 */
export async function scrubCollection(
  db: Firestore,
  store: IncidentStoreConfig,
  opts: { apply: boolean }
): Promise<ScrubReport> {
  const report: ScrubReport = {
    scanned: 0,
    changed: 0,
    byField: { errorMessage: 0, errorDetail: 0, stackTrace: 0, errorName: 0 },
    refingerprinted: 0,
    keysRemoved: 0,
    applied: opts.apply,
  };
  const incidents = db.collection(store.incidentCollection);
  const keys = db.collection(store.incidentKeyCollection);

  let batch = db.batch();
  let pending = 0;
  const flush = async () => {
    if (pending > 0) await batch.commit();
    batch = db.batch();
    pending = 0;
  };

  let last: string | undefined;
  for (;;) {
    let query = incidents.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (last !== undefined) query = query.startAfter(last);
    const page = await query.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      report.scanned += 1;
      const data = doc.data();
      const scrub = scrubDocument(data);
      if (!scrub) continue;

      report.changed += 1;
      for (const field of Object.keys(scrub.updates) as ScrubbedField[]) report.byField[field] += 1;
      if (scrub.fingerprint !== undefined) report.refingerprinted += 1;
      if (!opts.apply) continue;

      batch.update(doc.ref, {
        ...scrub.updates,
        ...(scrub.fingerprint !== undefined && { fingerprint: scrub.fingerprint }),
      });
      pending += 1;

      // The key for the OLD fingerprint named this record; it is stale now. Remove it, but only
      // if it still points here: it is someone else's key if the incident was re-keyed since.
      if (scrub.fingerprint !== undefined && typeof data.environment === "string" && typeof data.fingerprint === "string") {
        const staleRef = keys.doc(incidentKeyId(data.environment, data.fingerprint));
        const stale = await staleRef.get();
        if (stale.exists && stale.get("incidentId") === doc.id) {
          batch.delete(staleRef);
          pending += 1;
          report.keysRemoved += 1;
        }
      }
      if (pending >= WRITES_PER_BATCH) await flush();
    }
    last = page.docs[page.docs.length - 1]!.id;
  }
  await flush();
  return report;
}
