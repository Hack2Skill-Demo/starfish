/**
 * The status changes a person may make to an incident: acknowledge, resolve, ignore, reopen. Pure and shared: the
 * operator UI (web/src/lib/incidents.ts) offers exactly these, firestore.rules (`validTransition`) enforces the same
 * table against the stored status for an operator's write, and the public demo's open actions (src/publicDemo.ts) apply
 * it on the server for a visitor's. Change all three together.
 *
 * Reopen applies only to an ignored incident. A person never reopens a resolved one: the engine does, as `recurred`,
 * when its error actually fires again (src/ingest/store.ts). `recurred` is open, so it can be acknowledged, resolved or
 * ignored like any other open incident (#410: acknowledging is what stops a phone escalation, and a regression rings). `logged` and `recurred` are never a target: only the engine sets them.
 *
 * No imports, so the browser can import it too. The statuses are INCIDENT_STATUSES in src/types.ts (a test pins it).
 */

export const INCIDENT_ACTIONS = ["acknowledge", "resolve", "ignore", "reopen"] as const;
export type IncidentAction = (typeof INCIDENT_ACTIONS)[number];

export const TRIAGE_STATUSES = ["new", "acknowledged", "logged", "resolved", "recurred", "ignored"] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];
export const isTriageStatus = (v: unknown): v is TriageStatus => typeof v === "string" && (TRIAGE_STATUSES as readonly string[]).includes(v);

export const isIncidentAction = (v: unknown): v is IncidentAction => typeof v === "string" && (INCIDENT_ACTIONS as readonly string[]).includes(v);

/** The status an action moves to, or null when it doesn't apply from the current status. */
export function nextStatus(current: TriageStatus, action: IncidentAction): TriageStatus | null {
  const open = current === "new" || current === "acknowledged" || current === "logged" || current === "recurred";
  switch (action) {
    case "acknowledge":
      // A logged incident (the agent filed its issue) is still nobody's until a person takes it; so is a regression,
      // whose history stays on the incident (`recurrenceCount`, `lastResolution`). Taking it is what stops the calls (#410).
      return current === "new" || current === "logged" || current === "recurred" ? "acknowledged" : null;
    case "resolve":
      return open ? "resolved" : null;
    case "ignore":
      return open ? "ignored" : null;
    case "reopen":
      return current === "ignored" ? "new" : null;
  }
}
