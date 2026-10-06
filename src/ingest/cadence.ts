/**
 * How often the ingest is started, read from the Cloud Scheduler cron it is started by (#38, #33): the UI shows
 * when the next run is expected. Only the regular shapes a schedule for this job takes are understood; anything
 * else is `null` and the UI then says nothing about the next run rather than guess.
 *
 *   "* * * * *"      every minute          "M * * * *"     every hour
 *   "*\/N * * * *"   every N minutes        "M *\/H * * *"  every H hours
 *   "M H * * *"      every day
 *
 * An interval only counts when it divides the hour (or the day) evenly: `*\/7` fires at :56 and again at :00,
 * so its gap is not 7 minutes everywhere.
 */
const MINUTE_RE = /^(?:[0-9]|[1-5][0-9])$/;
const HOUR_RE = /^(?:[0-9]|1[0-9]|2[0-3])$/;

const step = (field: string): number | null => {
  const m = /^\*\/([1-9][0-9]?)$/.exec(field);
  return m ? Number(m[1]) : null;
};

export function cronIntervalMinutes(cron: string | undefined): number | null {
  if (typeof cron !== "string") return null;
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, month, dow] = f as [string, string, string, string, string];
  if (dom !== "*" || month !== "*" || dow !== "*") return null;
  if (hour === "*") {
    if (min === "*") return 1;
    const n = step(min);
    if (n !== null) return 60 % n === 0 ? n : null;
    return MINUTE_RE.test(min) ? 60 : null;
  }
  if (!MINUTE_RE.test(min)) return null;
  const h = step(hour);
  if (h !== null) return 24 % h === 0 ? h * 60 : null;
  return HOUR_RE.test(hour) ? 24 * 60 : null;
}
