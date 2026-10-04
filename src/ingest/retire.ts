/**
 * Close an incident for good and free its fingerprint (#63).
 *
 * In production a resolved incident that fires again is reopened as `recurred`: a regression. That
 * is wrong for a demo that puts a fixed bug back on purpose, and it would look like a failed fix to
 * anything watching for one. Retiring an incident ends that cycle: the incident keeps its history and
 * is marked resolved, its incident key is removed, and a later occurrence of the same error opens a NEW
 * incident (store.ts treats a retired incident as if it were not there).
 *
 * One transaction does all of it, together with the audit entry, so there is no state where the key is
 * gone but the incident is not retired, or the action happened unrecorded. It runs in the same
 * transactional world as `upsertIncident`, so a retire racing an occurrence either lands after it (the
 * occurrence is counted on this incident) or before it (the occurrence opens a new one): never lost, never
 * split.
 *
 * Admin only, checked HERE from the operator record (the same `roles` firestore.rules reads), not from
 * anything the caller passes: whoever builds the endpoint or admin action that calls this must still
 * authenticate the person and hand over their uid, but cannot widen what that uid may do.
 *
 * `retired` is the flag the fast-revert watch (#9) must honour. That watch does not exist yet, so there is
 * nothing to disarm; nothing here pretends otherwise.
 */
import { Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { hasAdminRole, isValidUid } from "../adminAuth.js";
import { computeErrorFingerprint } from "./fingerprint.js";
import { redactPii } from "./redact.js";
import { incidentKeyId } from "./store.js";
import type { StoredIncident } from "../types.js";

export type RetireConfig = Pick<StarfishConfig, "incidentCollection" | "incidentKeyCollection" | "usersCollection" | "auditCollection">;

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

  return db.runTransaction(async (tx): Promise<RetireResult> => {
    // Every read before any write.
    const [actor, snap] = await Promise.all([tx.get(actorRef), tx.get(incidentRef)]);
    if (!hasAdminRole(actor)) return { ok: false, reason: "not-admin" };
    if (!snap.exists) return { ok: false, reason: "no-such-incident" };
    const data = snap.data() as StoredIncident;
    if (data.retired === true) return { ok: true, alreadyRetired: true };

    const fingerprint = computeErrorFingerprint(data.functionName, data.errorMessage);
    const keyRef = db.collection(cfg.incidentKeyCollection).doc(incidentKeyId(data.environment, fingerprint));
    const key = await tx.get(keyRef);
    const wasOpen = data.status !== "resolved" && data.status !== "ignored";

    tx.update(incidentRef, {
      retired: true,
      retiredAt: Timestamp.fromDate(now),
      retiredBy: actorUid,
      // An open incident is closed; one already resolved or ignored keeps its status and its history.
      ...(wasOpen && { status: "resolved", resolvedAt: Timestamp.fromDate(now), statusChangedBy: actorUid }),
      updatedAt: Timestamp.fromDate(now),
    });
    // Only a key that points HERE is removed: one that already moved to a newer incident is not ours.
    if (key.exists && key.get("incidentId") === incidentId) tx.delete(keyRef);

    tx.create(db.collection(cfg.auditCollection).doc(), {
      action: "retire-incident",
      incidentId,
      environment: data.environment,
      fingerprint,
      actorUid,
      at: Timestamp.fromDate(now),
      reason: redactPii(String(reason)).slice(0, MAX_REASON),
      before: { status: data.status },
      after: { status: wasOpen ? "resolved" : data.status, retired: true },
    });
    return { ok: true, alreadyRetired: false };
  });
}
