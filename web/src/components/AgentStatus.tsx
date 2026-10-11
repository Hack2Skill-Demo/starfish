/**
 * Whether the agent pass is running (#274): when it last ran, how it went, and when the next pass is expected. Read
 * from `{runCollection}/agent_last_run`, which each `pnpm agent` pass writes at its end; judged like the ingest's line
 * (EngineStatus), so the Runs page, which is about agent runs, no longer shows the ingest's status in their place.
 *
 * Between two records it also says what the agent is doing now (`agentActivity`): a pass under way (the start mark each
 * pass stamps on the record), one that started long ago and never ended, or one that is due and has not started. While
 * a pass is under way or due it reads the record every few seconds, so its start and its result show as they happen.
 */
import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { Badge, type BadgeTone } from "./ui/Badge";
import { StatusCard } from "./StatusCard";
import { firestore } from "../lib/firebase";
import { webConfig } from "../lib/config";
import { formatRecentTime, formatRelativeTime } from "../lib/formatters";
import { TICK_MS, useNow } from "../lib/useNow";
import {
  agentActivity,
  judgeAgentRun,
  nextRunAt,
  readAgentPass,
  type AgentActivity,
  type AgentPass,
  type AgentRunRecord,
  type EngineState,
} from "../lib/engineStatus";

const BADGE: Record<EngineState, { tone: BadgeTone; label: string }> = {
  ok: { tone: "success", label: "Agent running" },
  capped: { tone: "warning", label: "Agent running, scan capped" },
  // Never judged for the agent: its record carries no checkpoint lag (#297), only the ingest's does.
  behind: { tone: "warning", label: "Agent running, behind" },
  stale: { tone: "warning", label: "Agent not running" },
  failed: { tone: "error", label: "Last agent pass failed" },
  never: { tone: "neutral", label: "No agent pass recorded yet" },
};

/** How often the record is read, and the clock ticks, while a pass is under way or due: its start and end show within this. */
export const WATCH_MS = 5_000;
const IDLE_READ_MS = 60_000;
const WATCH_DUE_MS = 15 * 60_000;

