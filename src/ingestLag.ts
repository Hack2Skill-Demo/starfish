/**
 * Is the ingest behind (#297)? Its last-run record says how far the checkpoint was behind the newest logs it could read
 * (`lagSeconds`, src/ingest/run.ts); this judges that against a threshold. Pure, and shared by `pnpm status`
 * (src/status.ts) and the UI's engine line (web/src/lib/engineStatus.ts), so both say the same.
 *
 * Under a sustained flood every window is narrowed and each run catches up less than the time that passed, while every
 * run still records ok: the lag is the one number that shows it.
 */

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * How far behind the newest readable logs the checkpoint may be, in minutes, before the ingest is "behind": the
 * configured threshold, else twice the schedule's interval the record names (one slow run is not yet a trend), else the
 * stale threshold.
 */
export function behindAfterMinutes(run: { intervalMinutes?: number } | null, staleMinutes: number, configured?: number): number {
  if (positive(configured)) return configured;
  if (positive(run?.intervalMinutes)) return 2 * run.intervalMinutes;
  return staleMinutes;
}

/**
 * True when the record says the checkpoint was further behind than the threshold. A record with no lag (written before
 * #297, or by a run that failed before it claimed a window) is never behind: missing is not zero, and not a large number
 * either.
 */
export function isBehind(run: { lagSeconds?: number; intervalMinutes?: number }, staleMinutes: number, configured?: number): boolean {
  return typeof run.lagSeconds === "number" && run.lagSeconds > behindAfterMinutes(run, staleMinutes, configured) * 60;
}

/** A stored `lagSeconds`, or undefined when it is missing or not a usable count of seconds. */
export function parseLagSeconds(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}
