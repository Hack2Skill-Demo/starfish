/**
 * Reconsidering a declined incident (#8). A decline is a decision on the evidence of its moment, not a verdict for good:
 * an isolated transient that becomes a sustained burst deserves another look. But re-reading the same logs is not new
 * evidence, and a decline that is re-triaged every pass is a model bill with no new answer. So a declined cycle is
 * reopened only when something changed AFTER the decision:
 *
 *   operator   an operator asked for a retriage (`retriageRequestedAt` on the incident, later than the decision; an
 *              operator's write of it is allowed by firestore.rules, but no UI sends it yet);
 *   burst      the incident's occurrences grew by at least `reconsiderBurstOccurrences` since the decision;
 *   cause      the incident's structural cause changed: an error code, name or HTTP status appeared or changed, or a
 *              detail or stack trace became available (ingest backfills these when an error recurs: an incident often
 *              becomes diagnosable only the second time);
 *   reopened   the cycle was not declined on its evidence at all: the loop stopped it because an operator closed the
 *              incident (`incident-ignored`, `incident-resolved`, with no decision recorded), and the incident is open
 *              again, so a person reopened it (#227).
 *
 * and only within bounds: the automatic triggers and `reopened` wait `reconsiderCooldownMinutes` after the decision (or
 * the stop; an operator's retriage request does not wait: a person asked), and a cycle is reconsidered at most
 * `reconsiderMaxPerDay` times in any 24 hours, whoever asks. An incident that is not open, or is retired, is never reconsidered: an operator's resolve or
 * ignore always wins. The daily cycle cap (pass.ts) bounds the spend on top of this.
 *
 * Pure functions: cycle.ts applies them inside the transaction that reopens the cycle, pass.ts to pick candidates.
 */
import { createHash } from "node:crypto";
import type { StarfishConfig } from "../config.js";
import type { Incident } from "../types.js";
import { OPEN_INCIDENT_STATUSES } from "../types.js";

export type ReconsiderPolicy = Pick<StarfishConfig, "reconsiderCooldownMinutes" | "reconsiderMaxPerDay" | "reconsiderBurstOccurrences">;

export type ReconsiderTrigger = "operator" | "burst" | "cause" | "reopened";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many earlier decisions a cycle keeps (`history`); the run events keep everything. */
export const MAX_DECISION_HISTORY = 10;

const ms = (value: unknown): number | undefined => {
  const v = value as { toMillis?: unknown } | null | undefined;
  return typeof v?.toMillis === "function" ? (v.toMillis() as number) : undefined;
};

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * A short key for the incident's STRUCTURAL cause: its class, code, name and HTTP status, and whether a detail and a stack
 * trace are known. Deliberately not the stack or detail text: those differ with every request and deploy, and a key
 * that changed on every occurrence would reopen every decline.
 */
export function causeClass(incident: Pick<Incident, "errorType" | "errorCode" | "errorName" | "httpStatus" | "errorDetail" | "stackTrace">): string {
  const parts = [
    str(incident.errorType),
    str(incident.errorCode),
    str(incident.errorName),
    typeof incident.httpStatus === "number" ? incident.httpStatus : null,
    str(incident.errorDetail) !== null,
    str(incident.stackTrace) !== null,
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** The UTC day of `now`, `YYYY-MM-DD`: what a cycle start is counted under (pass.ts). */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Reconsideration times (millis) of a cycle within the 24 hours before `now`. */
export function recentReconsiderations(cycle: Record<string, unknown>, now: Date): number[] {
  const list = Array.isArray(cycle.reconsideredAt) ? cycle.reconsideredAt : [];
  return list.map(ms).filter((t): t is number => t !== undefined && t > now.getTime() - DAY_MS && t <= now.getTime());
}

/**
 * A cycle the loop settled because the incident was closed under it (loop.ts `haltFor`: `incident-<status>`), not on a
 * triage decision. `incident-gone` is not one: an incident that could not be read was not closed by anyone.
 */
export function stoppedByClose(cycle: Record<string, unknown>): boolean {
  return cycle.decision == null && typeof cycle.outcome === "string" && cycle.outcome.startsWith("incident-") && cycle.outcome !== "incident-gone";
}

/**
 * Why the declined cycle `cycle` should be triaged again now, given the incident document `incident` as stored, or null.
 * Only a `declined` cycle qualifies. A decline with no `decision` has no evidence baseline to compare the burst and cause
 * triggers against: it is reconsidered on an operator's request, or, when the loop stopped it because the incident was
 * closed, once the incident is open again (`reopened`, after the cooldown, #227).
 */
export function reconsiderTrigger(cycle: Record<string, unknown>, incident: Record<string, unknown> | undefined, policy: ReconsiderPolicy, now: Date): ReconsiderTrigger | null {
  if (cycle.state !== "declined" || incident === undefined) return null;
  if (incident.retired === true || !(OPEN_INCIDENT_STATUSES as readonly string[]).includes(String(incident.status))) return null;
  // The cycle is this recurrence's: a regression since has its own cycle.
  const recurrence = typeof incident.recurrenceCount === "number" ? incident.recurrenceCount : 0;
  if (typeof cycle.recurrence === "number" && cycle.recurrence !== recurrence) return null;
  if (recentReconsiderations(cycle, now).length >= policy.reconsiderMaxPerDay) return null;

  const decision = (cycle.decision ?? undefined) as Record<string, unknown> | undefined;
  const decidedAt = ms(decision?.at) ?? ms(cycle.updatedAt);
  if (decidedAt === undefined) return null;

  const requested = ms(incident.retriageRequestedAt);
  if (requested !== undefined && requested > decidedAt && requested <= now.getTime()) return "operator";

  if (now.getTime() - decidedAt < policy.reconsiderCooldownMinutes * 60_000) return null;
  // The incident is open (checked above), so the close that stopped the cycle was undone by a person.
  if (decision === undefined) return stoppedByClose(cycle) ? "reopened" : null;

  const before = decision.occurrenceCount;
  const count = incident.occurrenceCount;
  if (typeof before === "number" && typeof count === "number" && count - before >= policy.reconsiderBurstOccurrences) return "burst";

  const key = str(decision.causeClass);
  if (key !== null && key !== causeClass(incident as Parameters<typeof causeClass>[0])) return "cause";
  return null;
}
