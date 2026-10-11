/**
 * Is the deployed engine alive? Reads what the engine itself wrote (`{runCollection}/last_run`,
 * src/ingest/run.ts) and judges it, the same way the Incidents page does (web/src/lib/engineStatus.ts),
 * so a person on a terminal and a person in the UI are told the same thing. The judgment is a pure
 * function; the reads are in statusCli.ts. It also reports the agent pass's own record (`agent_last_run`, #274), judged
 * the same way, as information only: the agent job is optional, so its state never decides the exit code.
 *
 * It is the check to run after a first deploy: `gcloud run jobs execute ... --wait`, then `pnpm status`.
 * A record is evidence the job ran, wrote to the store and finished; it is not evidence the project
 * had errors to find, so "ok" with zero incidents on a quiet project is a correct answer.
 */
import type { AgentRunRecord } from "./agentRunRecord.js";
import { behindAfterMinutes, isBehind, parseLagSeconds } from "./ingestLag.js";
import { SETTINGS_UNUSABLE } from "./settingsSchema.js";
import { OPEN_INCIDENT_STATUSES } from "./types.js";

export type EngineState = "ok" | "failed" | "stale" | "behind" | "capped" | "never";

/** The outcomes run.ts records; a record with any other is unusable, as in the UI. */
export type RunOutcome = "ok" | "failed" | "idle";

