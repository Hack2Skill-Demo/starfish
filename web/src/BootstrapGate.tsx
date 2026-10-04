/**
 * BootstrapGate — holds the app back until the web config has resolved.
 *
 * Everything below it may call `webConfig()` synchronously. A failure is shown
 * with its cause rather than as a blank page: the usual one is a build served
 * from somewhere other than Firebase Hosting, with no VITE_FIREBASE_* values set.
 */
import { useEffect, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { bootstrapWebConfig } from "./lib/config";

type State = { status: "loading" } | { status: "ready" } | { status: "failed"; message: string };

export function BootstrapGate({ children, bootstrap = bootstrapWebConfig }: { children: ReactNode; bootstrap?: () => Promise<unknown> }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    bootstrap().then(
      () => !cancelled && setState({ status: "ready" }),
      (err: unknown) =>
        !cancelled && setState({ status: "failed", message: err instanceof Error ? err.message : String(err) })
    );
    return () => {
      cancelled = true;
    };
  }, [bootstrap]);

  if (state.status === "ready") return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
      {state.status === "loading" ? (
        <div className="text-gray-500 dark:text-gray-400">Loading...</div>
      ) : (
        <div role="alert" className="w-full max-w-md rounded-lg bg-white p-8 shadow-lg dark:bg-gray-800">
          <TriangleAlert className="mb-4 h-8 w-8 text-error-600 dark:text-error-400" />
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">Starfish could not start</h1>
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">{state.message}</p>
        </div>
      )}
    </div>
  );
}
