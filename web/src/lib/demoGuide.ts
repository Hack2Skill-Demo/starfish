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
import { publicDemoActionsOn } from "./dataSource";

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

/**
 * What a visitor may do on the public demo, and the limits that protect its billing, or null where the open actions
 * are off (a view-only demo, or any other build): the guide and the guest bar never claim limits that are not active.
 * The numbers are the build's copy of the admin API's limits (`publicLimits`, the engine's defaults unless set), which
 * the admin API enforces per address (the last X-Forwarded-For entry, an IPv6 caller by its /64).
 */
export function visitorActions(): { short: string; full: string; limits: string } | null {
  if (!publicDemoActionsOn()) return null;
  const l = webConfig().publicLimits;
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return {
    short: "No sign-in needed: triage, retry and run the agent · limited per IP address to protect our cloud and model billing",
    full:
      "No sign-in needed: you can acknowledge, resolve or ignore incidents, retry a run, correct triage, and start an ingest run or an agent pass yourself.",
    limits:
      `To protect our cloud and Gemini billing, these actions are limited per IP address: up to ${n(l.actionsPerIpPerHour, "incident action", "incident actions")} ` +
      `and ${n(l.runsPerIpPerHour, "ingest or agent start", "ingest or agent starts")} an hour from one address, and ` +
      `${n(l.agentRunsPerHour, "agent pass", "agent passes")} an hour started by all visitors together. Past a limit you are told when to try again.`,
  };
}

/** Where the sign-in email and password are: the deployment's own line, else a generic one. Never the credentials. */
export function signInHint(): string {
  return webConfig().demoSignInHint || "Use the email and password you were given.";
}
