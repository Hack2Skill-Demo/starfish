/**
 * Overview — the page the app opens on: what is waiting on a human, what the agent is doing, errors per
 * hour, and whether the engine is running. Every number is a count of records the viewer may read (the
 * agent's cycles, the incidents' hourly buckets); an empty store reads as empty, not as good news.
 *
 * Not here, because nothing records it yet: a run "healed on its own", the next scheduled run, and
 * anything about merges or deploys. The agent job has never run on a real project, so on a real
 * deployment the run counts are zero until it does, and the page says so.
 *
 * The key figures keep their denominators ("3 of 12", never a bare percentage) and read "–" when there is
 * nothing to divide by. They are counts and medians of stored records, not accuracy: no run has been scored
 * against a corpus yet (see scoreboard/FORMAT.md).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import PageMeta from "../components/PageMeta";
import { Badge } from "../components/ui/Badge";
import { HourlyBars } from "../components/HourlyBars";
import { EngineStatus } from "../components/EngineStatus";
import { formatRelativeTime } from "../lib/formatters";
import { listIncidents } from "../lib/incidents";
import { subscribeCycles } from "../lib/runs";
import { PATH_LABELS, formatDuration, runStatus, type CycleRow } from "../lib/runsModel";
import { countCycles, countIncidents, countUntriaged, errorRate, headline, hourlySeries, runKpis, type Ratio } from "../lib/overviewModel";
import { useEnvironment } from "../lib/useSettings";

const WINDOW_HOURS = 24;
const TICK_MS = 15_000;

export default function Overview() {
  const { environment, ready } = useEnvironment();
  const [cycles, setCycles] = useState<CycleRow[] | null>(null);
  const [capped, setCapped] = useState(false);
  const [cyclesFailed, setCyclesFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!ready) return;
    setCycles(null);
    setCyclesFailed(false);
    return subscribeCycles(
      environment,
      (rows, isCapped) => {
        setCycles(rows);
        setCapped(isCapped);
        setCyclesFailed(false);
      },
      () => setCyclesFailed(true)
    );
  }, [environment, ready]);

  const incidents = useQuery({
    queryKey: ["overview", "incidents", environment],
    queryFn: () => listIncidents(WINDOW_HOURS, environment),
    enabled: ready,
    refetchInterval: 60_000,
    retry: false,
  });

  const counts = cycles ? countCycles(cycles, now) : null;
  const incidentCounts = incidents.data ? countIncidents(incidents.data.rows) : null;
  const series = incidents.data ? hourlySeries(incidents.data.rows, now, WINDOW_HOURS) : null;
  const kpis = cycles ? runKpis(cycles) : null;
  const rate = series ? errorRate(series) : null;
  const total = series ? series.reduce((sum, b) => sum + b.count, 0) : 0;
  const peak = series ? Math.max(...series.map((b) => b.count), 0) : 0;

  return (
    <div className="space-y-6">
      <PageMeta title="Overview | Starfish" description="What is waiting on a human, and what the agent is doing" />
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Overview</h1>
        <p className="mt-1 text-lg text-gray-900 dark:text-gray-100" data-testid="headline">
          {cyclesFailed ? "The agent's runs couldn't be read." : counts ? headline(counts) : "Loading…"}
        </p>
        <div className="mt-2">{ready && <EngineStatus environment={environment} />}</div>
      </div>

      <section aria-label="Counts" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Waiting on a human" value={counts?.waitingHuman} to="/runs" note="runs" />
        <Tile label="Runs in progress" value={counts?.inProgress} to="/runs" note={counts && counts.stalled > 0 ? `${counts.stalled} with no worker` : "a worker holds them now"} />
        <Tile label="Open incidents" value={incidentCounts?.open} to="/incidents" note={`last ${WINDOW_HOURS} hours`} />
        <Tile label="Regressions" value={incidentCounts?.regressions} to="/incidents" note="open, came back after a fix" />
      </section>
      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Pull requests opened"
          value={kpis ? ratioText(kpis.pullRequests) : undefined}
          note={kpis && kpis.finished === 0 ? "no finished runs yet" : "of finished runs"}
          to="/runs?path=pr"
        />
        <Kpi
          label="Failed runs"
          value={kpis ? ratioText(kpis.failed) : undefined}
          note={kpis && kpis.finished === 0 ? "no finished runs yet" : "of finished runs, timeouts included"}
          to="/runs?path=failed"
        />
        <Kpi
          label="Median run length"
          value={kpis ? (kpis.medianRunMs === undefined ? "–" : formatDuration(kpis.medianRunMs)) : undefined}
          note={kpis && kpis.medianRunMs !== undefined ? `over ${kpis.finished} finished runs` : "no finished runs yet"}
          to="/runs"
        />
        <Kpi
          label="Untriaged incidents"
          value={incidentCounts && incidents.data ? countUntriaged(incidents.data.rows).toLocaleString() : undefined}
          note={`open, no agent decision yet, last ${WINDOW_HOURS} hours`}
          to="/incidents"
        />
        <Kpi
          label="Errors this hour"
          value={rate ? rate.thisHour.toLocaleString() : undefined}
          note={rate ? `previous ${WINDOW_HOURS - 1} hours: ${rate.baseline.toFixed(1)} per hour` : "no incident data"}
          to="/incidents"
        />
      </section>
      {capped && <p className="text-xs text-gray-600 dark:text-gray-400">Run counts cover the most recently updated runs only; older ones are not counted.</p>}

      <section aria-label="Errors per hour" className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h2 className="font-medium text-gray-900 dark:text-white">Errors per hour</h2>
        {incidents.isError ? (
          <p role="alert" className="mt-2 text-sm text-error-700 dark:text-error-400">Couldn&apos;t read the incidents.</p>
        ) : !series ? (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Loading…</p>
        ) : total === 0 ? (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">No logged errors in the last {WINDOW_HOURS} hours.</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
              {total.toLocaleString()} occurrences in the last {WINDOW_HOURS} hours; busiest hour {peak.toLocaleString()}.
              {incidents.data?.capped && " Counts cover the most recently active incidents only."}
            </p>
            <HourlyBars series={series} />
          </>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="What the agent did" className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="font-medium text-gray-900 dark:text-white">What the agent did</h2>
          {!counts ? (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Loading…</p>
          ) : counts.total === 0 ? (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Nothing has run the agent loop for this environment, so there is nothing to count.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {(Object.keys(PATH_LABELS) as (keyof typeof PATH_LABELS)[])
                .filter((p) => counts.byPath[p] > 0)
                .map((p) => (
                  <li key={p}>
                    <Link to={`/runs?path=${p}`} className="flex justify-between gap-3 text-gray-900 hover:underline dark:text-gray-100">
                      <span>{PATH_LABELS[p]}</span>
                      <span className="font-mono">{counts.byPath[p]}</span>
                    </Link>
                  </li>
                ))}
              {counts.inProgress + counts.stalled > 0 && (
                <li className="flex justify-between gap-3 text-gray-900 dark:text-gray-100">
                  <span>Not finished</span>
                  <span className="font-mono">{counts.inProgress + counts.stalled}</span>
                </li>
              )}
            </ul>
          )}
        </section>

        <section aria-label="Latest activity" className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="font-medium text-gray-900 dark:text-white">Latest activity</h2>
          {!cycles ? (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Loading…</p>
          ) : cycles.length === 0 ? (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">No runs yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-200 text-sm dark:divide-gray-700">
              {cycles.slice(0, 5).map((c) => {
                const status = runStatus(c, now);
                return (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link to={`/runs?run=${encodeURIComponent(c.id)}`} className="truncate font-mono text-xs text-brand-700 hover:underline dark:text-brand-400">
                      {c.incidentId}
                    </Link>
                    <span className="flex items-center gap-2">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span className="text-xs text-gray-600 dark:text-gray-400">{formatRelativeTime(c.updatedAt)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Tile({ label, value, to, note }: { label: string; value: number | undefined; to: string; note: string }) {
  return (
    <Link to={to} className="rounded-lg border border-gray-200 bg-white p-4 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700">
      <p className="text-sm text-gray-700 dark:text-gray-300">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white" data-testid={`tile-${label}`}>
        {value === undefined ? "…" : value.toLocaleString()}
      </p>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{note}</p>
    </Link>
  );
}

function ratioText({ count, of }: Ratio): string {
  return of === 0 ? "–" : `${count} of ${of}`;
}

function Kpi({ label, value, note, to }: { label: string; value: string | undefined; note: string; to: string }) {
  return (
    <Link to={to} className="rounded-lg border border-gray-200 bg-white p-4 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700">
      <p className="text-sm text-gray-700 dark:text-gray-300">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-white" data-testid={`kpi-${label}`}>
        {value ?? "…"}
      </p>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{note}</p>
    </Link>
  );
}