export interface RunRecord {
  /** The environment the run was for: the runtime settings' one, which can differ from this shell's env var. */
  environment: string;
  outcome: RunOutcome;
  finishedAt: Date;
  windows: number;
  capped: boolean;
  totals: { entriesProcessed: number; incidentsCreated: number; incidentsUpdated: number; incidentsRecurred: number };
  problems: string[];
  /** A code or error name; never a message. */
  error?: string;
  /** How often a run is started, from the engine's schedule; absent when the engine could not tell. */
  intervalMinutes?: number;
  /** How far the checkpoint was behind the newest readable logs when the run ended (#297); absent when not known. */
  lagSeconds?: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const positive = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The stored last_run document as a RunRecord, or null when it is missing or unusable. */
export function parseRunRecord(data: Record<string, unknown> | undefined): RunRecord | null {
  if (data === undefined) return null;
  const finished = (data.finishedAt as { toDate?: () => Date } | undefined)?.toDate?.();
  if (finished === undefined || Number.isNaN(finished.getTime())) return null;
  const outcome = data.outcome;
  if (outcome !== "ok" && outcome !== "failed" && outcome !== "idle") return null;
  const totals = (data.totals ?? {}) as Record<string, unknown>;
  return {
    environment: typeof data.environment === "string" ? data.environment : "",
    outcome,
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
    ...(positive(data.intervalMinutes) && { intervalMinutes: data.intervalMinutes as number }),
    ...(parseLagSeconds(data.lagSeconds) !== undefined && { lagSeconds: parseLagSeconds(data.lagSeconds) }),
  };
}

/**
 * A run that refused to start because the runtime settings could not be used (#223). It records the env default's
 * environment, because the one an admin chose could not be read, so it is this deployment's failure whatever
 * environment it names. The UI's judge (web/src/lib/engineStatus.ts) reads it the same way.
 */
export function isSettingsRefusal(run: { outcome: string; error?: string }): boolean {
  return run.outcome === "failed" && run.error === SETTINGS_UNUSABLE;
}

/**
 * failed beats stale beats behind beats capped beats ok; no record at all is "never", and so is a record for another
 * environment (the label was changed): it is not this environment's run. Except a refusal on unusable settings,
 * which is failed whatever environment it names (`isSettingsRefusal`). Behind (#297) before capped: incidents seen
 * late are worse than counts that are a floor, and a flood usually brings both.
 */
export function judgeRun(
  run: (Pick<RunRecord, "environment" | "finishedAt" | "capped" | "error" | "intervalMinutes" | "lagSeconds"> & { outcome: string }) | null,
  environment: string,
  now: Date,
  staleMinutes: number,
  behindMinutes?: number
): EngineState {
  if (run === null) return "never";
  if (isSettingsRefusal(run)) return "failed";
  if (run.environment !== environment) return "never";
  if (run.outcome === "failed") return "failed";
  if (now.getTime() - run.finishedAt.getTime() > staleMinutes * 60_000) return "stale";
  if (isBehind(run, staleMinutes, behindMinutes)) return "behind";
  if (run.capped) return "capped";
  return "ok";
}

/**
 * The agent pass's record judged like the ingest's (#274): a scan that read its cap is the agent's "capped". The UI's
 * agent line (web/src/lib/engineStatus.ts `judgeAgentRun`) judges it the same way.
 */
export function judgeAgentRun(run: AgentRunRecord | null, environment: string, now: Date, staleMinutes: number): EngineState {
  return judgeRun(run && { ...run, capped: run.scanCapped }, environment, now, staleMinutes);
}

/** What `pnpm status` says about the agent pass: information only, never part of the exit code. */
export function describeAgentStatus(input: { run: AgentRunRecord | null; now: Date; staleMinutes: number; environment: string }): string[] {
  const { run, now, staleMinutes, environment } = input;
  if (run === null) return ["agent: no pass recorded (the agent job is not deployed, has not run, or could not write the store)"];
  if (run.environment !== environment && !isSettingsRefusal(run)) {
    return [`agent: no pass recorded for "${environment}" (the last pass recorded was for "${run.environment}")`];
  }
  const state = judgeAgentRun(run, environment, now, staleMinutes);
  const minutes = Math.max(0, Math.round((now.getTime() - run.finishedAt.getTime()) / 60_000));
  const lines = [
    `agent: ${state}. Last pass ${run.outcome}${run.dryRun === true ? " (dry run)" : ""}, finished ${minutes} min ago: ` +
      `${run.considered} candidate(s), ${run.ran} cycle(s) run, ${run.cycleErrors} threw`,
  ];
  if (state === "stale") lines.push(`  no pass has finished for more than ${staleMinutes} min (is the schedule slower than that?)`);
  if (run.skipped === "automation-disabled") lines.push("  automation was off (or the switch could not be read): no cycle started");
  if (run.skipped === "daily-cap") lines.push(`  the daily cycle cap${run.daily ? ` of ${run.daily.cap}` : ""} was reached: no cycle started`);
  if (run.scanCapped) lines.push("  the candidate scan read its cap: older open incidents wait for a later pass");
  if (run.aborted) lines.push("  the pass stopped early: cycles kept throwing");
  if (run.failedSteps.length > 0) lines.push(`  failed: ${run.failedSteps.join(", ")}`);
  if (run.error !== undefined) lines.push(`  failed with: ${run.error}`);
  if (run.problems.length > 0) lines.push(`  runtime settings not used: ${run.problems.join("; ")}`);
  return lines;
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
  input: { run: RunRecord | null; environment: string; counts: Record<string, number> },
  min: { incidents: number; entries: number }
): string[] {
  const unmet: string[] = [];
  const found = totalIncidents(input.counts);
  if (found < min.incidents) unmet.push(`expected at least ${min.incidents} incident(s), found ${found}`);
  // A run for another environment read none of this one's entries.
  const entries = input.run?.environment === input.environment ? input.run.totals.entriesProcessed : 0;
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
  /** `ingestBehindMinutes` (#297); unset follows the schedule (`behindAfterMinutes`). */
  behindMinutes?: number;
}): StatusReport {
  const { run, now, staleMinutes, environment, counts, behindMinutes } = input;
  const state = judgeRun(run, environment, now, staleMinutes, behindMinutes);
  const lines: string[] = [];

  if (run === null) {
    lines.push("engine: never recorded a run (the job has not run, or could not write the store)");
  } else if (run.environment !== environment && !isSettingsRefusal(run)) {
    lines.push(`engine: never recorded a run for "${environment}" (the last run recorded was for "${run.environment}")`);
  } else {
    const minutes = Math.max(0, Math.round((now.getTime() - run.finishedAt.getTime()) / 60_000));
    const t = run.totals;
    lines.push(
      `engine: ${state}. Last run ${run.outcome}, finished ${minutes} min ago: ${run.windows} window(s), ${t.entriesProcessed} entries; ` +
        `${t.incidentsCreated} new, ${t.incidentsUpdated} updated, ${t.incidentsRecurred} recurred`
    );
    if (state === "stale") lines.push(`  nothing has run for more than ${staleMinutes} min (is the schedule slower than that?)`);
    if (run.lagSeconds !== undefined && run.lagSeconds >= 60) {
      const lag = Math.round(run.lagSeconds / 60);
      lines.push(
        isBehind(run, staleMinutes, behindMinutes)
          ? `  behind: the checkpoint was ${lag} min behind the newest readable logs (more than ${behindAfterMinutes(run, staleMinutes, behindMinutes)} min): runs are not catching up, so new incidents are seen late`
          : `  the checkpoint was ${lag} min behind the newest readable logs`
      );
    }
    if (run.capped) lines.push("  a read hit its cap: the counts are a floor, not the truth");
    if (run.error !== undefined) lines.push(`  failed with: ${run.error}`);
    if (isSettingsRefusal(run)) lines.push("  the run read nothing: the runtime settings could not be used and no last-good copy exists");
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

/**
 * What to tell a person when the store could not be read at all, in one line and with no stack trace: the engine may
 * be perfectly healthy, and a crash here reads as if it were not. Credentials that expired or are missing get the
 * command that renews them (Google Workspace asks for a new sign-in on a schedule: `invalid_grant` / `invalid_rapt`);
 * a missing permission says which; anything else keeps the error's name and its first line, bounded. Never the stack.
 */
export function describeReadFailure(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (/invalid_grant|invalid_rapt|invalid_client|reauth|Getting metadata from plugin failed|Could not load the default credentials|Could not refresh access token|UNAUTHENTICATED/i.test(text) || code === 16) {
    return "could not sign in to Google Cloud: the credentials on this machine have expired or are missing. Run `gcloud auth application-default login`, then try again. The engine itself was not checked.";
  }
  if (/PERMISSION_DENIED/i.test(text) || code === 7) {
    return "signed in, but this account may not read Starfish's database (PERMISSION_DENIED): check the project and that the account can read it. The engine itself was not checked.";
  }
  const first = text.split("\n")[0]!.slice(0, 200);
  return `could not read Starfish's store (${first}). The engine itself was not checked.`;
}
