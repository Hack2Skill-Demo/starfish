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
  /**
   * Read from the guests' trimmed copy (#18, `publicView: 1`): the run record keeps only its enumerated, numeric and hash
   * values, so a missing key says nothing about what the engine recorded.
   */
  trimmed?: true;
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
    ...(d.publicView === 1 && { trimmed: true as const }),
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

/** How far Starfish goes with the incident (triage.ts `triageLevel`), in words, when triage recorded it. */
export const LEVEL_LABELS: Record<string, string> = {
  noise: "Noise: recorded, nothing filed",
  log: "Log: an issue and an alert; a person fixes it",
  fix: "Log + fix: a verified pull request; a person merges",
  merge: "Log + fix + merge: Starfish merges it on green checks",
};

/** Triage's decision of how far to go, and the admin's merge case Gemini named for a merge. */
export function triageDecision(c: CycleRow): { label: string; mergeCase?: string; heldBy?: string } | undefined {
  const triage = c.summary.triage as { level?: unknown; mergeCase?: unknown; cap?: unknown; capBy?: unknown; capRule?: unknown } | undefined;
  const level = triage?.level;
  if (typeof level !== "string" || !(level in LEVEL_LABELS)) return undefined;
  const mergeCase = level === "merge" && typeof triage?.mergeCase === "string" && triage.mergeCase !== "" ? triage.mergeCase : undefined;
  // The rules engine's cap (src/triageRules.ts), when one applied: who held Starfish back, and to what.
  const cap = typeof triage?.cap === "string" && ["noise", "log", "fix"].includes(triage.cap) ? triage.cap : undefined;
  const heldBy =
    cap === undefined
      ? undefined
      : triage?.capBy === "rule"
        ? `Held to ${cap} by the admin's class rule${typeof triage.capRule === "string" && triage.capRule !== "" ? ` ${triage.capRule}` : ""}`
        : triage?.capBy === "correction"
          ? `Held to ${cap} by an operator's correction`
          : undefined;
  return { label: LEVEL_LABELS[level]!, ...(mergeCase !== undefined && { mergeCase }), ...(heldBy !== undefined && { heldBy }) };
}

/** The rule that chose the path, as triage recorded it, when it did. */
export function triageRule(c: CycleRow): string | undefined {
  const rule = c.summary.triage?.rule;
  return typeof rule === "string" && rule !== "" ? rule : undefined;
}

/**
 * The step log's order (#279): the step in progress first, then the finished steps from the latest back, by the time
 * each one's last event was recorded. Not the track's order reversed: a side step (the issue, the alert) is listed
 * after the track's stages but happens between them. A step with no time keeps its place after the timed ones.
 */
export function stepLogOrder(steps: Step[]): Step[] {
  const reached = steps.filter((s) => s.status !== "not-reached");
  const time = (s: Step): number => s.at?.getTime() ?? Number.NEGATIVE_INFINITY;
  return reached
    .map((step, i) => ({ step, i }))
    .sort((a, b) => Number(b.step.status === "running") - Number(a.step.status === "running") || time(b.step) - time(a.step) || b.i - a.i)
    .map((x) => x.step);
}

/**
 * What triage found, as it recorded it (`summary.triage.reason`, `suspectedCause`), and whose words they are (`by`),
 * read from the record and never assumed: the model's when triage recorded one or the rule is a `model-*` one (an
 * older run recorded the rule but not the model's name); a rule's when another rule decided, which the engine words
 * itself with no model call. A `*-cap` rule with no model recorded could be either (a cap of noise asks no model, any
 * other cap does, src/agent/loop.ts), so `by` is then left out, as it is with no rule at all. Absent until triage has
 * recorded a reason, and on a guest's trimmed copy, which never carries model text (src/publicView.ts).
 */
