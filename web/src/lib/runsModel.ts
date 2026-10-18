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
  /**
   * When the run was reopened within the last day as the engine keeps it (`reconsideredAt`, src/agent/cycle.ts): what the
   * daily reopen limit counts (lib/retryHold.ts, #456). Absent when not recorded (a guest's trimmed copy keeps none).
   */
  reopenedAt?: number[];
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
  /**
   * The round of the run it was written in (#436): the engine stamps every event with it (src/agent/cycle.ts `roundOf`), so
   * a run whose early events are past the page read still numbers its rounds as Slack did. Absent on an older event.
   */
  round?: number;
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
    ...(Array.isArray(d.reconsideredAt) && { reopenedAt: d.reconsideredAt.map(date).filter((t): t is Date => t !== null).map((t) => t.getTime()) }),
    ...(d.synthetic === true && { synthetic: true as const }),
    ...(d.publicView === 1 && { trimmed: true as const }),
  };
}

/** An event from its document, or null when it lacks a stage, a time or a sequence number. */
export function parseEvent(id: string, d: Record<string, unknown>): EventRow | null {
  const at = date(d.at);
  const stage = str(d.stage);
  if (!at || !stage || typeof d.seq !== "number" || !Number.isInteger(d.seq)) return null;
  const round = typeof d.round === "number" && Number.isSafeInteger(d.round) && d.round > 0 ? d.round : undefined;
  return { id, seq: d.seq, stage, type: str(d.type) ?? "", summary: str(d.summary) ?? "", at, data: flat(d.data), ...(round !== undefined && { round }) };
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

export interface RecoveryView {
  /** "Recovered: deployed, and quiet through the window". */
  text: string;
  tone: RunTone;
  /** The facts behind it, one short line each: when it was deployed, the window, what was expected. */
  details: string[];
  checkedAt?: Date;
}

const UNVERIFIED_TEXT: Record<string, string> = {
  "no-deployment-environment": "Not verified: no deployment environment is configured, so Starfish cannot tell when the fix went live",
  "deploy-failed": "Not verified: the deployment of the merge failed",
  "deploy-not-observed": "Not verified: no deployment of the merge was seen",
  "deploy-unreadable": "Not verified: GitHub's deployments could not be read",
  "incident-gone": "Not verified: the incident was retired, so a return of the error would be a new incident",
  "low-traffic": "Not verified: the error was too rare before the merge for silence to show it stopped",
  "ingest-not-covering": "Not verified: ingest did not read the logs through the window",
};

/**
 * Whether a MERGED fix was deployed and the error stopped, as the engine last observed it (`summary.recovery`,
 * src/agent/recoveryStep.ts, #390). Absent unless the pull request was merged and the observer has recorded something: a
 * merge says nothing about recovery, and neither does an absent record. "Recovered" is only what the engine recorded.
 */
export function recoveryView(c: CycleRow, nowMs: number): RecoveryView | undefined {
  const pr = c.summary.prState;
  const r = c.summary.recovery;
  const checkedMs = isoMs(r?.checkedAt);
  if (pr?.state !== "merged" || !r || checkedMs === null) return undefined;
  const at = (v: unknown) => {
    const ms = isoMs(v);
    return ms === null ? undefined : ms;
  };
  const deployed = at(r.deployedAt);
  const end = at(r.windowEnd);
  const details: string[] = [];
  if (deployed !== undefined) details.push(`Deployed ${ago(deployed, nowMs)} (${new Date(deployed).toISOString()})`);
  if (end !== undefined && typeof r.windowStart === "string") details.push(`Judged from ${r.windowStart} to ${new Date(end).toISOString()}`);
  if (typeof r.expectedOccurrences === "number") details.push(`About ${Math.round(r.expectedOccurrences * 10) / 10} occurrences expected in that window at the error's rate before the merge`);
  const base = { details, checkedAt: new Date(checkedMs) };
  const reason = String(r.reason ?? "");
  switch (r.state) {
    case "awaiting-deploy":
      return { ...base, tone: "info", text: reason === "waiting-for-deployment" ? "Merged; waiting for the deployment" : "Merged; waiting" };
    case "observing":
      return { ...base, tone: "info", text: reason === "waiting-for-ingest" ? "Deployed; quiet so far, waiting for ingest to read through the window" : "Deployed; watching for the error to come back" };
    case "recovered":
      return { ...base, tone: "success", text: "Recovered: deployed, and the error stayed away for the whole window" };
    case "recurred": {
      const when = at(r.recurredAt);
      return { ...base, tone: "warning", text: `The error came back after the deployment${when !== undefined ? ` (${ago(when, nowMs)})` : ""}` };
    }
    case "unverified":
      return { ...base, tone: "neutral", text: UNVERIFIED_TEXT[reason] ?? "Not verified" };
    default:
      return undefined;
  }
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
  /** Its last event's data, when it carried any (a guest's copy never does). */
  data?: Flat;
  /**
   * Set when the stage ran more than once in this round (a block sends the fixer back for one revision: draft, gate and
   * review again): which run of the stage this is, and how many there were. The step itself is the stage's LATEST run; the
   * earlier ones are `Waterfall.attempts`.
   */
  attempt?: { n: number; of: number; /** Why this run exists, from the run before it (`attemptReason`). */ reason?: string };
}

/**
 * A `cycle` note of this type: a declined cycle (or, on an operator's retry, one that waited for a person) was reopened
 * and its stages run again (src/agent/reconsider.ts,
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
  /** Its last event's data, when it carried any (a guest's copy never does). */
  data?: Flat;
  /** Set when the stage ran more than once in that round (`Step.attempt`): which run this is, and how many there were. */
  attempt?: { n: number; of: number; /** Why this run exists, from the run before it (`attemptReason`). */ reason?: string };
}

