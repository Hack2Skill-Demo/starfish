/**
 * Routes. Public: sign-in and access-denied. Everything else sits behind
 * RequireRole inside the Starfish layout. A guest (an anonymous, read-only session on the
 * public demo) may see the layout, Incidents and a view-only Settings.
 */
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { RequireRole } from "./auth/RequireRole";
import { SignIn } from "./auth/SignIn";
import { AccessDenied } from "./auth/AccessDenied";
import { StarfishLayout } from "./layout/StarfishLayout";

const Incidents = lazy(() => import("./pages/Incidents"));
const Settings = lazy(() => import("./pages/Settings"));
const NotFound = lazy(() => import("./pages/NotFound"));

const pageFallback = <div className="py-12 text-center text-gray-600 dark:text-gray-400">Loading…</div>;

export default function App() {
  return (
    <Suspense fallback={pageFallback}>
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route path="/access-denied" element={<AccessDenied />} />
        <Route
          element={
            <RequireRole allowGuest>
              <StarfishLayout />
            </RequireRole>
          }
        >
          <Route index element={<Navigate to="/incidents" replace />} />
          <Route path="incidents" element={<Incidents />} />
          <Route
            path="settings"
            element={
              <RequireRole allowedRoles={["admin"]} allowGuest>
                <Settings />
              </RequireRole>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
