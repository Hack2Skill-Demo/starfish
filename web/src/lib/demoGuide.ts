/**
 * The public demo's welcome guide (#12): what a first-time visitor is told, and what this browser remembers about it.
 * Only a build for the demo environment shows it (`offersGuestView`); a private deployment never does.
 *
 * Per-browser marks, all conveniences kept in this browser only (nothing reaches the store): storage that is blocked or
 * cleared only means the guide shows again.
 *   - "Don't show this again", a box on the guide's last step: until it is ticked the guide opens by itself once per
 *     tab (sessionStorage), after it never by itself; the header opens it any time;
 *   - the visitor chose the view-only demo themselves (the sign-in page's "See the demo view", or "Continue view-only"
 *     in the guide), so the guide and the guest bar stop asking them to sign in. A visitor who was made a guest on
 *     arrival, without choosing it, is asked.
 */
import { webConfig } from "./config";

const DISMISSED_KEY = "starfish.demo.welcomeDismissed";
const SHOWN_THIS_SESSION_KEY = "starfish.demo.welcomeShownThisSession";
const CHOSE_GUEST_KEY = "starfish.demo.guestChosen";

function read(key: string, storage: () => Storage = () => localStorage): boolean {
  try {
    return storage().getItem(key) === "1";
  } catch {
    return false;
  }
}

function mark(key: string, storage: () => Storage = () => localStorage): void {
  try {
    storage().setItem(key, "1");
  } catch {
    // Private mode or blocked storage: the guide just won't remember.
  }
}

function unmark(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Blocked storage: nothing was remembered to forget.
  }
}

/** Whether the guide should open by itself: not after "Don't show this again", and once per tab. */
export const shouldAutoOpenWelcome = (): boolean =>
  !read(DISMISSED_KEY) && !read(SHOWN_THIS_SESSION_KEY, () => sessionStorage);
export const markWelcomeShownThisSession = (): void => mark(SHOWN_THIS_SESSION_KEY, () => sessionStorage);
export const isWelcomeDismissed = (): boolean => read(DISMISSED_KEY);
export const setWelcomeDismissed = (dismissed: boolean): void =>
  dismissed ? mark(DISMISSED_KEY) : unmark(DISMISSED_KEY);
export const hasChosenGuestView = (): boolean => read(CHOSE_GUEST_KEY);
export const markGuestViewChosen = (): void => mark(CHOSE_GUEST_KEY);

/** Where the sign-in email and password are: the deployment's own line, else a generic one. Never the credentials. */
export function signInHint(): string {
  return webConfig().demoSignInHint || "Use the email and password you were given.";
}
