/**
 * Runs — the agent's cycles as they happen: a list of runs by day, and for the one selected a hero card, its stages as a track, a
 * timeline of what each step did. Both are live subscriptions to what the engine writes (src/agent/cycle.ts); nothing
 * here is inferred. A step with no event is "not reached", a cycle with no worker on it is not "in
 * progress" (and nothing on it animates), and nothing is drawn for a stage the loop has no code for (merge, deploy, recovery).
 *
 * Where the agent job (`DEPLOY_AGENT=1`, #74) has not run, this page is empty until it does; it says so instead of looking
 * like a quiet day. On the demo project it runs hourly since 2026-10-07 (in dry run until 2026-10-10).
 */
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import {
  ArrowDownUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDot,
  Copy,
  CornerDownRight,
  Database,
  ExternalLink,
  FileText,
  FlaskConical,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Maximize2,
  Minimize2,
  Phone,
  ScanSearch,
  ShieldCheck,
  Play,
  X,
} from "lucide-react";
import { GeminiMark } from "../components/GeminiMark";
import { GithubMark } from "../components/GithubMark";
import { SlackMark } from "../components/SlackMark";
import { StarfishLogo } from "../layout/StarfishLogo";
import PageMeta from "../components/PageMeta";
import SettingsUnavailableNotice from "../components/SettingsUnavailableNotice";
import StoreReadHint from "../components/StoreReadHint";
import { AgentStatus } from "../components/AgentStatus";
import { RunAgentButton } from "../components/AdminActions";
import { RetryRunButton } from "../components/RetryRunButton";
import { ReplayControl } from "../components/ReplayControl";
import { HandoffCard } from "../components/HandoffCard";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { SyntheticBadge } from "../components/SyntheticBadge";
import { EmptyState } from "../components/ui/EmptyState";
import { formatDateTime, formatRelativeTime } from "../lib/formatters";
import { useEnvironment } from "../lib/useSettings";
import { useRetryingSubscription } from "../lib/useLiveRecord";
import { TICK_MS, useNow } from "../lib/useNow";
import { getIncident, type IncidentRow } from "../lib/incidents";
import { CYCLE_LIMIT, CYCLE_LIMIT_MAX, EVENT_LIMIT, readCycle, subscribeCycles, subscribeEvents } from "../lib/runs";
import {
  PATH_LABELS,
  indexRuntimeView,
  buildWaterfall,
  formatClock,
  formatDuration,
  groupByDay,
  pageIndexOf,
  pageOf,
  prStateView,
  recoveryView,
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
  prLink,
  stepLogOrder,
  earlierAsStep,
  triageFinding,
  triageDecision,
  triageRule,
  isReached,
  type CycleRow,
  type EventRow,
  type RunStatus,
  type Step,
  type StepStatus,
  type Waterfall,
  parseReplaySpeed,
  replaySpeed,
  roundStartMs,
  type ReplaySpeedChoice,
} from "../lib/runsModel";
import { runInWords } from "../lib/runWords";
import { LEVELS, LEVEL_SHORT, judgedOnGitHub, recordIsTheStep, stepDetail, type Level, type ReviewAttack, type StepDetail } from "../lib/runStepDetail";


/** Whether the selected run is shown full width, the run list hidden; kept per browser, like the sidebar's collapse. */
const LIST_HIDDEN_KEY = "starfish.runs.listHidden";