export function triageFinding(c: CycleRow): { reason: string; suspectedCause?: string; by?: "model" | "rule"; model?: string; rule?: string } | undefined {
  const triage = c.summary.triage;
  const reason = typeof triage?.reason === "string" ? triage.reason.trim() : "";
  if (reason === "") return undefined;
  const cause = typeof triage?.suspectedCause === "string" ? triage.suspectedCause.trim() : "";
  const model = typeof triage?.model === "string" ? triage.model.trim() : "";
  const rule = typeof triage?.rule === "string" ? triage.rule.trim() : "";
  const by = model !== "" || rule.startsWith("model-") ? "model" : rule !== "" && !rule.endsWith("-cap") ? "rule" : undefined;
  return {
    reason,
    ...(cause !== "" && { suspectedCause: cause }),
    ...(by !== undefined && { by }),
    ...(model !== "" && { model }),
    ...(by === "rule" && { rule }),
  };
}

/**
 * The issue Starfish filed for this run (`summary.issue`), once it recorded one as opened with a number and an https
 * link. A dry run and a failed filing have none; a guest's trimmed copy carries the same number and link (#18).
 */
export function issueLink(c: CycleRow): { number: number; url: string; repo?: string } | undefined {
  const issue = c.summary.issue;
  if (issue?.state !== "opened" || !isRefNumber(issue.number)) return undefined;
  const url = safeUrl(issue.url);
  if (url === undefined) return undefined;
  const repo = githubRepo(url, "issues", issue.number);
  return { number: issue.number, url, ...(repo !== undefined && { repo }) };
}

/**
 * The pull request this run opened (`summary.pr`), whenever it recorded an https link: its number when one was
 * recorded, and whether it is open, merged or closed as the engine last read it back (`summary.prState`), which picks
 * GitHub's icon for it. Never read back = no state, drawn as open.
 */
export function prLink(c: CycleRow): { url: string; number?: number; repo?: string; state?: "open" | "merged" | "closed" } | undefined {
  const pr = c.summary.pr;
  const url = safeUrl(pr?.url);
  if (url === undefined) return undefined;
  const number = isRefNumber(pr?.number) ? pr.number : undefined;
  const repo = number === undefined ? undefined : githubRepo(url, "pull", number);
  const state = c.summary.prState?.state;
  return {
    url,
    ...(number !== undefined && { number }),
    ...(repo !== undefined && { repo }),
    ...((state === "open" || state === "merged" || state === "closed") && { state }),
  };
}

const isRefNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * "owner/repo" from a link in GitHub's form (`/<owner>/<repo>/issues/<number>` or `/pull/<number>`, any host, so
 * GitHub Enterprise too), for a reference written the way GitHub writes one (`owner/repo#30`). Absent when the link is
 * not that form or names another number: the page then says only `#30`.
 */
function githubRepo(url: string, kind: "issues" | "pull", number: number): string | undefined {
  const m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)\/?$/.exec(new URL(url).pathname);
  return m && m[3] === kind && Number(m[4]) === number ? `${m[1]}/${m[2]}` : undefined;
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

/**
 * A missing-index heal that held (#38): the engine's observer (src/indexheal/observe.ts) recorded `runtime: "healed"` on
 * an index run after its quiet window. Nothing else is "healed on its own": not a merged pull request, not an index that
 * is merely READY or still under watch, and not a synthetic record (`pnpm seed-demo`), which no real run wrote.
 */
export const isHealedRun = (c: CycleRow): boolean => c.synthetic !== true && isIndexCycle(c) && c.summary.index?.runtime === "healed";

/** A narrowing of the Runs list from its URL (the Overview links here): what it shows, and the test. */
export interface RunFilter {
  /** "Showing runs that ended: Pull request opened". */
  lead: string;
  label: string;
  test: (c: CycleRow) => boolean;
}

const STATE_FILTERS: Record<string, { label: string; test: (c: CycleRow) => boolean }> = {
  "waiting-human": { label: "Waiting for a human", test: (c) => c.state === "waiting-human" },
  running: { label: "In progress, or waiting for a worker", test: (c) => c.state === "running" },
  declined: { label: "Declined", test: (c) => c.state === "declined" },
};

/**
 * `?heal=healed`, `?state=waiting-human|running` or `?path=<path>`, first match wins. The URL is untrusted: an unknown
 * value filters nothing (null), rather than showing an empty list that reads as "none".
 */
