/**
 * Whether the engine would hold a "Retry with agent" back right now (#456): the daily reopen limit, src/reopenLimit.ts,
 * the same rule src/agent/reconsider.ts applies. Pure; the Runs page gives it the run and the limit the agent's last pass
 * recorded (`agent_last_run.reconsiderMaxPerDay`), so it holds Retry back by the engine's own number.
 *
 * Two sources, the engine's own first:
 *   - the run's reopening times (`reconsideredAt`) and the recorded limit: the rule itself, also before anyone presses Retry;
 *   - without the limit (no pass recorded it yet), the engine's note that it held a retry back (`summary.retryRefused`,
 *     src/agent/cycle.ts `recordRetryRefused`), while the time it gave is still ahead.
 * Neither known: null, and Retry is offered as before; the engine still holds a request over the limit and says so on the run.
 */
import { reopenLimit } from "../../../src/reopenLimit";
import type { CycleRow } from "./runsModel";

export interface RetryHold {
  /** Reopenings within the last 24 hours. */
  reopenings: number;
  maxPerDay: number;
  /** When a retry can start again. */
  nextPossibleAt: Date;
  /** The engine recorded that a retry already asked for is held back: it stands, and can start from `nextPossibleAt`. */
  requestHeld: boolean;
}

const isoMs = (v: unknown): number | undefined => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : undefined);
const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export function retryHold(cycle: Pick<CycleRow, "reopenedAt" | "summary">, maxPerDay: number | undefined, nowMs: number): RetryHold | null {
  const refused = cycle.summary.retryRefused;
  const requestHeld = refused !== undefined && isoMs(refused.requestedAt) !== undefined;
  if (maxPerDay !== undefined && cycle.reopenedAt !== undefined) {
    const limit = reopenLimit(cycle.reopenedAt, maxPerDay, nowMs);
    if (!limit.reached || limit.nextPossibleAtMs === undefined) return null;
    return { reopenings: limit.recent, maxPerDay, nextPossibleAt: new Date(limit.nextPossibleAtMs), requestHeld };
  }
  const next = isoMs(refused?.nextPossibleAt);
  const reopenings = positive(refused?.reopenings);
  const max = positive(refused?.maxPerDay);
  if (!requestHeld || next === undefined || next <= nowMs || reopenings === undefined || max === undefined) return null;
  return { reopenings, maxPerDay: max, nextPossibleAt: new Date(next), requestHeld };
}

/** What the Retry control says while the limit holds it back; `when` is the time as the page formats it. */
export function retryHoldWords(hold: RetryHold, when: string): string {
  const reached = `This run was reopened ${hold.reopenings} ${hold.reopenings === 1 ? "time" : "times"} in 24 hours, the most allowed (${hold.maxPerDay}). A retry can start again at ${when}.`;
  return hold.requestHeld ? `${reached} The retry already asked for stands: the first agent pass after then can start it.` : reached;
}
