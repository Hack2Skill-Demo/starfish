/**
 * Whether a uid is an admin, read from the operator record ({usersCollection}/{uid}.roles): the same
 * record firestore.rules reads, and the only source the engine trusts for an admin action. A caller
 * (an endpoint, an admin tool) must authenticate the person itself and hand over their uid; nothing
 * it says about their roles is believed.
 */
import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** True for a well-formed uid: anything else is refused before it can become a document path. */
export function isValidUid(uid: string): boolean {
  return UID_RE.test(uid);
}

/** An operator record that lists `admin`. Anything else, a missing record included, is not an admin. */
export function hasAdminRole(operatorRecord: DocumentSnapshot): boolean {
  const roles = operatorRecord.get("roles") as unknown;
  return Array.isArray(roles) && roles.includes("admin");
}

export async function isAdmin(db: Firestore, usersCollection: string, uid: string): Promise<boolean> {
  if (!isValidUid(uid)) return false;
  return hasAdminRole(await db.collection(usersCollection).doc(uid).get());
}
