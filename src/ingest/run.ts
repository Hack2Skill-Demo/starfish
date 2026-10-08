/**
 * One scheduled ingest run: resolve the configuration, then read log windows one after another
 * and fold each into the store, keeping a checkpoint so no stretch of time is read twice or missed.
 *
 * The state that makes retries safe lives in `{runCollection}/state_<hash>`, one document per
 * (watched project, environment) target (`stateDocId`):
 *   - `checkpoint`: where the last completed window ended;
 *   - `pending`: the window being processed. It is written BEFORE any log is read, and a run that
 *     finds one replays exactly that window. Planning a new window from the clock again would
 *     give it a different end, and so a different id, and the store could not tell that the
 *     overlapping part had already been counted. `pending.writesBegun` records that an attempt
 *     reached its upserts (#199): such a window is never narrowed (below).
 * The checkpoint advances only after every upsert of the window has committed. If the process
 * dies between the last commit and the checkpoint, the next run replays the window and the
 * store recognises it (store.ts, "Replays"), so nothing is counted twice.
 * A window with more entries than one read takes is narrowed, not completed: the pending window
 * shrinks to the part the read covered in full, and the rest is planned after it (#127). Only while
 * nothing has been written under its id: the narrowed window has a new id, and occurrences an earlier
 * attempt already committed under the old one would be counted again under it (#199). A window an
 * attempt already wrote is processed as read instead, under its own id, and flagged capped.
 *
 * Per target (#198): moving the engine to another watched project or environment and back resumes
 * the first target from its own checkpoint. One shared document was overwritten by the switch, and
 * coming back re-read the lookback under new window ids, counting every occurrence in it twice. A
 * deployment from before this keeps its checkpoint: the single `{runCollection}/state` it wrote is
 * read while its target matches and no per-target document exists, and is moved to the per-target
 * one by the first write (`LEGACY_STATE_DOC`). A window pending in that document is taken as written (#222).
 *
 * No run on settings it cannot trust (#198): when the settings document could not be read or is
 * invalid and no earlier one is known good (`actionsAllowed` false), the env defaults may name
 * another project or environment than the admin chose, and reading it would write its incidents into
 * the store as if they were the chosen target's. The run reads nothing, records a failed last_run
 * (`settings-unusable`), and the CLI exits non-zero. That record names the env default's environment,
 * which may not be the one the UI and `pnpm status` judge against; both read it as failed whatever its
 * environment (#223). No settings document at all is not that: the env defaults are then the
 * configuration, and the run goes ahead.
 *
 * A bounded run (#221): one run works for at most `ingestRunBudgetSeconds`. It starts no new window once
 * most of that is spent (the next run carries on from the checkpoint), and gives up on a window's read at
 * whatever is left of it, so a stalled read is recorded as a failed last_run while the process is still
 * alive. Whatever runs the ingest must allow more than the budget: scripts/deploy-gcp.sh derives the
 * Cloud Run job's task timeout and the admin API's request timeout from it. What the deadline bounds is
 * the window's read and upserts; the settings read, the state transactions and the last_run write around
 * it are not timed.
 *
 * `{runCollection}/last_run` is the outcome of the latest run, for the UI: when it ran, over
 * what, what it found, whether it was capped or failed. It holds counts and field names, never
 * log text, because guests may read it.
 */
import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import type { CollectionReference, DocumentReference, DocumentSnapshot, Firestore, Transaction } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import type { ConfigSource, ResolvedConfig } from "../runtimeSettings.js";
import { aggregateErrors, type AggregateDeps, type AggregationResult } from "./aggregate.js";
import { planWindow, windowOf, type IngestWindow, type WindowPlan } from "./window.js";
import { cronIntervalMinutes } from "./cadence.js";
import { abortIfClosed } from "./store.js";
import { SETTINGS_UNUSABLE } from "../settingsSchema.js";

/** The single state document of a deployment from before per-target state (#198): read for migration only. */
export const LEGACY_STATE_DOC = "state";
export const LAST_RUN_DOC = "last_run";
/** The `error` a run records when it refused to run on settings it cannot trust (defined with the settings schema). */
export { SETTINGS_UNUSABLE };

/**
 * The state document of one (watched project, environment) target. Hashed because both are free
 * text and an environment label may hold a `/`, which a document id can't.
 */
export function stateDocId(target: { watchedProjectId: string; environment: string }): string {
  const hash = createHash("sha256").update(`${target.watchedProjectId}\n${target.environment}`).digest("hex");
  return `state_${hash.slice(0, 32)}`;
}
/** Windows one invocation works through before stopping, so a long outage is caught up over several runs. */
export const MAX_WINDOWS_PER_RUN = 8;

