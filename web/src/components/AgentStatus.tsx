/**
 * Whether the agent is alive (#274): when it last ran, how it went, and when the next pass is expected. Read
 * from `{runCollection}/agent_last_run`, which each `pnpm agent` pass writes at its end; judged like the ingest's line
 * (EngineStatus), so the Runs page, which is about agent runs, no longer shows the ingest's status in their place.
 *
 * Between two records it also says what the agent is doing now (`agentActivity`): a pass under way (the start mark each
 * pass stamps on the record), one that started long ago and never ended, or one that is due and has not started. While
 * a pass is under way or due it reads the record every few seconds, so its start and its result show as they happen.
 * Between passes a healthy agent is "waiting" (an hourglass), never "running": that word, in blue, is only for a pass
 * under way. Right after an admin's "Run agent now" it says the start was requested and watches the same way until the
 * pass records its start (`lib/agentStart.ts`).
 */
import { useQuery } from "@tanstack/react-query";
import { Bot, Hourglass } from "lucide-react";
import { Badge, type BadgeTone } from "./ui/Badge";
import { StatusCard } from "./StatusCard";
import { firestore } from "../lib/firebase";
import { webConfig } from "../lib/config";
import { formatRecentTime, formatRelativeTime } from "../lib/formatters";
import { TICK_MS, useNow } from "../lib/useNow";
import { useAgentStartRequestedAt } from "../lib/agentStart";
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

// Between passes: the agent runs as a scheduled job, so a healthy one is waiting for its next pass, not running. Only a
// pass under way (its start mark, `agentActivity`) reads "running".
const BADGE: Record<EngineState, { tone: BadgeTone; label: string }> = {
  ok: { tone: "success", label: "Agent waiting" },
  capped: { tone: "warning", label: "Agent waiting, last scan capped" },
  // Never judged for the agent: its record carries no checkpoint lag (#297), only the ingest's does.
  behind: { tone: "warning", label: "Agent waiting, behind" },
  stale: { tone: "warning", label: "Agent not running" },
  failed: { tone: "error", label: "Last agent pass failed" },
  never: { tone: "neutral", label: "No agent pass recorded yet" },
};

/** How often the record is read, and the clock ticks, while a pass is under way or due: its start and end show within this. */
export const WATCH_MS = 5_000;
const IDLE_READ_MS = 60_000;
const WATCH_DUE_MS = 15 * 60_000;
// The browser's clock and the job's can differ: a pass that recorded its start this soon before the request
// counts as the one it started.
const REQUEST_SKEW_MS = 60_000;

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
  const requestedAt = useAgentStartRequestedAt();
  // A start this tab requested that the record does not show yet: no pass started since (a start mark, or a finished
  // pass that started after it: one that only ended since was already running), and not long ago.
  const awaitingStart = (pass: AgentPass | undefined, nowMs: number) => {
    if (requestedAt === null || nowMs - requestedAt >= WATCH_DUE_MS) return false;
    const since = requestedAt - REQUEST_SKEW_MS;
    return !((pass?.inProgress && pass.inProgress.since.getTime() >= since) || (pass?.run?.startedAt !== undefined && pass.run.startedAt.getTime() >= since));
  };
  const watched = (pass: AgentPass | undefined) => {
    const nowMs = Date.now();
    const a = activityAt(pass, nowMs);
    return a.kind === "running" || (a.kind === "due" && nowMs - a.dueAt.getTime() < WATCH_DUE_MS) || awaitingStart(pass, nowMs);
  };
  const query = useQuery({
    queryKey: ["engine", "agentPass"],
    queryFn: () => readAgentPass(firestore(), webConfig().runCollection),
    refetchInterval: (q) => (watched(q.state.data) ? WATCH_MS : IDLE_READ_MS),
    retry: false,
  });
  // Ticks so "started 40 seconds ago" and "due" move without a new read.
  const nowMs = useNow(watched(query.data) ? WATCH_MS : TICK_MS);

  // A record that can't be read says nothing either way, so say nothing rather than guess.
  if (query.isPending || query.isError) {
    return query.isError ? <p className="text-xs text-gray-600 dark:text-gray-400">Agent status unavailable.</p> : null;
  }

  const health = judgeAgentRun(query.data.run, environment, nowMs, staleMinutes);
  const { state, run } = health;
  const activity = agentActivity(query.data, health, environment, nowMs, staleMinutes);
  const starting = activity.kind !== "running" && activity.kind !== "overrun" && awaitingStart(query.data, nowMs);
  const badge =
    activity.kind === "running"
      ? { tone: "info" as const, label: "Agent running" }
      : activity.kind === "overrun"
        ? { tone: "warning" as const, label: "Agent pass has not finished" }
        : starting
          ? { tone: "info" as const, label: "Agent starting" }
          : BADGE[state];
  // Waiting between passes, alive: an hourglass in place of a pulsing dot, which would read as work under way.
  const waiting = !starting && activity.kind !== "running" && activity.kind !== "overrun" && (state === "ok" || state === "capped");
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

  const requested = starting && requestedAt !== null ? formatRecentTime(new Date(requestedAt), undefined, nowMs) : undefined;
  const right =
    requested !== undefined ? (
      <>
        Requested <strong className="font-semibold text-gray-900 dark:text-white">{requested}</strong>
      </>
    ) : started !== undefined ? (
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
        busy={activity.kind === "running" || starting}
        icon={waiting ? <Hourglass className={`h-4 w-4 ${state === "ok" ? "text-success-700 dark:text-success-400" : "text-warning-700 dark:text-warning-400"}`} aria-hidden /> : undefined}
      >
        {starting && (
          <p className="text-gray-700 dark:text-gray-300">Start requested: waiting for its job to come up. It shows as running once the pass records its start.</p>
        )}
        {activity.kind === "running" && (
          <p className="text-gray-700 dark:text-gray-300">Runs it starts appear below as they start; this card shows its result when it ends.</p>
        )}
        {activity.kind === "overrun" && (
          <p className="text-gray-700 dark:text-gray-300">
            It has not recorded its end: it may have been stopped, as a pass ended by its task timeout records nothing.
          </p>
        )}
        {activity.kind === "due" && !starting && <p className="text-gray-700 dark:text-gray-300">Waiting for it to start: a pass shows here once its job is up.</p>}
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
      <Badge tone={badge.tone}>
        {waiting && <Hourglass className="mr-1 h-3 w-3" aria-hidden />}
        {badge.label}
      </Badge>
      {requested !== undefined && <span>start requested {requested}</span>}
      {started !== undefined && <span>started {started}</span>}
      {run && <span>last pass {lastPass(state, run, nowMs)}</span>}
      {skipped && <span>{skipped}</span>}
      {starting ? null : due !== undefined ? (
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
