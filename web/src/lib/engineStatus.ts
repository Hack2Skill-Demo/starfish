/**
 * What the engine says about its own last runs and how the UI judges them: the ingest's (`{runCollection}/last_run`,
 * written by src/ingest/run.ts) and the agent pass's (`{runCollection}/agent_last_run`, src/agent/lastRun.ts, #274).
 * Both are judged by the same rules (`judgeRun`), so "running", "not running" and "failed" mean the same on each line.
 *
 * Only firebase/firestore and pure engine modules are imported, so the reader can be exercised without the web config.
 * The records hold counts and labels, never log text, because guests may read them (directly: they are not trimmed
 * copies, so dataSource.ts plays no part).
 */
import { doc, getDoc, type Firestore } from "firebase/firestore";
import { SETTINGS_UNUSABLE } from "../../../src/settingsSchema";
import { AGENT_LAST_RUN_DOC, parseAgentRunRecord, type AgentRunRecord } from "../../../src/agentRunRecord";

export { AGENT_LAST_RUN_DOC, type AgentRunRecord };

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
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The last run, or null when none has been recorded (or the record is unusable). */
export async function readLastRun(db: Firestore, runCollection: string): Promise<LastRun | null> {
  const snap = await getDoc(doc(db, runCollection, LAST_RUN_DOC));
  if (!snap.exists()) return null;
  const d = snap.data();
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
  };
}

/** The agent's last pass (#274), or null when none has been recorded (or the record is unusable). */
export async function readAgentLastRun(db: Firestore, runCollection: string): Promise<AgentRunRecord | null> {
  const snap = await getDoc(doc(db, runCollection, AGENT_LAST_RUN_DOC));
  return snap.exists() ? parseAgentRunRecord(snap.data()) : null;
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

export type EngineState = "ok" | "failed" | "stale" | "capped" | "never";

export interface EngineHealth<T = LastRun> {
  state: EngineState;
  run: T | null;
}

/** What `judgeRun` reads of a record: the ingest's and the agent's both have it. */
type JudgedRecord = Pick<LastRun, "environment" | "finishedAt" | "capped" | "error"> & { outcome: string };

/**
 * Worst first: a failed last run, then a stopped engine, then a read that hit the cap, then healthy.
 * A run recorded for another environment is not this environment's run (the label was changed). Except a run that
 * refused to start because the runtime settings could not be used (#223): it records the env default's environment,
 * since the one an admin chose could not be read, so it is failed whatever environment it names, as in `pnpm status`.
 */
export function judgeRun<T extends JudgedRecord>(run: T | null, environment: string, nowMs: number, staleAfterMinutes: number): EngineHealth<T> {
  if (!run) return { state: "never", run: null };
  if (run.outcome === "failed" && run.error === SETTINGS_UNUSABLE) return { state: "failed", run };
  if (run.environment !== environment) return { state: "never", run: null };
  if (run.outcome === "failed") return { state: "failed", run };
  if (nowMs - run.finishedAt.getTime() > staleAfterMinutes * 60_000) return { state: "stale", run };
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
