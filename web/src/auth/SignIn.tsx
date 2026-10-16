/**
 * SignIn — email + password on Firebase
 * Auth; the route guard resolves roles and routes the operator on from here.
 * On the public demo it also offers the guest view (#12), for a visitor who
 * lands here (after signing out, or from a guest's "Sign in" link) without an account.
 * There it also says where the sign-in details are (`signInHint`, never the credentials) and that a visitor without
 * them can still look around in the view-only demo, with fewer details and features, and choosing the
 * demo view is remembered (`markGuestViewChosen`) so the app stops asking that visitor to sign in.
 *
 * With the open actions on (`publicDemoActionsOn`), a visitor has every operator action already, so /signin does not ask
 * them for anything: it opens the demo by itself and goes on to the page they asked for. The form is the team's, behind
 * a "Team sign-in" link (`?team=1`, `signInPath`); it is also what shows when the demo cannot be opened.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { signInWithEmailAndPassword } from "firebase/auth";
import { Loader2, Eye, EyeOff, AlertCircle } from "lucide-react";
import PageMeta from "../components/PageMeta";
import { SourceLink } from "../components/SourceLink";
import { Button } from "../components/ui/Button";
import { firebaseAuth } from "../lib/firebase";
import { StarfishLogo } from "../layout/StarfishLogo";
import { offersGuestView, publicDemoActionsOn, TEAM_SIGNIN_PARAM } from "../lib/dataSource";
import { markGuestViewChosen, signInHint } from "../lib/demoGuide";
import { useAuth } from "./authCore";

/** Firebase Auth error code → message. Never reveals whether the email exists. */
export function signInErrorMessage(code: string | undefined): string {
  switch (code) {
    case "auth/invalid-email":
      return "Invalid email address";
    case "auth/user-disabled":
      return "This account has been disabled";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Invalid email or password";
    case "auth/too-many-requests":
      return "Too many failed attempts. Please try again later.";
    default:
      return "Sign in failed. Please try again.";
  }
}

const inputClass =
  "h-11 w-full rounded-lg border border-gray-200 bg-transparent px-4 py-2.5 text-sm shadow-xs placeholder:text-gray-500 focus:border-brand-300 focus:outline-none focus:ring focus:ring-brand-500/10 disabled:bg-gray-100 disabled:text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-gray-400 dark:disabled:bg-gray-800";

/**
 * Where to go after signing in: the page the route guard bounced the operator
 * from (RequireRole passes it as `state.from`), else the incident list. Only an
 * in-app path is honoured, never the sign-in page itself.
 */
export function returnPath(state: unknown): string {
  const from = (state as { from?: { pathname?: unknown; search?: unknown } } | null)?.from;
  const pathname = typeof from?.pathname === "string" ? from.pathname : "";
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname === "/signin") return "/overview";
  return pathname + (typeof from?.search === "string" ? from.search : "");
}

