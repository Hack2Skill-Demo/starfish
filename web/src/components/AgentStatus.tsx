/**
 * Whether the agent pass is running (#274): when it last ran, how it went, and when the next pass is expected. Read
 * from `{runCollection}/agent_last_run`, which each `pnpm agent` pass writes at its end; judged like the ingest's line
 * (EngineStatus), so the Runs page, which is about agent runs, no longer shows the ingest's status in their place.
 */
import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { Badge, type BadgeTone } from "./ui/Badge";
import { StatusCard } from "./StatusCard";
import { firestore } from "../lib/firebase";
import { webConfig } from "../lib/config";
import { formatRelativeTime } from "../lib/formatters";
import { judgeAgentRun, nextRunAt, readAgentLastRun, type AgentRunRecord, type EngineState } from "../lib/engineStatus";

const BADGE: Record<EngineState, { tone: BadgeTone; label: string }> = {
  ok: { tone: "success", label: "Agent running" },
  capped: { tone: "warning", label: "Agent running, scan capped" },
  stale: { tone: "warning", label: "Agent not running" },
  failed: { tone: "error", label: "Last agent pass failed" },
  never: { tone: "neutral", label: "No agent pass recorded yet" },
};

/** What the last pass did, in one phrase: why it failed, or what it considered and ran. */
function lastPass(state: EngineState, run: AgentRunRecord): string {
  const why = run.error ?? (run.failedSteps.length > 0 ? `failed: ${run.failedSteps.join(", ")}` : undefined);
  return (
    `${formatRelativeTime(run.finishedAt)}${run.dryRun === true ? " (dry run)" : ""}` +
    (state === "failed" && why ? ` (${why})` : "") +
    (state !== "failed" && !run.skipped ? `: ${run.considered} candidate${run.considered === 1 ? "" : "s"}, ${run.ran} run` : "")
  );
}

const SKIPPED: Record<NonNullable<AgentRunRecord["skipped"]>, string> = {
  "automation-disabled": "automation is off: no run started",
  "daily-cap": "the daily cap of runs is reached: no run started",
};

/**
 * `line` (the default) is one row of text; `card` is the same facts in a box, with a bar for how far the agent is
 * through its interval when it recorded one. Both say only what the agent_last_run record says.
 */
export function AgentStatus({ environment, variant = "line" }: { environment: string; variant?: "line" | "card" }) {
  const query = useQuery({
    queryKey: ["engine", "agentLastRun"],
    queryFn: () => readAgentLastRun(firestore(), webConfig().runCollection),
    refetchInterval: 60_000,
    retry: false,
  });

  // A record that can't be read says nothing either way, so say nothing rather than guess.
  if (query.isPending || query.isError) {
    return query.isError ? <p className="text-xs text-gray-600 dark:text-gray-400">Agent status unavailable.</p> : null;
  }

  const { state, run } = judgeAgentRun(query.data, environment, Date.now(), webConfig().engineStaleMinutes);
  const badge = BADGE[state];
  // Only while the agent looks alive: a stopped or failed one has no "next pass" worth promising.
  const next = state === "ok" || state === "capped" ? nextRunAt(run) : null;
  const skipped = run?.skipped ? SKIPPED[run.skipped] : undefined;
  const capped = "the candidate scan read its cap: older open incidents wait for a later pass";
  const never = "nothing has said the agent has run in this environment";
  const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;

  if (variant === "card") {
    return (
      <StatusCard state={state} label={badge.label} next={next} startedAt={run?.startedAt} noun="pass" testId="agent-status">
        {run && <p className="text-gray-700 dark:text-gray-300">Last pass {lastPass(state, run)}.</p>}
        {skipped && <p className="text-gray-600 dark:text-gray-400">{sentence(skipped)}</p>}
        {state === "capped" && <p className="text-gray-600 dark:text-gray-400">{sentence(capped)}</p>}
        {state === "never" && <p className="text-gray-600 dark:text-gray-400">{sentence(never)}</p>}
        {run && run.problems.length > 0 && <p className="text-gray-600 dark:text-gray-400">Runtime settings not used: {run.problems.join("; ")}</p>}
      </StatusCard>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-700 dark:text-gray-300" data-testid="agent-status">
      <Bot className="h-4 w-4 text-gray-500 dark:text-gray-400" aria-hidden />
      <Badge tone={badge.tone}>{badge.label}</Badge>
      {run && <span>last pass {lastPass(state, run)}</span>}
      {skipped && <span>{skipped}</span>}
      {next && <span>next pass expected {next.getTime() > Date.now() ? formatRelativeTime(next) : "any moment"}</span>}
      {state === "capped" && <span>{capped}</span>}
      {state === "never" && <span>{never}</span>}
      {run && run.problems.length > 0 && <span>runtime settings not used: {run.problems.join("; ")}</span>}
    </div>
  );
}
