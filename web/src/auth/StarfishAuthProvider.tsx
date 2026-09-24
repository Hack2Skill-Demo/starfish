/**
 * StarfishAuthProvider — the signed-in operator and their roles, app-wide.
 *
 * Operators sign in with Firebase Auth email/password on the default (non-tenant)
 * auth. Roles come from the operator record, read fresh on every token event
 * (see authCore.ts). Each race guard below exists because the failure it
 * prevents — a valid operator stranded or signed out — happens in practice.
 *
 * Sign-out is local only: there is no backend endpoint revoking refresh tokens.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { onIdTokenChanged, type User } from "firebase/auth";
import { useQueryClient } from "@tanstack/react-query";
import { firebaseAuth } from "../lib/firebase";
import { readRoles } from "./session";
import { Ctx, primaryRole, type StarfishRole } from "./authCore";

/**
 * Whether an error is a transient network / unreachable failure rather than a
 * definitive auth failure. Never force sign-out on these: a brief offline blip
 * must keep the session so it recovers when connectivity returns. Firestore
 * reports an unreachable backend as `unavailable` / `deadline-exceeded`; Safari
 * reports a failed fetch as the bare message "Load failed".
 */
export function isNetworkError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  const code = err?.code ?? "";
  const message = err?.message ?? "";
  return (
    code === "auth/network-request-failed" ||
    code === "unavailable" ||
    code === "deadline-exceeded" ||
    message.includes("network") ||
    message.includes("Failed to fetch") ||
    message.includes("Load failed") ||
    message.includes("offline")
  );
}

export function StarfishAuthProvider({
  children,
  resolveRoles = readRoles,
}: {
  children: React.ReactNode;
  /** Injected in tests; production reads the operator record. */
  resolveRoles?: (uid: string) => Promise<StarfishRole[]>;
}) {
  const auth = firebaseAuth();
  const queryClient = useQueryClient();

  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<StarfishRole[]>([]);
  const [loading, setLoading] = useState(true);

  // Monotonic guard so only the NEWEST token-event resolution writes state. Two
  // token events fire in quick succession on first load (restored session, then
  // the forced refresh below); without this, a slower older read landing after a
  // good newer one leaves (loading=false, roles=[]) and RequireRole's redirect to
  // /access-denied strands a valid operator.
  const resolveSeq = useRef(0);

  // Identity of the last resolved token event: a genuine identity change must
  // re-raise the loading gate; a re-validation of the SAME user must not, or every
  // tab refocus remounts the page and discards form input.
  const lastResolvedUid = useRef<string | undefined>(undefined);

  // onIdTokenChanged, not onAuthStateChanged: it also fires on token refresh and
  // revocation, so a revoked role re-resolves promptly.
  useEffect(() => {
    const unsub = onIdTokenChanged(auth, async (fbUser) => {
      const seq = ++resolveSeq.current;
      setUser(fbUser);

      if (!fbUser) {
        lastResolvedUid.current = undefined;
        setRoles([]);
        setLoading(false);
        return;
      }

      if (fbUser.uid !== lastResolvedUid.current) {
        setLoading(true);
      }
      lastResolvedUid.current = fbUser.uid;

      try {
        const resolved = await resolveRoles(fbUser.uid);
        if (seq !== resolveSeq.current) return;
        setRoles(resolved);
        setLoading(false);
      } catch (error) {
        if (seq !== resolveSeq.current) return;
        if (!isNetworkError(error)) {
          // Genuine failure (revoked token, permission denied): fail closed. Leave
          // `loading` true and let the sign-out's null token event settle the gate,
          // rather than flashing Access Denied with the user still set.
          console.debug("[StarfishAuthProvider] roles read failed, signing out:", error);
          queryClient.clear();
          await auth.signOut();
        } else {
          console.debug("[StarfishAuthProvider] roles read failed (network), keeping session:", error);
        }
      }
    });
    return () => unsub();
  }, [auth, queryClient, resolveRoles]);

  // Re-check the token when the tab regains focus: a token revoked elsewhere
  // fails the forced refresh, and we sign out instead of showing stale state.
  const lastTokenCheckRef = useRef(0);
  useEffect(() => {
    const TOKEN_CHECK_COOLDOWN_MS = 30_000;
    const checkTokenValidity = async () => {
      const now = Date.now();
      if (now - lastTokenCheckRef.current < TOKEN_CHECK_COOLDOWN_MS) return;
      lastTokenCheckRef.current = now;
      if (auth.currentUser) {
        try {
          await auth.currentUser.getIdToken(true);
        } catch (error) {
          if (!isNetworkError(error)) {
            console.debug("[StarfishAuthProvider] token invalid, signing out:", error);
            await auth.signOut();
          }
        }
      }
    };
    void checkTokenValidity();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkTokenValidity();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [auth]);

  const signOut = useMemo(() => {
    return async () => {
      // Clear cached incident data (may include redacted-but-sensitive text)
      // before the next operator signs in on this browser.
      queryClient.clear();
      await auth.signOut();
    };
  }, [auth, queryClient]);

  const role = useMemo(() => primaryRole(roles), [roles]);
  const value = useMemo(
    () => ({ user, roles, role, loading, signOut }),
    [user, roles, role, loading, signOut]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
