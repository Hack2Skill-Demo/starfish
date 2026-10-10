/**
 * Runs — the agent's cycles as they happen: a list of runs, and for the one selected a waterfall of
 * its stages. Both are live subscriptions to what the engine writes (src/agent/cycle.ts); nothing
 * here is inferred. A step with no event is "not reached", a cycle with no worker on it is not "in
 * progress", and nothing is drawn for a stage the loop has no code for (merge, deploy, recovery).
 *
 * Where the agent job (`DEPLOY_AGENT=1`, #74) has not run, this page is empty until it does; it says so instead of looking
 * like a quiet day. On the demo project it runs hourly since 2026-10-07 (in dry run until 2026-10-10).
 */
import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { Check, CircleDashed, ExternalLink, Loader2, Workflow } from "lucide-react";
import PageMeta from "../components/PageMeta";
import SettingsUnavailableNotice from "../components/SettingsUnavailableNotice";
import { EngineStatus } from "../components/EngineStatus";
import { Badge } from "../components/ui/Badge";
import { SyntheticBadge } from "../components/SyntheticBadge";
import { EmptyState } from "../components/ui/EmptyState";
import { formatDateTime, formatRelativeTime } from "../lib/formatters";
import { useEnvironment } from "../lib/useSettings";
import { useNow } from "../lib/useNow";
import { getIncident, type IncidentRow } from "../lib/incidents";
import { CYCLE_LIMIT, readCycle, subscribeCycles, subscribeEvents } from "../lib/runs";
import {
  PATH_LABELS,
  indexRuntimeView,
  buildWaterfall,
  formatDuration,
  prStateView,
  progressText,
  runFilter,
  runStatus,
  safeUrl,
  triageDecision,
  triageRule,
  type CycleRow,
  type EventRow,
  type Step,
} from "../lib/runsModel";


export default function Runs() {
  const { environment, ready, settingsUnavailable } = useEnvironment();
  const [params, setParams] = useSearchParams();
  const now = useNow();
  const [cycles, setCycles] = useState<CycleRow[] | null>(null);
  const [capped, setCapped] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!ready) return;
    setCycles(null);
    setFailed(false);
    return subscribeCycles(
      environment,
      (rows, isCapped) => {
        setCycles(rows);
        setCapped(isCapped);
        setFailed(false);
      },
      () => setFailed(true)
    );
  }, [environment, ready]);

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
            <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
              <RunList cycles={visible ?? []} incidents={incidents} capped={capped} selectedId={selected?.id ?? null} now={now} onSelect={select} />
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

function RunList({
  cycles,
  incidents,
  capped,
  selectedId,
  now,
  onSelect,
}: {
  cycles: CycleRow[];
  incidents: ReadonlyMap<string, IncidentRow>;
  capped: boolean;
  selectedId: string | null;
  now: number;
  onSelect: (id: string) => void;
}) {
  return (
    <section aria-label="Runs" className="space-y-2">
      <ul className="space-y-2">
        {cycles.map((c) => {
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
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </span>
                </div>
                {incident && (
                  <p className="mt-1 truncate text-xs text-gray-600 dark:text-gray-400" title={`${incident.errorType}: ${incident.errorMessage}`}>
                    {incident.errorType}{incident.errorMessage ? `: ${incident.errorMessage}` : ""}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-600 dark:text-gray-400">
                  {c.recurrence > 0 && <span>recurrence {c.recurrence}</span>}
                  {status.live && <span>live</span>}
                  <span>{formatRelativeTime(c.updatedAt)}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {capped && (
        <p className="text-xs text-gray-600 dark:text-gray-400">
          Showing the {CYCLE_LIMIT} most recently updated runs; older ones are not listed.
        </p>
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
  const rule = triageRule(cycle);
  const decision = triageDecision(cycle);
  const prUrl = safeUrl(cycle.summary.pr?.url);
  const prNow = prStateView(cycle, now);
  const indexNow = indexRuntimeView(cycle);
  const water = useMemo(() => (events ? buildWaterfall(cycle, events, now) : null), [cycle, events, now]);

  return (
    <section aria-label="Run detail" className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className={`min-w-0 break-words text-sm font-semibold text-gray-900 dark:text-white ${incident ? "" : "font-mono"}`}>
            {incident?.functionName ?? cycle.incidentId}
          </h2>
          <Badge tone={status.tone}>{status.label}</Badge>
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
          <ol aria-label="Steps" className="space-y-2">
            {water.steps.map((step) => (
              <StepRow key={step.stage} step={step} href={step.stage === "pr" ? prUrl : undefined} />
            ))}
          </ol>
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

const STEP_LABEL = { done: "Done", running: "Running", "not-reached": "Not reached" } as const;

function StepRow({ step, href }: { step: Step; href?: string }) {
  const Icon = step.status === "done" ? Check : step.status === "running" ? Loader2 : CircleDashed;
  return (
    <li className="rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-step={step.stage} data-status={step.status}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Icon
          className={`h-4 w-4 ${step.status === "running" ? "animate-spin text-info-800 dark:text-info-400" : step.status === "done" ? "text-success-700 dark:text-success-400" : "text-gray-500 dark:text-gray-400"}`}
          aria-hidden
        />
        <span className="font-medium text-gray-900 dark:text-white">{step.title}</span>
        <span className="text-xs text-gray-600 dark:text-gray-400">
          {STEP_LABEL[step.status]}
          {step.outcome ? `: ${step.outcome}` : ""}
        </span>
        {step.at && (
          <span className="ml-auto text-xs text-gray-600 dark:text-gray-400">
            {formatDateTime(step.at)}
            {step.durationMs !== undefined ? ` · ${formatDuration(step.durationMs)} since the step before` : ""}
          </span>
        )}
      </div>
      {step.summary && <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{step.summary}</p>}
      {href && step.status === "done" && (
        <a href={href} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 break-all text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
          Open the pull request <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      )}
      {step.status === "done" && step.offset !== undefined && step.width !== undefined && (
        <div className="mt-2 h-2 rounded bg-gray-100 dark:bg-gray-700" aria-hidden>
          <div
            className="h-2 rounded bg-brand-600 dark:bg-brand-400"
            style={{ marginLeft: `${(step.offset * 100).toFixed(2)}%`, width: `${Math.max(step.width * 100, 1).toFixed(2)}%` }}
          />
        </div>
      )}
    </li>
  );
}