function readListHidden(): boolean {
  try {
    return localStorage.getItem(LIST_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** The replay speed a viewer picked; kept per browser, like the full-width choice. */
const REPLAY_SPEED_KEY = "starfish.runs.replaySpeed";

function readReplaySpeed(): ReplaySpeedChoice {
  try {
    return parseReplaySpeed(localStorage.getItem(REPLAY_SPEED_KEY));
  } catch {
    return "auto";
  }
}

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
  const [listHidden, setListHidden] = useState(readListHidden);
  const toggleList = () => {
    setListHidden((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LIST_HIDDEN_KEY, next ? "1" : "0");
      } catch {
        // Private mode: the choice just won't persist.
      }
      return next;
    });
  };
  const [listEnv, setListEnv] = useState(environment);
  if (listEnv !== environment) {
    setListEnv(environment);
    setPageLimit(CYCLE_LIMIT);
    setShown(CYCLE_LIMIT);
    setCycles(null);
  }

  // A bigger page re-subscribes; the rows already shown stay until the new snapshot replaces them. A listener that fails
  // is started again after a while (#357), and the list says it failed until a new snapshot arrives.
  useRetryingSubscription(ready ? JSON.stringify([environment, pageLimit]) : null, (onError, retrying) => {
    if (!retrying) setFailed(false);
    return subscribeCycles(
      environment,
      (rows, isCapped) => {
        setCycles(rows);
        setCapped(isCapped);
        setShown(pageLimit);
        setFailed(false);
      },
      () => {
        setFailed(true);
        onError();
      },
      pageLimit
    );
  });

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
  // The list shows RUNS_PER_PAGE runs at a time. Another environment or filter starts again from the first page; a run
  // named in the URL opens on its own page, once, so paging away from it afterwards stays where the operator put it.
  const [page, setPage] = useState(0);
  const pageKey = `${environment}|${filter?.label ?? ""}`;
  const [pagedFor, setPagedFor] = useState(pageKey);
  if (pagedFor !== pageKey) {
    setPagedFor(pageKey);
    setPage(0);
  }
  const [jumpedFor, setJumpedFor] = useState<string | null>(null);
  if (selectedId !== null && selectedId !== jumpedFor && visible) {
    const at = pageIndexOf(
      visible.map((c) => c.id),
      selectedId
    );
    if (at !== null) {
      setJumpedFor(selectedId);
      setPage(at);
    }
  }
  const paged = pageOf(visible ?? [], page);
  const selected =
    selectedId === null
      ? (paged.items[0] ?? null)
      : (cycles?.find((c) => c.id === selectedId) ?? (linkedAnswer && linkedAnswer !== "failed" ? linkedAnswer : null));
  // Full width only while a run is shown: its hero holds the toggle that brings the list back.
  const fullWidth = listHidden && selected !== null;
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("run", id);
    setParams(next, { replace: true });
  };
  // Cycle records carry only the incident ID. Read the incidents of the page shown by ID so the list can identify each
  // run without changing its stable URL or assuming that a recent run's incident is in the incident page's time window.
  const pageItems = paged.items;
  const incidentIds = useMemo(
    () => [...new Set([...pageItems.map((c) => c.incidentId), ...(selected ? [selected.incidentId] : [])])],
    [pageItems, selected]
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
            icon={<Play className="h-5 w-5" aria-hidden />}
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
            <div className={`grid grid-cols-[minmax(0,1fr)] gap-4 ${fullWidth ? "" : "lg:grid-cols-[20rem_minmax(0,1fr)]"}`}>
              {/* Hidden, not unmounted: the hero's toggle keeps its aria-controls target, and showing it again is instant. */}
              <div id="run-list" hidden={fullWidth} className="min-w-0">
                <RunList
                  cycles={paged.items}
                  pagination={{ ...paged, total: visible?.length ?? 0, onPage: setPage }}
                  incidents={incidents}
                  capped={capped}
                  shown={shown}
                  loadingOlder={pageLimit > shown}
                  onShowOlder={pageLimit < CYCLE_LIMIT_MAX ? () => setPageLimit((n) => Math.min(n + CYCLE_LIMIT, CYCLE_LIMIT_MAX)) : undefined}
                  selectedId={selected?.id ?? null}
                  now={now}
                  onSelect={select}
                />
              </div>
              {selected ? (
                <RunDetail
                  key={selected.id}
                  cycle={selected}
                  incident={incidents.get(selected.incidentId)}
                  environment={environment}
                  now={now}
                  fullWidth={{ on: fullWidth, toggle: toggleList }}
                />
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
  pagination,
  incidents,
  capped,
  shown,
  loadingOlder,
  onShowOlder,
  selectedId,
  now,
  onSelect,
}: {
  /** The runs of the page shown. */
  cycles: CycleRow[];
  pagination: { page: number; pages: number; from: number; to: number; total: number; onPage: (page: number) => void };
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
                    {/* How a finished run ended, in the loop's own words, beside its last step. */}
                    {c.path && !status.live && c.state !== "running" && (
                      <p className="mt-2 text-sm font-medium text-gray-800 dark:text-gray-200">{PATH_LABELS[c.path]}</p>
                    )}
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
      {pagination.pages > 1 && <RunPager {...pagination} />}
      {/* Older runs are read only from the last page: they come after it. */}
      {capped && pagination.page === pagination.pages - 1 && (
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

const PAGER_BUTTON =
  "inline-flex min-h-9 items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700";

/** Previous / next through the list, RUNS_PER_PAGE runs at a time, and which runs this page holds. */
function RunPager({ page, pages, from, to, total, onPage }: { page: number; pages: number; from: number; to: number; total: number; onPage: (page: number) => void }) {
  return (
    <nav aria-label="Runs pages" className="flex items-center justify-between gap-2">
      <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0} className={PAGER_BUTTON}>
        <ChevronLeft className="h-4 w-4" aria-hidden /> Newer
      </button>
      <span className="text-center text-xs text-gray-600 dark:text-gray-400" aria-live="polite">
        Page {page + 1} of {pages} · {from}–{to} of {total}
      </span>
      <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pages - 1} className={PAGER_BUTTON}>
        Older <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
    </nav>
  );
}

function RunDetail({
  cycle,
  incident,
  environment,
  now,
  fullWidth,
}: {
  cycle: CycleRow;
  incident?: IncidentRow;
  environment: string;
  now: number;
  fullWidth: { on: boolean; toggle: () => void };
}) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  // The run has more events than the page reads (#326): only its newest EVENT_LIMIT are drawn, and the page says so.
  const [eventsCapped, setEventsCapped] = useState(false);
  const [failed, setFailed] = useState(false);

  // Started again after a while when it fails (#357); the timeline says it failed until a new snapshot arrives.
  useRetryingSubscription(JSON.stringify([cycle.id, environment]), (onError, retrying) => {
    if (!retrying) {
      setEvents(null);
      setEventsCapped(false);
      setFailed(false);
    }
    return subscribeEvents(
      cycle.id,
      environment,
      (rows, capped) => {
        setEvents(rows);
        setEventsCapped(capped);
        setFailed(false);
      },
      () => {
        setFailed(true);
        onError();
      }
    );
  });

  const status = runStatus(cycle, now);
  // A replay plays the events the engine recorded back, as if a worker held the run, at the speed the viewer picked
  // ("auto": the recorded pace, faster for a long run). It is labelled a replay everywhere it shows, and it draws nothing
  // the events do not hold. It is anchored at a wall-clock moment and a recorded one, so a new speed carries on from
  // where the replay is instead of starting again.
  const [replay, setReplay] = useState<{ wallMs: number; atMs: number } | null>(null);
  const [speedChoice, setSpeedChoice] = useState<ReplaySpeedChoice>(readReplaySpeed);
  // While a worker holds the run, or it replays, the timer and time bar move every second; otherwise the page's tick.
  const tick = useNow(status.live || replay ? 1000 : TICK_MS);
  const clock = Math.max(now, tick);
  // The replay plays the round the track draws: from the latest reopening, not the run's first start.
  const startMs = roundStartMs(cycle, events ?? []);
  const lastMs = events && events.length > 0 ? Math.max(startMs, ...events.map((e) => e.at.getTime())) : startMs;
  const spanMs = lastMs - startMs;
  const speed = replaySpeed(speedChoice, spanMs);
  const replayAt = replay ? replay.atMs + Math.max(0, clock - replay.wallMs) * speed : null;
  const replaying = replay !== null && replayAt !== null && replayAt < lastMs;
  const canReplay = !status.live && events !== null && spanMs > 0;
  // A run a person was told about, or that was declined, on an open incident, and with no pull request of its own (the
  // record's `pr.opened`, the engine's own test, not a link's shape): the engine reopens that same run on request
  // (src/agent/reconsider.ts), so it opens no second issue or pull request.
  const canRetry =
    (cycle.state === "waiting-human" || cycle.state === "declined" || cycle.state === "failed") &&
    !status.live &&
    incident !== undefined &&
    ["new", "acknowledged", "logged", "recurred"].includes(incident.status) &&
    cycle.summary.pr?.opened !== true;
  const toggleReplay = () => setReplay(replaying ? null : { wallMs: Date.now(), atMs: startMs });
  const changeSpeed = (next: ReplaySpeedChoice) => {
    // Re-anchored on the same clock replayAt was read with, so the replay neither jumps nor stalls. A replay that already
    // ended is dropped: a slower speed would otherwise put its position back inside the run and resume it mid-way.
    if (replaying && replayAt !== null) setReplay({ wallMs: clock, atMs: replayAt });
    else setReplay(null);
    setSpeedChoice(next);
    try {
      localStorage.setItem(REPLAY_SPEED_KEY, String(next));
    } catch {
      // Private mode: the choice just won't persist.
    }
  };
  const asLive: CycleRow | null =
    replaying && replayAt !== null ? { ...cycle, state: "running", leaseExpiresAt: new Date(replayAt + 60_000), updatedAt: new Date(replayAt) } : null;
  const trackClock = asLive && replayAt !== null ? replayAt : clock;
  const rule = triageRule(cycle);
  const decision = triageDecision(cycle);
  const pr = prLink(cycle);
  const issue = issueLink(cycle);
  const finding = triageFinding(cycle);
  const prNow = prStateView(cycle, now);
  const recoveryNow = recoveryView(cycle, now);
  const indexNow = indexRuntimeView(cycle);
  const water = useMemo(() => {
    if (!events) return null;
    if (asLive && replayAt !== null) return buildWaterfall(asLive, events.filter((e) => e.at.getTime() <= replayAt), replayAt);
    return buildWaterfall(cycle, events, clock);
  }, [cycle, events, clock, asLive, replayAt]);

  const why = !asLive && water && events ? runInWords(cycle, water, events)?.why : undefined;
  const shownStatus = asLive ? { label: speed > 1 ? `Replaying · ${speed}×` : "Replaying", tone: "info" as const, live: true } : status;
  const summary = !water
    ? status.label
    : asLive && replayAt !== null
      ? `Replaying the recorded run${speed > 1 ? ` at ${speed}× speed` : ""}. ${runSummary(asLive, water.steps, replayAt)}`
      : runSummary(cycle, water.steps, clock, water.notes);
  const failure = incident?.errorMessage ? failureView(incident.errorMessage, incident.errorDetail) : null;
  // A run that ended with a person: drawn as a branch off the last step of its track that has an event.
  const handoff = !asLive && !status.live && cycle.state !== "running" && (cycle.path === "human" || cycle.path === "notify") ? PATH_LABELS[cycle.path] : undefined;
  // A person was told and the run waits for them: say what they can do, beside the control that does it. Only once the
  // incident is read and open: resolved or ignored, there is nothing left to choose.
  const handoffPath = !asLive && !status.live && cycle.state === "failed"
    ? "human"
    : !asLive && !status.live && cycle.state === "waiting-human" && cycle.path === "index"
      ? "human"
      : handoff && cycle.state === "waiting-human" && (cycle.path === "human" || cycle.path === "notify") ? cycle.path : undefined;
  const showHandoff = handoffPath !== undefined && incident !== undefined && ["new", "acknowledged", "logged", "recurred"].includes(incident.status);
  const queryClient = useQueryClient();

  return (
    <section aria-label="Run detail" className="min-w-0 space-y-4">
      <RunHero
        cycle={cycle}
        incident={incident}
        status={shownStatus}
        summary={summary}
        why={why}
        water={water}
        now={now}
        corner={
          <button
            type="button"
            onClick={fullWidth.toggle}
            aria-controls="run-list"
            aria-label={fullWidth.on ? "Exit full width" : "Full width"}
            title={fullWidth.on ? "Exit full width: show the run list" : "Full width: hide the run list"}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-300 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {fullWidth.on ? <Minimize2 className="h-5 w-5" aria-hidden /> : <Maximize2 className="h-5 w-5" aria-hidden />}
          </button>
        }
        actions={
          <>
            {canRetry && !showHandoff && <RetryRunButton incidentId={cycle.incidentId} size="md" />}
            {canReplay && (
              <ReplayControl replaying={replaying} onToggle={toggleReplay} speed={speedChoice} onSpeed={changeSpeed} spanMs={spanMs} />
            )}
            <Link to={`/incidents/${encodeURIComponent(cycle.incidentId)}`} className={HERO_ACTION}>
              <FileText className="h-4 w-4" aria-hidden />
              Evidence for this incident
            </Link>
            {issue && (
              <a href={issue.url} target="_blank" rel="noreferrer noopener" className={HERO_ACTION}>
                <CircleDot className="h-4 w-4" aria-hidden />
                Issue #{issue.number} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
            {pr && (
              <a href={pr.url} target="_blank" rel="noreferrer noopener" className={HERO_ACTION}>
                <PrIcon state={pr.state} className="h-4 w-4" />
                Pull request #{pr.number ?? ""} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
          </>
        }
      />

      {showHandoff && handoffPath && incident && (
        <HandoffCard
          path={handoffPath}
          incidentId={cycle.incidentId}
          incident={incident}
          issueUrl={issue?.url}
          canRetry={canRetry}
          failed={cycle.state === "failed"}
          onChanged={() => void queryClient.invalidateQueries({ queryKey: ["run-incident", environment, cycle.incidentId] })}
        />
      )}

      <div className="space-y-6 rounded-xl border border-gray-200 bg-white p-5 sm:p-6 dark:border-gray-700 dark:bg-gray-800">
        <section aria-label="Pipeline" className="space-y-4">
          <h3 className={SECTION_TITLE}>Pipeline</h3>
          {failed ? (
            <p role="alert" className="text-sm text-error-700 dark:text-error-400">
              Couldn&apos;t read this run&apos;s events.
            </p>
          ) : !water || !events ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">Loading steps…</p>
          ) : (
            <>
              {eventsCapped && (
                <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="events-capped">
                  Showing the newest {EVENT_LIMIT} events of this run; older ones are not drawn, so earlier rounds may be
                  missing or counted short.
                </p>
              )}
              <StepTrack steps={water.steps.filter((s) => !s.side)} clock={trackClock} handoff={handoff} />
              <SideSteps steps={water.steps.filter((s) => s.side)} />
              {/* Under the track, not below the trace: it fills in as the track moves, live or in a replay, so the page
                  says what is happening and not only how far it got. */}
              <Timeline
                water={water}
                cycle={cycle}
                events={events}
                live={status.live || asLive !== null}
                clock={trackClock}
                label={asLive && replayAt !== null ? `Replaying · ${formatClock(replayAt - startMs)} of ${formatClock(spanMs)}` : undefined}
                pr={pr}
                issue={issue}
                finding={finding}
                now={now}
              />
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
              {recoveryNow && (
                <Fact label="Recovery">
                  <Badge tone={recoveryNow.tone}>{recoveryNow.text}</Badge>
                  {recoveryNow.details.map((d) => (
                    <span key={d} className="block text-xs text-gray-600 dark:text-gray-400">
                      {d}
                    </span>
                  ))}
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
      </div>
    </section>
  );
}

/** A link or button on the dark hero card. */
const HERO_ACTION =
  "inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-600 px-4 text-sm font-medium text-white hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/** The run's story at a glance: what it is about, where it stands, how far it got, and what can be done with it. */
function RunHero({
  cycle,
  incident,
  status,
  summary,
  why,
  water,
  now,
  corner,
  actions,
}: {
  cycle: CycleRow;
  incident?: IncidentRow;
  status: RunStatus;
  summary: string;
  /** Why the run ended where it did (`runWords.ts`); absent while it runs or replays. */
  why?: string;
  water: Waterfall | null;
  now: number;
  /** Sits in the card's top-right corner: the full-width toggle. */
  corner: ReactNode;
  actions: ReactNode;
}) {
  const headline = incident?.errorMessage ? splitTrace(incident.errorMessage).headline : undefined;
  // Filled from the left in the order the steps happened (a side step such as the issue lands between the track's own),
  // then the one in progress, then the steps not reached.
  const all = water?.steps ?? [];
  const track = [...[...stepLogOrder(all)].reverse(), ...all.filter((s) => s.status === "not-reached")];
  return (
    <div className="relative space-y-5 rounded-2xl bg-gray-900 p-5 text-white sm:p-7 dark:bg-gray-950 dark:ring-1 dark:ring-gray-700">
      <div className="absolute right-3 top-3 sm:right-4 sm:top-4">{corner}</div>
      <div className="space-y-2">
        <p className="pr-10 text-sm text-gray-400">
          Run for incident <span className="break-all font-mono">{cycle.incidentId}</span>
          {cycle.recurrence > 0 && <> · recurrence {cycle.recurrence}</>} · started {formatDateTime(cycle.createdAt)}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className={`min-w-0 break-words text-3xl font-bold tracking-tight text-white ${incident ? "" : "font-mono"}`}>
            {incident?.functionName ?? cycle.incidentId}
          </h2>
          <StatusBadge status={status} />
          {cycle.synthetic && <SyntheticBadge />}
        </div>
        <p className="text-lg text-gray-100" data-testid="run-summary">
          {summary}
        </p>
        {/* Why it ended there, from the same records as "In plain words" below: the reason is read here first, the detail under it. */}
        {why && (
          <p className="text-base text-gray-200" data-testid="run-why">
            <span className="font-semibold text-white">Why: </span>
            {why}
          </p>
        )}
        {/* A reopened run (#285): say so here, since the steps and times below are only its latest round's. */}
        {water?.reopened && (
          <p className="text-sm text-gray-300" data-testid="run-rounds">
            <span className="font-semibold text-white">
              Round {water.rounds}: this run was reopened {water.rounds - 1} {water.rounds - 1 === 1 ? "time" : "times"}.
            </span>{" "}
            Latest {formatRelativeTime(water.reopened.at, "never", now)}
            {water.reopened.summary.replace(/[.\s]+$/, "") ? `: ${water.reopened.summary.replace(/[.\s]+$/, "")}.` : "."} The steps and times below are this round&apos;s; what the earlier
            rounds ended on is at the end of the step log.
          </p>
        )}
      </div>

      {incident && (
        <div className="space-y-3">
          <p className="break-words rounded-xl bg-black/40 px-4 py-3 font-mono text-sm text-gray-100 ring-1 ring-gray-800">
            <span className="font-semibold text-brand-300">{incident.errorType}</span>
            {headline ? ` · ${headline}` : ""}
          </p>
          <p className="flex flex-wrap gap-2 text-xs">
            {typeof incident.occurrenceCount === "number" && (
              <span className="rounded-md bg-gray-800 px-2.5 py-1 text-gray-200">
                {incident.occurrenceCount} {incident.occurrenceCount === 1 ? "occurrence" : "occurrences"}
              </span>
            )}
            {incident.service && <span className="rounded-md bg-gray-800 px-2.5 py-1 text-gray-200">{incident.service}</span>}
            {incident.recurrenceCount > 0 && <span className="rounded-md bg-warning-900 px-2.5 py-1 text-warning-100">Came back after a fix</span>}
          </p>
        </div>
      )}

      {track.length > 0 && (
        <div className="space-y-2">
          <div className="flex gap-1" aria-hidden>
            {track.map((s) => (
              <span key={s.stage} className={`h-2 flex-1 rounded-full ${HERO_SEGMENT[s.status]}`} />
            ))}
          </div>
          <p className="text-sm text-gray-300">{progressText(track)}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

const HERO_SEGMENT: Record<StepStatus, string> = {
  done: "bg-brand-500",
  failed: "bg-error-500",
  running: "bg-info-400 motion-safe:animate-pulse",
  "not-reached": "bg-gray-700",
};

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

/** What a reached step ended in: "Done: proposed", or "Failed: error" for an unexpected failure. */
function stepVerdict(step: Pick<Step, "status" | "outcome">): string {
  return `${step.status === "failed" ? "Failed" : "Done"}${step.outcome ? `: ${step.outcome}` : ""}`;
}

/** The line under a step on the track: what it ended in and how long it took, or how long it has been running. */
function stepLine(step: Step, clock: number): string {
  if (step.status === "running") return step.since ? `Running · ${formatClock(clock - step.since.getTime())}` : "Running";
  if (step.status === "not-reached") {
    // Reached by an earlier round of a reopened run: say where it got then, not that it never ran.
    const e = step.earlier;
    return e ? `Not reached this round · round ${e.round}: ${e.failed ? "failed" : "done"}${e.outcome ? ` (${e.outcome})` : ""}` : "Not reached";
  }
  return `${stepVerdict(step)}${step.durationMs !== undefined ? ` · ${formatDuration(step.durationMs)}` : ""}`;
}

function StepNode({ step }: { step: Step }) {
  const { status } = step;
  if (status === "failed") {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-error-600 text-white dark:bg-error-400 dark:text-gray-950">
        <X className="h-4 w-4" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (status === "not-reached" && step.earlier) {
    // Reached in an earlier round: a ring in that round's colour, with its mark inside, so it is not read as never run.
    return step.earlier.failed ? (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-error-500 text-error-600 dark:border-error-400 dark:text-error-400">
        <X className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
      </span>
    ) : (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-brand-400 text-brand-600 dark:border-brand-500 dark:text-brand-400">
        <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
      </span>
    );
  }
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
  failed: "h-0.5 bg-error-500 dark:bg-error-400",
  running: "h-0.5 bg-info-500 motion-safe:animate-pulse dark:bg-info-400",
  "not-reached": "border-t-2 border-dashed border-gray-300 dark:border-gray-600",
};

/**
 * The loop's stages in order. Only a step a worker is on right now spins; a step with no event is "not reached" (with
 * where an earlier round got, when one reached it); a step that went wrong unexpectedly is red with a cross.
 */
function StepTrack({ steps, clock, handoff }: { steps: Step[]; clock: number; handoff?: string }) {
  const lastDone = steps.map(isReached).lastIndexOf(true);
  return (
    <div className="overflow-x-auto pb-1">
      <ol aria-label="Steps" className="flex min-w-[34rem]">
        {steps.map((step, i) => {
          const next = steps[i + 1];
          return (
            <li key={step.stage} data-step={step.stage} data-status={step.status} className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="mb-1.5 flex items-center" aria-hidden>
                <StepNode step={step} />
                {next && <span className={`mx-2 flex-1 rounded ${RAIL[next.status]}`} />}
              </div>
              <span className={`pr-3 text-sm font-semibold ${step.status === "not-reached" ? "text-gray-600 dark:text-gray-400" : "text-gray-900 dark:text-white"}`}>
                {step.title}
              </span>
              <span
                className={`pr-3 text-xs ${
                  step.status === "running"
                    ? "font-medium tabular-nums text-info-800 dark:text-info-400"
                    : step.status === "failed"
                      ? "font-medium text-error-700 dark:text-error-400"
                      : "text-gray-600 dark:text-gray-400"
                }`}
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
          <li
            key={s.stage}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${
              s.status === "failed" ? "bg-error-50 text-error-700 dark:bg-error-500/15 dark:text-error-400" : "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"
            }`}
          >
            {s.status === "failed" ? <X className="h-3 w-3" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}
            {s.title}
            {s.outcome ? `: ${s.outcome}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** GitHub's own mark for a pull request: merged, closed without merging, or open (also when never read back). */
function PrIcon({ state, className }: { state?: "open" | "merged" | "closed"; className: string }) {
  const Icon = state === "merged" ? GitMerge : state === "closed" ? GitPullRequestClosed : GitPullRequest;
  return <Icon className={className} aria-hidden />;
}

/** A link to an issue or pull request, written the way GitHub writes a reference: its mark and `owner/repo#30`. */
function GitHubRef({ url, what, repo, number, icon }: { url: string; what: string; repo?: string; number?: number; icon: ReactNode }) {
  const ref = number === undefined ? undefined : `${repo ?? ""}#${number}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={ref === undefined ? `GitHub ${what}` : `GitHub ${what} ${ref}`}
      className="mt-1 inline-flex items-center gap-1.5 break-all text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
    >
      {icon}
      {ref === undefined ? <span>Open the {what}</span> : <span className="font-mono">{ref}</span>}
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
    </a>
  );
}

/** Outcomes that are a step doing its job by saying no: done, but worth a second look. */
const NO_OUTCOMES = new Set(["block", "rejected", "declined", "decline", "failed", "unavailable", "skipped", "dry-run"]);

function verdictTone(step: Step): BadgeTone {
  if (step.status === "failed") return "error";
  if (step.status === "running") return "info";
  return step.outcome && NO_OUTCOMES.has(step.outcome) ? "warning" : "success";
}

/** The Starfish mark at an icon's size: the step the engine decides itself. */
function StarfishMark({ className = "" }: { className?: string }) {
  return (
    <span className={`flex ${className}`}>
      <StarfishLogo size={20} title="" />
    </span>
  );
}

const SERVICE_TILE = "bg-white ring-1 ring-inset ring-gray-200 dark:bg-gray-700 dark:ring-gray-600";

/**
 * Each stage's mark in the step log: its icon and its tile. A step done by or on a service wears that service's mark:
 * triage is the engine's decision (Starfish; it may make no model call at all), the fix is always Gemini's, the issue,
 * the pull request and the merge happen on GitHub, the alert and the message to a person go through Slack. Every other
 * step, what it did; verify wears GitHub's only when the target's checks there judged it (`StageIcon`). The pull request's link below its step keeps GitHub's own open/merged/closed mark (`PrIcon`).
 */
const STAGE_LOOK: Record<string, { icon: ComponentType<{ className?: string }>; tile: string }> = {
  triage: { icon: StarfishMark, tile: "bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300" },
  fix: { icon: GeminiMark, tile: "bg-violet-50 dark:bg-violet-500/15" },
  verify: { icon: ShieldCheck, tile: "bg-success-100 text-success-800 dark:bg-success-500/15 dark:text-success-300" },
  review: { icon: ScanSearch, tile: "bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-100" },
  pr: { icon: GithubMark, tile: "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900" },
  issue: { icon: GithubMark, tile: "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900" },
  alert: { icon: SlackMark, tile: SERVICE_TILE },
  notify: { icon: SlackMark, tile: SERVICE_TILE },
  escalation: { icon: Phone, tile: "bg-info-100 text-info-800 dark:bg-info-500/15 dark:text-info-300" },
  before: { icon: FlaskConical, tile: "bg-success-100 text-success-800 dark:bg-success-500/15 dark:text-success-300" },
  merge: { icon: GithubMark, tile: "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900" },
  index: { icon: Database, tile: "bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300" },
};
const OTHER_LOOK = { icon: Circle, tile: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200" };

function StageIcon({ step, onGitHub }: { step: Step; onGitHub: boolean }) {
  const look = STAGE_LOOK[step.stage] ?? OTHER_LOOK;
  const Icon = step.status === "failed" ? X : onGitHub ? GithubMark : look.icon;
  const tile =
    step.status === "failed"
      ? "bg-error-100 text-error-700 dark:bg-error-500/15 dark:text-error-300"
      : step.status === "running"
        ? "bg-info-50 text-info-800 ring-2 ring-info-300 motion-safe:animate-pulse dark:bg-info-500/15 dark:text-info-300 dark:ring-info-700"
        : look.tile;
  return (
    <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${tile}`} aria-hidden>
      <Icon className="h-5 w-5" />
    </span>
  );
}

const CHIP = "inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200";
const BODY = "break-words text-sm text-gray-700 dark:text-gray-300";
const ATTACK_TONE: Record<ReviewAttack["outcome"], string> = {
  held: "text-success-700 dark:text-success-400",
  flagged: "text-warning-700 dark:text-warning-400",
  broken: "text-error-700 dark:text-error-400",
};

/**
 * How far Starfish goes, drawn as a scale to read and not as buttons: four points on a line, the line filled up to the
 * level triage chose and a ring on it. Nothing here is clickable; the one-line meaning sits under it.
 */
function LevelScale({ level }: { level: Level }) {
  const at = LEVELS.indexOf(level);
  const last = LEVELS.length - 1;
  return (
    <div role="group" aria-label="How far Starfish goes" className="relative grid grid-cols-4 pt-0.5">
      <span aria-hidden className="absolute left-[12.5%] right-[12.5%] top-[9px] h-0.5 rounded bg-gray-200 dark:bg-gray-700" />
      <span aria-hidden className="absolute left-[12.5%] top-[9px] h-0.5 rounded bg-brand-700 dark:bg-brand-400" style={{ width: `${(at / last) * 75}%` }} />
      {LEVELS.map((l, i) => {
        const chosen = i === at;
        return (
          <div key={l} className="relative flex flex-col items-center gap-1.5 text-center">
            <span
              aria-hidden
              className={`flex h-[18px] w-[18px] items-center justify-center rounded-full ${
                chosen
                  ? "bg-brand-700 ring-4 ring-brand-100 dark:bg-brand-400 dark:ring-brand-900"
                  : i < at
                    ? "bg-brand-700 dark:bg-brand-400"
                    : "border-2 border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-800"
              }`}
            >
              {i < at && <span className="h-1.5 w-1.5 rounded-full bg-white dark:bg-gray-950" />}
            </span>
            <span
              {...(chosen && { "aria-current": "true" as const })}
              className={`text-xs leading-tight ${chosen ? "font-semibold text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"}`}
            >
              {LEVEL_SHORT[l]}
              {!chosen && <span className="sr-only"> (not chosen)</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Whose words a Gemini step holds, when its record names the model (an older record does not, and then says nothing). */
function ModelNote({ model, recordedBy }: { model?: string; recordedBy: string }) {
  if (!model) return null;
  return (
    <p className="text-xs text-gray-600 dark:text-gray-400">
      The model&apos;s reasoning (<span className="font-mono">{model}</span>), as {recordedBy} recorded it.
    </p>
  );
}

/** What a step recorded beyond its one line: only what is stored for it (runStepDetail.ts), so a copy that left it out shows nothing. */
function StepDetails({
  step,
  detail,
  pr,
  issue,
  finding,
  now,
  cycle,
}: {
  step: Step;
  detail: StepDetail;
  pr?: ReturnType<typeof prLink>;
  issue?: ReturnType<typeof issueLink>;
  finding?: ReturnType<typeof triageFinding>;
  now: number;
  cycle: CycleRow;
}) {
  const done = isReached(step);
  const prNow = step.stage === "pr" ? prStateView(cycle, now) : undefined;
  return (
    <>
      {step.stage === "triage" && step.status === "done" && finding && (
        <>
          {!step.summary && <p className={`whitespace-pre-wrap ${BODY}`}>{finding.reason}</p>}
          {finding.suspectedCause && (
            <p className={BODY}>
              <span className="font-medium text-gray-900 dark:text-gray-100">Suspected cause:</span> {finding.suspectedCause}
            </p>
          )}
        </>
      )}
      {detail.triage?.level && (
        <div className="space-y-1.5">
          <LevelScale level={detail.triage.level} />
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {detail.triage.levelLabel}
            {detail.triage.mergeCase && (
              <>
                {" "}
                (merge case <span className="font-mono">{detail.triage.mergeCase}</span>)
              </>
            )}
            {detail.triage.cap &&
              ` · Held to ${detail.triage.cap.level} by ${detail.triage.cap.by === "correction" ? "an operator's correction" : detail.triage.cap.by === "rule" ? `the admin's class rule${detail.triage.cap.rule ? ` ${detail.triage.cap.rule}` : ""}` : "a cap"}`}
          </p>
        </div>
      )}
      {detail.triage?.recount && (
        <p className="flex flex-wrap gap-2">
          {detail.triage.recount.count === null ? (
            <span className={CHIP}>Recount unavailable: the evidence was missing, which triage never reads as zero</span>
          ) : (
            <span className={CHIP}>
              Recount: {detail.triage.recount.capped ? "at least " : ""}
              {detail.triage.recount.count} {detail.triage.recount.count === 1 ? "error" : "errors"}
              {detail.triage.recount.window ? ` in ${detail.triage.recount.window}` : ""}
            </span>
          )}
        </p>
      )}
      {step.stage === "triage" && step.status === "done" && finding?.by && (
        <p className="text-xs text-gray-600 dark:text-gray-400">
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

      {detail.fix && (
        <div className="space-y-1.5">
          {detail.fix.risk && (
            <p className={BODY}>
              <span className="font-medium text-gray-900 dark:text-gray-100">Could break:</span> {detail.fix.risk}
            </p>
          )}
          <p className="flex flex-wrap gap-2">
            {detail.fix.testAdded !== undefined && <span className={CHIP}>{detail.fix.testAdded ? "Test added" : "No test added"}</span>}
            {detail.fix.revisions !== undefined && detail.fix.revisions > 0 && <span className={CHIP}>Revision {detail.fix.revisions}</span>}
            {detail.fix.source && (
              <span className={CHIP}>
                Source found by <span className="font-mono">{detail.fix.source}</span>
              </span>
            )}
          </p>
          {detail.fix.alternatives.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer py-1 font-medium text-gray-900 dark:text-gray-100">
                {detail.fix.alternatives.length} rejected {detail.fix.alternatives.length === 1 ? "alternative" : "alternatives"}
              </summary>
              <div className="mt-1 space-y-1 border-l-2 border-gray-200 pl-3 dark:border-gray-700">
                {detail.fix.alternatives.map((a, i) => (
                  <p key={i} className={BODY}>
                    {a}
                  </p>
                ))}
              </div>
            </details>
          )}
          {detail.diffUrl ? (
            <a href={detail.diffUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
              See the diff on GitHub <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ) : (
            <p className="text-xs text-gray-600 dark:text-gray-400">The patch text is not stored; with no pull request there is no diff to link to.</p>
          )}
          <ModelNote model={detail.fix.model} recordedBy="the fix step" />
        </div>
      )}

      {detail.verify && (
        <div className="space-y-1.5">
          <p className="flex flex-wrap gap-2">
            {detail.verify.files !== undefined && (
              <span className={CHIP}>
                {detail.verify.files} {detail.verify.files === 1 ? "file" : "files"} changed
              </span>
            )}
            {detail.verify.exitCode !== undefined && detail.verify.exitCode !== null && <span className={CHIP}>Exit code {detail.verify.exitCode}</span>}
            {detail.verify.rule && <span className={`${CHIP} font-mono`}>{detail.verify.rule}</span>}
          </p>
          {detail.verify.output && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-50 p-3 font-mono text-xs text-gray-800 dark:bg-gray-900/60 dark:text-gray-200">
              {detail.verify.output}
            </pre>
          )}
        </div>
      )}

      {detail.review && (
        <div className="space-y-1.5">
          <p className="flex flex-wrap gap-2">
            {detail.review.held !== undefined && <span className={CHIP}>{detail.review.held} held</span>}
            {detail.review.flagged !== undefined && detail.review.flagged > 0 && <span className={CHIP}>{detail.review.flagged} flagged</span>}
            {detail.review.broken !== undefined && detail.review.broken > 0 && (
              <span className="inline-flex items-center rounded-md bg-error-50 px-2 py-1 text-xs font-medium text-error-700 dark:bg-error-500/15 dark:text-error-300">{detail.review.broken} broke it</span>
            )}
          </p>
          {detail.review.attacks.length > 0 && (
            <div className="space-y-1.5" role="group" aria-label="Attacks tried">
              {detail.review.attacks.map((a, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className={`w-16 shrink-0 font-semibold capitalize ${ATTACK_TONE[a.outcome]}`}>{a.outcome}</span>
                  <span className="min-w-0 break-words text-gray-700 dark:text-gray-300">
                    {a.attack}
                    {a.detail && <span className="block text-gray-600 dark:text-gray-400">{a.detail}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          <ModelNote model={detail.review.model} recordedBy="the review" />
        </div>
      )}

      {detail.delivery && (detail.delivery.attempts !== undefined || detail.delivery.reason) && (
        <p className="flex flex-wrap gap-2">
          {detail.delivery.attempts !== undefined && detail.delivery.attempts > 1 && <span className={CHIP}>{detail.delivery.attempts} attempts</span>}
          {detail.delivery.reason && <span className={CHIP}>{detail.delivery.reason}</span>}
        </p>
      )}

      {detail.index?.reason && <p className={`whitespace-pre-wrap ${BODY}`}>{detail.index.reason}</p>}

      {step.stage === "issue" && done && issue && (
        <div className="rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-700">
          <GitHubRef url={issue.url} what="issue" repo={issue.repo} number={issue.number} icon={<CircleDot className="h-4 w-4 shrink-0" aria-hidden />} />
        </div>
      )}
      {step.stage === "pr" && done && pr && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 px-4 py-3 dark:border-gray-700">
          <GitHubRef url={pr.url} what="pull request" repo={pr.repo} number={pr.number} icon={<PrIcon state={pr.state} className="h-4 w-4 shrink-0" />} />
          {prNow && <Badge tone={prNow.tone}>{prNow.text}</Badge>}
        </div>
      )}
    </>
  );
}

/**
 * One step of the step log: its icon, what it ended in and when, its own line and what it recorded. The same row draws the
 * latest round's steps and every step an earlier round reached, so reopening a run never takes the first round's details
 * away. The run record keeps only a stage's latest record, so `stepDetail` shows an earlier step's record details only when
 * no later round ran that stage again (`recordIsTheStep`); the links, which belong to the run, always show.
 */
function StepRow({
  step,
  cycle,
  events,
  pr,
  issue,
  finding,
  now,
}: {
  step: Step;
  cycle: CycleRow;
  events: readonly EventRow[];
  pr?: ReturnType<typeof prLink>;
  issue?: ReturnType<typeof issueLink>;
  finding?: ReturnType<typeof triageFinding>;
  now: number;
}) {
  const detail = stepDetail(step, cycle, events);
  return (
    <li className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 py-4 @lg:gap-x-4">
      <StageIcon step={step} onGitHub={step.stage === "verify" && judgedOnGitHub(detail.verify)} />
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-base font-semibold text-gray-900 dark:text-white">{step.title}</span>
          <Badge tone={verdictTone(step)}>{step.status === "running" ? "In progress" : stepVerdict(step)}</Badge>
          {step.attempt && (
            <span className="text-xs text-gray-600 dark:text-gray-400">
              Attempt {step.attempt.n} of {step.attempt.of}
              {step.attempt.reason && <> · {step.attempt.reason}</>}
            </span>
          )}
          {step.at && (
            <span className="ml-auto text-xs text-gray-600 dark:text-gray-400">
              {formatDateTime(step.at)}
              {step.durationMs !== undefined ? ` · ${formatDuration(step.durationMs)} since the step before` : ""}
            </span>
          )}
        </div>
        {step.summary && <p className={`whitespace-pre-wrap ${BODY}`}>{step.summary}</p>}
        <StepDetails step={step} detail={detail} pr={pr} issue={issue} finding={finding} now={now} cycle={cycle} />
      </div>
    </li>
  );
}

/**
 * What Starfish did, step by step: each step with its icon, what it ended in and when, its own line, what it recorded
 * (the decision and its alternatives, the fix's risk, the gate's checks, the review's attacks, the issue and pull
 * request). Newest first by default, so the step in progress sits right under the
 * track (#279); oldest first reads as the run's story. Triage's entry carries its suspected cause and whose words they
 * are; the issue's and the pull request's carry their links, each only once its own step happened. For a reopened run
 * (#285) these are its latest round's steps, and every step each earlier round reached follows, newest round first.
 */
function Timeline({
  water,
  cycle,
  events,
  live,
  clock,
  label,
  pr,
  issue,
  finding,
  now,
}: {
  water: Waterfall;
  cycle: CycleRow;
  events: readonly EventRow[];
  live: boolean;
  clock: number;
  label?: string;
  pr?: ReturnType<typeof prLink>;
  issue?: ReturnType<typeof issueLink>;
  finding?: ReturnType<typeof triageFinding>;
  now: number;
}) {
  const [oldestFirst, setOldestFirst] = useState(false);
  // The earlier runs of a repeated stage (the draft a review blocked, its gate) are rows of their own, so a revision reads in
  // the order it happened instead of the revised draft sitting above the review that sent it back.
  const newest = stepLogOrder([...water.steps, ...water.attempts]);
  const steps = oldestFirst ? [...newest].reverse() : newest;
  const { earlier, rounds } = water;
  if (steps.length === 0 && earlier.length === 0) return null;
  const span = water.endMs - water.startMs;
  const words = runInWords(cycle, water, events);
  return (
    <div className="@container space-y-2 border-t border-gray-200 pt-5 dark:border-gray-700">
      {words && (
        <section aria-label="In plain words" className="mb-4 space-y-2 rounded-xl bg-gray-50 px-4 py-3 dark:bg-gray-900/40">
          <h3 className={SECTION_TITLE}>In plain words</h3>
          {words.rounds.map((r, i) => {
            // A reopened run has several rounds: the last is the one the card, the track and the step log below draw; the
            // rest are over. Said in words and in weight, since the numbers alone do not say which is which.
            const current = i === words.rounds.length - 1;
            return (
              <div key={r.round} className="space-y-1">
                {words.rounds.length > 1 && (
                  <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-400">
                    <span className={current ? "text-gray-900 dark:text-white" : ""}>Round {r.round}</span>
                    <Badge tone={current ? "brand" : "neutral"}>{current ? (cycle.state === "running" ? "Current · running" : "Current") : "Earlier"}</Badge>
                    {r.began && <span>{r.began.replace(/[.\s]+$/, "")}</span>}
                  </p>
                )}
                <p className={words.rounds.length > 1 && !current ? "text-sm leading-relaxed text-gray-600 dark:text-gray-400" : BODY}>{r.sentences.map((x) => x.text).join(" ")}</p>
              </div>
            );
          })}
          {words.closing && <p className="text-sm font-medium text-gray-900 dark:text-white">{words.closing}</p>}
          <p className="text-xs text-gray-600 dark:text-gray-400">Composed from what the engine recorded; no model wrote it.</p>
        </section>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className={SECTION_TITLE}>What Starfish did</h3>
          <p className="mt-1 text-sm font-medium tabular-nums text-gray-900 dark:text-white">
            {label ??
              (live
                ? `Running for ${formatDuration(clock - water.startMs)}${water.reopened ? " since it was reopened" : ""}`
                : `${formatDuration(span)} from ${water.reopened ? "the latest reopening" : "start"} to the last update`)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOldestFirst((v) => !v)}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-700"
        >
          <ArrowDownUp className="h-4 w-4" aria-hidden />
          {oldestFirst ? "Oldest first" : "Newest first"}
          <span className="sr-only">: show {oldestFirst ? "newest" : "oldest"} first instead</span>
        </button>
      </div>
      <ol aria-label="Step log" className="divide-y divide-gray-100 dark:divide-gray-700">
        {steps.map((step) => (
          <StepRow key={`${step.stage}-${step.attempt?.n ?? 0}`} step={step} cycle={cycle} events={events} pr={pr} issue={issue} finding={finding} now={now} />
        ))}
      </ol>
      {earlier.length > 0 && (
        <>
          <h4 className="mt-3 text-xs font-medium text-gray-600 dark:text-gray-400">Earlier rounds</h4>
          <ol aria-label="Earlier rounds" className="mt-1 divide-y divide-gray-100 dark:divide-gray-700">
            {[...earlier].reverse().map((r) => (
              <li key={r.round} className="py-2">
                {/* Folded, like an accordion: the latest round is the one being read; an earlier one opens on request. */}
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded py-0.5 text-xs font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
                    Round {r.round} of {rounds} · ended on {r.title.toLowerCase()} · {formatDuration(r.durationMs)} long
                  </summary>
                  <ol aria-label={`Round ${r.round}`} className="mt-1 ml-3 divide-y divide-gray-100 border-l-2 border-gray-100 pl-3 dark:divide-gray-700 dark:border-gray-700">
                    {r.steps.map((step) => (
                      <StepRow
                        key={`${step.stage}-${step.attempt?.n ?? 0}`}
                        step={earlierAsStep(step)}
                        cycle={cycle}
                        events={events}
                        pr={pr}
                        issue={issue}
                        finding={recordIsTheStep(step, events) ? finding : undefined}
                        now={now}
                      />
                    ))}
                  </ol>
                </details>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
