/**
 * Ingest windows: the slices of log time a scheduled run reads.
 *
 * A window is (start, end]: an entry at exactly `end` belongs to this window, and the next one
 * starts after it, so consecutive windows tile time with no gap and no overlap. Its id is derived
 * from its boundaries, which is what lets the store recognise a replay (see store.ts).
 *
 * Planning is pure so it can be tested without a clock or a database. Persisting the window
 * before it is processed is the caller's job (run.ts): a retry must replay the SAME window, and
 * an end computed from the clock again would not be.
 */
import { MS_PER_HOUR } from "./buckets.js";

const MS_PER_MINUTE = 60_000;

export interface IngestWindow {
  /** Exclusive. */
  start: Date;
  /** Inclusive. */
  end: Date;
  /** Stable for the same boundaries; different for any other. */
  id: string;
}

export function windowOf(start: Date, end: Date): IngestWindow {
  return { start, end, id: `${start.toISOString()}..${end.toISOString()}` };
}

export interface WindowPlan {
  /** Where the last completed window ended; undefined on the first run. */
  checkpoint: Date | undefined;
  now: Date;
  /** Used for the first window only. */
  lookbackHours: number;
  lagMinutes: number;
  maxWindowHours: number;
}

/**
 * The next window to read, or null when there is nothing new yet (the lagged horizon has not
 * moved past the checkpoint). Never longer than `maxWindowHours`, so a long outage is caught up
 * one bounded window at a time.
 */
export function planWindow(plan: WindowPlan): IngestWindow | null {
  const horizon = plan.now.getTime() - plan.lagMinutes * MS_PER_MINUTE;
  const start = plan.checkpoint?.getTime() ?? horizon - plan.lookbackHours * MS_PER_HOUR;
  if (!(start < horizon)) return null;
  const end = Math.min(horizon, start + plan.maxWindowHours * MS_PER_HOUR);
  return windowOf(new Date(start), new Date(end));
}
