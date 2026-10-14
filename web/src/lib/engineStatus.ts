/**
 * What the engine says about its own last runs and how the UI judges them: the ingest's (`{runCollection}/last_run`,
 * written by src/ingest/run.ts) and the agent pass's (`{runCollection}/agent_last_run`, src/agent/lastRun.ts, #274).
 * Both are judged by the same rules (`judgeRun`), so "running", "not running" and "failed" mean the same on each line.
 *
 * Both are read live (a snapshot listener on the one document), so a run's start and its result show the moment the
 * engine writes them, with no polling.
 *
 * Only firebase/firestore and pure engine modules are imported, so the reader can be exercised without the web config.
 * The records hold counts and labels, never log text, because guests may read them (directly: they are not trimmed
 * copies, so dataSource.ts plays no part).
 */
import { doc, onSnapshot, type DocumentData, type Firestore, type Unsubscribe } from "firebase/firestore";
import { SETTINGS_UNUSABLE } from "../../../src/settingsSchema";
import { behindAfterMinutes, isBehind, parseLagSeconds } from "../../../src/ingestLag";
import { AGENT_LAST_RUN_DOC, parseAgentPassInProgress, parseAgentRunRecord, type AgentPassInProgress, type AgentRunRecord } from "../../../src/agentRunRecord";

export { AGENT_LAST_RUN_DOC, behindAfterMinutes, type AgentPassInProgress, type AgentRunRecord };

export const LAST_RUN_DOC = "last_run";

export interface LastRun {
  environment: string;
  outcome: "ok" | "failed" | "idle";
  finishedAt: Date;
  windows: number;
  /** A read hit the cap: counts are a floor. */
  capped: boolean;
  totals: { entriesProcessed: number; incidentsCreated: number; incidentsUpdated: number; incidentsRecurred: number };
  /** Runtime settings the engine could not use, as field names and rules. */
  problems: string[];
  /** A code or error name; never a message. */
  error?: string;
  /** When the run began. */
  startedAt?: Date;
  /** How often a run is started, from the engine's schedule; absent when the engine could not tell. */
  intervalMinutes?: number;
  /** How far the checkpoint was behind the newest readable logs when the run ended (#297); absent when not known. */
  lagSeconds?: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The last run, or null when none has been recorded (or the record is unusable). */
export function parseLastRun(d: DocumentData | undefined): LastRun | null {
  if (!d) return null;
  const finished = (d.finishedAt as { toDate?: () => Date } | undefined)?.toDate?.();
  const started = (d.startedAt as { toDate?: () => Date } | undefined)?.toDate?.();
  const outcome = d.outcome;
  if (!finished || Number.isNaN(finished.getTime())) return null;
  if (outcome !== "ok" && outcome !== "failed" && outcome !== "idle") return null;
  const totals = (d.totals ?? {}) as Record<string, unknown>;
  return {
    environment: typeof d.environment === "string" ? d.environment : "",
    outcome,
    finishedAt: finished,
    windows: num(d.windows),
    capped: d.capped === true,
    totals: {
      entriesProcessed: num(totals.entriesProcessed),
      incidentsCreated: num(totals.incidentsCreated),
      incidentsUpdated: num(totals.incidentsUpdated),
      incidentsRecurred: num(totals.incidentsRecurred),
    },
    problems: Array.isArray(d.problems) ? d.problems.filter((p): p is string => typeof p === "string") : [],
    ...(typeof d.error === "string" && { error: d.error }),
    ...(started && !Number.isNaN(started.getTime()) && { startedAt: started }),
    ...(typeof d.intervalMinutes === "number" && Number.isFinite(d.intervalMinutes) && d.intervalMinutes > 0 && { intervalMinutes: d.intervalMinutes }),
    ...(parseLagSeconds(d.lagSeconds) !== undefined && { lagSeconds: parseLagSeconds(d.lagSeconds) }),
  };
}

/** `{runCollection}/last_run`, live: `onData` with each version of the record (null when there is none). */
export function subscribeLastRun(
  db: Firestore,
  runCollection: string,
  onData: (run: LastRun | null) => void,
  onError: (err: Error) => void
): Unsubscribe {
  return onSnapshot(doc(db, runCollection, LAST_RUN_DOC), (snap) => onData(parseLastRun(snap.exists() ? snap.data() : undefined)), onError);
}

/** What the agent's record says (#274): its last finished pass, and a pass that has started and not yet ended. */
export interface AgentPass {
  /** Null when no pass has been recorded (or the record is unusable). */
  run: AgentRunRecord | null;
  /** Null when no pass is in progress. */
  inProgress: AgentPassInProgress | null;
}

/** The agent's record, live, both halves from each version of it: a pass's start mark and its result show as they are written. */
export function subscribeAgentPass(
  db: Firestore,
  runCollection: string,
  onData: (pass: AgentPass) => void,
  onError: (err: Error) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, runCollection, AGENT_LAST_RUN_DOC),
    (snap) => {
      const data = snap.exists() ? snap.data() : undefined;
      onData({ run: parseAgentRunRecord(data), inProgress: parseAgentPassInProgress(data) });
    },
    onError
  );
}

