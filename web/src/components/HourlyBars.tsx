/**
 * Occurrences per hour as bars, oldest first. The bars are decorative (aria-hidden) and each hour also has
 * screen-reader text OUTSIDE the coloured bar, so the contrast audit and assistive tech both read plain text.
 */
import { formatDateTime } from "../lib/formatters";
import type { HourBucket } from "../lib/overviewModel";

export function HourlyBars({ series, label = "Occurrences by hour" }: { series: HourBucket[]; label?: string }) {
  const peak = Math.max(...series.map((b) => b.count), 0);
  return (
    <ol className="mt-3 flex h-24 items-end gap-0.5" aria-label={label}>
      {series.map((b) => (
        <li key={b.startMs} title={`${formatDateTime(b.startMs)}: ${b.count}`} className="flex h-full flex-1 items-end">
          <div
            aria-hidden
            className="w-full rounded-t bg-brand-600 dark:bg-brand-400"
            style={{ height: `${Math.max((b.count / peak) * 100, b.count > 0 ? 3 : 0)}%`, minHeight: b.count > 0 ? 2 : 0 }}
          />
          <span className="sr-only">{`${formatDateTime(b.startMs)}: ${b.count}`}</span>
        </li>
      ))}
    </ol>
  );
}
