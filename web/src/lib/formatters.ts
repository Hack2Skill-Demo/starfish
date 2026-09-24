/**
 * Date formatting for incident rows: a relative time ("3 hours ago"), a locale
 * date-time, and a "Never" fallback for a missing timestamp.
 */
const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

function toMs(ts: Date | string | number | undefined | null): number {
  if (ts === undefined || ts === null || ts === "") return NaN;
  return ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
}

export function formatRelativeTime(ts: Date | string | number | undefined | null, fallback = "Never", nowMs = Date.now()): string {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return fallback;
  const deltaSec = Math.round((ms - nowMs) / 1000);
  for (const [unit, secs] of UNITS) {
    if (Math.abs(deltaSec) >= secs) return RTF.format(Math.trunc(deltaSec / secs), unit);
  }
  return "just now";
}

export function formatDateTime(ts: Date | string | number | undefined | null, fallback = "Never"): string {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return fallback;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