export function runFilter(params: URLSearchParams): RunFilter | null {
  if (params.get("heal") === "healed") return { lead: "Showing", label: "Missing-index heals that held through their window", test: isHealedRun };
  const state = params.get("state");
  if (state !== null && Object.hasOwn(STATE_FILTERS, state)) return { lead: "Showing runs:", ...STATE_FILTERS[state]! };
  const path = params.get("path");
  if (path !== null && Object.hasOwn(PATH_LABELS, path)) return { lead: "Showing runs that ended:", label: PATH_LABELS[path as CyclePath], test: (c) => c.path === path };
  return null;
}

/** `cycle` events are the loop's own bookkeeping (started, stopped, budget), shown as notes. */
const NOTE_STAGE = "cycle";

/**
 * `failed`: the step's last event says it went wrong in a way the run did not choose: an error, a timeout, a delivery
 * that failed. Not a judgement the step made: a verify gate that rejected a patch, a review that blocked it or a fix that
 * declined are `done`, since that is the step doing its job. A failed step was reached all the same.
 */
export type StepStatus = "done" | "failed" | "running" | "not-reached";

/** A step that has an event: done or failed. */
export const isReached = (s: Pick<Step, "status">): boolean => s.status === "done" || s.status === "failed";

/**
 * The outcomes that mean a step failed unexpectedly, per stage, as the loop writes them (src/agent/loop.ts): the fixer
 * or the reviewer that answered nothing usable (`error`), a verify that ran out of time, an issue, alert or message
 * that could not be delivered. Any other stage's `error` too. Never `failed` alone: the verify gate's `failed` is the
 * tests failing, and the "fails before" run's `failed` is the evidence it looks for.
 */
const UNEXPECTED: Record<string, readonly string[]> = {
  fix: ["error"],
  verify: ["timeout"],
  review: ["error"],
  issue: ["failed"],
  alert: ["failed"],
  notify: ["failed"],
  escalation: ["failed", "error"],
};

export function failedUnexpectedly(stage: string, outcome: string | undefined): boolean {
  if (outcome === undefined) return false;
  return (UNEXPECTED[stage] ?? ["error"]).includes(outcome);
}

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
  /**
   * A running step only: when the step before it ended (or the cycle began). The engine records a step's end, never its
   * start, so a timer counted from this reads "since the step before", not "since this step started".
   */
  since?: Date;
  /** Recorded beside the loop's own stages (the issue, the alert, telling a person...): not on the run's track. */
  side?: true;
  /**
   * A step this round did not reach that an earlier round of a reopened run did (#285): where it got then, so the track
   * does not read as though it never ran.
   */
  earlier?: EarlierStep;
  /** Position on the run's time axis, as fractions of the whole. */
  offset?: number;
  width?: number;
  /** Its last event's data, when it carried any (a guest's copy never does). */
  data?: Flat;
}

/**
 * A `cycle` note of this type: a declined cycle was reopened and its stages run again (src/agent/reconsider.ts,
 * src/agent/cycle.ts). The same cycle, so its earlier stages' events are still in its log.
 */
const REOPENED_TYPE = "reconsidered";

/** One step an earlier round of a reopened run reached: its last event in that round. */
export interface EarlierStep {
  round: number;
  stage: string;
  title: string;
  outcome?: string;
  summary?: string;
  at: Date;
  /** Its outcome is one that means it went wrong (`failedUnexpectedly`). */
  failed: boolean;
}

/** The step an earlier round of a reopened run ended on (#285), and every step it reached. */
export interface EarlierRound {
  /** 1 for the run's first round. */
  round: number;
  stage: string;
  title: string;
  outcome?: string;
  summary?: string;
  at: Date;
  /** From that round's start (the cycle's start, or the reopening before it) to the event. */
  durationMs: number;
  /** Every step the round reached, each by its last event in the round, newest first. */
  steps: EarlierStep[];
}

