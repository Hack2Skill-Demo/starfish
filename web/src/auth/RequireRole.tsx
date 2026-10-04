/**
 * RequireRole — route guard.
 *
 * Signed out → try to start a guest session (the public demo opens with no sign-in, #12), and
 * only if that is not possible → /signin. A guest passes where `allowGuest` is set and is sent
 * to /signin elsewhere. No Starfish role, or not an allowed one → /access-denied.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth, STARFISH_ROLES, type StarfishRole } from "./authCore";

export function RequireRole({
  children,
  allowedRoles,
  allowGuest = false,
}: {
  children: ReactNode;
  /** If set, the user needs one of these. If empty/unset, any Starfish role passes. */
  allowedRoles?: StarfishRole[];
  /** Whether a guest (an anonymous, read-only session) may see this route. */
  allowGuest?: boolean;
}) {
  const { user, roles, loading, guest, enterAsGuest } = useAuth();
  const location = useLocation();
  const [guestUnavailable, setGuestUnavailable] = useState(false);

  // A visitor with no session becomes a guest if the project allows it. The token event that
  // follows sets `user`; if it can't happen, fall through to the sign-in page.
  const signedOut = !loading && !user;
  useEffect(() => {
    if (!signedOut) return;
    let cancelled = false;
    void enterAsGuest().then((ok) => {
      if (!cancelled && !ok) setGuestUnavailable(true);
    });
    return () => {
      cancelled = true;
    };
  }, [signedOut, enterAsGuest]);

  const waiting = (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-gray-600 dark:text-gray-400">Loading...</div>
    </div>
  );

  if (loading) return waiting;
  if (!user) {
    if (guestUnavailable) return <Navigate to="/signin" state={{ from: location }} replace />;
    return waiting;
  }
  if (guest) {
    // A guest holds no role: they pass where guests are allowed, and otherwise sign in.
    return allowGuest ? <>{children}</> : <Navigate to="/signin" state={{ from: location }} replace />;
  }
  if (!roles.some((r) => STARFISH_ROLES.includes(r))) return <Navigate to="/access-denied" replace />;
  if (allowedRoles?.length && !roles.some((r) => allowedRoles.includes(r))) {
    return <Navigate to="/access-denied" replace />;
  }
  return <>{children}</>;
}