export type RunOutcome = "ok" | "failed" | "idle";

export interface RunSummary {
  outcome: RunOutcome;
  windows: number;
  /** The last window attempted (the one that failed, on a failure). */
  window?: { start: Date; end: Date };
  totals: Omit<AggregationResult, "capped" | "narrowedTo" | "monitoring" | "superseded">;
  /**
   * The Cloud Monitoring signal over the run's windows (#19), absent when it is off. `unavailableWindows`
   * counts windows whose read failed: their unlogged failures are unknown, not zero, and are not re-read.
   */
  monitoring?: { observations: number; annotated: number; monitoringOnly: number; unavailableWindows: number };
  /**
   * True if any window hit the read cap and could not be narrowed (see `narrowWindow`): part of it
   * was not read, so counts are a floor, not the truth. A capped read that was narrowed loses nothing.
   */
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
  /** `deps.writes` ties the window's writes to the run state (#199); the run always passes it. */
  aggregate: (db: Firestore, config: StarfishConfig, window: IngestWindow, deps: AggregateDeps) => Promise<AggregationResult>;
  /** Longest one window may take before the run gives up on it. */
  windowTimeoutMs?: number;
  /** How long the whole run may work (#221). Default: the config's `ingestRunBudgetSeconds`. */
  runBudgetMs?: number;
  /** Milliseconds since the epoch, for the run budget. Default `Date.now`. */
  clock?: () => number;
}

/**
 * A read that never finishes would hold the scheduler's slot and record nothing. After this long
 * the run gives up on the window, records the failure, and leaves the window pending so the next
 * run replays it (the store recognises whatever the abandoned read still managed to commit).
 * Never longer than what is left of the run budget (#221): a deadline past it would fire only after
 * the task timeout had already killed the process, and no failed `last_run` would be written.
 */
export const WINDOW_TIMEOUT_MS = 10 * 60_000;
/**
 * No new window is started once less than this share of the run budget is left (#221): a window started
 * on the last scraps of it would only be given up, and recorded as a failure, though nothing stalled.
 * The first window is always started; the next run carries on where this one stopped.
 */
export const MIN_BUDGET_SHARE_FOR_NEW_WINDOW = 0.25;

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
  /** `writesBegun`: an attempt at this window reached its upserts, so some may have committed (#199). */
  pending?: IngestWindow & { writesBegun?: boolean };
}

/** Where one target's state is read from and written to. */
interface StateRefs {
  target: RunState["target"];
  ref: DocumentReference;
  legacy: DocumentReference;
}

export async function runIngest(
  db: Firestore,
  loader: ConfigResolver,
  now: Date = new Date(),
  deps: RunDeps = defaultDeps
): Promise<RunSummary> {
  const clock = deps.clock ?? Date.now;
  const startedMs = clock();
  const resolved = await loader.resolve(db);
  const { config } = resolved;
  const budgetMs = deps.runBudgetMs ?? config.ingestRunBudgetSeconds * 1000;
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
    if (!resolved.actionsAllowed) {
      // See the header: the env defaults are not known to be the target the admin chose.
      throw Object.assign(new Error("runtime settings unusable and no last-good copy"), { code: SETTINGS_UNUSABLE });
    }
    const target = { watchedProjectId: config.watchedProjectId, environment: config.environment };
    const refs = stateRefs(runs, target);
    const plan = {
      now,
      lookbackHours: config.defaultLookbackHours,
      lagMinutes: config.ingestLagMinutes,
      maxWindowHours: config.ingestMaxWindowHours,
    };

    for (let i = 0; i < MAX_WINDOWS_PER_RUN; i++) {
      // The run budget (#221): with most of it spent, stop here and leave the rest to the next run.
      const leftMs = budgetMs - (clock() - startedMs);
      if (i > 0 && leftMs < budgetMs * MIN_BUDGET_SHARE_FOR_NEW_WINDOW) break;
      // A state that can't be read stops the run: starting over from the lookback would re-read
      // time that was already counted, and nothing could tell the difference.
      const claimed = await claimWindow(db, refs, plan);
      if (!claimed) break;
      const window = windowOf(claimed.start, claimed.end);

      summary.window = { start: window.start, end: window.end };
      const writes = { mayNarrow: claimed.writesBegun !== true, beginWrites: () => beginWrites(db, refs, window) };
      // Given up at whichever comes first: the window's own limit or the end of the run budget.
      const deadlineMs = Math.max(0, Math.min(deps.windowTimeoutMs ?? WINDOW_TIMEOUT_MS, budgetMs - (clock() - startedMs)));
      const result = await withDeadline(deps.aggregate(db, config, window, { writes }), deadlineMs);
      if (result.superseded) continue;
      if (result.narrowedTo) {
        // A capped read wrote nothing: replay the part it covered in full, and leave the rest of the
        // window to the windows planned after it (#127). It still counts against MAX_WINDOWS_PER_RUN.
        // If an attempt began writing this window meanwhile, it is left as it is, and the next claim
        // processes it unnarrowed (#199).
        await narrowPending(db, refs, window, result.narrowedTo);
        continue;
      }
      summary.windows += 1;
      summary.capped ||= result.capped;
      for (const key of Object.keys(summary.totals) as (keyof RunSummary["totals"])[]) {
        summary.totals[key] += result[key];
      }
      if (result.monitoring) {
        const m = (summary.monitoring ??= { observations: 0, annotated: 0, monitoringOnly: 0, unavailableWindows: 0 });
        m.observations += result.monitoring.observations;
        m.annotated += result.monitoring.annotated;
        m.monitoringOnly += result.monitoring.monitoringOnly;
        if (result.monitoring.unavailable) m.unavailableWindows += 1;
      }

      await completeWindow(db, refs, window);
    }
    // A run that only narrowed a window did work and has more to do: not idle.
    summary.outcome = summary.window ? "ok" : "idle";
  } catch (err) {
    summary.outcome = "failed";
    summary.error = errorLabel(err);
  }

  await recordLastRun(runs.doc(LAST_RUN_DOC), config, summary, now);
  return summary;
}

