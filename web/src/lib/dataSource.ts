/**
 * Where the data hooks read incidents, cycles and run events from: THE one switch between a guest and everyone else.
 *
 * An operator or an admin reads the documents the engine stores. A guest (an anonymous session on the public demo, #12)
 * may not (#18): firestore.rules serves a guest only the trimmed copies the engine writes for the demo environment
 * (src/publicView.ts), which keep the stored field names, so the same parsers read both. What a copy leaves out (error
 * detail, stack traces, the model's words, event payloads) is simply absent, and the pages show nothing for it.
 *
 * The public demo's open actions (`VITE_STARFISH_PUBLIC_DEMO_ACTIONS`, a demo build only, off by default): a guest then
 * reads the stored documents too (firestore.rules serve them while the engine's gate document is on), and gets the
 * operator's controls, which send each action to the admin API (`actsThroughAdminApi`): a guest never writes Firestore.
 *
 * Decided from the signed-in user at the moment of the read. The pages read only once the session is resolved
 * (RequireRole), and a change of identity clears the cache and remounts them (StarfishAuthProvider), so a read never
 * outlives the session it was made for.
 */
import { firebaseAuth } from "./firebase";
import { webConfig } from "./config";

export interface DataSource {
  /** The trimmed copies, for a guest. */
  guest: boolean;
  incidents: string;
  cycles: string;
  /**
   * A guest's run events: one flat collection of copies (`{cycleId}_{seq}`, with a `cycleId` field). Absent for everyone
   * else, who reads `{cycles}/{id}/events`.
   */
  publicEvents?: string;
}

/**
 * The one environment firestore.rules serves a guest, and the engine's default STARFISH_PUBLIC_ENVIRONMENTS. A build for
 * any other environment would show a guest nothing, so only this one offers the guest view on the sign-in page.
 */
export const PUBLIC_DEMO_ENVIRONMENT = "demo";

/** Whether this build is the public demo, so the sign-in page offers the guest view. */
export function offersGuestView(): boolean {
  return webConfig().environment === PUBLIC_DEMO_ENVIRONMENT;
}

/** True for an anonymous session: the public demo's guest. */
export function isGuestSession(): boolean {
  return firebaseAuth().currentUser?.isAnonymous === true;
}

/** The public demo's open actions are on for this build: the flag, on a demo build only. */
export function publicDemoActionsOn(): boolean {
  const c = webConfig();
  return c.publicDemoActions && c.environment === PUBLIC_DEMO_ENVIRONMENT;
}

/** This viewer's actions go to the admin API instead of Firestore: a guest, with the open actions on and an admin API to call. */
export function actsThroughAdminApi(): boolean {
  // The build flag first: with it off (every build but an open demo) nothing else is looked at.
  return publicDemoActionsOn() && Boolean(webConfig().adminApiUrl) && isGuestSession();
}

/**
 * Whether this viewer gets the operator's controls (triage, retry, correction): anyone with a role, and a guest where
 * the open actions are on and there is an admin API to send them to. The server and firestore.rules check again.
 */
export function canOperate(roles: readonly string[], guest: boolean): boolean {
  return roles.length > 0 || (guest && publicDemoActionsOn() && Boolean(webConfig().adminApiUrl));
}

export function dataSource(): DataSource {
  const c = webConfig();
  return isGuestSession() && !publicDemoActionsOn()
    ? { guest: true, incidents: c.publicIncidentCollection, cycles: c.publicCycleCollection, publicEvents: c.publicEventCollection }
    : { guest: false, incidents: c.incidentCollection, cycles: c.cycleCollection };
}
