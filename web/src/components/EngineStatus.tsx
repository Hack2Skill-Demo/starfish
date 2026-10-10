/**
 * One line on the Incidents and Overview pages saying whether the ingest is running: when it last ran and how
 * it went. A list that looks quiet is only good news if the engine is actually reading the logs, so
 * "no incidents" and "the engine stopped" must never look the same (issue #6). The agent pass has its own line
 * (AgentStatus, #274).
 */
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { Badge, type BadgeTone } from "./ui/Badge";
import { StatusCard } from "./StatusCard";
import { firestore } from "../lib/firebase";
import { webConfig } from "../lib/config";
import { formatRelativeTime } from "../lib/formatters";
import { judgeRun, nextRunAt, readLastRun, type EngineState } from "../lib/engineStatus";

const BADGE: Record<EngineState, { tone: BadgeTone; label: string }> = {
  ok: { tone: "success", label: "Ingest running" },
  capped: { tone: "warning", label: "Ingest running, read capped" },
  stale: { tone: "warning", label: "Ingest not running" },
  failed: { tone: "error", label: "Last ingest run failed" },
  never: { tone: "neutral", label: "No ingest run recorded" },
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
      <p className="text-xs text-gray-600 dark:text-gray-400">Ingest status unavailable.</p>
    ) : null;
  }

  const { state, run } = judgeRun(query.data, environment, Date.now(), webConfig().engineStaleMinutes);
  const badge = BADGE[state];
  const t = run?.totals;
  // Only while the engine looks alive: a stopped or failed engine has no "next run" worth promising.
  const next = state === "ok" || state === "capped" ? nextRunAt(run) : null;

  if (variant === "card") {
    return (
      <StatusCard state={state} label={badge.label} next={next} startedAt={run?.startedAt} noun="run" testId="engine-status">
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
      </StatusCard>
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