/** What the last pass did, in one phrase: why it failed, or what it considered and ran. */
function lastPass(state: EngineState, run: AgentRunRecord, nowMs: number): string {
  const why = run.error ?? (run.failedSteps.length > 0 ? `failed: ${run.failedSteps.join(", ")}` : undefined);
  return (
    `${formatRelativeTime(run.finishedAt, undefined, nowMs)}${run.dryRun === true ? " (dry run)" : ""}` +
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
  const staleMinutes = webConfig().engineStaleMinutes;
  const activityAt = (pass: AgentPass | undefined, nowMs: number): AgentActivity =>
    pass ? agentActivity(pass, judgeAgentRun(pass.run, environment, nowMs, staleMinutes), environment, nowMs, staleMinutes) : { kind: "idle" };
  // A due pass is watched only for a while: a job that never starts should not keep every open page reading.
  const watched = (a: AgentActivity) => a.kind === "running" || (a.kind === "due" && Date.now() - a.dueAt.getTime() < WATCH_DUE_MS);
  const query = useQuery({
    queryKey: ["engine", "agentPass"],
    queryFn: () => readAgentPass(firestore(), webConfig().runCollection),
    refetchInterval: (q) => (watched(activityAt(q.state.data, Date.now())) ? WATCH_MS : IDLE_READ_MS),
    retry: false,
  });
  // Ticks so "started 40 seconds ago" and "due" move without a new read.
  const nowMs = useNow(watched(activityAt(query.data, Date.now())) ? WATCH_MS : TICK_MS);

  // A record that can't be read says nothing either way, so say nothing rather than guess.
  if (query.isPending || query.isError) {
    return query.isError ? <p className="text-xs text-gray-600 dark:text-gray-400">Agent status unavailable.</p> : null;
  }

  const health = judgeAgentRun(query.data.run, environment, nowMs, staleMinutes);
  const { state, run } = health;
  const activity = agentActivity(query.data, health, environment, nowMs, staleMinutes);
  const badge =
    activity.kind === "running"
      ? { tone: "info" as const, label: "Agent pass in progress" }
      : activity.kind === "overrun"
        ? { tone: "warning" as const, label: "Agent pass has not finished" }
        : BADGE[state];
  const cardState: EngineState = activity.kind === "running" ? "ok" : activity.kind === "overrun" ? "stale" : state;
  const started = activity.kind === "running" || activity.kind === "overrun" ? formatRecentTime(activity.since, undefined, nowMs) : undefined;
  // Within a minute of when it was due reads "now": the schedule fires on the clock, not to the second.
  const due = activity.kind === "due" ? (nowMs - activity.dueAt.getTime() < 60_000 ? "now" : formatRelativeTime(activity.dueAt, undefined, nowMs)) : undefined;
  // Only while the agent looks alive: a stopped or failed one has no "next pass" worth promising.
  const next = state === "ok" || state === "capped" ? nextRunAt(run) : null;
  const skipped = run?.skipped ? SKIPPED[run.skipped] : undefined;
  const capped = "the candidate scan read its cap: older open incidents wait for a later pass";
  const never = "nothing has said the agent has run in this environment";
  const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;

  const right =
    started !== undefined ? (
      <>
        Started <strong className="font-semibold text-gray-900 dark:text-white">{started}</strong>
      </>
    ) : due !== undefined ? (
      <>
        Next pass due <strong className="font-semibold text-gray-900 dark:text-white">{due}</strong>
      </>
    ) : undefined;

  if (variant === "card") {
    return (
      <StatusCard
        state={cardState}
        label={badge.label}
        next={next}
        startedAt={run?.startedAt}
        noun="pass"
        testId="agent-status"
        right={right}
        busy={activity.kind === "running"}
      >
        {activity.kind === "running" && (
          <p className="text-gray-700 dark:text-gray-300">Runs it starts appear below as they start; this card shows its result when it ends.</p>
        )}
        {activity.kind === "overrun" && (
          <p className="text-gray-700 dark:text-gray-300">
            It has not recorded its end: it may have been stopped, as a pass ended by its task timeout records nothing.
          </p>
        )}
        {activity.kind === "due" && <p className="text-gray-700 dark:text-gray-300">Waiting for it to start: a pass shows here once its job is up.</p>}
        {run && <p className="text-gray-700 dark:text-gray-300">Last pass {lastPass(state, run, nowMs)}.</p>}
        {skipped && <p className="text-gray-600 dark:text-gray-400">{sentence(skipped)}</p>}
        {state === "capped" && <p className="text-gray-600 dark:text-gray-400">{sentence(capped)}</p>}
        {state === "never" && started === undefined && <p className="text-gray-600 dark:text-gray-400">{sentence(never)}</p>}
        {run && run.problems.length > 0 && <p className="text-gray-600 dark:text-gray-400">Runtime settings not used: {run.problems.join("; ")}</p>}
      </StatusCard>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-700 dark:text-gray-300" data-testid="agent-status">
      <Bot className="h-4 w-4 text-gray-500 dark:text-gray-400" aria-hidden />
      <Badge tone={badge.tone}>{badge.label}</Badge>
      {started !== undefined && <span>started {started}</span>}
      {run && <span>last pass {lastPass(state, run, nowMs)}</span>}
      {skipped && <span>{skipped}</span>}
      {due !== undefined ? (
        <span>next pass due {due}, waiting for it to start</span>
      ) : (
        activity.kind === "idle" && next && <span>next pass expected {formatRelativeTime(next, undefined, nowMs)}</span>
      )}
      {state === "capped" && <span>{capped}</span>}
      {state === "never" && started === undefined && <span>{never}</span>}
      {run && run.problems.length > 0 && <span>runtime settings not used: {run.problems.join("; ")}</span>}
    </div>
  );
}
