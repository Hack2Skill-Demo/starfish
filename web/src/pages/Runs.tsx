/**
 * Runs — the agent's cycles as they happen: a list of runs, and for the one selected a waterfall of
 * its stages. Both are live subscriptions to what the engine writes (src/agent/cycle.ts); nothing
 * here is inferred. A step with no event is "not reached", a cycle with no worker on it is not "in
 * progress", and nothing is drawn for a stage the loop has no code for (merge, deploy, recovery).
 *
 * Today the agent job (#74) is written but has never been deployed, so on a real deployment this page is empty until
 * that exists; it says so instead of looking like a quiet day.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Check, CircleDashed, ExternalLink, Loader2, Workflow } from "lucide-react";
import PageMeta from "../components/PageMeta";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import { formatDateTime, formatRelativeTime } from "../lib/formatters";
import { useEnvironment } from "../lib/useSettings";
import { CYCLE_LIMIT, subscribeCycles, subscribeEvents } from "../lib/runs";
import {
  PATH_LABELS,
  buildWaterfall,
  formatDuration,
  runStatus,
  safeUrl,
  triageRule,
  type CycleRow,
  type EventRow,
  type Step,
} from "../lib/runsModel";

/** Re-evaluate "live" and the running axis without waiting for the next write. */
const TICK_MS = 15_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function Runs() {
  const { environment, ready } = useEnvironment();
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

  const selectedId = params.get("run");
  const selected = cycles?.find((c) => c.id === selectedId) ?? cycles?.[0] ?? null;

  return (
    <div className="space-y-4">
      <PageMeta title="Runs | Starfish" description="Watch the agent work through each incident, step by step" />
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Runs</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          One run per incident and recurrence, updated live as the engine records each step. A step the engine has
          not recorded reads &quot;not reached&quot;.
        </p>
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
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <RunList
            cycles={cycles}
            capped={capped}
            selectedId={selected?.id ?? null}
            now={now}
            onSelect={(id) => setParams({ run: id }, { replace: true })}
          />
          {selected && <RunDetail cycle={selected} environment={environment} now={now} />}
        </div>
      )}
    </div>
  );
}

function RunList({
  cycles,
  capped,
  selectedId,
  now,
  onSelect,
}: {
  cycles: CycleRow[];
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
                  <span className="truncate font-mono text-xs text-gray-900 dark:text-gray-100">{c.incidentId}</span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </div>
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

function RunDetail({ cycle, environment, now }: { cycle: CycleRow; environment: string; now: number }) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setEvents(null);
    setFailed(false);
    return subscribeEvents(cycle.id, environment, (rows) => setEvents(rows), () => setFailed(true));
  }, [cycle.id, environment]);

  const status = runStatus(cycle, now);
  const rule = triageRule(cycle);
  const prUrl = safeUrl(cycle.summary.pr?.url);
  const water = useMemo(() => (events ? buildWaterfall(cycle, events, now) : null), [cycle, events, now]);

  return (
    <section aria-label="Run detail" className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-sm font-semibold text-gray-900 dark:text-white">{cycle.incidentId}</h2>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-gray-700 dark:text-gray-300">
          {cycle.path && (
            <>
              <dt className="text-gray-600 dark:text-gray-400">Path</dt>
              <dd>{PATH_LABELS[cycle.path]}</dd>
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
              <StepRow key={step.stage} step={step} />
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

function StepRow({ step }: { step: Step }) {
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