/**
 * When the next run (or pass) is expected: the last one's start plus the schedule's interval (#38, #274). `null` when
 * the engine did not say how often it runs. An estimate: the scheduler fires on the clock, not exactly an interval
 * after a start.
 */
export function nextRunAt(run: Pick<LastRun, "startedAt" | "intervalMinutes"> | null): Date | null {
  if (!run?.startedAt || run.intervalMinutes === undefined) return null;
  return new Date(run.startedAt.getTime() + run.intervalMinutes * 60_000);
}

export type EngineState = "ok" | "failed" | "stale" | "behind" | "capped" | "never";

export interface EngineHealth<T = LastRun> {
  state: EngineState;
  run: T | null;
}

/** What `judgeRun` reads of a record: the ingest's and the agent's both have it. */
type JudgedRecord = Pick<LastRun, "environment" | "finishedAt" | "capped" | "error" | "intervalMinutes" | "lagSeconds"> & { outcome: string };

/**
 * Worst first: a failed last run, then a stopped engine, then an ingest whose checkpoint is further behind the newest logs
 * than `behindMinutes` allows (#297; unset follows the schedule, `behindAfterMinutes`), then a read that hit the cap,
 * then healthy.
 * A run recorded for another environment is not this environment's run (the label was changed). Except a run that
 * refused to start because the runtime settings could not be used (#223): it records the env default's environment,
 * since the one an admin chose could not be read, so it is failed whatever environment it names, as in `pnpm status`.
 */
export function judgeRun<T extends JudgedRecord>(
  run: T | null,
  environment: string,
  nowMs: number,
  staleAfterMinutes: number,
  behindMinutes?: number
): EngineHealth<T> {
  if (!run) return { state: "never", run: null };
  if (run.outcome === "failed" && run.error === SETTINGS_UNUSABLE) return { state: "failed", run };
  if (run.environment !== environment) return { state: "never", run: null };
  if (run.outcome === "failed") return { state: "failed", run };
  if (nowMs - run.finishedAt.getTime() > staleAfterMinutes * 60_000) return { state: "stale", run };
  if (isBehind(run, staleAfterMinutes, behindMinutes)) return { state: "behind", run };
  if (run.capped) return { state: "capped", run };
  return { state: "ok", run };
}

/**
 * The agent's last pass judged like the ingest's run (#274): a candidate scan that read its cap is the agent's
 * "capped". `pnpm status` (src/status.ts `judgeAgentRun`) judges it the same way.
 */
export function judgeAgentRun(run: AgentRunRecord | null, environment: string, nowMs: number, staleAfterMinutes: number): EngineHealth<AgentRunRecord> {
  const { state, run: judged } = judgeRun(run && { ...run, capped: run.scanCapped }, environment, nowMs, staleAfterMinutes);
  return { state, run: judged && run };
}

/**
 * What the agent is doing between its last recorded end and the next (#274), for feedback while it works:
 *   running  a pass has started (its start mark) and not ended, within the stale threshold;
 *   overrun  a pass started longer ago than that and never recorded its end (killed by its task timeout, say);
 *   due      the next pass was expected by now and none has started (the job may still be starting);
 *   idle     none of these.
 * A start mark recorded for another environment is not this environment's pass. "due" only while the last pass looks
 * alive, as the line promises a next pass only then.
 */
export type AgentActivity =
  | { kind: "running"; since: Date }
  | { kind: "overrun"; since: Date }
  | { kind: "due"; dueAt: Date }
  | { kind: "idle" };

export function agentActivity(
  pass: AgentPass,
  health: EngineHealth<AgentRunRecord>,
  environment: string,
  nowMs: number,
  staleAfterMinutes: number
): AgentActivity {
  const started = pass.inProgress;
  if (started && started.environment === environment) {
    const over = nowMs - started.since.getTime() > staleAfterMinutes * 60_000;
    return { kind: over ? "overrun" : "running", since: started.since };
  }
  const next = health.state === "ok" || health.state === "capped" ? nextRunAt(health.run) : null;
  return next && next.getTime() <= nowMs ? { kind: "due", dueAt: next } : { kind: "idle" };
}