export interface Waterfall {
  /** The steps of the run's LATEST round: a reopened run's earlier rounds are in `earlier`, not here. */
  steps: Step[];
  notes: EventRow[];
  /** The axis: from the cycle's start (or its latest reopening) to its last update, or to now while a worker holds it. */
  startMs: number;
  endMs: number;
  /** How many rounds the run has had: 1, plus one for each time it was reopened. */
  rounds: number;
  /** The latest reopening, in the engine's own words, when there was one. */
  reopened?: { at: Date; summary: string };
  /** What each earlier round ended on, oldest first. Empty for a run never reopened. */
  earlier: EarlierRound[];
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
  // Phone escalation (#37): the calls to the on-call people when the Slack message went unacknowledged.
  escalation: "Phone the on-call",
};

export const titleOf = (stage: string): string =>
  [...KNOWN_STAGES, ...INDEX_STAGES].find((s) => s.stage === stage)?.title ?? OPTIONAL_STAGE_TITLES[stage] ?? stage;

/**
 * One row per stage that has an event, plus every known stage that has none, as "not reached", unless
 * the cycle is still running, in which case the first of them is "running". Stages the screen does not
 * know are kept, after the known ones, in the order they first appeared: a stage added to the loop
 * shows up without a change here.
 *
 * A reopened run (#285) is drawn from its latest reopening on: the steps, their times and the axis are that round's.
 * Timed from the cycle's start instead, a triage that ran four times an hour apart, seconds each, read as one step of
 * three hours, and a round in progress read as "triage done" from the round before. The earlier rounds are kept, as
 * what each ended on.
 */
export function buildWaterfall(cycle: CycleRow, events: readonly EventRow[], nowMs: number): Waterfall {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const notes = ordered.filter((e) => e.stage === NOTE_STAGE);
  const reopenings = notes.filter((n) => n.type === REOPENED_TYPE);
  const lastReopening = reopenings[reopenings.length - 1];
  const byStage = new Map<string, EventRow[]>();
  for (const e of ordered) {
    if (e.stage === NOTE_STAGE || (lastReopening && e.seq < lastReopening.seq)) continue;
    byStage.set(e.stage, [...(byStage.get(e.stage) ?? []), e]);
  }
  const createdMs = cycle.createdAt.getTime();
  const earlier: EarlierRound[] = reopenings.flatMap((reopening, r): EarlierRound[] => {
    const before = reopenings[r - 1];
    const inRound = ordered.filter((e) => e.stage !== NOTE_STAGE && e.seq < reopening.seq && (!before || e.seq > before.seq));
    const last = inRound[inRound.length - 1];
    if (!last) return [];
    const began = before ? before.at.getTime() : createdMs;
    const lastOf = new Map<string, EventRow>();
    for (const e of inRound) lastOf.set(e.stage, e);
    const steps = [...lastOf.values()]
      .sort((a, b) => b.seq - a.seq)
      .map(
        (e): EarlierStep => ({
          round: r + 1,
          stage: e.stage,
          title: titleOf(e.stage),
          ...(e.type && { outcome: e.type }),
          ...(e.summary && { summary: e.summary }),
          at: e.at,
          failed: failedUnexpectedly(e.stage, e.type),
        })
      );
    return [
      {
        round: r + 1,
        stage: last.stage,
        title: titleOf(last.stage),
        ...(last.type && { outcome: last.type }),
        ...(last.summary && { summary: last.summary }),
        at: last.at,
        durationMs: Math.max(0, last.at.getTime() - began),
        steps,
      },
    ];
  });
  // The latest earlier round that reached each stage: shown on a step this round has not reached.
  const reachedBefore = new Map<string, EarlierStep>();
  for (const round of earlier) for (const step of round.steps) reachedBefore.set(step.stage, step);

  const known: string[] = (isIndexCycle(cycle) || byStage.has("index") ? INDEX_STAGES : KNOWN_STAGES).map((s) => s.stage);
  const extra = [...byStage.keys()].filter((s) => !known.includes(s));
  const stages = [...known, ...extra];

  const status = runStatus(cycle, nowMs);
  const startMs = lastReopening ? lastReopening.at.getTime() : createdMs;
  const endMs = Math.max(status.live ? nowMs : cycle.updatedAt.getTime(), ...ordered.map((e) => e.at.getTime()), startMs + 1);
  const span = endMs - startMs;

  // Only the step right after the last one that happened can be in flight, and only while a worker holds the cycle.
  // Counted over the track's own stages only: a side stage (the issue, the alert) is listed after them, so counting it
  // would put "the step after" past the end and leave a live run with no running step.
  const lastDone = known.reduce((acc, stage, i) => (byStage.has(stage) ? i : acc), -1);
  const runningIdx = status.live && cycle.state === "running" && lastDone + 1 < known.length ? lastDone + 1 : -1;

  let previousEnd = startMs;
  const steps: Step[] = stages.map((stage, i) => {
    const evs = byStage.get(stage);
    if (!evs) {
      const before = reachedBefore.get(stage);
      return i === runningIdx
        ? { stage, title: titleOf(stage), status: "running", since: new Date(previousEnd) }
        : { stage, title: titleOf(stage), status: "not-reached", ...(before && { earlier: before }) };
    }
    const side = i >= known.length;
    const last = evs[evs.length - 1]!;
    const end = last.at.getTime();
    const from = Math.min(previousEnd, end);
    previousEnd = Math.max(previousEnd, end);
    return {
      stage,
      title: titleOf(stage),
      status: failedUnexpectedly(stage, last.type) ? "failed" : "done",
      ...(last.type && { outcome: last.type }),
      ...(last.summary && { summary: last.summary }),
      at: last.at,
      ...(Object.keys(last.data).length > 0 && { data: last.data }),
      ...(side && { side: true as const }),
      durationMs: end - from,
      offset: (from - startMs) / span,
      width: (end - from) / span,
    };
  });

  return {
    steps,
    notes,
    startMs,
    endMs,
    rounds: reopenings.length + 1,
    ...(lastReopening && { reopened: { at: lastReopening.at, summary: lastReopening.summary } }),
    earlier,
  };
}

