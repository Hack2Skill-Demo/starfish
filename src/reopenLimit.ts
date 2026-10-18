/**
 * The daily REOPEN LIMIT (#456), pure and import-free so the engine and the web UI read one rule, as they read
 * src/incidentActions.ts. A cycle is reopened (reconsider.ts) at most `reconsiderMaxPerDay` times (STARFISH_RECONSIDER_MAX_PER_DAY)
 * in any 24 hours, whoever asks: the cycle keeps the times it was reopened (`reconsideredAt`, cycle.ts), and a time counts
 * while it is less than 24 hours old.
 *
 * An operator's "Retry with agent" over the limit is not lost: the request stays on the incident (`retriageRequestedAt`),
 * and the first agent pass after the oldest counted reopening turns 24 hours old can start it. Until then the engine says
 * so on the run (cycle.ts `recordRetryRefused`) and the Runs page says so beside Retry. Whether an operator's request
 * should count against the limit at all is a product question (#456); this module only states the rule as it is.
 */

/** How long a reopening counts against the limit. */
export const REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ReopenLimit {
  /** No further reopening until `nextPossibleAtMs`. */
  reached: boolean;
  /** Reopenings within the 24 hours before now. */
  recent: number;
  maxPerDay: number;
  /** When the limit was reached: the moment enough counted reopenings have turned 24 hours old for one more. */
  nextPossibleAtMs?: number;
}

/** The reopening times (millis) that count at `nowMs`: within the 24 hours before it, none in the future. */
export function countedReopenings(reopenedAtMs: readonly number[], nowMs: number): number[] {
  return reopenedAtMs.filter((t) => Number.isFinite(t) && t > nowMs - REOPEN_WINDOW_MS && t <= nowMs);
}

/**
 * Whether a cycle reopened at `reopenedAtMs` may be reopened again at `nowMs` under a limit of `maxPerDay`, and if not,
 * from when. A time counts while `t > now - 24 h`, so it stops counting at exactly `t + 24 h`: with `recent` counted and
 * a limit of `max`, the oldest `recent - max + 1` must stop counting, so the next reopening is possible at the
 * `(recent - max)`-th oldest time plus 24 hours.
 */
export function reopenLimit(reopenedAtMs: readonly number[], maxPerDay: number, nowMs: number): ReopenLimit {
  const counted = countedReopenings(reopenedAtMs, nowMs).sort((a, b) => a - b);
  const recent = counted.length;
  if (recent < maxPerDay) return { reached: false, recent, maxPerDay };
  const pivot = counted[Math.max(0, recent - Math.max(1, Math.ceil(maxPerDay)))];
  return { reached: true, recent, maxPerDay, ...(pivot !== undefined && { nextPossibleAtMs: pivot + REOPEN_WINDOW_MS }) };
}

/** An ISO time to the second, the way the engine words a time in a run event. */
export function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The engine's one line on a run when an operator's retry is held back by the limit: its run event's summary. The
 * engine's own words and numbers only (guests read it in the trimmed copy, src/publicView.ts).
 */
export function retryRefusedSummary(limit: ReopenLimit): string {
  const when = limit.nextPossibleAtMs !== undefined ? `; it can start at ${isoSeconds(limit.nextPossibleAtMs)}, and the request stands until then` : "";
  return `Retry not started: reopened ${limit.recent} times in 24 h, the limit is ${limit.maxPerDay}${when}`;
}
