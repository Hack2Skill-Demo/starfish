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

/**
 * The part of `window` a capped read covered in full, or null when there is no such part (#127).
 *
 * A read capped at N entries (oldest first) whose last entry is at `lastReadAt` has read every entry
 * at or before `lastReadAt - 1 ms`, all of them strictly before that last one. Not `lastReadAt` itself:
 * Cloud Logging keeps nanoseconds and the client rounds them away, so more entries than the cap let
 * through can share that millisecond. The narrowed window (start, lastReadAt - 1 ms] then holds fewer
 * entries than the cap, so replaying it reads all of it; the rest of the original window is planned
 * after it, from its end, like any other window.
 *
 * Null when that bound is not after `start` (more entries than the cap in the window's first
 * millisecond), or not before `end`: the window cannot be narrowed.
 */
export function narrowWindow(window: IngestWindow, lastReadAt: Date): IngestWindow | null {
  const end = lastReadAt.getTime() - 1;
  if (!Number.isFinite(end) || end <= window.start.getTime() || end >= window.end.getTime()) return null;
  return windowOf(window.start, new Date(end));
}

/**
 * The first half of `window`, or null when it is too short to halve (#296). For a pending window that attempt after
 * attempt never finished: whatever killed it (memory, a stalled read) is less likely on half the time, and the second
 * half is planned after it, from its end, like any other window. Only for a window nothing was written under, as with
 * `narrowWindow`: the half has a new id.
 */
export function splitWindow(window: IngestWindow): IngestWindow | null {
  const start = window.start.getTime();
  const mid = start + Math.floor((window.end.getTime() - start) / 2);
  if (!(mid > start && mid < window.end.getTime())) return null;
  return windowOf(window.start, new Date(mid));
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
