/**
 * Rolling per-hour occurrence counts.
 *
 * A lifetime total can't answer "is this getting worse?", which is the question
 * triage actually needs. Hourly buckets give a time series while keeping each
 * incident document bounded to ~168 small integers.
 */

export const OCCURRENCE_BUCKET_RETENTION_HOURS = 168;
export const MS_PER_HOUR = 60 * 60 * 1000;

/** Epoch-hour bucket key for a timestamp in ms. */
export function hourBucketKey(ms: number): string {
  return String(Math.floor(ms / MS_PER_HOUR));
}

/** Fold new occurrences into the map and drop buckets past the retention window. */
export function mergeOccurrenceBuckets(
  existing: Record<string, number> | undefined,
  bucketKey: string,
  addCount: number,
  nowMs: number
): Record<string, number> {
  const cutoffHour = Math.floor(nowMs / MS_PER_HOUR) - OCCURRENCE_BUCKET_RETENTION_HOURS;
  const merged: Record<string, number> = {};
  if (existing) {
    for (const [k, v] of Object.entries(existing)) {
      const hour = Number(k);
      if (Number.isFinite(hour) && hour >= cutoffHour && typeof v === "number" && v > 0) {
        merged[k] = v;
      }
    }
  }
  merged[bucketKey] = (merged[bucketKey] ?? 0) + addCount;
  return merged;
}

/** Sum the buckets falling inside the last `hours`. */
export function countInWindow(
  buckets: Record<string, number> | undefined,
  hours: number,
  nowMs: number = Date.now()
): number {
  if (!buckets) return 0;
  const cutoffHour = Math.floor(nowMs / MS_PER_HOUR) - hours;
  let total = 0;
  for (const [k, v] of Object.entries(buckets)) {
    const hour = Number(k);
    if (Number.isFinite(hour) && hour >= cutoffHour && typeof v === "number") total += v;
  }
  return total;
}
