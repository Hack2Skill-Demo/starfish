/**
 * The public demo's judge sign-in accounts (`pnpm demo-users`): a few email/password operators, so a judge can see the
 * signed-in UI (full incident records, triage corrections) and not only the guest view.
 *
 * They are `operator`, never `admin`: an admin can edit the runtime settings and start the agent and ingest jobs, which
 * a published password must not allow. Passwords are random, made here, returned once for the person running this to put
 * on a slide, and never stored or logged; the repository holds none. Re-running leaves an existing account alone unless
 * `resetPasswords` is set, which replaces its password and signs it out everywhere (it also takes back an account a
 * stranger registered with the same email while self sign-up was on, #139).
 */
import { randomBytes } from "node:crypto";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { isValidUid } from "./adminAuth.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// No look-alikes (0/O, 1/l/I): the password is read off a slide.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A random password of `length` characters (16 by default, about 93 bits), drawn without modulo bias. */
export function generatePassword(length = 16): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}

type DemoAuth = Pick<Auth, "getUserByEmail" | "createUser" | "updateUser" | "revokeRefreshTokens" | "deleteUser">;
type DemoDeps = { auth: DemoAuth; db: Pick<Firestore, "collection">; usersCollection: string };

export interface DemoUserResult {
  email: string;
  uid: string;
  status: "created" | "password-reset" | "left-alone";
  /** Only for a created or reset account. Shown once; the caller must not store it. */
  password?: string;
}

export function checkDemoEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  for (const e of emails) {
    if (!EMAIL_RE.test(e)) throw new Error(`"${e}" is not an email address`);
    seen.add(e.toLowerCase());
  }
  if (seen.size === 0) throw new Error("no demo user emails given");
  if (seen.size > 20) throw new Error("at most 20 demo users");
  return [...seen];
}

export async function applyDemoUsers(
  deps: DemoDeps,
  emails: string[],
  options: { resetPasswords?: boolean } = {}
): Promise<DemoUserResult[]> {
  const list = checkDemoEmails(emails);
  // Before any account is made: a wrong project or an undeployed store fails here.
  try {
    await deps.db.collection(deps.usersCollection).limit(1).get();
  } catch (err) {
    throw new Error(
      `cannot read the operator store (${deps.usersCollection}); no account was created: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  const results: DemoUserResult[] = [];
  for (const email of list) {
    let existing: { uid: string } | undefined;
    try {
      existing = await deps.auth.getUserByEmail(email);
    } catch (err) {
      if ((err as { code?: string }).code !== "auth/user-not-found") throw err;
    }
    if (existing !== undefined && options.resetPasswords !== true) {
      results.push({ email, uid: existing.uid, status: "left-alone" });
      continue;
    }
    const password = generatePassword();
    let uid: string;
    let status: DemoUserResult["status"];
    if (existing === undefined) {
      uid = (await deps.auth.createUser({ email, password, emailVerified: true })).uid;
      status = "created";
    } else {
      uid = existing.uid;
      await deps.auth.updateUser(uid, { password, emailVerified: true, disabled: false });
      await deps.auth.revokeRefreshTokens(uid);
      status = "password-reset";
    }
    if (!isValidUid(uid)) throw new Error("the account's uid is not usable as a document id");
    await deps.db.collection(deps.usersCollection).doc(uid).set({ roles: ["operator"] });
    results.push({ email, uid, status, password });
  }
  return results;
}

/** Delete the accounts and their operator records. An email with no account is skipped. Returns how many were removed. */
export async function removeDemoUsers(deps: DemoDeps, emails: string[]): Promise<number> {
  let removed = 0;
  for (const email of checkDemoEmails(emails)) {
    let uid: string;
    try {
      uid = (await deps.auth.getUserByEmail(email)).uid;
    } catch (err) {
      if ((err as { code?: string }).code === "auth/user-not-found") continue;
      throw err;
    }
    if (!isValidUid(uid)) throw new Error("the account's uid is not usable as a document id");
    await deps.db.collection(deps.usersCollection).doc(uid).delete();
    await deps.auth.deleteUser(uid);
    removed++;
  }
  return removed;
}
