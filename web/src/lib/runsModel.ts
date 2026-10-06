/**
 * The agent's cycles as the Live runs screen shows them, and the pure logic that turns a cycle and its
 * events into a waterfall. Reads nothing: runs.ts subscribes, this file only parses and judges, so
 * every rule here is testable without Firestore.
 *
 * The engine writes a cycle document and an append-only list of events (src/agent/cycle.ts), the
 * loop's own stages being triage, fix, verify, review and pr (src/agent/loop.ts). An event is the
 * proof that a step happened. A step with no event is "not reached": the screen never fills a step in
 * from the stage order, so a partial run reads as partial.
 */

/** Mirrors CycleState in src/agent/cycle.ts. */
export type CycleState = "running" | "waiting-human" | "done" | "declined" | "failed";
const CYCLE_STATES: readonly string[] = ["running", "waiting-human", "done", "declined", "failed"];

/** Mirrors CyclePath in src/agent/cycle.ts. */
export type CyclePath = "decline" | "notify" | "draft" | "pr" | "human" | "failed" | "index";
const CYCLE_PATHS: readonly string[] = ["decline", "notify", "draft", "pr", "human", "failed", "index"];

type Flat = Record<string, string | number | boolean | null>;

export interface CycleRow {
  id: string;
  incidentId: string;
  environment: string;
  recurrence: number;
  state: CycleState;
  /** The last stage that wrote an event. */
  stage?: string;
  path?: CyclePath;
  outcome?: string;
  attempts: number;
  eventCount: number;
  createdAt: Date;
  updatedAt: Date;
  /** Null when no worker holds the cycle. */
  leaseExpiresAt: Date | null;
  deadlineAt: Date | null;
  /** The run record: `summary.<stage>` as the stages stored it. */
  summary: Record<string, Flat>;
  /** Written by `pnpm seed-demo` (src/seedDemo.ts), not by any real run: the UI must say so wherever it shows it. */
  synthetic?: true;
}

export interface EventRow {
  id: string;
  seq: number;
  stage: string;
  type: string;
  summary: string;
  at: Date;
  data: Flat;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function date(v: unknown): Date | null {
  const d = (v as { toDate?: () => Date } | null | undefined)?.toDate?.();
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}

function flat(v: unknown): Flat {
  const out: Flat = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === "string" || typeof x === "boolean" || x === null || (typeof x === "number" && Number.isFinite(x))) out[k] = x;
  }
  return out;
}

/** A cycle from its document, or null when it lacks what the screen cannot do without (never throws). */
export function parseCycle(id: string, d: Record<string, unknown>): CycleRow | null {
  const createdAt = date(d.createdAt);
  const updatedAt = date(d.updatedAt);
  const incidentId = str(d.incidentId);
  if (!createdAt || !updatedAt || !incidentId || typeof d.state !== "string" || !CYCLE_STATES.includes(d.state)) return null;
  const summary: Record<string, Flat> = {};
  if (typeof d.summary === "object" && d.summary !== null && !Array.isArray(d.summary)) {
    for (const [stage, record] of Object.entries(d.summary)) summary[stage] = flat(record);
  }
  return {
    id,
    incidentId,
    environment: str(d.environment) ?? "",
    recurrence: typeof d.recurrence === "number" ? d.recurrence : 0,
    state: d.state as CycleState,
    ...(str(d.stage) && { stage: str(d.stage) }),
    ...(typeof d.path === "string" && CYCLE_PATHS.includes(d.path) && { path: d.path as CyclePath }),
    ...(str(d.outcome) && { outcome: str(d.outcome) }),
    attempts: typeof d.attempts === "number" ? d.attempts : 1,
    eventCount: typeof d.eventCount === "number" ? d.eventCount : 0,
    createdAt,
    updatedAt,
    leaseExpiresAt: date(d.leaseExpiresAt),
    deadlineAt: date(d.deadlineAt),
    summary,
    ...(d.synthetic === true && { synthetic: true as const }),
  };
}

/** An event from its document, or null when it lacks a stage, a time or a sequence number. */
export function parseEvent(id: string, d: Record<string, unknown>): EventRow | null {
  const at = date(d.at);
  const stage = str(d.stage);
  if (!at || !stage || typeof d.seq !== "number" || !Number.isInteger(d.seq)) return null;
  return { id, seq: d.seq, stage, type: str(d.type) ?? "", summary: str(d.summary) ?? "", at, data: flat(d.data) };
}

// ---- Run state ---------------------------------------------------------------------------------

export type RunTone = "info" | "success" | "warning" | "error" | "neutral";

export interface RunStatus {
  label: string;
  tone: RunTone;
  /** A worker holds the cycle right now. */
  live: boolean;
}

/**
 * How a cycle reads in the list. A cycle marked running whose lease has run out is not live: no
 * worker is on it, and saying "in progress" would be a claim the data does not support.
 */