function stateRefs(runs: CollectionReference, target: RunState["target"]): StateRefs {
  return { target, ref: runs.doc(stateDocId(target)), legacy: runs.doc(LEGACY_STATE_DOC) };
}

/**
 * The target's state, inside a transaction: its own document, else the legacy single document when that
 * one was written for this target (a deployment from before #198), else a fresh state. `fromLegacy` says
 * the write that follows must move it: `writeState` then deletes the legacy document in the same commit.
 */
async function readState(tx: Transaction, refs: StateRefs): Promise<{ state: RunState; fromLegacy: boolean }> {
  const [own, legacy] = await Promise.all([tx.get(refs.ref), tx.get(refs.legacy)]);
  if (own.exists) return { state: parseState(own, refs.target), fromLegacy: false };
  if (legacy.exists && belongsTo(legacy, refs.target)) return { state: fromLegacyState(parseState(legacy, refs.target)), fromLegacy: true };
  return { state: { target: refs.target }, fromLegacy: false };
}

/**
 * A pending window in the legacy document counts as written (#222): the code that wrote it predates `writesBegun`
 * (#199) and never recorded it, so an attempt may have committed occurrences under its id. Narrowing it would count
 * them again under the narrowed window's new id; processing it as read, flagged capped, counts nothing twice.
 */
function fromLegacyState(state: RunState): RunState {
  return state.pending ? { ...state, pending: { ...state.pending, writesBegun: true } } : state;
}

function writeState(tx: Transaction, refs: StateRefs, state: RunState, fromLegacy: boolean): void {
  tx.set(refs.ref, serializeState(state));
  if (fromLegacy) tx.delete(refs.legacy);
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
  refs: StateRefs,
  plan: Omit<WindowPlan, "checkpoint">
): Promise<RunState["pending"] | null> {
  return db.runTransaction((tx) =>
    abortIfClosed(async () => {
    const { state, fromLegacy } = await readState(tx, refs);
    if (state.pending) return state.pending;
    const window = planWindow({ ...plan, checkpoint: state.checkpoint });
    if (!window) return null;
    writeState(tx, refs, { ...state, pending: window }, fromLegacy);
    return window;
  }));
}

/**
 * Records on the pending window that writes under its id are beginning (#199), so no later attempt
 * narrows it. False when the window is no longer the pending one (another run narrowed or completed
 * it): the caller then writes nothing, since its occurrences belong to whatever replaced it.
 */
async function beginWrites(db: Firestore, refs: StateRefs, window: IngestWindow): Promise<boolean> {
  return db.runTransaction((tx) =>
    abortIfClosed(async () => {
    const { state, fromLegacy } = await readState(tx, refs);
    if (state.pending?.id !== window.id) return false;
    if (state.pending.writesBegun !== true || fromLegacy) {
      writeState(tx, refs, { ...state, pending: { ...state.pending, writesBegun: true } }, fromLegacy);
    }
    return true;
  }));
}