/** The share of the timeline's axis one very long step is drawn across when the axis is shortened. */
const SHORTENED_SHARE = 0.25;

/**
 * Where a moment falls on the timeline's axis, as a fraction of its width. Linear, unless one step took more than 60%
 * of the run and something else happened too: that step is then drawn across a quarter of the axis, and the rest of the
 * run across the other three quarters, so the other steps are not hairlines beside it (a triage that waited an hour for
 * its model call and a fix of 40 s). The page says which step is drawn shortened; the times it prints are never scaled.
 */
export function timeAxis(steps: readonly Step[], startMs: number, endMs: number): { at: (ms: number) => number; shortened?: Step } {
  const span = endMs - startMs;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  if (!(span > 0)) return { at: () => 0 };
  const linear = (ms: number) => clamp((ms - startMs) / span);
  const placed = steps.filter((s) => (s.status === "done" || s.status === "failed") && s.offset !== undefined && s.width !== undefined);
  const longest = [...placed].sort((a, b) => b.width! - a.width!)[0];
  const others = steps.filter((s) => s !== longest && (s.status === "running" || placed.includes(s)));
  if (!longest || longest.width! <= 0.6 || longest.width! >= 1 || others.length === 0) return { at: linear };
  const a = startMs + longest.offset! * span;
  const b = a + longest.width! * span;
  const rest = span - (b - a);
  const share = 1 - SHORTENED_SHARE;
  return {
    shortened: longest,
    at: (ms) => {
      if (ms <= a) return clamp(((ms - startMs) / rest) * share);
      if (ms <= b) return clamp(((a - startMs) / rest) * share + ((ms - a) / (b - a)) * SHORTENED_SHARE);
      return clamp(((a - startMs) / rest) * share + SHORTENED_SHARE + ((ms - b) / rest) * share);
    },
  };
}

/** A labelled moment on the timeline's axis: where it falls, as a fraction of the axis's width, and what it reads. */
export interface AxisTick {
  at: number;
  label: string;
}

/** The steps an axis is ticked at: round seconds, minutes and hours. */
const TICK_STEPS_MS = [
  ...[1, 2, 5, 10, 15, 30].map((s) => s * 1000),
  ...[1, 2, 5, 10, 15, 30].map((m) => m * 60_000),
  ...[1, 2, 3, 6, 12, 24].map((h) => h * 3_600_000),
];
/** Ticks closer than this share of the axis are dropped, so their labels never overlap (a shortened step crowds them). */
const MIN_TICK_GAP = 0.15;

