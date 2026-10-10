/**
 * Runs — the agent's cycles as they happen: a list of runs by day, and for the one selected its stages as a track, a
 * time bar and a log. Both are live subscriptions to what the engine writes (src/agent/cycle.ts); nothing
 * here is inferred. A step with no event is "not reached", a cycle with no worker on it is not "in
 * progress" (and nothing on it animates), and nothing is drawn for a stage the loop has no code for (merge, deploy, recovery).
 *
 * Where the agent job (`DEPLOY_AGENT=1`, #74) has not run, this page is empty until it does; it says so instead of looking
 * like a quiet day. On the demo project it runs hourly since 2026-10-07 (in dry run until 2026-10-10).
 */
import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { Check, ExternalLink, Workflow } from "lucide-react";
import PageMeta from "../components/PageMeta";
import SettingsUnavailableNotice from "../components/SettingsUnavailableNotice";
import { EngineStatus } from "../components/EngineStatus";
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
  safeUrl,
  triageDecision,
  triageRule,
  type CycleRow,
  type EventRow,
  type RunStatus,
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
    <div className="space-y-4">
      <PageMeta title="Runs | Starfish" description="Watch the agent work through each incident, step by step" />
      {settingsUnavailable && <SettingsUnavailableNotice environment={environment} subject="runs" />}
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Runs</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          One run per incident and recurrence, updated live as the engine records each step. A step the engine has
          not recorded reads &quot;not reached&quot;.
        </p>
        <div className="mt-2">{ready && <EngineStatus environment={environment} />}</div>
      </div>

      {failed ? (
        <p role="alert" className="text-sm text-error-700 dark:text-error-400">
          Couldn&apos;t read the runs. Check that firestore.rules and firestore.indexes.json are deployed to the
          Starfish database.
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
          {filter && (
            <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="path-filter">
              {filter.lead} <strong>{filter.label}</strong> ({visible?.length ?? 0}).{" "}
              <Link to="/runs" className="font-medium text-brand-700 hover:underline dark:text-brand-400">
                Show all runs
              </Link>
            </p>
          )}
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
                <RunDetail cycle={selected} incident={incidents.get(selected.incidentId)} environment={environment} now={now} />
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
                    className={`w-full rounded-lg border p-3 text-left ${
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
                      <p className="mt-1 truncate text-xs text-gray-600 dark:text-gray-400" title={`${incident.errorType}: ${incident.errorMessage}`}>
                        {incident.errorType}{incident.errorMessage ? `: ${incident.errorMessage}` : ""}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-600 dark:text-gray-400">
                      {c.recurrence > 0 && <span>recurrence {c.recurrence}</span>}
                      <span>{formatRelativeTime(c.updatedAt)}</span>
                    </div>
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
  // While a worker holds the run, its timer and time bar move every second; otherwise the page's own tick is enough.
  const tick = useNow(status.live ? 1000 : TICK_MS);
  const clock = Math.max(now, tick);
  const rule = triageRule(cycle);
  const decision = triageDecision(cycle);
  const prUrl = safeUrl(cycle.summary.pr?.url);
  const prNow = prStateView(cycle, now);
  const indexNow = indexRuntimeView(cycle);
  const water = useMemo(() => (events ? buildWaterfall(cycle, events, clock) : null), [cycle, events, clock]);

  return (
    <section aria-label="Run detail" className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className={`min-w-0 break-words text-sm font-semibold text-gray-900 dark:text-white ${incident ? "" : "font-mono"}`}>
            {incident?.functionName ?? cycle.incidentId}
          </h2>
          <StatusBadge status={status} />
          {cycle.synthetic && <SyntheticBadge />}
        </div>
        {cycle.trimmed && (
          <p className="text-xs text-gray-600 dark:text-gray-400" data-testid="trimmed-note">
            Public view: a trimmed copy of the run. The model&apos;s own words and each step&apos;s details are left out of it.
          </p>
        )}
        {incident && (
          <p className="break-words text-sm text-gray-600 dark:text-gray-400">
            {incident.errorType}{incident.errorMessage ? `: ${incident.errorMessage}` : ""}
          </p>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-gray-700 dark:text-gray-300">
          {incident && (
            <>
              <dt className="text-gray-600 dark:text-gray-400">Incident ID</dt>
              <dd className="break-all font-mono text-xs">{cycle.incidentId}</dd>
            </>
          )}
          {cycle.path && (
            <>
              <dt className="text-gray-600 dark:text-gray-400">Path</dt>
              <dd>{PATH_LABELS[cycle.path]}</dd>
            </>
          )}
          {decision && (
            <>
              <dt className="text-gray-600 dark:text-gray-400">Decision</dt>
              <dd>
                {decision.label}
                {decision.mergeCase && <span className="ml-1 font-mono text-xs">({decision.mergeCase})</span>}
                {decision.heldBy && <span className="block text-xs text-gray-600 dark:text-gray-400">{decision.heldBy}</span>}
              </dd>
            </>
          )}
          {rule && (
            <>
              <dt className="text-gray-600 dark:text-gray-400">Triage rule</dt>
              <dd className="font-mono text-xs">{rule}</dd>
            </>
          )}
          {cycle.outcome && (
            <>
              <dt className="text-gray-600 dark:text-gray-400">Outcome</dt>
              <dd>{cycle.outcome}</dd>
            </>
          )}
          {indexNow && (
            <>
              <dt className="text-gray-600 dark:text-gray-400">Index at runtime</dt>
              <dd>
                <Badge tone={indexNow.tone}>{indexNow.text}</Badge>
                {indexNow.until && <span className="ml-2 text-xs text-gray-600 dark:text-gray-400">until {indexNow.until.toISOString()}</span>}
              </dd>
            </>
          )}
          {prNow && (
            <>
              <dt className="text-gray-600 dark:text-gray-400">Pull request now</dt>
              <dd>
                <Badge tone={prNow.tone}>{prNow.text}</Badge>
                {prNow.checkedAt && (
                  <span className="ml-2 text-xs text-gray-600 dark:text-gray-400">read from GitHub {formatRelativeTime(prNow.checkedAt, "never", now)}</span>
                )}
              </dd>
            </>
          )}
          {water && (
            <>
              <dt className="text-gray-600 dark:text-gray-400">Progress</dt>
              <dd>{progressText(water.steps)}</dd>
            </>
          )}
          <dt className="text-gray-600 dark:text-gray-400">Started</dt>
          <dd>
            {formatDateTime(cycle.createdAt)}, attempt {cycle.attempts}
          </dd>
        </dl>
        <Link
          to={`/incidents/${encodeURIComponent(cycle.incidentId)}`}
          className="mr-4 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          Evidence for this incident
        </Link>
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            Pull request #{String(cycle.summary.pr?.number ?? "")} <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
      </header>

      {failed ? (
        <p role="alert" className="text-sm text-error-700 dark:text-error-400">
          Couldn&apos;t read this run&apos;s events.
        </p>
      ) : !water ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">Loading steps…</p>
      ) : (
        <>
          <StepTrack steps={water.steps.filter((s) => !s.side)} clock={clock} />
          <SideSteps steps={water.steps.filter((s) => s.side)} />
          <TimeBar water={water} live={status.live} clock={clock} />
          <StepLog steps={water.steps.filter((s) => s.status === "done")} prUrl={prUrl} />
          {water.notes.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-900 dark:text-white">Cycle notes</h3>
              <ul className="mt-1 space-y-1 text-sm text-gray-700 dark:text-gray-300">
                {water.notes.map((n) => (
                  <li key={n.id}>
                    <span className="text-xs text-gray-600 dark:text-gray-400">{formatDateTime(n.at)}</span> {n.summary}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
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
function StepTrack({ steps, clock }: { steps: Step[]; clock: number }) {
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
function TimeBar({ water, live, clock }: { water: Waterfall; live: boolean; clock: number }) {
  const done = water.steps.filter((s) => s.status === "done" && s.width !== undefined && s.durationMs !== undefined);
  const running = water.steps.find((s) => s.status === "running");
  if (done.length === 0 && !running) return null;
  const span = water.endMs - water.startMs;
  const runningShare = running?.since ? Math.max(0, (water.endMs - running.since.getTime()) / span) : 0;
  const parts = [...done.map((s) => `${s.title} ${formatDuration(s.durationMs!)}`), ...(running ? [`${running.title} running`] : [])];
  return (
    <div className="space-y-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
      <p className="text-xs font-medium tabular-nums text-gray-900 dark:text-white">
        {live ? `Running for ${formatDuration(clock - water.startMs)}` : `${formatDuration(span)} from start to the last update`}
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

/** What each recorded step said, when, and the pull request from its own step once that step happened. */
function StepLog({ steps, prUrl }: { steps: Step[]; prUrl?: string }) {
  if (steps.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-900 dark:text-white">Step log</h3>
      <ol aria-label="Step log" className="mt-1 divide-y divide-gray-100 dark:divide-gray-700">
        {steps.map((step) => (
          <li key={step.stage} className="py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-sm font-medium text-gray-900 dark:text-white">{step.title}</span>
              <span className="text-xs text-gray-600 dark:text-gray-400">Done{step.outcome ? `: ${step.outcome}` : ""}</span>
              {step.at && (
                <span className="ml-auto text-xs text-gray-600 dark:text-gray-400">
                  {formatDateTime(step.at)}
                  {step.durationMs !== undefined ? ` · ${formatDuration(step.durationMs)} since the step before` : ""}
                </span>
              )}
            </div>
            {step.summary && <p className="mt-0.5 text-sm text-gray-700 dark:text-gray-300">{step.summary}</p>}
            {step.stage === "pr" && prUrl && (
              <a href={prUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 break-all text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
                Open the pull request <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
