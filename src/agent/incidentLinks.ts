/**
 * The incident's links to its GitHub issue and fix pull request (#194): the cycle's run record (`summary.issue`,
 * `summary.pr`, `summary.prState`) is the source of truth; these copy the number, URL and PR state onto the incident
 * document (`githubIssueNumber/Url`, `githubPrNumber/Url/State`) so the Incidents page can link them.
 *
 * Only those fields are written, in a transaction, and only while the incident is still in the cycle's recurrence
 * (`recurrenceCount` equals the cycle's `recurrence`, same environment): the store's recurrence update clears them
 * (src/ingest/store.ts), and a late write from the cycle of a fix that failed must not put them back on the regression.
 * The status is never touched: an issue filed is not `logged`, and a merged PR is not `resolved`.
 *
 * Best effort, and never throws: the links are a convenience for the UI, and the cycle has already recorded them.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { CycleKey, RunEvent } from "./cycle.js";

export type IncidentLink =
  | { kind: "issue"; number: number; url: string }
  | { kind: "pr"; number: number; url: string }
  | { kind: "pr-state"; number: number; state: "open" | "closed" | "merged"; url?: string };

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//.test(v) && v.length <= 500;

/** The link a recorded run event carries: an issue filed, or a pull request opened. Null for every other event. */
export function linkFromEvent(event: RunEvent): IncidentLink | null {
  if (event.type !== "opened" || !event.record) return null;
  const { number, url } = event.record;
  if (!isNumber(number) || !isUrl(url)) return null;
  if (event.stage === "issue") return { kind: "issue", number, url };
  if (event.stage === "pr" && event.record.opened === true) return { kind: "pr", number, url };
  return null;
}

/** Copy one link onto the incident. Returns whether it was written; never throws. */
export async function linkIncident(db: Firestore, incidentCollection: string, key: CycleKey, link: IncidentLink): Promise<boolean> {
  try {
    const ref = db.collection(incidentCollection).doc(key.incidentId);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.data();
      if (!snap.exists || d === undefined) return false;
      const recurrence = typeof d.recurrenceCount === "number" ? d.recurrenceCount : 0;
      if (d.environment !== key.environment || recurrence !== key.recurrence) return false;
      if (link.kind === "issue") {
        tx.update(ref, { githubIssueNumber: link.number, githubIssueUrl: link.url });
      } else if (link.kind === "pr") {
        // A pull request is open when it is opened; reconcile.ts records what happens to it afterwards, which a resumed
        // attempt re-linking the same PR must not overwrite.
        tx.update(ref, { githubPrNumber: link.number, githubPrUrl: link.url, ...(d.githubPrNumber !== link.number && { githubPrState: "open" }) });
      } else {
        // Written in full on every read reconcile.ts makes, so a link whose first copy failed (the open's, or an earlier
        // state's) is repaired by the next read. Never over another pull request's link.
        if (d.githubPrNumber !== undefined && d.githubPrNumber !== link.number) return false;
        tx.update(ref, { githubPrNumber: link.number, githubPrState: link.state, ...(link.url !== undefined && isUrl(link.url) && { githubPrUrl: link.url }) });
      }
      return true;
    });
  } catch {
    return false;
  }
}
