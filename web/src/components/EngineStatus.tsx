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
import { judgeRun, readLastRun, type EngineState } from "../lib/engineStatus";

const BADGE: Record<EngineState, { tone: BadgeTone; label: string }> = {
  ok: { tone: "success", label: "Engine running" },
  capped: { tone: "warning", label: "Engine running, read capped" },
  stale: { tone: "warning", label: "Engine not running" },
  failed: { tone: "error", label: "Last run failed" },
  never: { tone: "neutral", label: "No engine run recorded" },
};

export function EngineStatus({ environment }: { environment: string }) {
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
      {state === "capped" && <span>counts from the busiest window are a floor, not the true volume</span>}
      {state === "never" && <span>incidents below may be out of date: nothing has said the logs are being read</span>}
      {run && run.problems.length > 0 && <span>runtime settings not used: {run.problems.join("; ")}</span>}
    </div>
  );
}
