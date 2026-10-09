/**
 * Where the data hooks read incidents, cycles and run events from: THE one switch between a guest and everyone else.
 *
 * An operator or an admin reads the documents the engine stores. A guest (an anonymous session on the public demo, #12)
 * may not (#18): firestore.rules serves a guest only the trimmed copies the engine writes for the demo environment
 * (src/publicView.ts), which keep the stored field names, so the same parsers read both. What a copy leaves out (error
 * detail, stack traces, the model's words, event payloads) is simply absent, and the pages show nothing for it.
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

export function dataSource(): DataSource {
  const c = webConfig();
  return isGuestSession()
    ? { guest: true, incidents: c.publicIncidentCollection, cycles: c.publicCycleCollection, publicEvents: c.publicEventCollection }
    : { guest: false, incidents: c.incidentCollection, cycles: c.cycleCollection };
}
