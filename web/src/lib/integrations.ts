/**
 * Which credentials the agent job says it holds (`{runCollection}/integrations`, written by
 * src/agent/integrations.ts at the start of each pass).
 *
 * Booleans and a time, never a value; guests may read it. "Set" is not "works": the Settings page says
 * "configured", and shows nothing at all until the agent has reported once.
 */
import { doc, getDoc, type Firestore } from "firebase/firestore";

export const INTEGRATIONS_DOC = "integrations";

export interface Integrations {
  environment: string;
  checkedAt: Date;
  github: boolean;
  slackOnCall: boolean;
  slackAlerts: boolean;
  twilio: boolean;
}

/** The record, or null when the agent has not reported (or the record is unusable). */
export async function readIntegrations(db: Firestore, runCollection: string): Promise<Integrations | null> {
  const snap = await getDoc(doc(db, runCollection, INTEGRATIONS_DOC));
  if (!snap.exists()) return null;
  const d = snap.data();
  const checked = (d.checkedAt as { toDate?: () => Date } | undefined)?.toDate?.();
  if (!checked || Number.isNaN(checked.getTime())) return null;
  return {
    environment: typeof d.environment === "string" ? d.environment : "",
    checkedAt: checked,
    github: d.github === true,
    slackOnCall: d.slackOnCall === true,
    slackAlerts: d.slackAlerts === true,
    twilio: d.twilio === true,
  };
}

/** A report for another environment is not this environment's (the label was changed): treated as no report. */
export function reportFor(record: Integrations | null | undefined, environment: string): Integrations | null {
  return record && record.environment === environment ? record : null;
}