/**
 * The time axis's ticks, the way a browser's network waterfall draws them: a round step that fits at most four times in
 * the run, each tick placed by the axis itself (so on a shortened axis they sit where those moments are drawn). Labels
 * are minutes, seconds or hours from the start, the unit only on the last ("0 10 20 30 min").
 */
export function axisTicks(startMs: number, endMs: number, at: (ms: number) => number): AxisTick[] {
  const span = endMs - startMs;
  if (!(span > 0)) return [];
  const step = TICK_STEPS_MS.find((s) => span / s <= 4) ?? Math.ceil(span / 4 / 86_400_000) * 86_400_000;
  const [unitMs, unit] = step < 60_000 ? [1000, "s"] : step < 3_600_000 ? [60_000, "min"] : [3_600_000, "h"];
  const kept: { at: number; t: number }[] = [];
  for (let t = 0; t <= span; t += step) {
    const x = at(startMs + t);
    const last = kept[kept.length - 1];
    if (!last || x - last.at >= MIN_TICK_GAP) kept.push({ at: x, t });
  }
  return kept.map(({ at: x, t }, i) => ({
    at: x,
    label: i > 0 && i === kept.length - 1 ? `${t / unitMs} ${unit}` : String(t / unitMs),
  }));
}

/**
 * One sentence on where the run stands, from what the engine recorded: the step a worker is on, or the path the run
 * ended on and the last step of the run's track that has an event. Never a step the engine did not record.
 */
export function runSummary(cycle: CycleRow, steps: readonly Step[], nowMs: number): string {
  const status = runStatus(cycle, nowMs);
  const running = steps.find((s) => s.status === "running");
  if (running) return `Working on ${running.title.toLowerCase()} now.`;
  if (cycle.state === "running") return "No worker holds this run right now; the next pass picks it up.";
  const lastDone = [...steps].reverse().find((s) => isReached(s) && !s.side);
  // The step a path is named for needs no "after" (a pull request opened after the pull request step).
  const ownStep = (cycle.path === "pr" && lastDone?.stage === "pr") || (cycle.path === "index" && lastDone?.stage === "index");
  const after = lastDone && !ownStep ? ` after ${lastDone.title.toLowerCase()}${lastDone.outcome ? ` (${lastDone.outcome})` : ""}` : "";
  return `${cycle.path ? PATH_LABELS[cycle.path] : status.label}${after}.`;
}

/** One mark per stage of a run's track, for the list's small strip. */
export type TrackMark = "done" | "running" | "none";

/**
 * The list reads only the cycle document, not its events, so a stage is marked done only on direct evidence there: its
 * run record (`summary.<stage>`) or its being the last stage that wrote an event. Never filled in from the stage order,
 * so a stage that ran without a record shows as a gap. The stage after the last marked one runs only while a worker
 * holds the cycle.
 */
export function trackMarks(c: CycleRow, nowMs: number): TrackMark[] {
  const stages = (isIndexCycle(c) ? INDEX_STAGES : KNOWN_STAGES).map((s) => s.stage as string);
  const marks: TrackMark[] = stages.map((stage) => (c.summary[stage] !== undefined || c.stage === stage ? "done" : "none"));
  if (runStatus(c, nowMs).live) {
    const next = marks.lastIndexOf("done") + 1;
    if (next < marks.length) marks[next] = "running";
  }
  return marks;
}

/** One frame of a stack trace written into an error message: the function and where it is. */
export interface TraceFrame {
  fn: string;
  at: string;
  /** In a dependency (node_modules) or Node itself, not the app's own code. */
  library: boolean;
}

const FRAME_RE = /^([^\s()]+(?: \[as [^\]]+\])?) \(([^)]*)\)?$/;
const LOCATION_RE = /^(?:file:|node:|https?:|\/|[A-Za-z]:\\)\S*$/;

