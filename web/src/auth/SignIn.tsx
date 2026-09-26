/**
 * SignIn — email + password on Firebase
 * Auth; the route guard resolves roles and routes the operator on from here.
 */
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { sendPasswordResetEmail, signInWithEmailAndPassword } from "firebase/auth";
import { Loader2, Eye, EyeOff, AlertCircle } from "lucide-react";
import PageMeta from "../components/PageMeta";
import { Button } from "../components/ui/Button";
import { firebaseAuth } from "../lib/firebase";
import { StarfishLogo } from "../layout/StarfishLogo";

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

function resetErrorMessage(code: string | undefined): string {
  if (code === "auth/invalid-email") return "Invalid email address";
  if (code === "auth/too-many-requests") return "Too many requests. Please try again later.";
  return "Could not send the reset link. Please try again.";
}

const inputClass =
  "h-11 w-full rounded-lg border border-gray-200 bg-transparent px-4 py-2.5 text-sm shadow-xs placeholder:text-gray-400 focus:border-brand-300 focus:outline-none focus:ring focus:ring-brand-500/10 disabled:bg-gray-100 disabled:text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-white/30 dark:disabled:bg-gray-800";

/**
 * Where to go after signing in: the page the route guard bounced the operator
 * from (RequireRole passes it as `state.from`), else the incident list. Only an
 * in-app path is honoured, never the sign-in page itself.
 */
export function returnPath(state: unknown): string {
  const from = (state as { from?: { pathname?: unknown; search?: unknown } } | null)?.from;
  const pathname = typeof from?.pathname === "string" ? from.pathname : "";
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname === "/signin") return "/incidents";
  return pathname + (typeof from?.search === "string" ? from.search : "");
}

export function SignIn() {
  const navigate = useNavigate();
  const location = useLocation();
  const [resetMode, setResetMode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!email.trim()) return setError("Email is required");
    if (!resetMode && !password) return setError("Password is required");

    setIsLoading(true);
    try {
      if (resetMode) {
        await sendPasswordResetEmail(firebaseAuth(), email.trim());
        setNotice("If an account exists for this email, you’ll receive a password reset link.");
      } else {
        await signInWithEmailAndPassword(firebaseAuth(), email.trim(), password);
        navigate(returnPath(location.state), { replace: true });
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (resetMode && (code === "auth/user-not-found" || code === "auth/user-disabled")) {
        setNotice("If an account exists for this email, you’ll receive a password reset link.");
      } else {
        setError(resetMode ? resetErrorMessage(code) : signInErrorMessage(code));
      }
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

            {error && (
              <div
                role="alert"
                className="mb-6 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
              >
                <AlertCircle className="h-5 w-5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <h2 className="mb-5 text-center text-xl font-semibold dark:text-white">
              {resetMode ? "Reset password" : "Sign in"}
            </h2>
            {notice && <p role="status" className="mb-5 text-sm text-gray-600 dark:text-gray-300">{notice}</p>}
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
              {!resetMode && <div>
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
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed dark:hover:text-gray-300"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>}
              <Button type="submit" disabled={isLoading} className="w-full">
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {resetMode ? "Sending..." : "Signing in..."}
                  </>
                ) : (
                  resetMode ? "Send reset link" : "Sign In"
                )}
              </Button>
            </form>
            <button type="button" disabled={isLoading} className="mt-5 w-full text-sm text-brand-600 hover:underline disabled:opacity-50"
              onClick={() => { setResetMode(!resetMode); setError(null); setNotice(null); setPassword(""); }}>
              {resetMode ? "Back to sign in" : "Forgot password?"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
