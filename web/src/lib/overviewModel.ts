/**
 * What the Overview page counts, from the records it reads: the agent's cycles (`runsModel`) and the
 * incidents' hourly buckets. Pure. A number here is a count of stored documents; nothing is estimated,
 * and what the engine does not record (a run "healed on its own", the next scheduled run) has no field.
 */
import type { IncidentRow } from "./incidents";
import { KNOWN_STAGES, parseEvent, runStatus, type CyclePath, type CycleRow, type EventRow } from "./runsModel";

export interface CycleCounts {
  /** Cycles waiting for a person: a pull request, a notification, a stuck verify... */
  waitingHuman: number;
  /** Cycles a worker holds right now. */
  inProgress: number;
  /** Cycles with no worker on them: running by state, but the lease ran out. */
  stalled: number;
  /** Finished or waiting cycles by the path they took. */
  byPath: Record<CyclePath, number>;
  /** Cycles counted. */
  total: number;
}

const PATHS: CyclePath[] = ["decline", "notify", "draft", "pr", "human", "failed"];

export function countCycles(cycles: readonly CycleRow[], nowMs: number): CycleCounts {
  const byPath = Object.fromEntries(PATHS.map((p) => [p, 0])) as Record<CyclePath, number>;
  let waitingHuman = 0;
  let inProgress = 0;
  let stalled = 0;
  for (const c of cycles) {
    if (c.state === "waiting-human") waitingHuman += 1;
    if (c.state === "running") {
      if (runStatus(c, nowMs).live) inProgress += 1;
      else stalled += 1;
    }
    if (c.path) byPath[c.path] += 1;
  }
  return { waitingHuman, inProgress, stalled, byPath, total: cycles.length };
}

/** The sentence at the top. It claims nothing about what is "handled": the data does not say. */
export function headline(counts: CycleCounts): string {
  if (counts.total === 0) return "No agent runs are recorded for this environment.";
  const n = counts.waitingHuman;
  if (n === 0) return "No run is waiting on a human.";
  return n === 1 ? "One run is waiting on a human." : `${n} runs are waiting on a human.`;
}

export interface HourBucket {
  /** Start of the hour, ms since epoch. */
  startMs: number;
  count: number;
}

const HOUR_MS = 3_600_000;

/**
 * Errors per hour over the last `hours` full hours up to and including the current one, summed over the
 * incidents' hourly buckets. A bucket outside the window is ignored. Oldest first.
 */
export function hourlySeries(rows: readonly IncidentRow[], nowMs: number, hours: number): HourBucket[] {
  const currentHour = Math.floor(nowMs / HOUR_MS);
  const first = currentHour - hours + 1;
  const counts = new Array<number>(hours).fill(0);
  for (const row of rows) {
    for (const [k, n] of Object.entries(row.occurrencesByHour ?? {})) {
      const hour = Number(k);
      if (Number.isInteger(hour) && hour >= first && hour <= currentHour && Number.isFinite(n)) counts[hour - first]! += n;
    }
  }
  return counts.map((count, i) => ({ startMs: (first + i) * HOUR_MS, count }));
}

export interface IncidentCounts {
  open: number;
  /** Open incidents that have come back after being resolved. */
  regressions: number;
}

const OPEN = new Set(["new", "acknowledged", "logged", "recurred"]);

export function countIncidents(rows: readonly IncidentRow[]): IncidentCounts {
  let open = 0;
  let regressions = 0;
  for (const r of rows) {
    if (!OPEN.has(r.status)) continue;
    open += 1;
    if (r.recurrenceCount > 0) regressions += 1;
  }
  return { open, regressions };
}

/** A ratio that keeps both of its numbers: a percentage alone hides how small the sample is. */
export interface Ratio {
  count: number;
  of: number;
}

export interface RunKpis {
  /** Runs no worker is still on: every state but `running`. The denominator of the two ratios below. */
  finished: number;
  /** Finished runs that opened a pull request. A dry run drafts a fix and opens nothing, so it is not one. */
  pullRequests: Ratio;
  /** Finished runs that failed, including the ones that timed out. */
  failed: Ratio;
  /**
   * Median of (last write - start) over finished runs, in ms; undefined when there are none. A cycle's last
   * write is its last event or its release, so for a run waiting on a human this is when the agent stopped.
   */
  medianRunMs?: number;
}

export function runKpis(cycles: readonly CycleRow[]): RunKpis {
  const finished = cycles.filter((c) => c.state !== "running");
  const durations = finished.map((c) => c.updatedAt.getTime() - c.createdAt.getTime()).filter((ms) => ms >= 0);
  return {
    finished: finished.length,
    pullRequests: { count: finished.filter((c) => c.path === "pr").length, of: finished.length },
    failed: { count: finished.filter((c) => c.state === "failed").length, of: finished.length },
    ...(durations.length > 0 && { medianRunMs: median(durations) }),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Open incidents the agent has not decided on yet (`triageState` "pending"). A row with no triage state at
 * all is not counted: the engine always writes one, so a missing field is a record we cannot judge.
 */
export function countUntriaged(rows: readonly IncidentRow[]): number {
  return rows.filter((r) => OPEN.has(r.status) && r.triageState === "pending").length;
}

export interface ErrorRate {
  /** Occurrences in the current, still-running hour. */
  thisHour: number;
  /** Mean per hour over the full hours before it in the window. */
  baseline: number;
}

/** The current hour against the hours before it, from `hourlySeries` (oldest first, current hour last). */
export function errorRate(series: readonly HourBucket[]): ErrorRate | null {
  if (series.length < 2) return null;
  const current = series[series.length - 1]!;
  const before = series.slice(0, -1);
  return { thisHour: current.count, baseline: before.reduce((sum, b) => sum + b.count, 0) / before.length };
}

// ---- Latest activity -----------------------------------------------------------------------------

/** One run event in the Overview's feed, with the cycle it belongs to (from the document's path). */
export interface ActivityRow extends EventRow {
  cycleId: string;
}

/**
 * A feed entry from an event document found by the collection-group query, or null (never throws). A
 * collection-group query matches every collection named `events`, so only a document at
 * `{cycleCollection}/{cycleId}/events/{seq}` counts, and only one of the environment the page shows: the
 * query already filters on it, and a row from anywhere else would be shown under the wrong run.
 */
export function parseActivity(
  cycleCollection: string,
  environment: string,
  path: string,
  d: Record<string, unknown>
): ActivityRow | null {
  const parts = path.split("/");
  if (parts.length !== 4 || parts[0] !== cycleCollection || parts[2] !== "events" || !parts[1] || !parts[3]) return null;
  if (d.environment !== environment) return null;
  const event = parseEvent(parts[3], d);
  return event && { ...event, cycleId: parts[1] };
}

/** Newest first, ties broken by the later sequence number; at most `max` rows. */
export function latestActivity(rows: readonly ActivityRow[], max: number): ActivityRow[] {
  return [...rows].sort((a, b) => b.at.getTime() - a.at.getTime() || b.seq - a.seq).slice(0, max);
}

/** The words the Runs page uses for a stage; `cycle` is the loop's own bookkeeping; anything else as stored. */
export function stageTitle(stage: string): string {
  if (stage === "cycle") return "Run";
  return KNOWN_STAGES.find((s) => s.stage === stage)?.title ?? stage;
}