export function runStatus(c: CycleRow, nowMs: number): RunStatus {
  switch (c.state) {
    case "running": {
      const live = c.leaseExpiresAt !== null && c.leaseExpiresAt.getTime() > nowMs;
      return live
        ? { label: "In progress", tone: "info", live: true }
        : { label: "Waiting for a worker", tone: "warning", live: false };
    }
    case "waiting-human":
      return { label: "Waiting for a human", tone: "warning", live: false };
    case "done":
      return { label: "Done", tone: "success", live: false };
    case "declined":
      return { label: "Declined", tone: "neutral", live: false };
    case "failed":
      return c.outcome === "deadline-passed"
        ? { label: "Timed out", tone: "error", live: false }
        : { label: "Failed", tone: "error", live: false };
  }
}

/** What the cycle ended in, in the words of the loop's own paths. */
export const PATH_LABELS: Record<CyclePath, string> = {
  decline: "Declined: no fix attempted",
  notify: "A person is told",
  draft: "Fix drafted, nothing opened (dry run)",
  pr: "Pull request opened",
  human: "Handed to a person",
  failed: "Failed",
  index: "Missing index: READY, evidence recorded",
};

/** The rule that chose the path, as triage recorded it, when it did. */
export function triageRule(c: CycleRow): string | undefined {
  const rule = c.summary.triage?.rule;
  return typeof rule === "string" && rule !== "" ? rule : undefined;
}

/** A link is shown only if it is an https URL: the record is written by the engine, but it is still data. */
export function safeUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

// ---- The pull request afterwards (#17) ----------------------------------------------------------

/** "just now", "5 min ago", "2h ago", "3d ago": short, for one line. */
export function ago(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

const isoMs = (v: unknown): number | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);

const CHECKS_TEXT: Record<string, string> = {
  passed: "checks passed",
  failed: "checks failed",
  pending: "checks still running",
  missing: "checks not reported",
  "not-configured": "no required checks named",
};

export interface PrStateView {
  /** "merged 2h ago · checks passed". */
  text: string;
  tone: RunTone;
  /** When GitHub was last read, or absent when it never was. */
  checkedAt?: Date;
}

/**
 * What the pull request a cycle opened looks like now, as the engine last read it back from GitHub
 * (`summary.prState`, src/agent/reconcile.ts). Absent for a cycle that opened none. A PR never read back says
 * so, rather than guessing it is still open; a merge says nothing about the incident being healed.
 */
export function prStateView(c: CycleRow, nowMs: number): PrStateView | undefined {
  if (c.summary.pr?.opened !== true) return undefined;
  const s = c.summary.prState;
  const checkedMs = isoMs(s?.checkedAt);
  if (!s || checkedMs === null || !["open", "closed", "merged"].includes(String(s.state))) {
    return { text: "Not checked since it was opened", tone: "neutral" };
  }
  const at = (v: unknown) => {
    const ms = isoMs(v);
    return ms === null ? "" : ` ${ago(ms, nowMs)}`;
  };
  const state = s.state === "merged" ? `merged${at(s.mergedAt)}` : s.state === "closed" ? `closed without merging${at(s.closedAt)}` : "open";
  const failed = typeof s.failedChecks === "string" && s.failedChecks !== "" ? ` (${s.failedChecks})` : "";
  const checks = `${CHECKS_TEXT[String(s.checks)] ?? "checks unknown"}${s.checks === "failed" ? failed : ""}`;
  const tone: RunTone = s.checks === "failed" ? "warning" : s.state === "merged" ? "success" : s.state === "closed" ? "neutral" : "info";
  return { text: `${state} · ${checks}`, tone, checkedAt: new Date(checkedMs) };
}

// ---- Waterfall ---------------------------------------------------------------------------------

/** The stages the loop runs, in order, with the words the screen uses for them. */
export const KNOWN_STAGES = [
  { stage: "triage", title: "Triage" },
  { stage: "fix", title: "Draft a fix" },
  { stage: "verify", title: "Verify gate" },
  { stage: "review", title: "Adversarial review" },
  { stage: "pr", title: "Pull request" },
] as const;

/**
 * The stages of the missing-index path (#11, src/agent/indexPath.ts): no triage, draft, verify or review, so a cycle on
 * that path does not show those as "not reached".
 */
export const INDEX_STAGES = [
  { stage: "index", title: "Missing index" },
  { stage: "pr", title: "Pull request" },
] as const;

/** Whether a cycle took the missing-index path: its path says so, or it recorded the index stage. */
export const isIndexCycle = (c: CycleRow): boolean => c.path === "index" || c.summary.index !== undefined;

const RUNTIME_TEXT: Record<string, { text: string; tone: RunTone }> = {
  observing: { text: "READY and the query passes; watching for a recurrence", tone: "info" },
  healed: { text: "Healed: quiet through the window, and the query passes", tone: "success" },
  recurred: { text: "Recurred after the index was READY", tone: "warning" },
  "query-failing": { text: "Quiet, but the query no longer passes", tone: "warning" },
  unverified: { text: "Not verified: the query could not be replayed", tone: "neutral" },
};

/**
 * Where a missing-index heal stands at runtime (`summary.index.runtime`), apart from its pull request: absent until the
 * index was READY and the configured query passed. "Healed" is only ever what the engine recorded after the window.
 */