export function SignIn() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user, guest, loading, enterAsGuest } = useAuth();
  const [enteringGuest, setEnteringGuest] = useState(false);
  const [params] = useSearchParams();
  // The open demo, for anyone not signed in to an account and not asking for the form: no sign-in at all.
  const demoFirst = publicDemoActionsOn() && params.get(TEAM_SIGNIN_PARAM) === null && (guest || !user);
  const [demoFailed, setDemoFailed] = useState(false);
  const autoStarted = useRef(false);

  // The guest session is in once the token event has set it: navigating before that would
  // reach the route guard with nobody signed in. The open demo goes on to the page asked for. A visitor who chose Team
  // sign-in while the demo was still opening stays on the form when the session lands: only the demo view's own button
  // (`enteringGuest`) or the open demo's page leaves it.
  useEffect(() => {
    if (!guest) return;
    if (demoFirst && !demoFailed) navigate(returnPath(location.state), { replace: true });
    else if (enteringGuest) navigate("/overview", { replace: true });
  }, [enteringGuest, demoFirst, demoFailed, guest, navigate, location.state]);

  const unavailable = "The demo view isn't available right now. Please try again later.";
  const startGuest = async (): Promise<boolean> => {
    markGuestViewChosen();
    return enterAsGuest({ requested: true });
  };

  const handleGuest = async () => {
    setError(null);
    setEnteringGuest(true);
    if (!(await startGuest())) {
      setEnteringGuest(false);
      setError(unavailable);
    }
  };

  // The open demo starts the guest session itself, once; if it cannot, the form is shown with the reason.
  useEffect(() => {
    if (!demoFirst || loading || user || autoStarted.current) return;
    autoStarted.current = true;
    void startGuest().then((ok) => {
      if (ok) return;
      setError(unavailable);
      setDemoFailed(true);
    });
  });

  if (demoFirst && !demoFailed) {
    return (
      <>
        <PageMeta title="Starfish demo" description="Opening the public demo" />
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gray-50 px-4 text-center dark:bg-gray-900">
          <h1 className="sr-only">Starfish</h1>
          <div className="dark:hidden">
            <StarfishLogo variant="lockup" tone="light" size={56} title="" />
          </div>
          <div className="hidden dark:block">
            <StarfishLogo variant="lockup" tone="dark" size={56} title="" />
          </div>
          <p role="status" className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Opening the demo…
          </p>
          <p className="max-w-sm text-xs text-gray-500 dark:text-gray-400">
            No sign-in needed. Actions are limited per IP address to protect our cloud and model billing.
          </p>
          <Link
            to={`/signin?${TEAM_SIGNIN_PARAM}=1`}
            state={location.state}
            className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            Team sign-in
          </Link>
        </div>
      </>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim()) return setError("Email is required");
    if (!password) return setError("Password is required");

    setIsLoading(true);
    try {
      await signInWithEmailAndPassword(firebaseAuth(), email.trim(), password);
      navigate(returnPath(location.state), { replace: true });
    } catch (err) {
      setError(signInErrorMessage((err as { code?: string }).code));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <PageMeta title="Sign In | Starfish" description="Sign in to continue" />
      <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
        <div className="w-full max-w-md">
          <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-lg dark:border-gray-800 dark:bg-gray-800">
            <div className="mb-8 text-center">
              <h1 className="sr-only">Starfish</h1>
              <div className="mb-4 flex justify-center dark:hidden">
                <StarfishLogo variant="lockup" tone="light" size={56} title="" />
              </div>
              <div className="mb-4 hidden justify-center dark:flex">
                <StarfishLogo variant="lockup" tone="dark" size={56} title="" />
              </div>
            </div>

            {offersGuestView() && (
              <p className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
                <span className="font-medium text-gray-900 dark:text-white">Public demo.</span> {signInHint()}
                {(guest || !user) &&
                  (publicDemoActionsOn() ? (
                    <span className="mt-2 block">
                      No sign-in details? Open the demo below: no sign-in is needed to triage incidents, retry a run or
                      start the agent. Those actions are limited per IP address to protect our cloud and model billing.
                    </span>
                  ) : (
                    <span className="mt-2 block">
                      No sign-in details? You can still look around in the view-only demo below. It shows fewer details
                      (no stack traces, error detail, Gemini's reasoning or patches) and none of the triage or admin
                      actions.
                    </span>
                  ))}
              </p>
            )}

            {error && (
              <div
                role="alert"
                className="mb-6 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
              >
                <AlertCircle className="h-5 w-5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
              <div>
                <label htmlFor="email" className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  disabled={isLoading}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    disabled={isLoading}
                    className={`${inputClass} pr-12`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    disabled={isLoading}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700 disabled:cursor-not-allowed dark:text-gray-400 dark:hover:text-gray-300"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>
              <Button type="submit" disabled={isLoading} className="w-full">
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  "Sign In"
                )}
              </Button>
            </form>

            {offersGuestView() && (guest || !user) && (
              <div className="mt-6 border-t border-gray-200 pt-6 text-center text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
                No account?{" "}
                {guest ? (
                  <Link
                    to="/overview"
                    onClick={markGuestViewChosen}
                    className="font-medium text-brand-700 hover:underline dark:text-brand-400"
                  >
                    See the demo view
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleGuest()}
                    disabled={enteringGuest || isLoading}
                    className="font-medium text-brand-700 hover:underline disabled:cursor-not-allowed disabled:opacity-60 dark:text-brand-400"
                  >
                    {enteringGuest ? "Opening the demo view..." : "See the demo view"}
                  </button>
                )}
                <span className="mt-1 block text-xs">
                  {publicDemoActionsOn() ? "No sign-in needed; actions limited per IP address." : "Read-only, no sign-in needed."}
                </span>
              </div>
            )}
          </div>
          <div className="mt-4 text-center text-xs">
            <SourceLink />
          </div>
        </div>
      </div>
    </>
  );
}
