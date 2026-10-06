/**
 * One scheduled ingest run: resolve the configuration, then read log windows one after another
 * and fold each into the store, keeping a checkpoint so no stretch of time is read twice or missed.
 *
 * The state that makes retries safe lives in `{runCollection}/state`:
 *   - `checkpoint`: where the last completed window ended;
 *   - `pending`: the window being processed. It is written BEFORE any log is read, and a run that
 *     finds one replays exactly that window. Planning a new window from the clock again would
 *     give it a different end, and so a different id, and the store could not tell that the
 *     overlapping part had already been counted.
 * The checkpoint advances only after every upsert of the window has committed. If the process
 * dies between the last commit and the checkpoint, the next run replays the window and the
 * store recognises it (store.ts, "Replays"), so nothing is counted twice.
 *
 * `{runCollection}/last_run` is the outcome of the latest run, for the UI: when it ran, over
 * what, what it found, whether it was capped or failed. It holds counts and field names, never
 * log text, because guests may read it.
 *
 * Single target: the state records which (watched project, environment) it belongs to. If the
 * runtime settings move the engine to another, the checkpoint is not carried over to it.
 */
import { Timestamp } from "firebase-admin/firestore";
import type { DocumentReference, DocumentSnapshot, Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import type { ConfigSource, ResolvedConfig } from "../runtimeSettings.js";
import { aggregateErrors, type AggregationResult } from "./aggregate.js";
import { planWindow, windowOf, type IngestWindow, type WindowPlan } from "./window.js";
import { cronIntervalMinutes } from "./cadence.js";

export const STATE_DOC = "state";
export const LAST_RUN_DOC = "last_run";
/** Windows one invocation works through before stopping, so a long outage is caught up over several runs. */
export const MAX_WINDOWS_PER_RUN = 8;

export type RunOutcome = "ok" | "failed" | "idle";

export interface RunSummary {
  outcome: RunOutcome;
  windows: number;
  /** The last window attempted (the one that failed, on a failure). */
  window?: { start: Date; end: Date };
  totals: Omit<AggregationResult, "capped">;
  /** True if any window hit the read cap: counts are then a floor, not the truth. */
  capped: boolean;
  configSource: ConfigSource;
  /** Why the runtime settings weren't used, as field names and rules. */
  problems: string[];
  actionsAllowed: boolean;
  /** A code or error name, never a message: messages can echo log text. */
  error?: string;
}

/** What run.ts needs from a configuration loader (RuntimeConfigLoader satisfies it). */
export interface ConfigResolver {
  resolve(db: Firestore): Promise<ResolvedConfig>;
}

export interface RunDeps {
  aggregate: (db: Firestore, config: StarfishConfig, window: IngestWindow) => Promise<AggregationResult>;
  /** Longest one window may take before the run gives up on it. */
  windowTimeoutMs?: number;
}

/**
 * A read that never finishes would hold the scheduler's slot and record nothing. After this long
 * the run gives up on the window, records the failure, and leaves the window pending so the next
 * run replays it (the store recognises whatever the abandoned read still managed to commit).
 */
export const WINDOW_TIMEOUT_MS = 10 * 60_000;

const defaultDeps: RunDeps = { aggregate: aggregateErrors };

class WindowTimeoutError extends Error {
  override name = "TimeoutError";
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WindowTimeoutError(`window not finished in ${ms} ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

interface RunState {
  target: { watchedProjectId: string; environment: string };
  checkpoint?: Date;
  pending?: IngestWindow;
}

export async function runIngest(
  db: Firestore,
  loader: ConfigResolver,
  now: Date = new Date(),
  deps: RunDeps = defaultDeps
): Promise<RunSummary> {
  const resolved = await loader.resolve(db);
  const { config } = resolved;
  const runs = db.collection(config.runCollection);

  const summary: RunSummary = {
    outcome: "idle",
    windows: 0,
    totals: { entriesProcessed: 0, incidentsCreated: 0, incidentsUpdated: 0, incidentsRecurred: 0, incidentsReplayed: 0 },
    capped: false,
    configSource: resolved.source,
    problems: resolved.problems,
    actionsAllowed: resolved.actionsAllowed,
  };

  try {
    const target = { watchedProjectId: config.watchedProjectId, environment: config.environment };
    const stateRef = runs.doc(STATE_DOC);
    const plan = {
      now,
      lookbackHours: config.defaultLookbackHours,
      lagMinutes: config.ingestLagMinutes,
      maxWindowHours: config.ingestMaxWindowHours,
    };

    for (let i = 0; i < MAX_WINDOWS_PER_RUN; i++) {
      // A state that can't be read stops the run: starting over from the lookback would re-read
      // time that was already counted, and nothing could tell the difference.
      const window = await claimWindow(db, stateRef, target, plan);
      if (!window) break;

      summary.window = { start: window.start, end: window.end };
      const result = await withDeadline(deps.aggregate(db, config, window), deps.windowTimeoutMs ?? WINDOW_TIMEOUT_MS);
      summary.windows += 1;
      summary.capped ||= result.capped;
      for (const key of Object.keys(summary.totals) as (keyof RunSummary["totals"])[]) {
        summary.totals[key] += result[key];
      }

      await completeWindow(db, stateRef, target, window);
    }
    summary.outcome = summary.windows > 0 ? "ok" : "idle";
  } catch (err) {
    summary.outcome = "failed";
    summary.error = errorLabel(err);
  }

  await recordLastRun(runs.doc(LAST_RUN_DOC), config, summary, now);
  return summary;
}

/**
 * The window to process: the one already pending, else the next one, saved as pending in the same
 * transaction that planned it. Two runs that overlap (a slow run and the next scheduled one) both
 * end up with the same window, because the second sees the first's pending window instead of
 * planning its own from a different clock, so the store's replay check applies to them both.
 * Returns null when there is nothing new to read.
 */
async function claimWindow(
  db: Firestore,
  ref: DocumentReference,
  target: RunState["target"],
  plan: Omit<WindowPlan, "checkpoint">
): Promise<IngestWindow | null> {
  return db.runTransaction(async (tx) => {
    const state = parseState(await tx.get(ref), target);
    if (state.pending) return state.pending;
    const window = planWindow({ ...plan, checkpoint: state.checkpoint });
    if (!window) return null;
    tx.set(ref, serializeState({ ...state, pending: window }));
    return window;
  });
}

/**
 * Moves the checkpoint to the window's end, and only if that window is still the pending one: a
 * run that finished after another run already completed it (or after the target changed) leaves
 * the state as it is, so a late finisher can never move the checkpoint backwards.
 */
async function completeWindow(
  db: Firestore,
  ref: DocumentReference,
  target: RunState["target"],
  window: IngestWindow
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const state = parseState(await tx.get(ref), target);
    if (state.pending?.id !== window.id) return;
    tx.set(ref, serializeState({ target, checkpoint: window.end }));
  });
}

function parseState(snap: DocumentSnapshot, target: RunState["target"]): RunState {
  const data = snap.data() as Record<string, unknown> | undefined;
  const saved = data?.target as Partial<RunState["target"]> | undefined;
  // The state belongs to the target it was written for. Moving to another starts that one fresh.
  if (!snap.exists || saved?.watchedProjectId !== target.watchedProjectId || saved?.environment !== target.environment) {
    return { target };
  }
  const checkpoint = toDate(data?.checkpoint);
  // A checkpoint that is there but unreadable is not "no checkpoint": starting over would re-read time
  // that was already counted.
  if (data?.checkpoint !== undefined && !checkpoint) throw new Error("ingest state holds an unreadable checkpoint");
  const pending = data?.pending as { start?: unknown; end?: unknown } | undefined;
  const start = toDate(pending?.start);
  const end = toDate(pending?.end);
  return {
    target,
    ...(checkpoint && { checkpoint }),
    ...(start && end && { pending: windowOf(start, end) }),
  };
}

function serializeState(state: RunState): Record<string, unknown> {
  return {
    target: state.target,
    ...(state.checkpoint && { checkpoint: Timestamp.fromDate(state.checkpoint) }),
    ...(state.pending && {
      pending: { start: Timestamp.fromDate(state.pending.start), end: Timestamp.fromDate(state.pending.end) },
    }),
  };
}

/** Best effort: the record is for people to look at, and a run's work does not depend on it. */
async function recordLastRun(
  ref: DocumentReference,
  config: StarfishConfig,
  s: RunSummary,
  now: Date
): Promise<void> {
  try {
    await ref.set({
      environment: config.environment,
      outcome: s.outcome,
      finishedAt: Timestamp.now(),
      startedAt: Timestamp.fromDate(now),
      windows: s.windows,
      capped: s.capped,
      totals: s.totals,
      configSource: s.configSource,
      actionsAllowed: s.actionsAllowed,
      problems: s.problems.slice(0, 20),
      // How often a run is started, so the UI can say when the next is expected. Absent when not known.
      ...(cronIntervalMinutes(config.ingestSchedule) !== null && { intervalMinutes: cronIntervalMinutes(config.ingestSchedule) }),
      ...(s.window && { windowStart: Timestamp.fromDate(s.window.start), windowEnd: Timestamp.fromDate(s.window.end) }),
      ...(s.error !== undefined && { error: s.error }),
    });
  } catch {
    // Nothing to do: the next run writes it again.
  }
}

function toDate(value: unknown): Date | undefined {
  const v = value as { toDate?: unknown } | null | undefined;
  if (typeof v?.toDate !== "function") return undefined;
  const d = (v.toDate as () => Date)();
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** An error's code or name: enough to diagnose, and never its message, which can echo data. */
function errorLabel(err: unknown): string {
  if (err instanceof AggregateError) return `AggregateError (${err.errors.length} failed)`;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" || typeof code === "number") return String(code);
  return err instanceof Error ? err.name : "unknown error";
}
