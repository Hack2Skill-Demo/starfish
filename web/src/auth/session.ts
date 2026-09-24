/**
 * Resolve an operator's roles from their record. Starfish reads the record
 * directly from the client, and firestore.rules
 * lets a signed-in user read only their own record.
 */
import { doc, getDoc } from "firebase/firestore";
import { firestore } from "../lib/firebase";
import { webConfig } from "../lib/config";
import { STARFISH_ROLES, type StarfishRole } from "./authCore";

/** Defensively coerce a record's roles to known roles only. */
export function normalizeRoles(roles: unknown): StarfishRole[] {
  if (!Array.isArray(roles)) return [];
  return roles.filter((r): r is StarfishRole => STARFISH_ROLES.includes(r as StarfishRole));
}

export async function readRoles(uid: string): Promise<StarfishRole[]> {
  const snap = await getDoc(doc(firestore(), webConfig().usersCollection, uid));
  return snap.exists() ? normalizeRoles(snap.get("roles")) : [];
}
