/**
 * authCore — Starfish's auth context.
 *
 * Authorization comes from a `roles` ARRAY read fresh from an operator record
 * (`<usersCollection>/{uid}.roles`), NOT a Firebase Auth custom claim. A claim
 * can drift from the record for up to an hour (cached ID token); a record read
 * on every token event makes a revoked role take effect on the next event.
 */
import { createContext, useContext } from "react";
import type { User } from "firebase/auth";

/** Starfish operator roles. Source of truth: `<usersCollection>/{uid}.roles`. */
export type StarfishRole = "admin" | "operator";

/**
 * What a viewer can be for navigation: a Starfish role, or `guest` (an anonymous session on
 * the public demo: read-only, no operator record). `guest` is never stored on a record.
 */
export type ViewerRole = StarfishRole | "guest";

/** All roles, in descending order of privilege. */
export const STARFISH_ROLES: readonly StarfishRole[] = ["admin", "operator"];

/** The highest-privilege role in a roles array, or null. Display only — gate on `roles`. */
export function primaryRole(roles: readonly string[]): StarfishRole | null {
  for (const role of STARFISH_ROLES) {
    if (roles.includes(role)) return role;
  }
  return null;
}

export type StarfishAuthCtx = {
  user: User | null;
  /** Roles resolved fresh from the operator record. The source of truth. */
  roles: StarfishRole[];
  /** Highest-privilege role, derived from `roles`. Display only. */
  role: StarfishRole | null;
  /**
   * True until the session is DEFINITIVELY resolved for the current auth state.
   * Only a successful roles read (or no signed-in user) clears it; a transient
   * failure keeps it true. So empty `roles` with `loading` false always means a
   * real denial, never an in-flight one.
   */
  loading: boolean;
  signOut: () => Promise<void>;
  /**
   * True for an anonymous session: the public demo's read-only guest (issue #12). A guest
   * holds no role and passes only the routes that allow guests.
   */
  guest: boolean;
  /**
   * Try to start a guest session for a signed-out visitor. Resolves true if one started,
   * false if it can't (Anonymous sign-in is off for this project, a network failure, or the
   * visitor just signed out on purpose). Safe to call repeatedly: it makes one attempt.
   * `requested`: the visitor asked for the guest view themselves (the sign-in page's link), which a
   * deliberate sign-out does not block.
   */
  enterAsGuest: (opts?: { requested?: boolean }) => Promise<boolean>;
};

export const Ctx = createContext<StarfishAuthCtx | null>(null);

export const useAuth = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside StarfishAuthProvider");
  return v;
};
