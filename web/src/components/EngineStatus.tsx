/**
 * One line on the Incidents page saying whether the engine is running: when it last ran and how
 * it went. A list that looks quiet is only good news if the engine is actually reading the logs, so
 * "no incidents" and "the engine stopped" must never look the same (issue #6).
 */
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { Badge, type BadgeTone } from "./ui/Badge";
import { firestore } from "../lib/firebase";
import { webConfig } from "../lib/config";
import { formatRelativeTime } from "../lib/formatters";
import { judgeRun, nextRunAt, readLastRun, type EngineState } from "../lib/engineStatus";

const BADGE: Record<EngineState, { tone: BadgeTone; label: string }> = {
  ok: { tone: "success", label: "Engine running" },
  capped: { tone: "warning", label: "Engine running, read capped" },
  stale: { tone: "warning", label: "Engine not running" },
  failed: { tone: "error", label: "Last run failed" },
  never: { tone: "neutral", label: "No engine run recorded" },
};

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

/**
 * `line` (the default) is one row of text; `card` is the same facts in a box, with a bar for how far the engine is
 * through its interval when it recorded one. Both say only what the last_run record says.
 */
export function EngineStatus({ environment, variant = "line" }: { environment: string; variant?: "line" | "card" }) {
  const query = useQuery({
    queryKey: ["engine", "lastRun"],
    queryFn: () => readLastRun(firestore(), webConfig().runCollection),
    refetchInterval: 60_000,
    retry: false,
  });

  // A record that can't be read says nothing either way, so say nothing rather than guess.
  if (query.isPending || query.isError) {
    return query.isError ? (
      <p className="text-xs text-gray-600 dark:text-gray-400">Engine status unavailable.</p>
    ) : null;
  }

  const { state, run } = judgeRun(query.data, environment, Date.now(), webConfig().engineStaleMinutes);
  const badge = BADGE[state];
  const t = run?.totals;
  // Only while the engine looks alive: a stopped or failed engine has no "next run" worth promising.
  const next = state === "ok" || state === "capped" ? nextRunAt(run) : null;

  if (variant === "card") {
    const nowMs = Date.now();
    const startedMs = run?.startedAt?.getTime();
    const span = next && startedMs !== undefined ? next.getTime() - startedMs : 0;
    const through = span > 0 && startedMs !== undefined ? Math.min(1, Math.max(0, (nowMs - startedMs) / span)) : null;
    return (
      <div className="w-full max-w-xl space-y-3 rounded-xl border border-gray-200 bg-white p-4 text-sm dark:border-gray-700 dark:bg-gray-800" data-testid="engine-status">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="relative flex h-2.5 w-2.5" aria-hidden>
            {state === "ok" && <span className={`absolute inline-flex h-full w-full rounded-full opacity-50 motion-safe:animate-ping ${DOT[state]}`} />}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${DOT[state]}`} />
          </span>
          <span className={`font-semibold ${LABEL_TEXT[state]}`}>{badge.label}</span>
          {next && (
            <span className="ml-auto text-gray-600 dark:text-gray-400">
              Next run expected{" "}
              <strong className="font-semibold text-gray-900 dark:text-white">
                {next.getTime() > nowMs ? formatRelativeTime(next) : "any moment"}
              </strong>
            </span>
          )}
        </div>
        {through !== null && (
          <div
            role="img"
            aria-label={`${Math.round(through * 100)}% of the way to the next run`}
            className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
          >
            <div className="h-full rounded-full bg-success-600 dark:bg-success-400" style={{ width: `${(through * 100).toFixed(1)}%` }} />
          </div>
        )}
        {run && (
          <p className="text-gray-700 dark:text-gray-300">
            Last run {formatRelativeTime(run.finishedAt)}
            {state === "failed" && run.error ? ` (${run.error})` : ""}
            {state !== "failed" && t ? `: ${t.incidentsCreated} new, ${t.incidentsUpdated} updated, ${t.incidentsRecurred} recurred.` : "."}
          </p>
        )}
        {state === "capped" && <p className="text-gray-600 dark:text-gray-400">Counts from the busiest window are a floor, not the true volume.</p>}
        {state === "never" && <p className="text-gray-600 dark:text-gray-400">Nothing has said the logs are being read, so what is below may be out of date.</p>}
        {run && run.problems.length > 0 && <p className="text-gray-600 dark:text-gray-400">Runtime settings not used: {run.problems.join("; ")}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-700 dark:text-gray-300" data-testid="engine-status">
      <Activity className="h-4 w-4 text-gray-500 dark:text-gray-400" aria-hidden />
      <Badge tone={badge.tone}>{badge.label}</Badge>
      {run && (
        <span>
          last run {formatRelativeTime(run.finishedAt)}
          {state === "failed" && run.error ? ` (${run.error})` : ""}
          {state !== "failed" && t ? `: ${t.incidentsCreated} new, ${t.incidentsUpdated} updated, ${t.incidentsRecurred} recurred` : ""}
        </span>
      )}
      {next && <span>next run expected {next.getTime() > Date.now() ? formatRelativeTime(next) : "any moment"}</span>}
      {state === "capped" && <span>counts from the busiest window are a floor, not the true volume</span>}
      {state === "never" && <span>incidents below may be out of date: nothing has said the logs are being read</span>}
      {run && run.problems.length > 0 && <span>runtime settings not used: {run.problems.join("; ")}</span>}
    </div>
  );
}
