/**
 * Which credentials the agent job holds, recorded for the Settings page (`{runCollection}/integrations`).
 *
 * The secrets are mounted on the agent job only (docs/deploy.md), so the browser cannot see them and the
 * engine's own ingest job does not have them. The agent states at the start of each pass whether each one is
 * set. Booleans only: never a value, a length or a prefix, because guests may read the record. "Set" is not
 * "works": nothing here calls the service, and the page says "configured", never "connected".
 */
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";

export const INTEGRATIONS_DOC = "integrations";

export interface IntegrationPresence {
  github: boolean;
  slackOnCall: boolean;
  slackAlerts: boolean;
  twilio: boolean;
}

/** Best effort, like the last run: the pass does not depend on the record. Returns whether it was written. */
export async function recordIntegrations(
  db: Firestore,
  config: Pick<StarfishConfig, "runCollection" | "environment">,
  presence: IntegrationPresence,
  now: Date = new Date()
): Promise<boolean> {
  try {
    await db.collection(config.runCollection).doc(INTEGRATIONS_DOC).set({
      environment: config.environment,
      checkedAt: Timestamp.fromDate(now),
      github: presence.github,
      slackOnCall: presence.slackOnCall,
      slackAlerts: presence.slackAlerts,
      twilio: presence.twilio,
    });
    return true;
  } catch {
    return false;
  }
}
