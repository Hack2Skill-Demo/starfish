/**
 * Is the deployed engine alive? Reads what the engine itself wrote (`{runCollection}/last_run`,
 * src/ingest/run.ts) and judges it, the same way the Incidents page does (web/src/lib/engineStatus.ts),
 * so a person on a terminal and a person in the UI are told the same thing. The judgment is a pure
 * function; the reads are in statusCli.ts.
 *
 * It is the check to run after a first deploy: `gcloud run jobs execute ... --wait`, then `pnpm status`.
 * A record is evidence the job ran, wrote to the store and finished; it is not evidence the project
 * had errors to find, so "ok" with zero incidents on a quiet project is a correct answer.
 */
import { OPEN_INCIDENT_STATUSES } from "./types.js";

export type EngineState = "ok" | "failed" | "stale" | "capped" | "never";

export interface RunRecord {
  outcome: string;
  finishedAt: Date;
  windows: number;
  capped: boolean;
  totals: { entriesProcessed: number; incidentsCreated: number; incidentsUpdated: number; incidentsRecurred: number };
  problems: string[];
  /** A code or error name; never a message. */
  error?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The stored last_run document as a RunRecord, or null when it is missing or unusable. */
export function parseRunRecord(data: Record<string, unknown> | undefined): RunRecord | null {
  if (data === undefined) return null;
  const finished = (data.finishedAt as { toDate?: () => Date } | undefined)?.toDate?.();
  if (finished === undefined || Number.isNaN(finished.getTime())) return null;
  if (typeof data.outcome !== "string") return null;
  const totals = (data.totals ?? {}) as Record<string, unknown>;
  return {
    outcome: data.outcome,
    finishedAt: finished,
    windows: num(data.windows),
    capped: data.capped === true,
    totals: {
      entriesProcessed: num(totals.entriesProcessed),
      incidentsCreated: num(totals.incidentsCreated),
      incidentsUpdated: num(totals.incidentsUpdated),
      incidentsRecurred: num(totals.incidentsRecurred),
    },
    problems: Array.isArray(data.problems) ? data.problems.filter((p): p is string => typeof p === "string") : [],
    ...(typeof data.error === "string" && { error: data.error }),
  };
}

/** failed beats stale beats capped beats ok; no record at all is "never". */
export function judgeRun(run: RunRecord | null, now: Date, staleMinutes: number): EngineState {
  if (run === null) return "never";
  if (run.outcome === "failed") return "failed";
  if (now.getTime() - run.finishedAt.getTime() > staleMinutes * 60_000) return "stale";
  if (run.capped) return "capped";
  return "ok";
}

/** The incident total across every status, for "did the run find what I planted". */
export function totalIncidents(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/**
 * What the caller required and the record does not show, as sentences; empty when everything holds.
 * `entries` counts the log entries the last run processed: on a quiet project a run that read one
 * entry has read the one that was planted, which the incident total alone cannot show.
 */
export function unmetMinimums(
  input: { run: RunRecord | null; counts: Record<string, number> },
  min: { incidents: number; entries: number }
): string[] {
  const unmet: string[] = [];
  const found = totalIncidents(input.counts);
  if (found < min.incidents) unmet.push(`expected at least ${min.incidents} incident(s), found ${found}`);
  const entries = input.run?.totals.entriesProcessed ?? 0;
  if (entries < min.entries) unmet.push(`expected the last run to process at least ${min.entries} log entr${min.entries === 1 ? "y" : "ies"}, it processed ${entries}`);
  return unmet;
}

export interface StatusReport {
  state: EngineState;
  lines: string[];
}

export function describeStatus(input: {
  run: RunRecord | null;
  now: Date;
  staleMinutes: number;
  environment: string;
  /** Incident counts by status, for the watched environment. */
  counts: Record<string, number>;
}): StatusReport {
  const { run, now, staleMinutes, environment, counts } = input;
  const state = judgeRun(run, now, staleMinutes);
  const lines: string[] = [];

  if (run === null) {
    lines.push("engine: never recorded a run (the job has not run, or could not write the store)");
  } else {
    const minutes = Math.max(0, Math.round((now.getTime() - run.finishedAt.getTime()) / 60_000));
    const t = run.totals;
    lines.push(
      `engine: ${state}. Last run ${run.outcome}, finished ${minutes} min ago: ${run.windows} window(s), ${t.entriesProcessed} entries; ` +
        `${t.incidentsCreated} new, ${t.incidentsUpdated} updated, ${t.incidentsRecurred} recurred`
    );
    if (state === "stale") lines.push(`  nothing has run for more than ${staleMinutes} min (is the schedule slower than that?)`);
    if (run.capped) lines.push("  a read hit its cap: the counts are a floor, not the truth");
    if (run.error !== undefined) lines.push(`  failed with: ${run.error}`);
    if (run.problems.length > 0) lines.push(`  runtime settings not used: ${run.problems.join("; ")}`);
  }

  const total = totalIncidents(counts);
  const open = OPEN_INCIDENT_STATUSES.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  const byStatus = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s} ${n}`)
    .join(", ");
  lines.push(`incidents in "${environment}": ${total} total, ${open} open${byStatus !== "" ? ` (${byStatus})` : ""}`);

  return { state, lines };
}