/**
 * Moves the checkpoint to the window's end, and only if that window is still the pending one: a
 * run that finished after another run already completed it leaves the state as it is, so a late
 * finisher can never move the checkpoint backwards.
 */
async function completeWindow(db: Firestore, refs: StateRefs, window: IngestWindow): Promise<void> {
  await db.runTransaction((tx) =>
    abortIfClosed(async () => {
    const { state, fromLegacy } = await readState(tx, refs);
    if (state.pending?.id !== window.id) return;
    writeState(tx, refs, { target: refs.target, checkpoint: window.end }, fromLegacy);
  }));
}

/**
 * Replaces the pending window with the narrower one a capped read asked for, keeping the checkpoint.
 * Only if that window is still the pending one, as in `completeWindow`: if another run already
 * narrowed or completed it, the next claim picks up whatever that run left. And never once an attempt
 * began writing it (#199): the narrowed window's new id would let those writes count twice.
 */
async function narrowPending(db: Firestore, refs: StateRefs, window: IngestWindow, narrowed: IngestWindow): Promise<void> {
  // A narrowed window that does not start where this one does, or does not end inside it, would skip or
  // re-read time. The aggregator never returns one; this keeps a bad one from reaching the state.
  if (narrowed.start.getTime() !== window.start.getTime() || !(narrowed.end > window.start && narrowed.end < window.end)) {
    throw new Error("narrowed window is not a prefix of the pending one");
  }
  await db.runTransaction((tx) =>
    abortIfClosed(async () => {
    const { state, fromLegacy } = await readState(tx, refs);
    if (state.pending?.id !== window.id || state.pending.writesBegun === true) return;
    writeState(tx, refs, { ...state, pending: narrowed }, fromLegacy);
  }));
}

/**
 * How far ingest has read this target's logs: every window up to the returned time is committed to the store. Null when
 * that is not known (no state, another target's state, an unreadable checkpoint), never "now" or zero. Read-only; for
 * a check that must not take a stalled ingest for a quiet incident (#188). Reads the target's own state document, else
 * the legacy single one when it was written for this target, as `readState` does. A failed read throws.
 */
export async function readIngestCheckpoint(
  db: Firestore,
  runCollection: string,
  target: RunState["target"]
): Promise<Date | null> {
  const runs = db.collection(runCollection);
  const [own, legacy] = await Promise.all([runs.doc(stateDocId(target)).get(), runs.doc(LEGACY_STATE_DOC).get()]);
  const snap = own.exists ? own : legacy.exists && belongsTo(legacy, target) ? legacy : null;
  if (snap === null) return null;
  try {
    return parseState(snap, target).checkpoint ?? null;
  } catch {
    return null;
  }
}

/** True when a state document was written for `target`. */
function belongsTo(snap: DocumentSnapshot, target: RunState["target"]): boolean {
  const saved = (snap.data() as Record<string, unknown> | undefined)?.target as Partial<RunState["target"]> | undefined;
  return saved?.watchedProjectId === target.watchedProjectId && saved?.environment === target.environment;
}

function parseState(snap: DocumentSnapshot, target: RunState["target"]): RunState {
  const data = snap.data() as Record<string, unknown> | undefined;
  // The state belongs to the target it was written for. A per-target document that names another (a
  // hand edit) can't be trusted, and starting this target fresh could re-read time already counted.
  if (!belongsTo(snap, target)) throw new Error("ingest state document names another target");
  const checkpoint = toDate(data?.checkpoint);
  // A checkpoint that is there but unreadable is not "no checkpoint": starting over would re-read time
  // that was already counted.
  if (data?.checkpoint !== undefined && !checkpoint) throw new Error("ingest state holds an unreadable checkpoint");
  const pending = data?.pending as { start?: unknown; end?: unknown; writesBegun?: unknown } | undefined;
  const start = toDate(pending?.start);
  const end = toDate(pending?.end);
  return {
    target,
    ...(checkpoint && { checkpoint }),
    ...(start && end && { pending: { ...windowOf(start, end), ...(pending?.writesBegun === true && { writesBegun: true }) } }),
  };
}

function serializeState(state: RunState): Record<string, unknown> {
  return {
    target: state.target,
    ...(state.checkpoint && { checkpoint: Timestamp.fromDate(state.checkpoint) }),
    ...(state.pending && {
      pending: {
        start: Timestamp.fromDate(state.pending.start),
        end: Timestamp.fromDate(state.pending.end),
        ...(state.pending.writesBegun === true && { writesBegun: true }),
      },
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
      // Counts only, like the totals: guests may read this record.
      ...(s.monitoring && { monitoring: s.monitoring }),
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
