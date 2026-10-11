/**
 * The public demo's welcome guide (#12): what a first-time visitor is told, and what this browser remembers about it.
 * Only a build for the demo environment shows it (`offersGuestView`); a private deployment never does.
 *
 * Two per-browser marks, both conveniences: storage that is blocked or cleared only means the guide shows again.
 *   - the guide was seen (it opens by itself once, and from the header any time);
 *   - the visitor chose the view-only demo themselves (the sign-in page's "See the demo view", or "Continue view-only"
 *     in the guide), so the guide and the guest bar stop asking them to sign in. A visitor who was made a guest on
 *     arrival, without choosing it, is asked.
 */
import { webConfig } from "./config";

const SEEN_KEY = "starfish.demo.welcomeSeen";
const CHOSE_GUEST_KEY = "starfish.demo.guestChosen";

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function mark(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Private mode or blocked storage: the guide just won't remember.
  }
}

export const hasSeenWelcome = (): boolean => read(SEEN_KEY);
export const markWelcomeSeen = (): void => mark(SEEN_KEY);
export const hasChosenGuestView = (): boolean => read(CHOSE_GUEST_KEY);
export const markGuestViewChosen = (): void => mark(CHOSE_GUEST_KEY);

/** Where the sign-in email and password are: the deployment's own line, else a generic one. Never the credentials. */
export function signInHint(): string {
  return webConfig().demoSignInHint || "Use the email and password you were given.";
}
