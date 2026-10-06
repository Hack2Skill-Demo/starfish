/**
 * Grant a person access to the operator UI: write their operator record ({usersCollection}/{uid}.roles),
 * the record firestore.rules and the UI read. `starfish_users` is closed to every client, so the first
 * admin of a deployment can only be made from the Admin SDK or the console; this is that, as a tool.
 *
 * It sets the roles it is given and nothing else (re-running with fewer roles removes the others), and
 * it never handles a password: a person who has no account yet is created without one and gets a
 * password-reset link to set their own.
 *
 * It refuses an existing account whose email is not verified (#139): with self sign-up on, anyone holding the public
 * web API key can register `ops@victim.com` with a password of their choosing before the owner runs this, and the
 * roles would then go to the attacker's uid. An account this run created, or one the person running it vouches for
 * with `--trust-existing` (after reading its creation time and providers, which the result carries), is let through.
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
  /** Present for a created account, or when a link was asked for: the link the person opens to choose a password. */
  passwordResetLink?: string;
  /** What Auth says about the account, for the person running the grant to check it is the one they mean. */
  account: AccountFacts;
}

export interface AccountFacts {
  emailVerified: boolean;
  /** When Auth says the account was made (its own string), or null if it did not say. */
  creationTime: string | null;
  /** The sign-in providers linked to it ("password", "google.com", ...); empty for an account with none. */
  providers: string[];
}

type AuthUser = {
  uid: string;
  emailVerified?: boolean;
  metadata?: { creationTime?: string };
  providerData?: { providerId: string }[];
};

function accountFacts(user: AuthUser): AccountFacts {
  return {
    emailVerified: user.emailVerified === true,
    creationTime: typeof user.metadata?.creationTime === "string" ? user.metadata.creationTime : null,
    providers: (user.providerData ?? []).map((p) => p.providerId),
  };
}

/** One line a person can read before trusting an account: "created <time>, providers <list>, email (not) verified". */
export function describeAccount(facts: AccountFacts): string {
  return (
    `created ${facts.creationTime ?? "(unknown)"}, providers ${facts.providers.length > 0 ? facts.providers.join(",") : "(none)"}, ` +
    `email ${facts.emailVerified ? "verified" : "NOT verified"}`
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function grantOperator(
  deps: {
    auth: Pick<Auth, "getUserByEmail" | "createUser" | "generatePasswordResetLink">;
    db: Pick<Firestore, "collection">;
    usersCollection: string;
  },
  request: {
    email: string;
    roles: OperatorRole[];
    createAccount: boolean;
    resetLink?: boolean;
    /** Grant to an existing account whose email is not verified. The person running the grant vouches for it. */
    trustExisting?: boolean;
  }
): Promise<GrantResult> {
  const email = request.email.trim();
  if (!EMAIL_RE.test(email)) throw new Error("not an email address");

  // Before any account is created: a wrong project (or a store that was never deployed) must fail here, not after an
  // Auth user has already been made in the wrong place. A read of the collection is enough; Firestore says NOT_FOUND
  // for a database that does not exist.
  try {
    await deps.db.collection(deps.usersCollection).limit(1).get();
  } catch (err) {
    throw new Error(
      `cannot read the operator store (${deps.usersCollection}); no account was created: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  let created = false;
  let user: AuthUser;
  try {
    user = await deps.auth.getUserByEmail(email);
  } catch (err) {
    if ((err as { code?: string }).code !== "auth/user-not-found") throw err;
    if (!request.createAccount) {
      throw new Error("no account for that email; create it in the console, or pass --create", { cause: err });
    }
    user = await deps.auth.createUser({ email });
    created = true;
  }
  const uid = user.uid;
  const account = accountFacts(user);
  if (!isValidUid(uid)) throw new Error("the account's uid is not usable as a document id");
  // An account this run did not make, with an email nobody has proved they own, may be a stranger's sign-up (#139).
  if (!created && !account.emailVerified && request.trustExisting !== true) {
    throw new Error(
      `refusing: an account for that email already exists and its email is not verified (${describeAccount(account)}). ` +
        "Anyone can sign up with any address while self sign-up is on. If you made this account yourself, pass " +
        "--trust-existing; otherwise delete it in the Firebase console and re-run with --create. Nothing was written."
    );
  }

  await deps.db.collection(deps.usersCollection).doc(uid).set({ roles: request.roles });

  return {
    uid,
    created,
    account,
    ...((created || request.resetLink === true) && { passwordResetLink: await deps.auth.generatePasswordResetLink(email) }),
  };
}
