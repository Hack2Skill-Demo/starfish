/**
 * Grant a person access to the operator UI: write their operator record ({usersCollection}/{uid}.roles),
 * the record firestore.rules and the UI read. `starfish_users` is closed to every client, so the first
 * admin of a deployment can only be made from the Admin SDK or the console; this is that, as a tool.
 *
 * It sets the roles it is given and nothing else (re-running with fewer roles removes the others), and
 * it never handles a password: a person who has no account yet is created without one and gets a
 * password-reset link to set their own.
 */
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { isValidUid } from "./adminAuth.js";

export const OPERATOR_ROLES = ["admin", "operator"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

/** "admin,operator" -> ["admin", "operator"]. Unknown or empty input throws: a typo must not grant nothing quietly. */
export function parseRoles(input: string): OperatorRole[] {
  const parts = input
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) throw new Error(`no role given; use ${OPERATOR_ROLES.join(" and/or ")}`);
  const roles: OperatorRole[] = [];
  for (const p of parts) {
    if (!(OPERATOR_ROLES as readonly string[]).includes(p)) {
      throw new Error(`unknown role "${p}"; use ${OPERATOR_ROLES.join(" and/or ")}`);
    }
    if (!roles.includes(p as OperatorRole)) roles.push(p as OperatorRole);
  }
  return roles;
}

export interface GrantResult {
  uid: string;
  /** The account did not exist and was created (without a password). */
  created: boolean;
  /** Present only for a created account: the link the person opens to choose a password. */
  passwordResetLink?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function grantOperator(
  deps: {
    auth: Pick<Auth, "getUserByEmail" | "createUser" | "generatePasswordResetLink">;
    db: Pick<Firestore, "collection">;
    usersCollection: string;
  },
  request: { email: string; roles: OperatorRole[]; createAccount: boolean }
): Promise<GrantResult> {
  const email = request.email.trim();
  if (!EMAIL_RE.test(email)) throw new Error("not an email address");

  let created = false;
  let uid: string;
  try {
    uid = (await deps.auth.getUserByEmail(email)).uid;
  } catch (err) {
    if ((err as { code?: string }).code !== "auth/user-not-found") throw err;
    if (!request.createAccount) {
      throw new Error("no account for that email; create it in the console, or pass --create", { cause: err });
    }
    uid = (await deps.auth.createUser({ email })).uid;
    created = true;
  }
  if (!isValidUid(uid)) throw new Error("the account's uid is not usable as a document id");

  await deps.db.collection(deps.usersCollection).doc(uid).set({ roles: request.roles });

  return {
    uid,
    created,
    ...(created && { passwordResetLink: await deps.auth.generatePasswordResetLink(email) }),
  };
}
