/**
 * The card both status lines can take (the ingest's, EngineStatus, and the agent's, AgentStatus, #274): a dot and label
 * for the judged state, when the next one is expected, a bar for how far through its interval it is when the record
 * gave one, and the record's own facts as children. It says only what it is given.
 */
import type { ReactNode } from "react";
import type { EngineState } from "../lib/engineStatus";
import { formatRelativeTime } from "../lib/formatters";

const DOT: Record<EngineState, string> = {
  ok: "bg-success-600 dark:bg-success-400",
  capped: "bg-warning-500 dark:bg-warning-400",
  stale: "bg-warning-500 dark:bg-warning-400",
  failed: "bg-error-600 dark:bg-error-400",
  never: "bg-gray-400 dark:bg-gray-500",
};

const LABEL_TEXT: Record<EngineState, string> = {
  ok: "text-success-700 dark:text-success-400",
  capped: "text-warning-700 dark:text-warning-400",
  stale: "text-warning-700 dark:text-warning-400",
  failed: "text-error-700 dark:text-error-400",
  never: "text-gray-700 dark:text-gray-300",
};

export function StatusCard({
  state,
  label,
  next,
  startedAt,
  noun,
  testId,
  children,
}: {
  state: EngineState;
  label: string;
  /** When the next one is expected; null when that is not known or not worth promising. */
  next: Date | null;
  /** When the last one started, for the bar. */
  startedAt: Date | undefined;
  /** What the next one is called: "run", "pass". */
  noun: string;
  testId: string;
  children?: ReactNode;
}) {
  const nowMs = Date.now();
  const startedMs = startedAt?.getTime();
  const span = next && startedMs !== undefined ? next.getTime() - startedMs : 0;
  const through = span > 0 && startedMs !== undefined ? Math.min(1, Math.max(0, (nowMs - startedMs) / span)) : null;
  return (
    <div className="w-full max-w-xl space-y-3 rounded-xl border border-gray-200 bg-white p-4 text-sm dark:border-gray-700 dark:bg-gray-800" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="relative flex h-2.5 w-2.5" aria-hidden>
          {state === "ok" && <span className={`absolute inline-flex h-full w-full rounded-full opacity-50 motion-safe:animate-ping ${DOT[state]}`} />}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${DOT[state]}`} />
        </span>
        <span className={`font-semibold ${LABEL_TEXT[state]}`}>{label}</span>
        {next && (
          <span className="ml-auto text-gray-600 dark:text-gray-400">
            Next {noun} expected{" "}
            <strong className="font-semibold text-gray-900 dark:text-white">
              {next.getTime() > nowMs ? formatRelativeTime(next) : "any moment"}
            </strong>
          </span>
        )}
      </div>
      {through !== null && (
        <div
          role="img"
          aria-label={`${Math.round(through * 100)}% of the way to the next ${noun}`}
          className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
        >
          <div className="h-full rounded-full bg-success-600 dark:bg-success-400" style={{ width: `${(through * 100).toFixed(1)}%` }} />
        </div>
      )}
      {children}
    </div>
  );
}
