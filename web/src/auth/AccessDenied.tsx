/**
 * AccessDenied — shown to a signed-in user with no Starfish
 * role. Self-heals: while the session is resolving it waits, and a user who does
 * hold a role is bounced into the app instead of being stranded here.
 */
import { ShieldX } from "lucide-react";
import { Navigate } from "react-router";
import { useAuth, STARFISH_ROLES } from "./authCore";
import { webConfig } from "../lib/config";

export function AccessDenied() {
  const { user, roles, loading, signOut } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }
  if (roles.some((r) => STARFISH_ROLES.includes(r))) return <Navigate to="/incidents" replace />;

  const handleSignOut = async () => {
    try {
      await signOut();
    } finally {
      window.location.href = "/";
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-lg dark:bg-gray-800">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-error-100 dark:bg-error-900">
            <ShieldX className="h-8 w-8 text-error-600 dark:text-error-400" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Access Denied</h1>
        </div>
        <div className="mb-6 space-y-3 text-center">
          <p className="text-gray-600 dark:text-gray-400">You don&apos;t have permission to access Starfish.</p>
          {user?.email && (
            <p className="text-sm text-gray-500">
              Signed in as: <span className="font-medium">{user.email}</span>
            </p>
          )}
          <p className="text-sm text-gray-500">
            An admin grants access by adding a <code>roles</code> array to your record in{" "}
            <code>{webConfig().usersCollection}</code>.
          </p>
        </div>
        <button
          onClick={handleSignOut}
          className="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