/** An earlier round's step drawn like any other step of the log, so a reopened run keeps the first round's details. */
export function earlierAsStep(e: EarlierStep): Step {
  return {
    stage: e.stage,
    title: e.title,
    status: e.failed ? "failed" : "done",
    ...(e.outcome && { outcome: e.outcome }),
    ...(e.summary && { summary: e.summary }),
    at: e.at,
    ...(e.data && { data: e.data }),
    ...(e.attempt && { attempt: e.attempt }),
  };
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

/** The stages a review's block sends round again (one revision: src/agent/loop.ts): each may have run more than once in a round. */
export const REPEATABLE_STAGES: readonly string[] = ["fix", "verify", "review"];

/**
 * Why a repeated stage ran again, from the nearest earlier run of the loop's stages (a block, a refused gate, a failed model
 * call), in the engine's own words; nothing for a first run or one the record does not explain. Never guessed: a stage whose
 * cause is not one of these says nothing.
 */
export function attemptReason(stage: string, n: number, before: Pick<EventRow, "stage" | "type"> | undefined): string | undefined {
  if (n <= 1) return undefined;
  if (stage === "verify") return "Checks the revised draft";
  if (stage === "review") return "Reviews the revised draft";
  if (stage !== "fix" || !before) return undefined;
  if (before.stage === "review" && before.type === "block") return "Revision: the review blocked the previous draft";
  if (before.stage === "verify" && (before.type === "failed" || before.type === "rejected" || before.type === "timeout")) return "Revision: the gate did not pass the previous draft";
  if (before.stage === "fix" && before.type === "error") return "Retry: the previous model call failed";
  return undefined;
}

/** The nearest event before index `i` that is one of the repeatable stages, in a round's events in sequence order. */
const loopEventBefore = (round: readonly EventRow[], i: number): EventRow | undefined => {
  for (let k = i - 1; k >= 0; k--) if (REPEATABLE_STAGES.includes(round[k]!.stage)) return round[k];
  return undefined;
};

export interface Waterfall {
  /** The steps of the run's LATEST round: a reopened run's earlier rounds are in `earlier`, not here. */
  steps: Step[];
  /** The earlier runs of a repeatable stage in the latest round (the draft a review blocked, its gate...), oldest first. */
  attempts: Step[];
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
  // Fast revert (#9): the watch after a merge, and the revert it opens when the incident comes back.
  revert: "Fast revert",
  // Phone escalation (#37): the calls to the on-call people when the Slack message went unacknowledged.
  escalation: "Phone the on-call",
};

export const titleOf = (stage: string): string =>
  [...KNOWN_STAGES, ...INDEX_STAGES].find((s) => s.stage === stage)?.title ?? OPTIONAL_STAGE_TITLES[stage] ?? stage;

/** The run's latest reopening (#285), by sequence: its note opens the round the track draws. */
function latestReopening(events: readonly EventRow[]): EventRow | undefined {
  return events.filter((e) => e.stage === NOTE_STAGE && e.type === REOPENED_TYPE).reduce<EventRow | undefined>((a, e) => (!a || e.seq > a.seq ? e : a), undefined);
}

/**
 * When the round the track draws began: the latest reopening, else the cycle's start. A replay plays from here, so a
 * run reopened hours after its first round replays its last round's minutes, not the idle hours in between.
 */
export function roundStartMs(cycle: CycleRow, events: readonly EventRow[]): number {
  return latestReopening(events)?.at.getTime() ?? cycle.createdAt.getTime();
}

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
  const lastReopening = latestReopening(ordered);
  const byStage = new Map<string, EventRow[]>();
  for (const e of ordered) {
    if (e.stage === NOTE_STAGE || (lastReopening && e.seq < lastReopening.seq)) continue;
    byStage.set(e.stage, [...(byStage.get(e.stage) ?? []), e]);
  }
  const createdMs = cycle.createdAt.getTime();
  // A round's number is the engine's when its events carry it (#436): a run with more events than the page read has lost its
  // earliest reopenings, and counting the ones left would number the rounds from 1 again.
  const roundBefore = (reopening: EventRow, r: number) => (reopening.round !== undefined && reopening.round > 1 ? reopening.round - 1 : r + 1);
  const earlier: EarlierRound[] = reopenings.flatMap((reopening, r): EarlierRound[] => {
    const before = reopenings[r - 1];
    const inRound = ordered.filter((e) => e.stage !== NOTE_STAGE && e.seq < reopening.seq && (!before || e.seq > before.seq));
    const last = inRound[inRound.length - 1];
    if (!last) return [];
    const began = before ? before.at.getTime() : createdMs;
    const lastOf = new Map<string, EventRow>();
    const runs = new Map<string, number>();
    for (const e of inRound) {
      lastOf.set(e.stage, e);
      runs.set(e.stage, (runs.get(e.stage) ?? 0) + 1);
    }
    // One step per stage, its last event; a repeated stage (the fix, gate and review a block sends round again) keeps every
    // run, so the round reads in the order it happened.
    const seen = new Map<string, number>();
    const steps = inRound
      .filter((e) => (REPEATABLE_STAGES.includes(e.stage) && (runs.get(e.stage) ?? 0) > 1) || lastOf.get(e.stage) === e)
      .map((e): EarlierStep => {
        const repeated = REPEATABLE_STAGES.includes(e.stage) && (runs.get(e.stage) ?? 0) > 1;
        const n = (seen.get(e.stage) ?? 0) + 1;
        seen.set(e.stage, n);
        return {
          round: roundBefore(reopening, r),
          stage: e.stage,
          title: titleOf(e.stage),
          ...(e.type && { outcome: e.type }),
          ...(e.summary && { summary: e.summary }),
          at: e.at,
          failed: failedUnexpectedly(e.stage, e.type),
          ...(Object.keys(e.data).length > 0 && { data: e.data }),
          ...(repeated && (() => {
            const reason = attemptReason(e.stage, n, loopEventBefore(inRound, inRound.indexOf(e)));
            return { attempt: { n, of: runs.get(e.stage)!, ...(reason && { reason }) } };
          })()),
        };
      })
      // Newest first: `inRound` is in sequence order.
      .reverse();
    return [
      {
        round: roundBefore(reopening, r),
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
  const startMs = roundStartMs(cycle, ordered);
  const endMs = Math.max(status.live ? nowMs : cycle.updatedAt.getTime(), ...ordered.map((e) => e.at.getTime()), startMs + 1);

  // Only the step right after the last one that happened can be in flight, and only while a worker holds the cycle.
  // Counted over the track's own stages only: a side stage (the issue, the alert) is listed after them, so counting it
  // would put "the step after" past the end and leave a live run with no running step.
  const lastDone = known.reduce((acc, stage, i) => (byStage.has(stage) ? i : acc), -1);
  const runningIdx = status.live && cycle.state === "running" && lastDone + 1 < known.length ? lastDone + 1 : -1;

  // The end of the event just before `e` in this round (any stage), else the round's start: a repeated stage's own "since the
  // step before", which the stage order cannot say (a revised draft comes after the review that blocked the first one).
  const inRound = ordered.filter((e) => e.stage !== NOTE_STAGE && (!lastReopening || e.seq > lastReopening.seq));
  const sinceBefore = (e: EventRow): number => {
    const i = inRound.findIndex((x) => x.seq === e.seq);
    const prev = i > 0 ? inRound[i - 1]!.at.getTime() : startMs;
    return Math.max(0, e.at.getTime() - Math.min(prev, e.at.getTime()));
  };
  const attempts: Step[] = [];
  for (const stage of REPEATABLE_STAGES) {
    const evs = byStage.get(stage);
    if (!evs || evs.length < 2) continue;
    evs.slice(0, -1).forEach((e, k) => {
      const reason = attemptReason(stage, k + 1, loopEventBefore(inRound, inRound.indexOf(e)));
      attempts.push({
        stage,
        title: titleOf(stage),
        status: failedUnexpectedly(stage, e.type) ? "failed" : "done",
        ...(e.type && { outcome: e.type }),
        ...(e.summary && { summary: e.summary }),
        at: e.at,
        ...(Object.keys(e.data).length > 0 && { data: e.data }),
        durationMs: sinceBefore(e),
        attempt: { n: k + 1, of: evs.length, ...(reason && { reason }) },
      });
    });
  }

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
    const incompleteIndex = stage === "index" && cycle.state === "failed" && ["started", "creating", "building", "waiting"].includes(last.type ?? "");
    const end = last.at.getTime();
    const from = Math.min(previousEnd, end);
    previousEnd = Math.max(previousEnd, end);
    return {
      stage,
      title: titleOf(stage),
      status: incompleteIndex || failedUnexpectedly(stage, last.type) ? "failed" : "done",
      ...(incompleteIndex ? { outcome: "interrupted", summary: "Index recovery did not finish; READY and a passing query were not recorded." } : {
        ...(last.type && { outcome: last.type }),
        ...(last.summary && { summary: last.summary }),
      }),
      at: last.at,
      ...(Object.keys(last.data).length > 0 && { data: last.data }),
      ...(side && { side: true as const }),
      durationMs: evs.length > 1 && REPEATABLE_STAGES.includes(stage) ? sinceBefore(last) : end - from,
      ...(evs.length > 1 && REPEATABLE_STAGES.includes(stage) && (() => {
        const reason = attemptReason(stage, evs.length, loopEventBefore(inRound, inRound.indexOf(last)));
        return { attempt: { n: evs.length, of: evs.length, ...(reason && { reason }) } };
      })()),
    };
  });

  return {
    steps,
    attempts,
    notes,
    startMs,
    endMs,
    rounds: Math.max(reopenings.length + 1, ...ordered.map((e) => e.round ?? 1)),
    ...(lastReopening && { reopened: { at: lastReopening.at, summary: lastReopening.summary } }),
    earlier,
  };
}

/**
 * One sentence on where the run stands, from what the engine recorded: the step a worker is on, or the path the run
 * ended on and the last step of the run's track that has an event. Never a step the engine did not record.
 */
export function runSummary(cycle: CycleRow, steps: readonly Step[], nowMs: number, notes: readonly Pick<EventRow, "type" | "at">[] = []): string {
  const status = runStatus(cycle, nowMs);
  const running = steps.find((s) => s.status === "running");
  if (running) return `Working on ${running.title.toLowerCase()} now.`;
  if (cycle.state === "running") return "No worker holds this run right now; the next pass picks it up.";
  const lastDone = [...steps].reverse().find((s) => isReached(s) && !s.side);
  // A run stopped by its model-call budget after its last step: that is what it ended on, not that step's outcome.
  const budgetAt = notes.filter((n) => n.type === "budget").reduce((acc, n) => Math.max(acc, n.at.getTime()), 0);
  if (cycle.path && budgetAt > 0 && budgetAt >= (lastDone?.at?.getTime() ?? 0)) return `${PATH_LABELS[cycle.path]} after the model-call budget ran out.`;
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

/** How many runs one page of the Runs list shows. */
export const RUNS_PER_PAGE = 10;

export interface RunPage<T> {
  items: T[];
  /** 0-based, clamped into range: a live list that shrank, or a filter, never leaves an empty page past the end. */
  page: number;
  /** At least 1, so "page 1 of 1" holds for an empty list too. */
  pages: number;
  /** 1-based positions of the page's first and last item; 0 and 0 when the list is empty. */
  from: number;
  to: number;
}

/** One page of a list, newest first as given. A page out of range (or not a whole number) is clamped. */
export function pageOf<T>(items: readonly T[], page: number, perPage: number = RUNS_PER_PAGE): RunPage<T> {
  const size = Math.max(1, Math.floor(perPage));
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Number.isFinite(page) ? Math.min(Math.max(0, Math.floor(page)), pages - 1) : 0;
  const slice = items.slice(p * size, p * size + size);
  return { items: slice, page: p, pages, from: slice.length > 0 ? p * size + 1 : 0, to: p * size + slice.length };
}

/** The page of the list a run is on, or null when it is not in the list. */
export function pageIndexOf(ids: readonly string[], id: string, perPage: number = RUNS_PER_PAGE): number | null {
  const i = ids.indexOf(id);
  return i < 0 ? null : Math.floor(i / Math.max(1, Math.floor(perPage)));
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

/** The replay speeds a viewer can pick; "auto" plays a short run at its recorded pace and fits a long one into about a minute. */
export const REPLAY_SPEEDS = ["auto", 1, 2, 5, 10, 30, 60] as const;
export type ReplaySpeedChoice = (typeof REPLAY_SPEEDS)[number];

/** The "auto" speed: recorded pace up to a minute and a half, else fast enough to finish in about a minute. */
export function autoReplaySpeed(spanMs: number): number {
  return spanMs > 90_000 ? Math.ceil(spanMs / 60_000) : 1;
}

/** How many recorded milliseconds a replay plays per millisecond on the page. */
export function replaySpeed(choice: ReplaySpeedChoice, spanMs: number): number {
  return choice === "auto" ? autoReplaySpeed(spanMs) : choice;
}

/** A stored or selected choice read back; anything not offered is "auto". */
export function parseReplaySpeed(raw: unknown): ReplaySpeedChoice {
  if (raw === "auto") return "auto";
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return REPLAY_SPEEDS.find((s) => s === n) ?? "auto";
}

/** A speed's name in the replay menu: "10×", or "Auto (2×)" with the speed auto picks for this run. */
export function replaySpeedLabel(choice: ReplaySpeedChoice, spanMs: number): string {
  return choice === "auto" ? `Auto (${autoReplaySpeed(spanMs)}×)` : `${choice}×`;
}

/** The line under a speed in the replay menu: how long this run takes to play back at it, so nobody does the maths. */
export function replaySpeedHint(choice: ReplaySpeedChoice, spanMs: number): string {
  const takes = formatDuration(spanMs / replaySpeed(choice, spanMs));
  if (choice === "auto") return `Recorded pace; a long run fits in about a minute. This run: ${takes}.`;
  return choice === 1 ? `As it happened: ${takes}.` : `This run in ${takes}.`;
}
