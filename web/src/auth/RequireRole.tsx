/**
 * RequireRole — route guard.
 * Signed out → /signin. No Starfish role, or not an allowed one → /access-denied.
 */
import { type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth, STARFISH_ROLES, type StarfishRole } from "./authCore";

export function RequireRole({
  children,
  allowedRoles,
}: {
  children: ReactNode;
  /** If set, the user needs one of these. If empty/unset, any Starfish role passes. */
  allowedRoles?: StarfishRole[];
}) {
  const { user, roles, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }
  if (!user) return <Navigate to="/signin" state={{ from: location }} replace />;
  if (!roles.some((r) => STARFISH_ROLES.includes(r))) return <Navigate to="/access-denied" replace />;
  if (allowedRoles?.length && !roles.some((r) => allowedRoles.includes(r))) {
    return <Navigate to="/access-denied" replace />;
  }
  return <>{children}</>;
}
