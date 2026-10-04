/**
 * What the Overview page counts, from the records it reads: the agent's cycles (`runsModel`) and the
 * incidents' hourly buckets. Pure. A number here is a count of stored documents; nothing is estimated,
 * and what the engine does not record (a run "healed on its own", the next scheduled run) has no field.
 */
import type { IncidentRow } from "./incidents";
import { runStatus, type CyclePath, type CycleRow } from "./runsModel";

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
