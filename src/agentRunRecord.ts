/**
 * The agent pass's own last-run record (#274), `{runCollection}/agent_last_run`: when the latest `pnpm agent` pass
 * started and finished, how it went, what it considered and started, and how often it runs when the job was told its
 * schedule (`STARFISH_AGENT_SCHEDULE`). src/agent/lastRun.ts writes it; the UI's agent line (web/src/lib/engineStatus.ts)
 * and `pnpm status` (src/status.ts) read it through `parseAgentRunRecord`.
 *
 * Pure and import-free, so the web UI can import it as it imports the settings schema. The record holds counts, booleans
 * and enumerated labels, never an error message, an incident id or any text from the logs: guests may read it, like
 * the ingest's `last_run`.
 *
 * While a pass runs, the record also holds `runningSince` (src/agent/lastRun.ts `recordAgentPassStarted`): the previous
 * pass's fields stay as they were until the end-of-pass write replaces the whole document.
 */

export const AGENT_LAST_RUN_DOC = "agent_last_run";

/**
 * The parts of a pass that can fail without stopping it, as recorded in `failedSteps`. A pass with any of them failed
 * is `failed` and the job exits 1, as before the record existed.
 *   cycles         a cycle threw (an infrastructure failure), or the pass stopped early because cycles kept throwing
 *   sweep          the sweep for stranded cycles failed
 *   index-heals    checking earlier index heals failed
 *   pull-requests  reading opened pull requests back stopped or failed
 *   recovery       reading deployments for merged fixes stopped on an error every one would hit (credentials, rate limit)
 *   merge-steps    the fast-revert or auto-merge step failed as a whole
 *   escalation     the phone escalation tick failed
 */
export const AGENT_PASS_STEPS = ["cycles", "sweep", "index-heals", "pull-requests", "recovery", "merge-steps", "escalation"] as const;
export type AgentPassStep = (typeof AGENT_PASS_STEPS)[number];

/** The `error` of a pass that refused to start because the agent's preflight refused its configuration. */
export const AGENT_PREFLIGHT_REFUSED = "preflight-refused";

export interface AgentRunRecord {
  /** The environment the pass ran for (the env default's when the runtime settings could not be used). */
  environment: string;
  /** `failed`: the pass did not start, threw, or one of its steps failed (`failedSteps`). */
  outcome: "ok" | "failed";
  finishedAt: Date;
  startedAt?: Date;
  /** Whether the pass ran with the dry run on. Absent when the pass stopped before it knew. */
  dryRun?: boolean;
  /** Candidates selected for a cycle. */
  considered: number;
  /** Cycles handed to the loop (started or resumed). */
  ran: number;
  /** Cycles whose run threw. */
  cycleErrors: number;
  /** The pass stopped early because cycles kept throwing. */
  aborted: boolean;
  /** Stranded cycles the sweep gave up. */
  gaveUp: number;
  /** The pass started nothing on purpose: automation is off, or the daily cycle cap was reached. */
  skipped?: "automation-disabled" | "daily-cap";
  /** The candidate scan read its cap: older open incidents wait for a later pass. */
  scanCapped: boolean;
  /** The daily cycle cap and how many cycles had been started that UTC day before this pass. */
  daily?: { cap: number; startedBefore: number };
  failedSteps: AgentPassStep[];
  /** Runtime settings the pass could not use, as field names and rules. */
  problems: string[];
  /** A code or error name for a pass that did not start or threw; never a message. */
  error?: string;
  /** How often a pass is started, from the job's schedule; absent when it could not tell. */
  intervalMinutes?: number;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const toDate = (v: unknown): Date | undefined => {
  const d = (v as { toDate?: () => Date } | null | undefined)?.toDate?.();
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : undefined;
};

/**
 * A pass that has started and not yet recorded its end: the start mark (`runningSince`) a pass stamps on the record as
 * it begins, which the end-of-pass write replaces. It says only that a pass started; one that was killed never clears
 * it, so a reader bounds how long it believes it (the UI uses its stale threshold).
 */
export interface AgentPassInProgress {
  /** The environment the record names: the previous pass's, or the env default's on a first pass. */
  environment: string;
  since: Date;
}

/** The start mark, or null when no pass is in progress: none stamped, or one older than the last recorded finish. */
export function parseAgentPassInProgress(data: Record<string, unknown> | undefined): AgentPassInProgress | null {
  if (data === undefined) return null;
  const since = toDate(data.runningSince);
  if (since === undefined) return null;
  const finishedAt = toDate(data.finishedAt);
  if (finishedAt !== undefined && finishedAt.getTime() >= since.getTime()) return null;
  return { environment: typeof data.environment === "string" ? data.environment : "", since };
}

/** The stored record, or null when it is missing or unusable (no finish time, an unknown outcome). */
export function parseAgentRunRecord(data: Record<string, unknown> | undefined): AgentRunRecord | null {
  if (data === undefined) return null;
  const finishedAt = toDate(data.finishedAt);
  if (finishedAt === undefined) return null;
  const outcome = data.outcome;
  if (outcome !== "ok" && outcome !== "failed") return null;
  const startedAt = toDate(data.startedAt);
  const daily = data.daily as { cap?: unknown; startedBefore?: unknown } | undefined;
  const skipped = data.skipped;
  return {
    environment: typeof data.environment === "string" ? data.environment : "",
    outcome,
    finishedAt,
    ...(startedAt && { startedAt }),
    ...(typeof data.dryRun === "boolean" && { dryRun: data.dryRun }),
    considered: count(data.considered),
    ran: count(data.ran),
    cycleErrors: count(data.cycleErrors),
    aborted: data.aborted === true,
    gaveUp: count(data.gaveUp),
    ...((skipped === "automation-disabled" || skipped === "daily-cap") && { skipped }),
    scanCapped: data.scanCapped === true,
    ...(typeof daily?.cap === "number" && Number.isFinite(daily.cap) && { daily: { cap: daily.cap, startedBefore: count(daily.startedBefore) } }),
    failedSteps: Array.isArray(data.failedSteps)
      ? data.failedSteps.filter((s): s is AgentPassStep => (AGENT_PASS_STEPS as readonly unknown[]).includes(s))
      : [],
    problems: Array.isArray(data.problems) ? data.problems.filter((p): p is string => typeof p === "string") : [],
    ...(typeof data.error === "string" && { error: data.error }),
    ...(typeof data.intervalMinutes === "number" && Number.isFinite(data.intervalMinutes) && data.intervalMinutes > 0 && { intervalMinutes: data.intervalMinutes }),
  };
}