export function indexRuntimeView(c: CycleRow): { text: string; tone: RunTone; until?: Date } | undefined {
  const r = c.summary.index;
  const known = r && typeof r.runtime === "string" ? RUNTIME_TEXT[r.runtime] : undefined;
  if (!r || !known) return undefined;
  const until = typeof r.observeUntil === "string" && Number.isFinite(Date.parse(r.observeUntil)) ? new Date(r.observeUntil) : undefined;
  return { ...known, ...(r.runtime === "observing" && until && { until }) };
}

/** `cycle` events are the loop's own bookkeeping (started, stopped, budget), shown as notes. */
const NOTE_STAGE = "cycle";

export type StepStatus = "done" | "running" | "not-reached";

export interface Step {
  stage: string;
  title: string;
  status: StepStatus;
  /** What the step's last event said happened ("proposed", "declined", "passed"...). */
  outcome?: string;
  summary?: string;
  /** Where the step ended: the time of its last event. */
  at?: Date;
  /** Time since the step before it ended (or the cycle began): an event marks an end, not a start. */
  durationMs?: number;
  /** Position on the run's time axis, as fractions of the whole. */
  offset?: number;
  width?: number;
}

export interface Waterfall {
  steps: Step[];
  notes: EventRow[];
  /** The axis: from the cycle's start to its last update, or to now while a worker holds it. */
  startMs: number;
  endMs: number;
}

/**
 * Stages that appear only on some cycles (a cycle Starfish acts on or escalates files an issue and alerts the team, one that ends waiting for a person tells one, #17), so they are not in
 * KNOWN_STAGES, which would show every cycle a "not reached" row for them. They get a readable title when present.
 */
const OPTIONAL_STAGE_TITLES: Record<string, string> = {
  issue: "GitHub issue",
  alert: "Alert the team",
  notify: "Tell a person",
  // Auto-merge (#9): the patch's tests alone on the base revision, and the merge candidate.
  before: "Test before the fix",
  merge: "Auto-merge",
};

const titleOf = (stage: string): string =>
  [...KNOWN_STAGES, ...INDEX_STAGES].find((s) => s.stage === stage)?.title ?? OPTIONAL_STAGE_TITLES[stage] ?? stage;

/**
 * One row per stage that has an event, plus every known stage that has none, as "not reached", unless
 * the cycle is still running, in which case the first of them is "running". Stages the screen does not
 * know are kept, after the known ones, in the order they first appeared: a stage added to the loop
 * shows up without a change here.
 */
export function buildWaterfall(cycle: CycleRow, events: readonly EventRow[], nowMs: number): Waterfall {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const notes = ordered.filter((e) => e.stage === NOTE_STAGE);
  const byStage = new Map<string, EventRow[]>();
  for (const e of ordered) {
    if (e.stage === NOTE_STAGE) continue;
    byStage.set(e.stage, [...(byStage.get(e.stage) ?? []), e]);
  }

  const known: string[] = (isIndexCycle(cycle) || byStage.has("index") ? INDEX_STAGES : KNOWN_STAGES).map((s) => s.stage);
  const extra = [...byStage.keys()].filter((s) => !known.includes(s));
  const stages = [...known, ...extra];

  const status = runStatus(cycle, nowMs);
  const startMs = cycle.createdAt.getTime();
  const endMs = Math.max(status.live ? nowMs : cycle.updatedAt.getTime(), ...ordered.map((e) => e.at.getTime()), startMs + 1);
  const span = endMs - startMs;

  // Only the step right after the last one that happened can be in flight, and only while a worker holds the cycle.
  const lastDone = stages.reduce((acc, stage, i) => (byStage.has(stage) ? i : acc), -1);
  const runningIdx = status.live && cycle.state === "running" && lastDone + 1 < known.length ? lastDone + 1 : -1;

  let previousEnd = startMs;
  const steps: Step[] = stages.map((stage, i) => {
    const evs = byStage.get(stage);
    if (!evs) return { stage, title: titleOf(stage), status: i === runningIdx ? "running" : "not-reached" };
    const last = evs[evs.length - 1]!;
    const end = last.at.getTime();
    const from = Math.min(previousEnd, end);
    previousEnd = Math.max(previousEnd, end);
    return {
      stage,
      title: titleOf(stage),
      status: "done",
      ...(last.type && { outcome: last.type }),
      ...(last.summary && { summary: last.summary }),
      at: last.at,
      durationMs: end - from,
      offset: (from - startMs) / span,
      width: (end - from) / span,
    };
  });

  return { steps, notes, startMs, endMs };
}

/** "850 ms", "12 s", "3 min 5 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * "3 of 5 steps recorded": the run header's progress (#33). Counts only steps with an event, out of the loop's
 * stages plus any optional ones this run recorded; a step in flight or never reached is not counted as done.
 */
export function progressText(steps: readonly Pick<Step, "status">[]): string {
  const done = steps.filter((s) => s.status === "done").length;
  return `${done} of ${steps.length} steps recorded`;
}
