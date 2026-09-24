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
};

export const Ctx = createContext<StarfishAuthCtx | null>(null);

export const useAuth = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside StarfishAuthProvider");
  return v;
};