/**
 * An error message that carries its own stack trace ("Error: x failed at fn (file:///…) at …"), split into the message and
 * its frames, for display only. Split only when every piece after the first reads as a frame; anything else is left whole.
 */
export function splitTrace(message: string): { headline: string; frames: TraceFrame[] } {
  const parts = message.split(/\s+at\s+(?=\S)/);
  const whole = { headline: message.replace(/^Error:\s*/, ""), frames: [] };
  if (parts.length < 2) return whole;
  const frames: TraceFrame[] = [];
  for (const part of parts.slice(1)) {
    // "at async fn (file)", "at new Thing (file)", "at async /path:1:2": the keyword is kept with the function's name (#289).
    const [, prefix = "", text = ""] = /^((?:async|new) )?(.*)$/s.exec(part.trim()) ?? [];
    const m = FRAME_RE.exec(text);
    const fn = m ? `${prefix}${m[1]!}` : LOCATION_RE.test(text) ? prefix.trim() : null;
    if (fn === null) return whole;
    const at = m ? m[2]! : text;
    frames.push({ fn, at, library: /(^|\/)node_modules\//.test(at) || at.startsWith("node:") });
  }
  return { headline: parts[0]!.replace(/^Error:\s*/, ""), frames };
}

/**
 * What the "What failed" panel shows (#289): the incident's title, and its cause when the engine stored one apart from
 * it. Ingest keeps `jsonPayload.error` out of the title on purpose (the title keys the fingerprint; the error is the
 * cause), so a shop that logs "Checkout failed" with the real error beside it has a title that says nothing and a
 * detail that says everything. The frames are the title's own when it carries a trace, otherwise the detail's.
 * `hasMore`: the raw text holds something the panel does not already show, so a toggle for it is worth offering. A
 * guest's trimmed copy has no detail, and then this is the title alone.
 */
export function failureView(errorMessage: string, errorDetail?: string): { headline: string; cause?: string; frames: TraceFrame[]; raw: string; hasMore: boolean } {
  const title = splitTrace(errorMessage);
  const detailText = errorDetail?.trim() ? errorDetail : undefined;
  const detail = detailText !== undefined ? splitTrace(detailText) : undefined;
  const cause = detail && detail.headline.trim() !== "" && detail.headline.trim() !== title.headline.trim() ? detail.headline.trim() : undefined;
  const raw = detailText !== undefined && detailText.trim() !== errorMessage.trim() ? `${errorMessage}\n\n${detailText}` : errorMessage;
  return {
    headline: title.headline,
    ...(cause !== undefined && { cause }),
    frames: title.frames.length > 0 ? title.frames : (detail?.frames ?? []),
    raw,
    hasMore: raw.trim() !== title.headline.trim(),
  };
}

/** "0:07", "1:05", "1:02:09": a running timer. */
export function formatClock(ms: number): string {
  const s = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const two = (n: number) => String(n).padStart(2, "0");
  return s < 3600 ? `${Math.floor(s / 60)}:${two(s % 60)}` : `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

/** One day of the run list, by when each run was last updated, in the viewer's local time. */
export interface RunDay {
  key: string;
  /** "Today", "Yesterday", or the date ("Thursday, Oct 8"; with the year when it is not this one). */
  label: string;
  cycles: CycleRow[];
}

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** The list's runs under one heading per day, keeping the order given (the list is newest-update first). */
export function groupByDay(cycles: readonly CycleRow[], nowMs: number): RunDay[] {
  const today = new Date(nowMs);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const label = (d: Date): string => {
    const key = dayKey(d);
    if (key === dayKey(today)) return "Today";
    if (key === dayKey(yesterday)) return "Yesterday";
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
      ...(d.getFullYear() !== today.getFullYear() && { year: "numeric" as const }),
    });
  };
  const days = new Map<string, RunDay>();
  for (const c of cycles) {
    const key = dayKey(c.updatedAt);
    const day = days.get(key) ?? { key, label: label(c.updatedAt), cycles: [] };
    day.cycles.push(c);
    days.set(key, day);
  }
  return [...days.values()];
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
  const done = steps.filter(isReached).length;
  return `${done} of ${steps.length} steps recorded`;
}
