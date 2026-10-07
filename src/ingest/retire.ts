/**
 * Close an incident for good and free its fingerprint (#63).
 *
 * In production a resolved incident that fires again is reopened as `recurred`: a regression. That
 * is wrong for a demo that puts a fixed bug back on purpose, and it would look like a failed fix to
 * anything watching for one. Retiring an incident ends that cycle: the incident keeps its history and
 * is marked resolved, and a later occurrence of the same error opens a NEW incident.
 *
 * The incident key is left in place, as a tombstone (store.ts): it still names this incident and still
 * holds the ingest windows already applied, so a window replayed after the retire counts nothing twice
 * (#197). Deleting it lost that record: the replay opened a second incident. The store reads the key's
 * incident as retired: an occurrence dated at or before `retiredAt` (ingest reads behind the clock)
 * accrues onto this incident without reopening it; a later one opens a new incident and the key moves to
 * it. That is what frees the fingerprint.
 *
 * One transaction does it, together with the audit entry, so the action never happens unrecorded. It
 * writes the incident document the store reads in every upsert of this fingerprint, so a retire racing an
 * occurrence either lands after it (the occurrence is counted on this incident) or before it (counted on
 * this one if it happened before the retire, else on a new one): never lost, never split.
 *
 * Admin only, checked HERE from the operator record (the same `roles` firestore.rules reads), not from
 * anything the caller passes: whoever calls this (the admin API, src/adminApi.ts) must still
 * authenticate the person and hand over their uid, but cannot widen what that uid may do.
 *
 * The fast-revert watch (#9, src/agent/fastRevert.ts) honours `retired`: a retired incident never counts
 * as having come back, so a watch on it never opens a revert and ends `clear` when its window closes.
 */
import { Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { hasAdminRole, isValidUid } from "../adminAuth.js";
import { fingerprintOf } from "./fingerprint.js";
import { redactPii, sliceWellFormed, toWellFormed } from "./redact.js";
import { abortIfClosed } from "./store.js";
import type { StoredIncident } from "../types.js";

export type RetireConfig = Pick<StarfishConfig, "incidentCollection" | "usersCollection" | "auditCollection">;

export type RetireResult =
  | { ok: true; alreadyRetired: boolean }
  | { ok: false; reason: "not-admin" | "no-such-incident" | "invalid-id" };

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_REASON = 200;

export async function retireIncident(
  db: Firestore,
  cfg: RetireConfig,
  incidentId: string,
  actorUid: string,
  reason: string,
  now: Date
): Promise<RetireResult> {
  if (!ID_RE.test(incidentId) || !isValidUid(actorUid)) return { ok: false, reason: "invalid-id" };
  const incidentRef = db.collection(cfg.incidentCollection).doc(incidentId);
  const actorRef = db.collection(cfg.usersCollection).doc(actorUid);

  return db.runTransaction((tx) =>
    abortIfClosed(async (): Promise<RetireResult> => {
    // Every read before any write.
    const [actor, snap] = await Promise.all([tx.get(actorRef), tx.get(incidentRef)]);
    if (!hasAdminRole(actor)) return { ok: false, reason: "not-admin" };
    if (!snap.exists) return { ok: false, reason: "no-such-incident" };
    const data = snap.data() as StoredIncident;
    if (data.retired === true) return { ok: true, alreadyRetired: true };

    const fingerprint = fingerprintOf(data.functionName, data.errorMessage, data.signalSource);
    const wasOpen = data.status !== "resolved" && data.status !== "ignored";

    tx.update(incidentRef, {
      retired: true,
      retiredAt: Timestamp.fromDate(now),
      retiredBy: actorUid,
      // An open incident is closed; one already resolved or ignored keeps its status and its history.
      ...(wasOpen && { status: "resolved", resolvedAt: Timestamp.fromDate(now), statusChangedBy: actorUid }),
      updatedAt: Timestamp.fromDate(now),
    });
    // The incident key is not touched: it stays as the tombstone the store reads (see above).

    tx.create(db.collection(cfg.auditCollection).doc(), {
      action: "retire-incident",
      incidentId,
      environment: data.environment,
      fingerprint,
      actorUid,
      at: Timestamp.fromDate(now),
      // Never a lone surrogate (#126): Firestore would reject the whole retire over its audit reason.
      reason: sliceWellFormed(toWellFormed(redactPii(String(reason))), MAX_REASON),
      before: { status: data.status },
      after: { status: wasOpen ? "resolved" : data.status, retired: true },
    });
    return { ok: true, alreadyRetired: false };
  }));
}
