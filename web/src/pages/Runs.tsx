/**
 * Runs — the agent's cycles as they happen: a list of runs by day, and for the one selected its stages as a track, a
 * time bar and a log. Both are live subscriptions to what the engine writes (src/agent/cycle.ts); nothing
 * here is inferred. A step with no event is "not reached", a cycle with no worker on it is not "in
 * progress" (and nothing on it animates), and nothing is drawn for a stage the loop has no code for (merge, deploy, recovery).
 *
 * Where the agent job (`DEPLOY_AGENT=1`, #74) has not run, this page is empty until it does; it says so instead of looking
 * like a quiet day. On the demo project it runs hourly since 2026-10-07 (in dry run until 2026-10-10).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { Check, Copy, CornerDownRight, ExternalLink, FileText, RotateCcw, Square, Workflow } from "lucide-react";
import PageMeta from "../components/PageMeta";
import SettingsUnavailableNotice from "../components/SettingsUnavailableNotice";
import StoreReadHint from "../components/StoreReadHint";
import { AgentStatus } from "../components/AgentStatus";
import { RunAgentButton } from "../components/AdminActions";
import { Badge } from "../components/ui/Badge";
import { SyntheticBadge } from "../components/SyntheticBadge";
import { EmptyState } from "../components/ui/EmptyState";
import { formatDateTime, formatRelativeTime } from "../lib/formatters";
import { useEnvironment } from "../lib/useSettings";
import { TICK_MS, useNow } from "../lib/useNow";
import { getIncident, type IncidentRow } from "../lib/incidents";
import { CYCLE_LIMIT, CYCLE_LIMIT_MAX, readCycle, subscribeCycles, subscribeEvents } from "../lib/runs";
import {
  PATH_LABELS,
  indexRuntimeView,
  buildWaterfall,
  formatClock,
  formatDuration,
  groupByDay,
  prStateView,
  progressText,
  runFilter,
  runStatus,
  runSummary,
  failureView,
  splitTrace,
  titleOf,
  trackMarks,
  type TrackMark,
  issueLink,
  safeUrl,
  stepLogOrder,
  triageFinding,
  triageDecision,
  triageRule,
  type CycleRow,
  type EventRow,
  type RunStatus,
  type EarlierRound,
  type Step,
  type StepStatus,
  type Waterfall,
} from "../lib/runsModel";


export default function Runs() {
  const { environment, ready, settingsUnavailable } = useEnvironment();
  const [params, setParams] = useSearchParams();
  const now = useNow();
  const [cycles, setCycles] = useState<CycleRow[] | null>(null);
  const [capped, setCapped] = useState(false);
  const [failed, setFailed] = useState(false);
  // How many runs the list reads: "Show older runs" adds CYCLE_LIMIT, up to CYCLE_LIMIT_MAX; `shown` is what the last
  // snapshot answered, so the button can say it is loading. Another environment starts again from the first page.
  const [pageLimit, setPageLimit] = useState(CYCLE_LIMIT);
  const [shown, setShown] = useState(CYCLE_LIMIT);
  const [listEnv, setListEnv] = useState(environment);
  if (listEnv !== environment) {
    setListEnv(environment);
    setPageLimit(CYCLE_LIMIT);
    setShown(CYCLE_LIMIT);
    setCycles(null);
  }

  useEffect(() => {
    if (!ready) return;
    setFailed(false);
    // A bigger page re-subscribes; the rows already shown stay until the new snapshot replaces them.
    return subscribeCycles(
      environment,
      (rows, isCapped) => {
        setCycles(rows);
        setCapped(isCapped);
        setShown(pageLimit);
        setFailed(false);
      },
      () => setFailed(true),
      pageLimit
    );
  }, [environment, ready, pageLimit]);

  // `?path=`, `?state=` or `?heal=` narrows the list (the Overview links here). An unknown value filters nothing.
  const filter = runFilter(params);
  const visible = cycles && filter ? cycles.filter(filter.test) : cycles;
  const selectedId = params.get("run");
  // A link to one run (the Incidents page, the evidence page) names it by id: when it is not among the newest
  // CYCLE_LIMIT, it is read by id, so the link opens that run and not whichever is first.
  const loaded = cycles !== null;
  const listed = selectedId !== null && loaded && cycles.some((c) => c.id === selectedId);
  // The by-id answer for one (environment, run): the run, null when it does not exist, "failed" when the read failed.
  const [linked, setLinked] = useState<{ key: string; row: CycleRow | null | "failed" } | null>(null);
  const linkKey = `${environment}/${selectedId ?? ""}`;
  // Listed now: the list is newer than any by-id answer, so a run that drops out of it again is read anew (as on Incidents, #218).
  if (listed && linked?.key === linkKey) setLinked(null);
  useEffect(() => {
    if (!ready || selectedId === null || !loaded || listed) return;
    let live = true;
    readCycle(selectedId, environment).then(
      (row) => live && setLinked({ key: linkKey, row: row !== null && row.id === selectedId ? row : null }),
      () => live && setLinked({ key: linkKey, row: "failed" })
    );
    return () => {
      live = false;
    };
  }, [ready, selectedId, loaded, listed, environment, linkKey]);
  // Absent: not answered yet. A run named in the URL is only ever that run: never another one in its place.
  const linkedAnswer = linked?.key === linkKey ? linked.row : undefined;
  const selected =
    selectedId === null
      ? (visible?.[0] ?? null)
      : (cycles?.find((c) => c.id === selectedId) ?? (linkedAnswer && linkedAnswer !== "failed" ? linkedAnswer : null));
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("run", id);
    setParams(next, { replace: true });
  };
  // Cycle records carry only the incident ID. Read the visible incidents by ID so the list can identify each run
  // without changing its stable URL or assuming that a recent run's incident is in the incident page's time window.
  const incidentIds = useMemo(
    () => [...new Set([...(visible ?? []).map((c) => c.incidentId), ...(selected ? [selected.incidentId] : [])])],
    [visible, selected]
  );
  const incidentReads = useQueries({
    queries: incidentIds.map((id) => ({
      queryKey: ["run-incident", environment, id],
      queryFn: () => getIncident(id, environment),
      enabled: ready,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const incidents = new Map<string, IncidentRow>();
  incidentIds.forEach((id, i) => {
    const row = incidentReads[i]?.data;
    if (row) incidents.set(id, row);
  });

  return (
    <div className="space-y-6">
      <PageMeta title="Runs | Starfish" description="Watch the agent work through each incident, step by step" />
      {settingsUnavailable && <SettingsUnavailableNotice environment={environment} subject="runs" />}
      <div className="space-y-4">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Runs</h1>
            <RunAgentButton />
          </div>
          <p className="mt-2 max-w-3xl text-base text-gray-600 dark:text-gray-400">
            Every incident the engine picks up becomes a run, one per recurrence: it triages the error, may draft a fix,
            verifies and reviews it, and opens a pull request, or hands it to a person. Updated live as the engine records
            each step; a step it has not recorded reads &quot;not reached&quot;.
          </p>
        </div>
        {/* The agent's own status (#274): this page is about agent runs, not the ingest's. */}
        {ready && <AgentStatus environment={environment} variant="card" />}
      </div>

      {failed ? (
        <p role="alert" className="text-sm text-error-700 dark:text-error-400">
          Couldn&apos;t read the runs. <StoreReadHint />
        </p>
      ) : cycles === null ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">Loading runs…</p>
      ) : cycles.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <EmptyState
            icon={<Workflow className="h-5 w-5" aria-hidden />}
            title="No runs recorded"
            description="Nothing has run the agent loop for this environment. A deployment schedules it only once that job exists; until then this list stays empty."
          />
        </div>
      ) : (
        <>
          <RunTiles cycles={cycles} params={params} capped={capped} shown={shown} />
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              {filter ? (
                <span data-testid="path-filter">
                  {filter.label} · {visible?.length ?? 0}
                </span>
              ) : (
                `All runs · ${cycles.length}`
              )}
            </h2>
            <span className="text-sm text-gray-600 dark:text-gray-400">
              Newest first
              {filter && (
                <>
                  {" · "}
                  <Link to="/runs" className="font-medium text-brand-700 hover:underline dark:text-brand-400">
                    Show all runs
                  </Link>
                </>
              )}
            </span>
          </div>
          {visible && visible.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">No recorded run matches this filter.</p>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
              <RunList
                cycles={visible ?? []}
                incidents={incidents}
                capped={capped}
                shown={shown}
                loadingOlder={pageLimit > shown}
                onShowOlder={pageLimit < CYCLE_LIMIT_MAX ? () => setPageLimit((n) => Math.min(n + CYCLE_LIMIT, CYCLE_LIMIT_MAX)) : undefined}
                selectedId={selected?.id ?? null}
                now={now}
                onSelect={select}
              />
              {selected ? (
                <RunDetail key={selected.id} cycle={selected} incident={incidents.get(selected.incidentId)} environment={environment} now={now} />
              ) : (
                selectedId !== null && <LinkedRunMissing answer={linkedAnswer} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** What stands in the detail pane while a run named in the URL is not listed and its by-id read has not found it. */
function LinkedRunMissing({ answer }: { answer: CycleRow | null | "failed" | undefined }) {
  return (
    <section aria-label="Run detail" className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      {answer === undefined ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">Loading this run…</p>
      ) : answer === "failed" ? (
        <p role="alert" className="text-sm text-error-700 dark:text-error-400">
          Couldn&apos;t read this run. Pick one from the list to see it.
        </p>
      ) : (
        <p className="text-sm text-gray-700 dark:text-gray-300">
          No such run: nothing is recorded under this link for this environment. Pick one from the list to see it.
        </p>
      )}
    </section>
  );
}

/** A run's state, with a pulsing dot while a worker holds it (still, for anyone who asked for reduced motion). */
function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge tone={status.tone}>
      {status.live && (
        <span className="relative mr-1.5 flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
        </span>
      )}
      {status.label}
    </Badge>
  );
}

const MARK: Record<TrackMark, string> = {
  done: "bg-brand-600 dark:bg-brand-400",
  running: "bg-info-500 motion-safe:animate-pulse dark:bg-info-400",
  none: "bg-gray-200 dark:bg-gray-700",
};

function RunList({
  cycles,
  incidents,
  capped,
  shown,
  loadingOlder,
  onShowOlder,
  selectedId,
  now,
  onSelect,
}: {
  cycles: CycleRow[];
  incidents: ReadonlyMap<string, IncidentRow>;
  capped: boolean;
  /** How many runs the list read. */
  shown: number;
  loadingOlder: boolean;
  /** Absent once the list reads as many as it ever will (CYCLE_LIMIT_MAX). */
  onShowOlder?: () => void;
  selectedId: string | null;
  now: number;
  onSelect: (id: string) => void;
}) {
  const days = groupByDay(cycles, now);
  return (
    <section aria-label="Runs" className="space-y-4">
      {days.map((day) => (
        <div key={day.key} className="space-y-2">
          <h3 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
            {day.label}
            <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" aria-hidden />
          </h3>
          <ul className="space-y-2">
            {day.cycles.map((c) => {
              const status = runStatus(c, now);
              const current = c.id === selectedId;
              const incident = incidents.get(c.incidentId);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-current={current ? "true" : undefined}
                    onClick={() => onSelect(c.id)}
                    className={`w-full rounded-xl border p-4 text-left ${
                      current
                        ? "border-brand-500 bg-brand-50 dark:border-brand-400 dark:bg-brand-500/10"
                        : "border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100 ${incident ? "" : "font-mono text-xs"}`} title={incident?.functionName ?? c.incidentId}>
                        {incident?.functionName ?? c.incidentId}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {c.synthetic && <SyntheticBadge />}
                        <StatusBadge status={status} />
                      </span>
                    </div>
                    {incident && (
                      <p className="mt-1.5 truncate text-xs text-gray-600 dark:text-gray-400" title={`${incident.errorType}: ${incident.errorMessage}`}>
                        <span className="font-mono text-gray-900 dark:text-gray-100">{incident.errorType}</span>
                        {incident.errorMessage ? ` · ${splitTrace(incident.errorMessage).headline}` : ""}
                      </p>
                    )}
                    <div className="mt-3 flex items-center gap-3">
                      <span className="flex min-w-0 flex-1 gap-1" aria-hidden>
                        {trackMarks(c, now).map((m, i) => (
                          <span key={i} className={`h-1.5 flex-1 rounded-full ${MARK[m]}`} />
                        ))}
                      </span>
                      <span className="shrink-0 text-xs text-gray-600 dark:text-gray-400">{formatRelativeTime(c.updatedAt)}</span>
                    </div>
                    {((c.stage && c.stage !== "cycle") || c.recurrence > 0) && (
                      <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-gray-600 dark:text-gray-400">
                        {c.stage && c.stage !== "cycle" && <span>Last step: {titleOf(c.stage)}</span>}
                        {c.recurrence > 0 && <span>recurrence {c.recurrence}</span>}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {capped && (
        <div className="space-y-2">
          <p className="px-1 text-xs text-gray-600 dark:text-gray-400">
            Showing the {shown} most recently updated runs{onShowOlder ? "." : "; older ones are not listed."}
          </p>
          {onShowOlder && (
            <button
              type="button"
              onClick={onShowOlder}
              disabled={loadingOlder}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-70 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              {loadingOlder ? "Loading older runs…" : "Show older runs"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function RunDetail({ cycle, incident, environment, now }: { cycle: CycleRow; incident?: IncidentRow; environment: string; now: number }) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setEvents(null);
    setFailed(false);
    return subscribeEvents(cycle.id, environment, (rows) => setEvents(rows), () => setFailed(true));
  }, [cycle.id, environment]);

  const status = runStatus(cycle, now);
  // A replay plays the events the engine recorded back at their recorded pace (faster for a long run), as if a worker
  // held the run. It is labelled a replay everywhere it shows, and it draws nothing the events do not hold.
  const [replay, setReplay] = useState<{ startMs: number; speed: number } | null>(null);
  // While a worker holds the run, or it replays, the timer and time bar move every second; otherwise the page's tick.
  const tick = useNow(status.live || replay ? 1000 : TICK_MS);
  const clock = Math.max(now, tick);
  const startMs = cycle.createdAt.getTime();
  const lastMs = events && events.length > 0 ? Math.max(...events.map((e) => e.at.getTime())) : startMs;
  const spanMs = lastMs - startMs;
  const replayAt = replay ? startMs + Math.max(0, clock - replay.startMs) * replay.speed : null;
  const replaying = replay !== null && replayAt !== null && replayAt < lastMs;
  const canReplay = !status.live && events !== null && spanMs > 0;
  const toggleReplay = () =>
    setReplay(replaying ? null : { startMs: Date.now(), speed: spanMs > 90_000 ? Math.ceil(spanMs / 60_000) : 1 });
  const asLive: CycleRow | null =
    replaying && replayAt !== null ? { ...cycle, state: "running", leaseExpiresAt: new Date(replayAt + 60_000), updatedAt: new Date(replayAt) } : null;
  const trackClock = asLive && replayAt !== null ? replayAt : clock;
  const rule = triageRule(cycle);
  const decision = triageDecision(cycle);
  const prUrl = safeUrl(cycle.summary.pr?.url);
  const issue = issueLink(cycle);
  const finding = triageFinding(cycle);
  const prNow = prStateView(cycle, now);
  const indexNow = indexRuntimeView(cycle);
  const water = useMemo(() => {
    if (!events) return null;
    if (asLive && replayAt !== null) return buildWaterfall(asLive, events.filter((e) => e.at.getTime() <= replayAt), replayAt);
    return buildWaterfall(cycle, events, clock);
  }, [cycle, events, clock, asLive, replayAt]);

  const speed = replay?.speed ?? 1;
  const shownStatus = asLive ? { label: speed > 1 ? `Replaying · ${speed}×` : "Replaying", tone: "info" as const, live: true } : status;
  const summary = !water
    ? status.label
    : asLive && replayAt !== null
      ? `Replaying the recorded run${speed > 1 ? ` at ${speed}× speed` : ""}. ${runSummary(asLive, water.steps, replayAt)}`
      : runSummary(cycle, water.steps, clock);
  const failure = incident?.errorMessage ? failureView(incident.errorMessage, incident.errorDetail) : null;
  // A run that ended with a person: drawn as a branch off the last step of its track that has an event.
  const handoff = !asLive && !status.live && cycle.state !== "running" && (cycle.path === "human" || cycle.path === "notify") ? PATH_LABELS[cycle.path] : undefined;

  return (
    <section aria-label="Run detail" className="space-y-6 rounded-xl border border-gray-200 bg-white p-5 sm:p-6 dark:border-gray-700 dark:bg-gray-800">
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 basis-80 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={`min-w-0 break-words text-2xl font-bold tracking-tight text-gray-900 dark:text-white ${incident ? "" : "font-mono"}`}>
              {incident?.functionName ?? cycle.incidentId}
            </h2>
            <StatusBadge status={shownStatus} />
            {cycle.synthetic && <SyntheticBadge />}
          </div>
          <p className="text-base text-gray-700 dark:text-gray-300" data-testid="run-summary">{summary}</p>
          {/* A reopened run (#285): say so here, since the steps and times below are only its latest round's. */}
          {water?.reopened && (
            <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="run-rounds">
              <span className="font-medium text-gray-900 dark:text-gray-100">
                Round {water.rounds}: this run was reopened {water.rounds - 1} {water.rounds - 1 === 1 ? "time" : "times"}.
              </span>{" "}
              Latest {formatRelativeTime(water.reopened.at, "never", now)}
              {water.reopened.summary.replace(/[.\s]+$/, "") ? `: ${water.reopened.summary.replace(/[.\s]+$/, "")}.` : "."} The steps and times below are this round&apos;s; what the earlier
              rounds ended on is at the end of the step log.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {canReplay && (
            <button
              type="button"
              onClick={toggleReplay}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              {replaying ? <Square className="h-4 w-4" aria-hidden /> : <RotateCcw className="h-4 w-4" aria-hidden />}
              {replaying ? "Stop replay" : "Replay this run"}
            </button>
          )}
          <Link
            to={`/incidents/${encodeURIComponent(cycle.incidentId)}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700"
          >
            <FileText className="h-4 w-4" aria-hidden />
            Evidence for this incident
          </Link>
          {issue && (
            <a
              href={issue.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              Issue #{issue.number} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              Pull request #{String(cycle.summary.pr?.number ?? "")} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
        </div>
      </header>

      <section aria-label="Pipeline" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className={SECTION_TITLE}>Pipeline</h3>
          {water && <span className="text-sm text-gray-600 dark:text-gray-400">{progressText(water.steps)}</span>}
        </div>
        {failed ? (
          <p role="alert" className="text-sm text-error-700 dark:text-error-400">
            Couldn&apos;t read this run&apos;s events.
          </p>
        ) : !water ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">Loading steps…</p>
        ) : (
          <>
            <StepTrack steps={water.steps.filter((s) => !s.side)} clock={trackClock} handoff={handoff} />
            <SideSteps steps={water.steps.filter((s) => s.side)} />
            <TimeBar
              water={water}
              live={status.live || asLive !== null}
              clock={trackClock}
              label={asLive && replayAt !== null ? `Replaying · ${formatClock(replayAt - startMs)} of ${formatClock(spanMs)}` : undefined}
            />
            {/* Under the track, not below the trace: it fills in as the track moves, live or in a replay, so the page
                says what is happening and not only how far it got. */}
            <StepLog steps={stepLogOrder(water.steps)} prUrl={prUrl} issueUrl={issue?.url} finding={finding} earlier={water.earlier} rounds={water.rounds} />
          </>
        )}
      </section>

      <div className="flex flex-wrap gap-6">
        {incident && failure && <WhatFailed errorType={incident.errorType} failure={failure} />}
        <section aria-label="Run facts" className="min-w-0 flex-[2_1_16rem] space-y-3">
          <h3 className={SECTION_TITLE}>Run facts</h3>
          <dl className="divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 text-sm dark:divide-gray-700 dark:border-gray-700">
            <Fact label="Incident ID">
              <span className="flex items-center justify-end gap-2">
                <span className="break-all font-mono text-xs">{cycle.incidentId}</span>
                <CopyButton text={cycle.incidentId} />
              </span>
            </Fact>
            {cycle.path && <Fact label="Path">{PATH_LABELS[cycle.path]}</Fact>}
            {decision && (
              <Fact label="Decision">
                {decision.label}
                {decision.mergeCase && <span className="ml-1 font-mono text-xs">({decision.mergeCase})</span>}
                {decision.heldBy && <span className="block text-xs text-gray-600 dark:text-gray-400">{decision.heldBy}</span>}
              </Fact>
            )}
            {rule && (
              <Fact label="Triage rule">
                <span className="font-mono text-xs">{rule}</span>
              </Fact>
            )}
            {cycle.outcome && (
              <Fact label="Outcome">
                <span className="font-mono text-xs">{cycle.outcome}</span>
              </Fact>
            )}
            {indexNow && (
              <Fact label="Index at runtime">
                <Badge tone={indexNow.tone}>{indexNow.text}</Badge>
                {indexNow.until && <span className="block text-xs text-gray-600 dark:text-gray-400">until {indexNow.until.toISOString()}</span>}
              </Fact>
            )}
            {prNow && (
              <Fact label="Pull request now">
                <Badge tone={prNow.tone}>{prNow.text}</Badge>
                {prNow.checkedAt && (
                  <span className="block text-xs text-gray-600 dark:text-gray-400">read from GitHub {formatRelativeTime(prNow.checkedAt, "never", now)}</span>
                )}
              </Fact>
            )}
            <Fact label="Started">{formatDateTime(cycle.createdAt)}</Fact>
            <Fact label="Attempt">{cycle.attempts}</Fact>
          </dl>
        </section>
      </div>

      {water && water.notes.length > 0 && (
        <div>
          <h3 className={SECTION_TITLE}>Cycle notes</h3>
          <ul className="mt-2 space-y-1 text-sm text-gray-700 dark:text-gray-300">
            {water.notes.map((n) => (
              <li key={n.id}>
                <span className="text-xs text-gray-600 dark:text-gray-400">{formatDateTime(n.at)}</span> {n.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
      {cycle.trimmed && (
        <p className="border-t border-gray-200 pt-4 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400" data-testid="trimmed-note">
          Public view: a trimmed copy of the run. The model&apos;s own words and each step&apos;s details are left out of it.
        </p>
      )}
    </section>
  );
}

const SECTION_TITLE = "text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2.5">
      <dt className="shrink-0 text-gray-600 dark:text-gray-400">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-gray-900 dark:text-gray-100">{children}</dd>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // Best effort: a browser that refuses the clipboard just leaves the label as it was.
    navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : "Copy the incident ID"}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100"
    >
      {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
    </button>
  );
}

/** The incident's error: its message, and the stack frames written into it one per line, with the raw text on request. */
function WhatFailed({ errorType, failure }: { errorType: string; failure: ReturnType<typeof failureView> }) {
  const [showRaw, setShowRaw] = useState(false);
  const libraryOnly = failure.frames.length > 0 && failure.frames.every((f) => f.library);
  return (
    <section aria-label="What failed" className="min-w-0 flex-[3_1_22rem] space-y-3">
      <h3 className={SECTION_TITLE}>What failed</h3>
      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="space-y-1.5 border-b border-gray-200 p-4 dark:border-gray-700">
          <p className="font-mono text-xs font-medium text-brand-700 dark:text-brand-400">{errorType}</p>
          <p className="break-words font-mono text-sm text-gray-900 dark:text-gray-100">{failure.headline}</p>
          {/* The cause the engine stored beside the title (#289): the title alone can say nothing ("Checkout failed"). */}
          {failure.cause && (
            <p className="break-words text-sm text-gray-700 dark:text-gray-300">
              <span className="font-medium text-gray-900 dark:text-gray-100">Cause:</span> <span className="font-mono">{failure.cause}</span>
            </p>
          )}
        </div>
        {failure.frames.length > 0 && (
          <ol aria-label="Stack frames" className="bg-gray-50 py-1.5 dark:bg-gray-900/40">
            {failure.frames.map((f, i) => (
              <li key={i} className="px-4 py-1.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs text-gray-600 dark:text-gray-400">at</span>
                  {f.fn && <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{f.fn}</span>}
                  {f.library && <Badge>library</Badge>}
                </div>
                <p className="break-all pl-5 font-mono text-xs text-gray-600 dark:text-gray-400">{f.at}</p>
              </li>
            ))}
          </ol>
        )}
        {showRaw && failure.hasMore && (
          <pre className="whitespace-pre-wrap break-all border-t border-gray-200 px-4 py-3 font-mono text-xs text-gray-700 dark:border-gray-700 dark:text-gray-300">{failure.raw}</pre>
        )}
        {/* Offered only when the raw text holds more than the panel shows: a toggle that opens to the title again says nothing. */}
        {(libraryOnly || failure.hasMore) && (
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 px-4 py-1 dark:border-gray-700">
            {libraryOnly && <p className="flex-1 basis-48 py-2 text-xs text-gray-600 dark:text-gray-400">Every frame is in a dependency; none points at the app&apos;s own code.</p>}
            {failure.hasMore && (
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                aria-expanded={showRaw}
                className="ml-auto min-h-11 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
              >
                {showRaw ? "Hide the raw message" : "Show the raw message"}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Counts of the listed runs by how they stand, each a link to the list narrowed to them (the same URLs Overview uses). */
function RunTiles({ cycles, params, capped, shown }: { cycles: CycleRow[]; params: URLSearchParams; capped: boolean; shown: number }) {
  const count = (test: (c: CycleRow) => boolean) => cycles.filter(test).length;
  const active = params.get("heal") ? "" : params.get("state") ? `state=${params.get("state")}` : params.get("path") ? `path=${params.get("path")}` : "all";
  const tiles = [
    { key: "state=waiting-human", label: "Waiting for a human", n: count((c) => c.state === "waiting-human"), tone: "text-warning-700 dark:text-warning-400" },
    { key: "state=running", label: "In progress", n: count((c) => c.state === "running"), tone: "text-info-800 dark:text-info-400" },
    { key: "state=declined", label: "Declined", n: count((c) => c.state === "declined"), tone: "" },
    { key: "path=pr", label: "Pull request opened", n: count((c) => c.path === "pr"), tone: "" },
    { key: "all", label: "All runs", n: cycles.length, tone: "" },
  ];
  return (
    <nav aria-label="Run counts" className="space-y-2">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <li key={t.key}>
            <Link
              to={t.key === "all" || t.key === active ? "/runs" : `/runs?${t.key}`}
              aria-current={t.key === active ? "true" : undefined}
              className={`flex min-h-11 flex-col gap-0.5 rounded-xl border bg-white px-4 py-3 hover:border-gray-400 dark:bg-gray-800 dark:hover:border-gray-500 ${
                t.key === active ? "border-gray-900 ring-1 ring-gray-900 dark:border-gray-100 dark:ring-gray-100" : "border-gray-200 dark:border-gray-700"
              }`}
            >
              <span className={`text-2xl font-bold tabular-nums ${t.tone || "text-gray-900 dark:text-white"}`}>{t.n}</span>
              <span className="text-sm text-gray-600 dark:text-gray-400">{t.label}</span>
            </Link>
          </li>
        ))}
      </ul>
      {capped && <p className="text-xs text-gray-600 dark:text-gray-400">Counts cover the {shown} most recently updated runs.</p>}
    </nav>
  );
}

/** The line under a step on the track: what it ended in and how long it took, or how long it has been running. */
function stepLine(step: Step, clock: number): string {
  if (step.status === "running") return step.since ? `Running · ${formatClock(clock - step.since.getTime())}` : "Running";
  if (step.status === "not-reached") return "Not reached";
  return `Done${step.outcome ? `: ${step.outcome}` : ""}${step.durationMs !== undefined ? ` · ${formatDuration(step.durationMs)}` : ""}`;
}

function StepNode({ status }: { status: StepStatus }) {
  if (status === "done") {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white dark:bg-brand-400 dark:text-gray-950">
        <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center">
        <span className="absolute inset-0 rounded-full border-2 border-info-200 border-t-info-700 motion-safe:animate-spin dark:border-info-900 dark:border-t-info-400" />
        <span className="h-2 w-2 rounded-full bg-info-700 dark:bg-info-400" />
      </span>
    );
  }
  return <span className="h-7 w-7 shrink-0 rounded-full border-2 border-dashed border-gray-300 dark:border-gray-600" />;
}

/** The line into a step: solid once it happened, pulsing while it runs, dashed while it is not reached. */
const RAIL: Record<StepStatus, string> = {
  done: "h-0.5 bg-brand-600 dark:bg-brand-400",
  running: "h-0.5 bg-info-500 motion-safe:animate-pulse dark:bg-info-400",
  "not-reached": "border-t-2 border-dashed border-gray-300 dark:border-gray-600",
};

/** The loop's stages in order. Only a step a worker is on right now spins; a step with no event is "not reached". */
function StepTrack({ steps, clock, handoff }: { steps: Step[]; clock: number; handoff?: string }) {
  const lastDone = steps.map((s) => s.status).lastIndexOf("done");
  return (
    <div className="overflow-x-auto pb-1">
      <ol aria-label="Steps" className="flex min-w-[34rem]">
        {steps.map((step, i) => {
          const next = steps[i + 1];
          return (
            <li key={step.stage} data-step={step.stage} data-status={step.status} className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="mb-1.5 flex items-center" aria-hidden>
                <StepNode status={step.status} />
                {next && <span className={`mx-2 flex-1 rounded ${RAIL[next.status]}`} />}
              </div>
              <span className={`pr-3 text-sm font-semibold ${step.status === "not-reached" ? "text-gray-600 dark:text-gray-400" : "text-gray-900 dark:text-white"}`}>
                {step.title}
              </span>
              <span
                className={`pr-3 text-xs ${step.status === "running" ? "font-medium tabular-nums text-info-800 dark:text-info-400" : "text-gray-600 dark:text-gray-400"}`}
                title={step.status === "running" ? "Counted from when the step before ended: the engine records a step's end, not its start" : undefined}
              >
                {stepLine(step, clock)}
              </span>
              {handoff && i === lastDone && (
                <span className="mr-3 mt-1.5 inline-flex items-center gap-1.5 self-start rounded-lg bg-warning-50 px-2.5 py-1.5 text-xs font-semibold text-warning-700 dark:bg-warning-500/15 dark:text-warning-400">
                  <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
                  {handoff}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Steps recorded beside the loop's own (the issue, the alert, telling a person, a phone call...). */
function SideSteps({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-gray-600 dark:text-gray-400">Also recorded:</span>
      <ul aria-label="Also recorded" className="flex flex-wrap gap-2">
        {steps.map((s) => (
          <li key={s.stage} className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200">
            <Check className="h-3 w-3" aria-hidden />
            {s.title}
            {s.outcome ? `: ${s.outcome}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

const SEGMENT_COLORS = [
  "bg-brand-600 dark:bg-brand-400",
  "bg-warning-500 dark:bg-warning-400",
  "bg-success-600 dark:bg-success-400",
  "bg-gray-500 dark:bg-gray-400",
  "bg-brand-300 dark:bg-brand-200",
];

/** Where the run's time went: one segment per recorded step, and the running one growing while a worker holds it. */
function TimeBar({ water, live, clock, label }: { water: Waterfall; live: boolean; clock: number; label?: string }) {
  const done = water.steps.filter((s) => s.status === "done" && !s.side && s.width !== undefined && s.durationMs !== undefined);
  const running = water.steps.find((s) => s.status === "running");
  if (done.length === 0 && !running) return null;
  const span = water.endMs - water.startMs;
  const runningShare = running?.since ? Math.max(0, (water.endMs - running.since.getTime()) / span) : 0;
  const parts = [...done.map((s) => `${s.title} ${formatDuration(s.durationMs!)}`), ...(running ? [`${running.title} running`] : [])];
  return (
    <div className="space-y-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
      <p className="text-xs font-medium tabular-nums text-gray-900 dark:text-white">
        {label ??
          (live
            ? `Running for ${formatDuration(clock - water.startMs)}${water.reopened ? " since it was reopened" : ""}`
            : `${formatDuration(span)} from ${water.reopened ? "the latest reopening" : "start"} to the last update`)}
      </p>
      <div role="img" aria-label={`Time per step: ${parts.join(", ")}`} className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        {done.map((s, i) => (
          <span key={s.stage} className={SEGMENT_COLORS[i % SEGMENT_COLORS.length]} style={{ flexBasis: `${Math.max(s.width! * 100, 0.75).toFixed(2)}%` }} />
        ))}
        {running && (
          <span className="bg-info-500 motion-safe:animate-pulse dark:bg-info-400" style={{ flexBasis: `${Math.max(runningShare * 100, 0.75).toFixed(2)}%` }} />
        )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400" aria-hidden>
        {done.map((s, i) => (
          <li key={s.stage} className="inline-flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${SEGMENT_COLORS[i % SEGMENT_COLORS.length]}`} />
            {s.title} <span className="tabular-nums text-gray-900 dark:text-gray-100">{formatDuration(s.durationMs!)}</span>
          </li>
        ))}
        {running && (
          <li className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-info-500 dark:bg-info-400" />
            {running.title} <span className="font-medium text-info-800 dark:text-info-400">running</span>
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * What each step said and when, newest first: the step in progress on top, then the latest finished one, so what is
 * happening now sits right under the track without scrolling. Triage's entry carries
 * its suspected cause and whose words they are; the issue's and the pull request's carry their links, each only once its
 * own step happened. For a reopened run (#285) these are its latest round's steps, and what each earlier round ended on
 * follows, newest first.
 */
function StepLog({
  steps,
  prUrl,
  issueUrl,
  finding,
  earlier = [],
  rounds = 1,
}: {
  steps: Step[];
  prUrl?: string;
  issueUrl?: string;
  finding?: ReturnType<typeof triageFinding>;
  earlier?: EarlierRound[];
  rounds?: number;
}) {
  if (steps.length === 0 && earlier.length === 0) return null;
  return (
    <div>
      <h3 className={SECTION_TITLE}>Step log</h3>
      <ol aria-label="Step log" className="mt-1 divide-y divide-gray-100 dark:divide-gray-700">
        {steps.map((step) => (
          <li key={step.stage} className="py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-sm font-medium text-gray-900 dark:text-white">{step.title}</span>
              <span className="text-xs text-gray-600 dark:text-gray-400">
                {step.status === "running" ? "In progress" : `Done${step.outcome ? `: ${step.outcome}` : ""}`}
              </span>
              {step.at && (
                <span className="ml-auto text-xs text-gray-600 dark:text-gray-400">
                  {formatDateTime(step.at)}
                  {step.durationMs !== undefined ? ` · ${formatDuration(step.durationMs)} since the step before` : ""}
                </span>
              )}
            </div>
            {step.summary && <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{step.summary}</p>}
            {step.stage === "triage" && step.status === "done" && finding && (
              <>
                {!step.summary && <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{finding.reason}</p>}
                {finding.suspectedCause && (
                  <p className="mt-0.5 break-words text-sm text-gray-700 dark:text-gray-300">
                    <span className="font-medium text-gray-900 dark:text-gray-100">Suspected cause:</span> {finding.suspectedCause}
                  </p>
                )}
                {finding.by && (
                  <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                    {finding.by === "model" ? (
                      <>
                        The model&apos;s reasoning{finding.model && <> (<span className="font-mono">{finding.model}</span>)</>}, as triage recorded it.
                      </>
                    ) : (
                      <>
                        Decided by the rule <span className="font-mono">{finding.rule}</span>, with no model call.
                      </>
                    )}
                  </p>
                )}
              </>
            )}
            {step.stage === "issue" && step.status === "done" && issueUrl && (
              <a href={issueUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 break-all text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
                Open the issue <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            )}
            {step.stage === "pr" && step.status === "done" && prUrl && (
              <a href={prUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 break-all text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
                Open the pull request <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            )}
          </li>
        ))}
      </ol>
      {earlier.length > 0 && (
        <>
          <h4 className="mt-3 text-xs font-medium text-gray-600 dark:text-gray-400">Earlier rounds</h4>
          <ol aria-label="Earlier rounds" className="mt-1 divide-y divide-gray-100 dark:divide-gray-700">
            {[...earlier].reverse().map((r) => (
              <li key={r.round} className="py-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">{r.title}</span>
                  <span className="text-xs text-gray-600 dark:text-gray-400">
                    Round {r.round} of {rounds} · Done{r.outcome ? `: ${r.outcome}` : ""}
                  </span>
                  <span className="ml-auto text-xs text-gray-600 dark:text-gray-400">
                    {formatDateTime(r.at)} · {formatDuration(r.durationMs)} into that round
                  </span>
                </div>
                {r.summary && <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{r.summary}</p>}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
