/**
 * The agent loop (#8): one cycle for one incident, from lease to pull request.
 *
 *   lease -> triage -> fixer -> verify gate -> adversarial review -> pull request
 *
 * It owns no judgment. Each stage is its own tested function (triage.ts, fixer.ts, verifyGate.ts,
 * reviewer.ts); this file orders them, and wraps them in the guarantees that make running them
 * unattended safe:
 *
 *   - ONE WORKER. The cycle is leased (cycle.ts). Every event and the final state are written under
 *     that lease, so a worker that lost it stops at once and can record or open nothing.
 *   - KEPT ALIVE. The lease is renewed about every third of its length while the cycle works, and before verify;
 *     the verifiers that wait call a heartbeat on every poll, which stops them once the lease is lost (#132).
 *   - RECHECKED BEFORE ACTING. Before each stage, before the issue is filed, before verify, before a person is told, and
 *     again before the pull request, the incident's status is read fresh and the automation switch is asked: an operator
 *     who resolved or ignored the incident settles the cycle at the next step; automation turned off releases it,
 *     uncounted, to be taken up again when it is back on (#133). A cycle that would wait for a person, or whose open pull
 *     request a person must decide on, is never settled with nobody told because the switch went off (#180, #412).
 *   - BOUNDED. At most `modelCallBudget` model calls (a used-up budget goes to a person; a triage decided by a
 *     deterministic gate costs none); at most ONE revision, shared between a failed
 *     verify and a blocking review (a second failure goes to a person). Both are counted on the cycle, not the attempt
 *     (cycle.ts `countSpend`, #182), so a resumed attempt goes on from what earlier ones spent, and keeps the round's
 *     triage decision rather than asking for it again (`keptTriage`, #414); the cycle's own deadline and
 *     attempt cap (cycle.ts) bound the rest, and a person is told when either gives a cycle up. A failure
 *     worth retrying (a missing counter-check, a model call that failed) releases the lease so the next run
 *     tries again, counted against the cap; a patch unfit to verify goes to a person.
 *   - ONE PULL REQUEST. An attempt that finds one already opened for its cycle (recorded, or found by the
 *     opener) records it and stops (#134).
 *   - DRY RUN BY DEFAULT. With `dryRun` (the default) or no opener, a verified, reviewed patch ends the
 *     cycle waiting for a person and nothing is opened. Opening is an interface (`openPullRequest`)
 *     keyed by the cycle id so a retry after a timeout cannot open a second one; the loop itself never merges
 *     and never deploys.
 *   - HOW FAR TO GO is triage's decision (triage.ts `triageLevel`): decline (noise), notify (log), act (log + fix), or
 *     act with one of the admin's merge cases (log + fix + merge). The cases are passed to triage from the config.
 *   - AUTO-MERGE EVIDENCE (#9). Only where Gemini named a merge case and auto-merge could apply to it right now
 *     (`autoMergeAllowed(case)`, dry run off), the loop runs the safety floor on the proposed patch (blastRadius.ts
 *     `assessMergeFloor`) with the changed file's content read from the base checkout (`readBaseFiles`), and, when it
 *     passes, runs the patch's TESTS ALONE (new test files only) on the base revision through the same verifier, so the
 *     run record shows whether the test failed before the fix (`summary.before`, reported in the evidence, not
 *     required). When it opens the pull request it records the candidate (`summary.merge`, with the case); merging is
 *     the agent pass's separate step (autoMerge.ts). A candidate that fails the floor is handed to a person at once.
 *     Nothing is prepared while an earlier Starfish merge for the same incident is still watched, or was reverted
 *     (#240): the pull request is recorded as not auto-merged and a person is told.
 *
 * Infrastructure errors (the store, the opener) throw, as in cycle.ts: a worker that cannot reach what it
 * needs must not carry on. The lease then expires and the cycle is resumed.
 *
 * Events hold rule names, counts and hashes, never the patch, a log line or model text beyond the
 * short redacted reasons the stages already produce. Run by the agent job (`pnpm agent`), and not on the Agent
 * Development Kit: the stage ordering here is plain code, which an ADK workflow can wrap.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import type { IncidentStatus, LogCounterCheck } from "../types.js";
import { OPEN_INCIDENT_STATUSES } from "../types.js";
import { clipWellFormed } from "../ingest/redact.js";
import {
  acquireLease,
  countSpend,
  cycleId,
  finishCycle,
  giveUpStranded,
  recordEvent,
  releaseLease,
  renewLease,
  roundOf,
  updateSettledCycle,
  type CycleConfig,
  LONG_VALUE_KEYS,
  type CycleKey,
  type CyclePath,
  type CycleState,
  type DeclineDecision,
  type RunEvent,
} from "./cycle.js";
import type { IssueRequest, IssueResult } from "../integrations/githubPr.js";
import type { AlertRequest, DeliveryResult, NotifyRequest } from "../integrations/slack.js";
import { proposeFix, reviewFeedback, verifyFeedback, type FixRequest, type FixResult, type RevisionFeedback, type SourceFile } from "./fixer.js";
export { REVISION_SCOPE } from "./fixer.js";
import { reviewPatch, type Attack, type ReviewResult, type ReviewVerdict } from "./reviewer.js";
import { triageIncident, triageLevel, type AskJson, type TriageDecision, type TriageOptions, type TriageResult, type TriageRule, type TriageSubject } from "./triage.js";
import { verifyPatch, type VerifyConfig, type VerifyRequest, type VerifyResult } from "./verifyGate.js";
import { causeClass, type ReconsiderPolicy } from "./reconsider.js";
import { isIndexIncident, runIndexPath, type IndexHealWiring } from "./indexPath.js";
import { linkFromEvent, linkIncident } from "./incidentLinks.js";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { assessMergeFloor, judgedTheVerifiedFiles, parsePatch, testOnlyPatch, type BlastRadius } from "./blastRadius.js";
import { earlierMergeHolds, mergeRecordAtOpen } from "./autoMerge.js";
import { INDEX_MERGE_CASE } from "../settingsSchema.js";
import { capHolds, isCapLevel, levelCap, type LevelCap } from "../triageRules.js";
import { sha256 } from "./reviewer.js";
import type { SourceProvenance } from "./sourceByName.js";

/** Everything about the incident the stages need, assembled by the caller (it owns the repo checkout). */
export interface LoopSubject {
  subject: TriageSubject;
  /** The files shown to the fixer and the reviewer. */
  files: SourceFile[];
  /** Which rule found `files` (#259): recorded on the run record as `summary.fix.source`. Absent: not known. */
  source?: SourceProvenance;
  /** A checkout of the target repo at `baseRevision`, never modified. */
  sourceDir: string;
  baseRevision: string;
  /**
   * Every file of that checkout, as the stack trace was matched against (assemble.ts): gate 2's structural cause is
   * judged against the same list (#203). Absent: no stack frame can tie the cause to the changed file.
   */
  repoFiles?: readonly string[];
}

export interface PullRequestRequest {
  /** Idempotency key: the same cycle must never produce two pull requests. */
  cycleId: string;
  incidentId: string;
  baseRevision: string;
  patch: string;
  patchSha256: string;
  rootCause: string;
  risk: string;
  /** The verify gate's result for a code fix. Absent for the index path's evidence PR, which has `index` instead. */
  verify?: Pick<VerifyResult, "status" | "rule" | "changedFiles" | "output">;
  /** The incident's GitHub issue, when one was filed (#17): the pull request then says it closes it. */
  issueNumber?: number;
  review?: { verdict: ReviewVerdict; attacks: Attack[] };
  /** Auto-merge could apply to this pull request (#9): its text then says Starfish may merge it itself. */
  autoMerge?: boolean;
  /**
   * Set for the missing-index heal's evidence pull request (#11): the index that already exists in production and the
   * entry the patch adds to the repository's index file. The body is then a fixed template (no model text).
   */
  index?: IndexEvidence;
}

export interface IndexEvidence {
  project: string;
  database: string;
  collectionGroup: string;
  queryScope: string;
  fields: { fieldPath: string; order: string }[];
  /** True when this cycle created the index; false when it was found already there (and is only recorded). */
  created: boolean;
  operation?: string;
  /** The repository's index file, and whether the patch creates it. */
  indexFile: string;
  fileCreated: boolean;
  /** When the index was READY and the configured query passed again (ISO). */
  readyAt: string;
}

export interface LoopDeps {
  db: Firestore;
  config: Pick<StarfishConfig, "dryRun" | "reviewRequired" | "modelCallBudget" | "uiBaseUrl" | "model" | "incidentCollection" | "autoMergeExcludedPaths" | "mergeCases" | "classRules" | "verifyIsolation"> &
    CycleConfig &
    VerifyConfig;
  /** This worker's identity, for the lease. */
  owner: string;
  now: () => Date;
  /**
   * The model client, bound to the same snapshot as `config` (`createAskJson` in vertex.ts). Required, so a cycle
   * can't fall back to the environment's model and region and record `config.model` for a call it didn't make (#7).
   */
  ask: AskJson;
  load: (incidentId: string) => Promise<LoopSubject | null>;
  /** The incident's status right now, read fresh. null if it is gone. */
  incidentStatus: (incidentId: string) => Promise<IncidentStatus | null>;
  /** The kill switch, asked before each stage and before anything is opened. */
  automationEnabled: () => Promise<boolean>;
  /**
   * Where the verify command runs. Absent: `verifyPatch`, in THIS process (the `in-process` isolation). The agent
   * entrypoint passes a remote verifier for `cloud-run-job` (verifyRemote.ts), so this process never runs the
   * target's code. A failure of the infrastructure throws; a command that failed is a result.
   */
  verify?: (req: VerifyRequest) => Promise<VerifyResult>;
  /** Opens (or finds, by `cycleId`) the pull request. Absent means nothing can be opened. */
  openPullRequest?: (req: PullRequestRequest) => Promise<{ number: number; url: string; headSha?: string }>;
  /**
   * Auto-merge (#9): whether it could apply to this deployment's target right now, read fresh (the switches in
   * autoMerge.ts `mergeBlockedBy`); with a merge case, that the case is still listed too. Absent, or false: nothing about
   * merging is prepared and the pull request is the end.
   */
  autoMergeAllowed?: (mergeCase?: string) => Promise<boolean>;
  /**
   * The pull request this cycle already opened, or null (#134). Asked once at the start of an attempt that has none
   * recorded, so an attempt resumed after the open succeeded but its record did not stops there instead of redoing
   * the work. Absent: only the recorded `summary.pr` is consulted.
   */
  findPullRequest?: (cycleId: string) => Promise<{ number: number; url: string } | null>;
  /**
   * Files (or finds, by `cycleId`) the incident's GitHub issue (#17). Absent means none is filed. A failure is recorded
   * on the cycle and the cycle goes on: the issue is the incident's history, not a step the fix depends on. In a dry run
   * nothing is filed and the record says so.
   */
  openIssue?: (req: IssueRequest) => Promise<IssueResult>;
  /**
   * Tells a person (Slack, src/integrations/slack.ts) that this cycle needs them. Absent means nobody is told. It
   * never throws: a failed delivery is a result, recorded on the cycle (`summary.notify`) so it is visible. In a dry
   * run nothing is sent and the record says so.
   */
  notify?: (req: NotifyRequest) => Promise<DeliveryResult>;
  /**
   * Posts the "new incident" message (the `#ops-alerts` channel, src/integrations/slack.ts) once for a cycle Starfish
   * acts on or escalates. Absent means no such channel. Never throws; recorded like `notify` (`summary.alert`); in a
   * dry run nothing is sent and the record says so.
   */
  alert?: (req: AlertRequest) => Promise<DeliveryResult>;
  /**
   * Reconsider a declined cycle when new evidence arrived since its decision (#8, reconsider.ts): the lease acquire
   * reopens it in its own transaction. Absent: a declined cycle stays closed.
   */
  reconsider?: ReconsiderPolicy;
  /**
   * The missing-index heal (#11, indexPath.ts). Present: a `MissingIndexError` incident skips triage and the model and
   * takes the index path. Absent (the default, and whenever no index target is allowed): it is triaged like any other.
   */
  indexHeal?: IndexHealWiring;
}

export type LoopResult =
  | { kind: "not-acquired"; reason: string }
  | { kind: "lease-lost" }
  | { kind: "released"; reason: string }
  | { kind: "finished"; state: Exclude<CycleState, "running">; outcome: string };

/** What a message to a person says about the incident: from the loaded subject, or the stored incident. */
type IncidentFacts = Pick<NotifyRequest, "functionName" | "service" | "errorType" | "occurrenceCount">;

function factsOf(loaded: LoopSubject): IncidentFacts {
  const incident = loaded.subject.incident;
  return {
    functionName: incident.functionName ?? "unknown function",
    service: incident.service ?? "unknown",
    errorType: incident.errorType ?? "unknown",
    occurrenceCount: incident.occurrenceCount ?? null,
  };
}

/** The same facts read from the store, for a message sent without the incident loaded. Never a count it does not have. */
async function storedIncidentFacts(deps: Pick<LoopDeps, "db" | "config">, incidentId: string): Promise<IncidentFacts> {
  const incident = (await deps.db.collection(deps.config.incidentCollection).doc(incidentId).get()).data() ?? {};
  const text = (v: unknown, fallback: string) => (typeof v === "string" && v !== "" ? v : fallback);
  return {
    functionName: text(incident.functionName, "unknown function"),
    service: text(incident.service, "unknown"),
    errorType: text(incident.errorType, "unknown"),
    occurrenceCount: typeof incident.occurrenceCount === "number" && Number.isFinite(incident.occurrenceCount) ? incident.occurrenceCount : null,
  };
}

/** Thrown inside the loop when a fenced write is refused; turned into `lease-lost` at the top. */
class LeaseLost extends Error {}

/** How many revisions one cycle may make, shared between a failed verify and a blocking review. */
export const MAX_REVISIONS = 1;

const RECONSIDER_SUMMARY = {
  operator: "an operator asked for a retriage",
  corrected: "an operator corrected the incident to a level above noise",
  burst: "the occurrences grew past the burst threshold since the decline",
  cause: "the incident's structural cause changed since the decline",
  reopened: "the incident was closed while it was worked on, and has been reopened",
} as const;

/** A Slack message's retry wording: present from a run's second round on (`NotifyRequest`/`AlertRequest`). */
type RetryWords = { round?: number; retriedBecause?: string };

/** Which round of its run a cycle is in: cycle.ts's one definition, re-exported for the loop's tests. */
export { roundOf };

/** The retry wording for a round: nothing for round 1; the round, and why it was reopened in Starfish's own words. */
export function retryWords(round: number, trigger: unknown): RetryWords {
  if (round <= 1) return {};
  const because = typeof trigger === "string" && Object.hasOwn(RECONSIDER_SUMMARY, trigger) ? RECONSIDER_SUMMARY[trigger as keyof typeof RECONSIDER_SUMMARY] : undefined;
  return { round, ...(because !== undefined && { retriedBecause: because }) };
}

/**
 * The stage failures a later attempt may do better at (#418), the same for all three model stages: the model call failed
 * or timed out, its answer could not be read, or the review listed no attacks. They release the cycle for a retry,
 * counted against its attempts. Every other stage failure goes to a person now: a patch unfit to verify (malformed, too
 * large, credential-shaped) is the model's considered answer (#137); an answer cut at the output limit or stopped by a
 * filter would be cut or stopped again at temperature 0; and a review refused for its evidence is Starfish's own error,
 * which no retry corrects.
 */
export const RETRYABLE_STAGE_RULES: ReadonlySet<string> = new Set(["model-call-failed", "model-output-invalid", "review-empty"]);

export function releasesForRetry(rule: string): boolean {
  return RETRYABLE_STAGE_RULES.has(rule);
}

/*
 * What the loop does after each stage, as pure decisions, so the replay harness (scoreboard/replay.ts) takes exactly the
 * loop's path through the same stages (#420): it had its own copy of the revision loop, and drifted from it.
 */

/** What triage is given: the admin's merge cases and class rules, and the files the fixer will be shown (#371). */
export function triageOptionsFor(cfg: Pick<StarfishConfig, "mergeCases" | "classRules">, files: readonly SourceFile[]): TriageOptions {
  return { mergeCases: cfg.mergeCases, classRules: cfg.classRules, source: { files } };
}

/** The decisions an attempt resumed within the round keeps (#414): the ones that settle where the round goes. */
const KEPT_DECISIONS: ReadonlySet<TriageDecision> = new Set(["act", "notify", "decline"]);

/**
 * This round's triage decision, read back from the run record (`summary.triage`), for an attempt resumed within the same
 * round (#414), or null to ask the model again. Triage asked once per round: on the demo (2026-10-18) a fix call that
 * failed released the cycle, the resumed attempt triaged again, and that second call for a decision already made left the
 * round one call short of its second review and a pull request, two rounds running. Asking again could also contradict
 * the issue and the alert the first decision sent.
 *
 * Kept only when the record is this round's (`round`, written with it; a record without one is asked again), is a
 * decision that settles the round (act, notify, decline: a deferred or failed triage released the cycle so it is asked
 * again), and the rules engine's cap NOW does not hold it back: an operator's correction or an admin's class rule made
 * since is honoured by asking again (the rules engine only ever holds Starfish back). The reason is the record's, bounded
 * as every record value is.
 */
export function keptTriage(record: unknown, round: number, cap: LevelCap | null): TriageResult | null {
  if (typeof record !== "object" || record === null) return null;
  const r = record as Record<string, unknown>;
  if (r.round !== round) return null;
  if (typeof r.decision !== "string" || !KEPT_DECISIONS.has(r.decision as TriageDecision)) return null;
  if (typeof r.rule !== "string" || r.rule === "" || typeof r.reason !== "string") return null;
  const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const decision = r.decision as TriageDecision;
  const mergeCase = decision === "act" ? text(r.mergeCase) : undefined;
  const recordedCap: LevelCap | undefined =
    isCapLevel(r.cap) && (r.capBy === "rule" || r.capBy === "correction")
      ? { level: r.cap, by: r.capBy, ...(text(r.capRule) !== undefined && { ruleId: text(r.capRule) }) }
      : undefined;
  const kept: TriageResult = {
    decision,
    rule: r.rule as TriageRule,
    reason: r.reason,
    ...(text(r.suspectedCause) !== undefined && { suspectedCause: text(r.suspectedCause) }),
    ...(mergeCase !== undefined && { mergeCase }),
    ...(recordedCap && { cap: recordedCap }),
  };
  const level = triageLevel(kept);
  return level !== null && capHolds(cap, level) ? null : kept;
}

/** Where a stage's result sends the cycle, other than on: round again with feedback, released for a retry, or to a person. */
export type Revise = { next: "revise"; feedback: RevisionFeedback };
export type Retry = { next: "retry"; rule: string };
export type ToPerson = { next: "person"; rule: string; reason: string };

/** After the fixer: a proposed patch goes to verify; a failure worth retrying is released; anything else is a person's. */
export function afterFix(fix: FixResult): { next: "verify"; patch: string } | Retry | ToPerson {
  if (fix.outcome === "proposed" && fix.patch !== undefined) return { next: "verify", patch: fix.patch };
  if (fix.outcome === "error" && releasesForRetry(fix.rule)) return { next: "retry", rule: fix.rule };
  return { next: "person", rule: fix.rule, reason: fix.rootCause };
}

/** After verify: a passed patch goes on; a failed one gets the cycle's one revision, then goes to a person. */
export function afterVerify(verified: VerifyResult, patch: string, revisions: number): { next: "review" } | Revise | ToPerson {
  if (verified.status === "passed") return { next: "review" };
  if (revisions < MAX_REVISIONS) return { next: "revise", feedback: verifyFeedback(patch, verified) };
  return { next: "person", rule: `verify-${verified.rule}`, reason: verified.reason };
}

/** After review: approved goes on; blocked gets the one revision (#375), then a person; no review at all, see `releasesForRetry`. */
export function afterReview(reviewed: ReviewResult, patch: string, revisions: number): { next: "pr"; verdict: ReviewVerdict } | Revise | Retry | ToPerson {
  if (reviewed.verdict === undefined) {
    // A review refused for its evidence (not passed, another patch's) is a logic error no retry corrects (#418).
    if (releasesForRetry(reviewed.rule)) return { next: "retry", rule: reviewed.rule };
    return { next: "person", rule: reviewed.rule, reason: reviewed.reason ?? "The patch could not be reviewed." };
  }
  if (reviewed.verdict !== "block") return { next: "pr", verdict: reviewed.verdict };
  // Only what the review showed this patch breaks (#375): a revision that also takes on other problems in the file stops
  // being the minimal fix and fails on its own (CODE-03's transaction rewrite).
  if (revisions < MAX_REVISIONS) return { next: "revise", feedback: reviewFeedback(patch, reviewed.attacks ?? []) };
  return { next: "person", rule: "review-blocked", reason: "The adversarial review broke the patch, and the one revision did not fix it." };
}

/** How many rejected alternatives and review attacks the run record keeps (each value is bounded by cycle.ts). */
export const MAX_RECORDED_ALTERNATIVES = 5;
export const MAX_RECORDED_ATTACKS = 10;
/** A counter-check filter longer than its record value (cycle.ts) is left out rather than cut: a cut filter would count something else. */
const MAX_RECORDED_FILTER = LONG_VALUE_KEYS.counterFilter ?? 0;

/** `alternative1`, `alternative2`...: the run record holds flat values only, so a list is numbered keys. */
function numbered(prefix: string, items: readonly string[], max: number): Record<string, string> {
  const out: Record<string, string> = {};
  items.slice(0, max).forEach((item, i) => {
    out[`${prefix}${i + 1}`] = item;
  });
  return out;
}

/**
 * The independent log recount triage judged on, kept with its decision (#39): the count, its window, whether
 * counting stopped at the cap, when it ran, and the exact filter so a person can run it again. A missing
 * check is recorded as missing (`counterCount: null`), never as zero.
 */
export function counterCheckRecord(check: LogCounterCheck | undefined): Record<string, string | number | boolean | null> {
  if (!check || !Number.isFinite(check.count)) return { counterCount: null };
  return {
    counterCount: check.count,
    counterWindow: check.window,
    counterCapped: check.capped === true,
    ...(check.checkedAt !== undefined && { counterCheckedAt: check.checkedAt }),
    ...(check.filter !== undefined && check.filter.length <= MAX_RECORDED_FILTER && { counterFilter: check.filter }),
  };
}

/**
 * Keeps the lease alive while the loop waits on something slow (a model call, a clone, above all a verify run that can
 * take far longer than one lease, #132). `beat` renews when a third of the lease has gone by since the last renewal,
 * and throws `LeaseLost` once a renewal is refused. A timer beats on its own for the waits that cannot (the in-process
 * gate, a model call); the CI and remote verifiers also beat on every poll, so they stop as soon as the lease is lost.
 * A renewal that fails on the store is not a refusal: it is tried again at the next beat, and the next fenced write
 * proves the lease either way.
 */
function leaseKeeper(renew: () => Promise<boolean>, now: () => number, everyMs: number) {
  let last = now();
  let lost = false;
  let pending: Promise<void> | undefined;
  const beat = async (): Promise<void> => {
    if (!lost && now() - last >= everyMs) {
      pending ??= renew()
        .then(
          (ok) => {
            if (ok) last = now();
            else lost = true;
          },
          () => undefined
        )
        .finally(() => {
          pending = undefined;
        });
      await pending;
    }
    if (lost) throw new LeaseLost();
  };
  const timer = setInterval(() => void beat().catch(() => undefined), everyMs);
  timer.unref();
  return { beat, stop: () => clearInterval(timer) };
}

export async function runCycle(deps: LoopDeps, key: CycleKey): Promise<LoopResult> {
  const { db, config: cfg, owner } = deps;
  const lease = await acquireLease(db, cfg, key, owner, deps.now(), deps.reconsider ? { reconsider: { ...deps.reconsider, incidentCollection: cfg.incidentCollection } } : {});
  if (!lease.acquired) {
    // This call is the one that just gave the cycle up (a later one sees it closed): tell a person, once (#137).
    if (lease.reason === "deadline-passed" || lease.reason === "retries-exhausted") await announceGivenUp(deps, key, lease.reason);
    return { kind: "not-acquired", reason: lease.reason };
  }
  const id = lease.cycleId;

  const note = async (event: RunEvent) => {
    const r = await recordEvent(db, cfg, id, owner, deps.now(), event);
    if (!r.ok) throw new LeaseLost();
    // An issue filed or a PR opened is also linked from the incident, for the UI (#194). Never throws.
    const link = linkFromEvent(event);
    if (link) await linkIncident(db, cfg, key, link);
  };
  const finish = async (state: Exclude<CycleState, "running">, outcome: string, path?: CyclePath, decision?: DeclineDecision): Promise<LoopResult> => {
    const r = await finishCycle(db, cfg, id, owner, deps.now(), state, outcome, path, decision);
    if (!r.ok) throw new LeaseLost();
    return { kind: "finished", state, outcome };
  };
  const release = async (reason: string, opts: { uncounted?: boolean } = {}): Promise<LoopResult> => {
    const r = await releaseLease(db, cfg, id, owner, deps.now(), reason, opts);
    if (!r.ok) throw new LeaseLost();
    return { kind: "released", reason };
  };
  const renew = async (): Promise<void> => {
    const r = await renewLease(db, cfg, id, owner, deps.now());
    if (!r.ok) throw new LeaseLost();
  };
  const keeper = leaseKeeper(
    async () => (await renewLease(db, cfg, id, owner, deps.now())).ok,
    () => deps.now().getTime(),
    Math.max(1000, (cfg.leaseSeconds * 1000) / 3)
  );

  try {
    await note({
      stage: "cycle",
      type: lease.reconsidered ? "reconsidered" : "started",
      // A run that waited for a person was never declined: only an operator's Retry reopens one (reconsider.ts).
      summary: lease.reconsidered
        ? lease.reopenedFrom === "failed"
          ? `Failed earlier; retried: ${RECONSIDER_SUMMARY[lease.reconsidered]}`
          : lease.reopenedFrom === "waiting-human"
          ? `Handed to a person earlier; retried: ${RECONSIDER_SUMMARY[lease.reconsidered]}`
          : `Declined earlier; triaged again: ${RECONSIDER_SUMMARY[lease.reconsidered]}`
        : `Attempt ${lease.attempt}${lease.resumed ? " (resumed)" : ""}`,
      data: {
        attempt: lease.attempt,
        resumed: lease.resumed,
        ...(lease.reconsidered && { trigger: lease.reconsidered }),
        ...(lease.reopenedFrom && { reopenedFrom: lease.reopenedFrom }),
      },
    });

    // Asked before every stage and before anything is opened: a cycle stops at the next step after an
    // operator resolves or ignores the incident, or automation is switched off.
    const stopReason = async (): Promise<string | null> => {
      const status = await deps.incidentStatus(key.incidentId);
      if (status === null) return "incident-gone";
      if (!(OPEN_INCIDENT_STATUSES as readonly string[]).includes(status)) return `incident-${status}`;
      if (!(await deps.automationEnabled())) return "automation-disabled";
      return null;
    };
    // An operator who resolved or ignored the incident settles the cycle (with no decision: reopening the incident later
    // triages it again, reconsider.ts `reopened`, #227). The kill switch only pauses it (#133): the
    // lease is released, uncounted, so the cycle is taken up again once automation is back on. The switch also reads
    // "off" when the settings cannot be read, and one failed read must not decline an incident for good.
    const haltFor = async (why: string): Promise<LoopResult> => {
      await note({ stage: "cycle", type: "stopped", summary: `Stopped before acting: ${why}`, data: { rule: why } });
      if (why === "automation-disabled") return release(why, { uncounted: true });
      return finish("declined", why, "decline");
    };
    const halted = async (): Promise<LoopResult | null> => {
      const why = await stopReason();
      return why === null ? null : haltFor(why);
    };

    // Auto-merge could apply right now (#9): never in a dry run, never without the switches; with a case, that case listed.
    const autoMergeOn = async (mergeCase?: string): Promise<boolean> =>
      !cfg.dryRun && deps.autoMergeAllowed !== undefined && (await deps.autoMergeAllowed(mergeCase));
    // An earlier Starfish merge for this incident still watched, or reverted: its revert, not a second fix, is what
    // follows, so nothing is prepared for merging this one (#240). The merge step asks again before any merge.
    const mergeHeldBy = async (): Promise<string | null> => earlierMergeHolds(db, cfg, key.incidentId, id);

    // The incident's GitHub issue, for a cycle Starfish acts on or escalates, none for a declined one: filed once per
    // incident while it stays open, a recurrence noting itself on it (githubPr.ts `openIssue`, #397). Recorded on the
    // cycle (`summary.issue`) so a resumed attempt reuses it, and so a failure is visible and not silent.
    let issue: { number: number; url: string } | undefined;
    // `mergeCase`: the admin's case Gemini named in triage (triage.ts), when it named one: only then may the issue say
    // Starfish could merge the fix itself.
    const fileIssue = async (loaded: LoopSubject, path: IssueRequest["path"], reason: string, suspectedCause: string | undefined, mergeCase?: string): Promise<void> => {
      if (!deps.openIssue) return;
      const snap = await db.collection(cfg.cycleCollection).doc(id).get();
      const prior = (snap.data()?.summary as { issue?: { state?: unknown; number?: unknown; url?: unknown } } | undefined)?.issue;
      if (prior?.state === "opened" && typeof prior.number === "number" && typeof prior.url === "string") {
        issue = { number: prior.number, url: prior.url };
        return;
      }
      if (cfg.dryRun) {
        await note({ stage: "issue", type: "dry-run", summary: "An issue would be filed here; nothing filed (dry run)", record: { state: "dry-run" } });
        return;
      }
      await renew();
      const incident = loaded.subject.incident;
      const counter = incident.logCounterCheck;
      let filed: IssueResult;
      try {
        filed = await deps.openIssue({
          cycleId: id,
          incidentId: key.incidentId,
          functionName: incident.functionName ?? "unknown function",
          service: incident.service ?? "unknown",
          errorType: incident.errorType ?? "unknown",
          occurrenceCount: incident.occurrenceCount ?? null,
          fingerprint: incident.fingerprint ?? null,
          counterCheck: counter ? { window: counter.window, count: counter.count, capped: counter.capped === true } : null,
          path,
          reason,
          suspectedCause: suspectedCause ?? null,
          uiBaseUrl: cfg.uiBaseUrl,
          ...(incident.traceId !== undefined && {
            trace: {
              id: incident.traceId,
              ...(incident.sourceProjectId !== undefined && { projectId: incident.sourceProjectId }),
              ...(incident.lastOccurredAt !== undefined && { lastOccurredAt: incident.lastOccurredAt }),
            },
          }),
          ...(path === "act" && mergeCase !== undefined && (await autoMergeOn(mergeCase)) && (await mergeHeldBy()) === null && { autoMerge: true }),
        });
      } catch (err) {
        const rule = typeof (err as { rule?: unknown })?.rule === "string" ? (err as { rule: string }).rule : "error";
        await note({ stage: "issue", type: "failed", summary: `The issue could not be filed: ${rule}`, record: { state: "failed", reason: rule } });
        return;
      }
      issue = { number: filed.number, url: filed.url };
      // A recurrence whose earlier issue is still open is noted there, not filed again (#397). The record is the same
      // `opened` one either way: it is this run's issue, and its fix pull request references it.
      await note({
        stage: "issue",
        type: "opened",
        summary: filed.reused === true ? `Recurrence noted on the incident's open issue #${filed.number}` : `Issue #${filed.number} filed`,
        data: { number: filed.number, ...(filed.reused === true && { reused: true }) },
        record: { state: "opened", number: filed.number, url: filed.url, ...(filed.reused === true && { reused: true }) },
      });
    };

    // A cycle that ends waiting for a person says so, once per round. Recorded before and after the send, so a crash
    // between the two leaves `pending` and the next attempt posts again (at-least-once: a missed escalation is worse than
    // a repeat), while a `sent` or `failed` recorded in this round is never sent again. A reopened round (reconsider.ts)
    // is new work with its own outcome, so it sends again, worded as a retry (`round`, `retriedBecause`): round 2 of a
    // run that opened a pull request after a hand-off was otherwise silent, the team still reading round 1's message.
    // The same pattern serves the `#ops-alerts` "new incident" message (`summary.alert`).
    // Resolves to why it stopped before sending (the incident closed, or automation off), or null: the caller must then
    // stop too, and not settle the cycle as if a person had been told (#180).
    const deliverOnce = async (
      stage: "notify" | "alert",
      words: { dryRun: string; pending: string; sent: string; failed: string },
      send: (retry: RetryWords) => Promise<DeliveryResult>
    ): Promise<string | null> => {
      const snap = await db.collection(cfg.cycleCollection).doc(id).get();
      const cycleNow = snap.data();
      const round = roundOf(cycleNow);
      if (cfg.dryRun) {
        await note({ stage, type: "dry-run", summary: words.dryRun, record: { state: "dry-run", at: deps.now().toISOString(), round } });
        return null;
      }
      const priorRecord = (cycleNow?.summary as Record<string, { state?: unknown; round?: unknown } | undefined> | undefined)?.[stage];
      const prior = priorRecord?.state;
      // A record from before rounds were recorded is round 1's.
      const priorRound = typeof priorRecord?.round === "number" ? priorRecord.round : 1;
      if ((prior === "sent" || prior === "failed") && priorRound === round) return null;
      const why = await stopReason();
      if (why !== null) return why;
      await renew();
      await note({ stage, type: "pending", summary: words.pending, record: { state: "pending", attempts: 0, round } });
      let result: DeliveryResult;
      try {
        result = await send(retryWords(round, cycleNow?.reconsideredBecause));
      } catch {
        // The sender promises not to throw; if it does anyway, that is a failed delivery and not a lost cycle.
        result = { state: "failed", attempts: 1, reason: "notifier-error" };
      }
      await note({
        stage,
        type: result.state,
        summary: result.state === "sent" ? words.sent : `${words.failed}: ${result.reason ?? "unknown"}`,
        data: { attempts: result.attempts },
        // `at`: when a person was told, which the phone escalation (#37, src/oncall/escalation.ts) waits after.
        record: { state: result.state, attempts: result.attempts, at: deps.now().toISOString(), round, ...(result.reason !== undefined && { reason: result.reason }) },
      });
      return null;
    };
    const about = (facts: IncidentFacts) => ({ cycleId: id, incidentId: key.incidentId, ...facts, ...(issue && { issueUrl: issue.url }) });
    // The one way a person is told (#412). Asked first, and again by the delivery itself: resolves to why nobody was told
    // (the incident closed, or automation off), or null once they were (or a dry run, or no notifier, says so). Only the
    // two hand-offs below call it, and each branches on the answer: a stop is never read as "told".
    const tellPerson = async (facts: IncidentFacts, path: NotifyRequest["path"], rule: string, reason: string): Promise<string | null> => {
      const why = await stopReason();
      if (why !== null) return why;
      const notify = deps.notify;
      if (!notify) return null;
      return deliverOnce(
        "notify",
        { dryRun: "A person would be told here; nothing sent (dry run)", pending: "Telling a person", sent: "A person was told", failed: "A person could not be told" },
        (retry) => notify({ ...about(facts), ...retry, path, rule, reason })
      );
    };
    // End the cycle waiting for a person, after telling them: an incident an operator closed settles the cycle, and
    // automation turned off releases it uncounted, to be told when it is back on. Never `waiting-human` with nobody told
    // because the switch went off meanwhile (#180): nothing would ever resume it (pass.ts treats it as settled) and the
    // phone escalation waits on the message that was never sent.
    const handOver = async (facts: IncidentFacts, path: NotifyRequest["path"], rule: string, reason: string, outcome: string, cyclePath: CyclePath): Promise<LoopResult> => {
      const why = await tellPerson(facts, path, rule, reason);
      if (why !== null) return haltFor(why);
      return finish("waiting-human", outcome, cyclePath);
    };
    // End a cycle whose pull request is open, telling a person first when its merge record owes them a word (`prHandOff`:
    // Starfish will not merge it itself). The same rule as `handOver` (#412): automation turned off before they were told
    // releases the cycle uncounted, and the attempt that resumes it finds the pull request and tells them then. A `done`
    // cycle with nobody told would never be resumed, and its merge record is not `pending`, so the merge step would
    // never speak either. An incident an operator closed or that is gone needs nobody told: the pull request stands.
    const closeWithPr = async (facts: () => Promise<IncidentFacts>, merge: PrHandOff | null): Promise<LoopResult> => {
      if (merge !== null) {
        const why = await tellPerson(await facts(), "human", merge.rule, merge.reason);
        if (why === "automation-disabled") return haltFor(why);
      }
      return finish("done", "pr-opened", "pr");
    };
    // The `#ops-alerts` "new incident" message: once for every cycle Starfish acts on or escalates, after its issue is
    // filed so the message can link to it. A declined incident gets none, as it gets no issue. A stop it meets is left to
    // the next step, which asks again.
    const alertTeam = async (loaded: LoopSubject, path: AlertRequest["path"], reason: string): Promise<void> => {
      const alert = deps.alert;
      if (!alert) return;
      await deliverOnce(
        "alert",
        { dryRun: "The team would be alerted here; nothing sent (dry run)", pending: "Alerting the team", sent: "The team was alerted", failed: "The team could not be alerted" },
        (retry) => alert({ ...about(factsOf(loaded)), ...retry, path, reason })
      );
    };

    // A pull request already opened for this cycle ends it (#134): an attempt resumed after the open succeeded but its
    // record or the finish did not must not redo the pipeline (the CI verifier would rebuild the PR's own branch).
    const priorPr = await openedPullRequest(deps, id);
    if (priorPr) {
      await note({
        stage: "pr",
        type: "opened",
        summary: "Pull request already opened by an earlier attempt",
        data: { number: priorPr.number },
        record: { opened: true, number: priorPr.number, url: priorPr.url, ...(priorPr.patchSha256 !== undefined && { patchSha256: priorPr.patchSha256 }) },
      });
      if (priorPr.index) return await finish("done", "index-pr-opened", "index");
      if (priorPr.issueNumber !== undefined && priorPr.issueUrl !== undefined) issue = { number: priorPr.issueNumber, url: priorPr.issueUrl };
      const storedFacts = () => storedIncidentFacts(deps, key.incidentId);
      // Where auto-merge could apply, the attempt that opened it never recorded it as a candidate (#184): what the floor and
      // the "fails before" run saw is gone with it, so it is never merged on a guess. Recorded as skipped, and a person
      // is told the decision is theirs.
      if (priorPr.mergeCase !== undefined && priorPr.merge === undefined && (await autoMergeOn(priorPr.mergeCase))) {
        const record = {
          state: "skipped",
          reason: "resumed-without-candidate",
          number: priorPr.number,
          ...(priorPr.patchSha256 !== undefined && { patchSha256: priorPr.patchSha256 }),
          headSha: null,
          decidedAt: deps.now().toISOString(),
        };
        await note({ stage: "merge", type: "skipped", summary: "Not auto-merged: resumed-without-candidate", record });
        return await closeWithPr(storedFacts, prHandOff(record));
      }
      // A merge record the earlier attempt wrote may still owe a person a word: that attempt was stopped before telling
      // them (#412), or before it could settle. Once they were told in this round, `deliverOnce` sends nothing again.
      return await closeWithPr(storedFacts, prHandOff(priorPr.merge));
    }

    let modelCalls = lease.modelCalls;
    // A used-up budget hands the incident to a person, like any other "Starfish stops here": the spend is the cycle's
    // (#182), so ordinary retries can reach it, and a cycle given up with nobody told is what #180 forbids.
    const overBudget = async (loaded: LoopSubject): Promise<LoopResult | null> => {
      if (modelCalls < cfg.modelCallBudget) return null;
      await note({ stage: "cycle", type: "budget", summary: "Model-call budget used up", data: { budget: cfg.modelCallBudget, used: modelCalls } });
      return handOver(
        factsOf(loaded),
        "human",
        "budget-exceeded",
        `This cycle used its ${cfg.modelCallBudget} model calls without a result Starfish could act on, so a person decides.`,
        "budget-exceeded",
        "human"
      );
    };
    // Counted on the cycle before the call is made (#182): a resumed attempt goes on from what earlier ones spent.
    const spendModelCall = async (): Promise<void> => {
      const r = await countSpend(db, cfg, id, owner, deps.now(), "modelCalls");
      if (!r.ok) throw new LeaseLost();
      modelCalls = r.count ?? modelCalls + 1;
    };

    const loaded = await deps.load(key.incidentId);
    if (!loaded) {
      await note({ stage: "cycle", type: "stopped", summary: "The incident could not be loaded", data: { rule: "incident-gone" } });
      return await finish("failed", "incident-gone", "failed");
    }

    // ---- the index path (#11): Google's own error names the fix, so no model is asked anything ----------------
    // The rules engine's cap (src/triageRules.ts): an admin's class rule or an operator's correction. Held to noise or log,
    // the index path is not taken (triage declines or notifies); held to fix, its evidence PR is never merged.
    const cap = levelCap(loaded.subject.incident, cfg.classRules, loaded.subject.correction);
    if (deps.indexHeal && isIndexIncident(loaded.subject.incident) && !capHolds(cap, "fix")) {
      return await runIndexPath({
        db,
        cycleCollection: cfg.cycleCollection,
        dryRun: cfg.dryRun,
        cycleId: id,
        incidentId: key.incidentId,
        loaded,
        now: deps.now,
        wiring: deps.indexHeal,
        note,
        finish: (state, outcome, path) => finish(state, outcome, path),
        release: (reason) => release(reason),
        renew,
        halted,
        stopReason,
        handOver: (rule, reason, outcome, path) => handOver(factsOf(loaded), "human", rule, reason, outcome, path),
        fileIssue: async (reason) => {
          await fileIssue(loaded, "index", reason, undefined);
          return issue?.number;
        },
        beat: keeper.beat,
        ...(!cfg.dryRun && deps.openPullRequest && { openPullRequest: deps.openPullRequest }),
        // The admin's reserved `missing-index` case, read fresh: listed, the evidence PR merges once its checks are green.
        indexMergeAllowed: async () => cap === null && (await autoMergeOn(INDEX_MERGE_CASE)) && (await mergeHeldBy()) === null,
      });
    }

    // ---- triage ---------------------------------------------------------------------------------
    let stop = (await halted()) ?? (await overBudget(loaded));
    if (stop) return stop;
    // Counted only when triage asks the model: a deterministic gate's decision (a closed incident, a zero counter-check)
    // spends nothing. Triage turns a throwing `ask` into "model call failed", so a lost lease is carried out and rethrown.
    let spendError: unknown;
    const countedAsk: AskJson = async <T,>(prompt: string, system: string, schema: Record<string, unknown>): Promise<T> => {
      try {
        await spendModelCall();
      } catch (err) {
        spendError = err;
        throw err;
      }
      return deps.ask<T>(prompt, system, schema);
    };
    // The round the decision belongs to, written with it, so an attempt resumed within the round can keep it (#414).
    const cycleNow = (await db.collection(cfg.cycleCollection).doc(id).get()).data();
    const round = roundOf(cycleNow);
    const kept = lease.resumed ? keptTriage((cycleNow?.summary as Record<string, unknown> | undefined)?.triage, round, cap) : null;
    let triage: TriageResult;
    if (kept) {
      // Not asked again, and not recorded again: the run record keeps the decision as it was made. The status and the kill
      // switch were asked above, and are asked again before the issue and at every stage.
      triage = kept;
      await note({
        stage: "cycle",
        type: "triage-kept",
        summary: `Triage's decision from earlier in this round kept (${kept.decision}); no second model call`,
        data: { decision: kept.decision, rule: kept.rule },
      });
    } else {
      triage = await triageIncident(loaded.subject, countedAsk, triageOptionsFor(cfg, loaded.files));
      if (spendError !== undefined) throw spendError;
      const level = triageLevel(triage);
      await note({
        stage: "triage",
        type: "decision",
        summary: triage.reason,
        data: { decision: triage.decision, rule: triage.rule, ...(level !== null && { level }), ...(triage.cap && { cap: triage.cap.level, capBy: triage.cap.by }) },
        record: {
          decision: triage.decision,
          rule: triage.rule,
          reason: triage.reason,
          suspectedCause: triage.suspectedCause ?? null,
          // How far Starfish goes (noise, log, fix, merge), and the admin's merge case Gemini named for "merge".
          level,
          mergeCase: triage.mergeCase ?? null,
          // The rules engine's cap, when one applied (src/triageRules.ts): its level, its source and the admin rule's id.
          cap: triage.cap?.level ?? null,
          capBy: triage.cap?.by ?? null,
          capRule: triage.cap?.ruleId ?? null,
          round,
          // The configured model, only when the decision was the model's: a gate (missing or zero recount, a cap of noise)
          // asked none. A cap that turned the model's act into notify still asked it.
          ...((triage.rule.startsWith("model-") || (triage.rule.endsWith("-cap") && triage.cap?.level !== "noise")) && { model: cfg.model }),
          ...counterCheckRecord(loaded.subject.incident.logCounterCheck),
          // Whether triage read the recount at all (#436): a gate before it (a cap of noise, a kind's gate) did not need it,
          // so a missing one there was not waited for.
          counterRead: triage.decidedBeforeRecount !== true,
        },
      });
    }
    // The merge case Gemini named (triage.ts): Starfish may merge only what it named.
    const chosenCase = triage.mergeCase;
    // An issue for every incident Starfish acts on or escalates; a declined, skipped or deferred one gets none.
    if (triage.decision === "act" || triage.decision === "notify") {
      // The triage call can take a while: an operator who closed the incident, or the kill switch, stops it before
      // anything is filed or posted (#181).
      stop = await halted();
      if (stop) return stop;
      await fileIssue(loaded, triage.decision, triage.reason, triage.suspectedCause, chosenCase);
      await alertTeam(loaded, triage.decision, triage.reason);
    }
    switch (triage.decision) {
      case "skip":
      case "decline": {
        // What this decline saw, kept so a later pass can tell new evidence from the same logs read again (#8).
        const incident = loaded.subject.incident;
        const counter = incident.logCounterCheck;
        return await finish("declined", triage.rule, "decline", {
          rule: triage.rule,
          reason: triage.reason,
          suspectedCause: triage.suspectedCause ?? null,
          occurrenceCount: typeof incident.occurrenceCount === "number" ? incident.occurrenceCount : null,
          counterCount: counter && Number.isFinite(counter.count) ? counter.count : null,
          counterWindow: counter?.window ?? null,
          errorType: incident.errorType ?? null,
          causeClass: causeClass(incident),
        });
      }
      case "notify":
        return await handOver(factsOf(loaded), "notify", triage.rule, triage.reason, `notify:${triage.rule}`, "notify");
      case "defer":
        return await release(triage.rule);
      case "error":
        if (releasesForRetry(triage.rule)) return await release(triage.rule);
        return await handOver(factsOf(loaded), "human", triage.rule, triage.reason, triage.rule, "human");
      case "act":
        break;
    }

    // ---- fix, verify, review (one revision, shared) ----------------------------------------------
    let feedback: FixRequest["feedback"];
    // The cycle's revisions so far (#182): one resumed after a revision does not get another.
    let revisions = lease.revisions;
    const spendRevision = async (): Promise<void> => {
      const r = await countSpend(db, cfg, id, owner, deps.now(), "revisions");
      if (!r.ok) throw new LeaseLost();
      revisions = r.count ?? revisions + 1;
    };
    for (;;) {
      stop = (await halted()) ?? (await overBudget(loaded));
      if (stop) return stop;
      await spendModelCall();
      const fix = await proposeFix(
        {
          subject: loaded.subject,
          files: loaded.files,
          ...(feedback && { feedback }),
        },
        deps.ask
      );
      await note({
        stage: "fix",
        type: fix.outcome,
        summary: fix.rootCause,
        data: { rule: fix.rule, testAdded: fix.testAdded ?? null },
        record: {
          outcome: fix.outcome,
          rule: fix.rule,
          rootCause: fix.rootCause,
          testAdded: fix.testAdded ?? null,
          risk: fix.risk ?? null,
          revisions,
          // The configured model: the fixer always asks it, and its words are what this record holds (the UI says whose they are).
          model: cfg.model,
          // Which rule found the source the fixer was shown (#259): a file found by the function's name is weaker evidence.
          ...(loaded.source && { source: loaded.source.rule, sourceFiles: loaded.files.length }),
          ...(loaded.source?.search && { sourceSearch: loaded.source.search }),
          // How many of the files shown are ones the file found by name imports (#347).
          ...(loaded.source?.imports !== undefined && { sourceImports: loaded.source.imports }),
          ...numbered("alternative", fix.rejectedAlternatives ?? [], MAX_RECORDED_ALTERNATIVES),
        },
      });
      // A model call that failed, or an answer that could not be read, may do better next time: released to retry. Any other
      // error (an unfit patch, an answer cut at the limit or filtered) would most likely repeat: a person, now (#137, #418).
      const fixed = afterFix(fix);
      if (fixed.next === "retry") return await release(fixed.rule);
      if (fixed.next !== "verify") return await handOver(factsOf(loaded), "human", fixed.rule, fixed.reason, fixed.rule, "human");
      const patch = fixed.patch;

      // ---- auto-merge evidence (#9): the safety floor, then the patch's tests alone on the base revision -------
      // Only where Gemini named a merge case: the decision to merge is its, inside the cases an admin listed.
      let floor: BlastRadius | undefined;
      const mayMerge = chosenCase !== undefined && (await autoMergeOn(chosenCase));
      const heldBack = mayMerge ? await mergeHeldBy() : null;
      if (mayMerge && heldBack === null) {
        floor = assessMergeFloor(patch, {
          excludedPaths: [...cfg.patchExcludedPaths, ...cfg.autoMergeExcludedPaths],
          // The floor judges the whole function around each change, as the base revision has it (#202).
          baseFiles: await readBaseFiles(loaded.sourceDir, patch),
        });
        if (floor.allowed) {
          stop = await halted();
          if (stop) return stop;
          await recordFailsBefore(deps, { id, loaded, heartbeat: keeper.beat, note, renew }, patch);
        }
      }

      // The kill switch is asked again before verify: with `github-actions` verify pushes a branch to the target (#138).
      stop = await halted();
      if (stop) return stop;
      // Verify can take far longer than one lease: prove the lease is ours and extend it first; the keeper (and the
      // heartbeat the waiting verifiers call on every poll) keeps it alive while it runs (#132).
      await renew();
      const verified = await (deps.verify ?? verifyPatch)({
        cycleId: id,
        sourceDir: loaded.sourceDir,
        patch,
        baseRevision: loaded.baseRevision,
        config: cfg,
        heartbeat: keeper.beat,
      });
      await note({
        stage: "verify",
        type: verified.status,
        summary: verified.reason,
        data: {
          rule: verified.rule,
          patchSha256: verified.patchSha256,
          files: verified.changedFiles.length,
          exitCode: verified.exitCode ?? null,
          // Why a patch was refused (`git apply`'s own words, already redacted): without it a rejection cannot be explained (#317).
          ...(verified.status !== "passed" && verified.output.trim() !== "" && { output: clipWellFormed(verified.output.trim(), 300) }),
        },
        record: {
          status: verified.status,
          rule: verified.rule,
          patchSha256: verified.patchSha256,
          baseRevision: loaded.baseRevision,
          files: verified.changedFiles.length,
          exitCode: verified.exitCode ?? null,
          durationMs: verified.durationMs,
          // Where the verdict came from: with `github-actions` a `command-*` rule is the target's checks on GitHub.
          isolation: cfg.verifyIsolation,
        },
      });
      const checked = afterVerify(verified, patch, revisions);
      if (checked.next === "revise") {
        await spendRevision();
        feedback = checked.feedback;
        continue;
      }
      if (checked.next !== "review") return await handOver(factsOf(loaded), "human", checked.rule, checked.reason, checked.rule, "human");
      // The floor read the patch's headers; the verify gate saw what `git apply` actually wrote. Unless they are the same
      // files, the floor judged a different change from the one that was verified, and it does not hold (#200).
      // Only the files, not their lines: the written tree is gone by now (a scratch copy, or a branch the target's CI
      // built), so the lines git wrote cannot be compared here. That half rests on the floor reading lines exactly as git
      // does: a `\ No newline` marker anywhere but a file's end, where git would join two lines, is refused (#237).
      if (floor?.allowed && !judgedTheVerifiedFiles(floor, verified.changedFiles)) {
        floor = { ...floor, allowed: false, problems: [...floor.problems, "files-differ-from-verified"] };
      }

      let review: { verdict: ReviewVerdict; attacks: Attack[] } | undefined;
      if (cfg.reviewRequired) {
        stop = (await halted()) ?? (await overBudget(loaded));
        if (stop) return stop;
        await spendModelCall();
        const reviewed = await reviewPatch(
          { subject: loaded.subject, patch, verify: verified, files: loaded.files, claimed: { rootCause: fix.rootCause, risk: fix.risk ?? "" } },
          deps.ask
        );
        await note({
          stage: "review",
          type: reviewed.verdict ?? "error",
          summary: reviewed.reason ?? `${reviewed.attacks?.length ?? 0} attacks tried`,
          data: { rule: reviewed.rule, attacks: reviewed.attacks?.length ?? 0, broken: reviewed.attacks?.filter((a) => a.outcome === "broken").length ?? 0 },
          record: {
            verdict: reviewed.verdict ?? null,
            rule: reviewed.rule,
            attacks: reviewed.attacks?.length ?? 0,
            held: reviewed.attacks?.filter((a) => a.outcome === "held").length ?? 0,
            flagged: reviewed.attacks?.filter((a) => a.outcome === "flagged").length ?? 0,
            broken: reviewed.attacks?.filter((a) => a.outcome === "broken").length ?? 0,
            patchSha256: verified.patchSha256,
            // The configured model, when the review asked it: the two evidence rules refuse before any call.
            ...(!reviewed.rule.startsWith("evidence-") && { model: cfg.model }),
            ...numbered(
              "attack",
              (reviewed.attacks ?? []).map((a) => `${a.outcome}: ${a.attack} | ${a.detail}`),
              MAX_RECORDED_ATTACKS
            ),
          },
        });
        const judged = afterReview(reviewed, patch, revisions);
        if (judged.next === "retry") return await release(judged.rule);
        if (judged.next === "revise") {
          await spendRevision();
          feedback = judged.feedback;
          continue;
        }
        if (judged.next === "person") return await handOver(factsOf(loaded), "human", judged.rule, judged.reason, judged.rule, "human");
        review = { verdict: judged.verdict, attacks: reviewed.attacks ?? [] };
      }

      // ---- the pull request ----------------------------------------------------------------------
      if (cfg.dryRun || !deps.openPullRequest) {
        await note({
          stage: "pr",
          type: "dry-run",
          summary: "Patch verified; nothing opened (dry run)",
          data: { patchSha256: verified.patchSha256 },
          record: { opened: false, reason: "dry-run", patchSha256: verified.patchSha256 },
        });
        return await finish("waiting-human", "dry-run", "draft");
      }
      stop = await halted();
      if (stop) return stop;
      // Opening may take a while: prove the lease is still ours, and extended, before and not after.
      await renew();
      const pr = await deps.openPullRequest({
        cycleId: id,
        incidentId: key.incidentId,
        baseRevision: loaded.baseRevision,
        patch,
        patchSha256: verified.patchSha256,
        rootCause: fix.rootCause,
        risk: fix.risk ?? "",
        verify: { status: verified.status, rule: verified.rule, changedFiles: verified.changedFiles, output: verified.output },
        ...(issue && { issueNumber: issue.number }),
        ...(review && { review }),
        ...(floor?.allowed === true && { autoMerge: true }),
      });
      await note({
        stage: "pr",
        type: "opened",
        summary: "Pull request opened",
        data: { number: pr.number, patchSha256: verified.patchSha256 },
        record: { opened: true, number: pr.number, url: pr.url, patchSha256: verified.patchSha256 },
      });
      // The auto-merge candidate (#9): pending for the pass's merge step, or handed to a person now when the floor failed.
      if (floor && chosenCase !== undefined) {
        const record = mergeRecordAtOpen({
          floor,
          mergeCase: chosenCase,
          pr,
          patchSha256: verified.patchSha256,
          baseRevision: loaded.baseRevision,
          incident: loaded.subject.incident,
          repoFiles: loaded.repoFiles ?? [],
          now: deps.now(),
        });
        const pending = record.state === "pending";
        await note({
          stage: "merge",
          type: String(record.state),
          summary: pending ? `Auto-merge candidate (${chosenCase}): waiting for the required checks` : `Not auto-merged: ${String(record.reason)}`,
          data: { floor: floor.allowed ? "pass" : "fail", mergeCase: chosenCase },
          record,
        });
        return await closeWithPr(async () => factsOf(loaded), prHandOff(record));
      }
      if (heldBack !== null) {
        const record = { state: "skipped", reason: heldBack, number: pr.number, patchSha256: verified.patchSha256, headSha: null, decidedAt: deps.now().toISOString() };
        await note({ stage: "merge", type: "skipped", summary: `Not auto-merged: ${heldBack}`, record });
        return await closeWithPr(async () => factsOf(loaded), prHandOff(record));
      }
      return await closeWithPr(async () => factsOf(loaded), null);
    }
  } catch (err) {
    if (err instanceof LeaseLost) return { kind: "lease-lost" };
    throw err;
  } finally {
    keeper.stop();
  }
}

/** The most files, and the largest file, read for the safety floor: a patch it can pass changes one source file. */
const MAX_BASE_FILES = 4;
const MAX_BASE_FILE_BYTES = 1024 * 1024;

/**
 * The base revision's content of the existing files a patch changes, read from the cycle's checkout (#202): what the
 * safety floor judges the enclosing function on. A file is read only when it is a regular file reached with no symbolic link on the
 * way, inside the checkout, within the size cap, and text; anything else is left out, and the floor then refuses (no base
 * is not a pass). Never throws.
 */
export async function readBaseFiles(sourceDir: string, patch: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const paths = [...new Set((parsePatch(patch) ?? []).flatMap((f) => (f.oldPath === null ? [] : [f.oldPath])))].slice(0, MAX_BASE_FILES);
  let root: string;
  try {
    root = await realpath(sourceDir);
  } catch {
    return out;
  }
  for (const rel of paths) {
    try {
      // parsePatch refuses `.`, `..` and empty segments; the real path must also be exactly the joined one (no link).
      const full = join(root, rel);
      if ((await realpath(full)) !== full) continue;
      const st = await lstat(full);
      if (!st.isFile() || st.size > MAX_BASE_FILE_BYTES) continue;
      const content = await readFile(full, "utf8");
      if (!content.includes("\0")) out.set(rel, content);
    } catch {
      // Missing or unreadable: left out, and the floor refuses.
    }
  }
  return out;
}

/**
 * "Fails before" (#9), recorded as `summary.before`: the patch's TEST files alone, on the base revision, through the same
 * verifier the patch goes through. `failed` is the evidence wanted: the test fails without the fix. A patch with no test
 * file, or a verifier that broke, is recorded as such: missing is not a failure of the test. Reported in the merge's
 * evidence comment; no longer required to merge. With `github-actions` this is a commit on `starfish/<cycle>` that the
 * target's CI judges, deleted again.
 */
async function recordFailsBefore(
  deps: LoopDeps,
  ctx: { id: string; loaded: LoopSubject; heartbeat: () => Promise<void>; note: (event: RunEvent) => Promise<void>; renew: () => Promise<void> },
  patch: string
): Promise<void> {
  const forPatchSha256 = sha256(patch);
  const tests = testOnlyPatch(patch);
  if (tests === null) {
    await ctx.note({ stage: "before", type: "unavailable", summary: "No test file in the patch: nothing can show it failing before the fix", record: { status: "unavailable", rule: "no-test-in-patch", forPatchSha256 } });
    return;
  }
  await ctx.renew();
  let ran: VerifyResult;
  try {
    ran = await (deps.verify ?? verifyPatch)({ cycleId: ctx.id, sourceDir: ctx.loaded.sourceDir, patch: tests, baseRevision: ctx.loaded.baseRevision, config: deps.config, heartbeat: ctx.heartbeat });
  } catch (err) {
    if (err instanceof LeaseLost) throw err;
    await ctx.note({ stage: "before", type: "error", summary: "The run of the tests before the fix could not be completed", record: { status: "error", rule: "verifier-error", forPatchSha256 } });
    return;
  }
  await ctx.note({
    stage: "before",
    type: ran.status,
    summary: ran.status === "failed" ? "The patch's tests fail without the fix, as they should" : `The patch's tests alone: ${ran.reason}`,
    data: { rule: ran.rule, exitCode: ran.exitCode ?? null },
    record: { status: ran.status, rule: ran.rule, patchSha256: ran.patchSha256, forPatchSha256, exitCode: ran.exitCode ?? null },
  });
}

/** What a merge record written as a pull request was opened says, as far as telling a person goes. */
interface MergeRecordAtOpen {
  state?: unknown;
  reason?: unknown;
}

/** A word owed to a person about an open pull request: the rule and the plain reason the message carries. */
export interface PrHandOff {
  rule: string;
  reason: string;
}

const HELD_BACK_REASONS: readonly string[] = ["incident-merge-watched", "incident-reverted-before"];

/**
 * What a person is owed about a pull request the loop opened, read from the merge record written with it (#412), or null
 * when nothing is owed: no record (a plain PR a person merges), or a `pending` candidate the merge step takes from here.
 * A `skipped` one means Starfish will not merge it itself, and a person decides: the attempt that opened it tells them,
 * and an attempt that resumes it, when that one was stopped before it could. Shared by both so the words are the same.
 */
export function prHandOff(merge: MergeRecordAtOpen | undefined): PrHandOff | null {
  if (merge?.state !== "skipped") return null;
  const reason = typeof merge.reason === "string" ? merge.reason : "";
  if (reason === "resumed-without-candidate") {
    return {
      rule: "auto-merge-resumed",
      reason: "The pull request is open, but the attempt that opened it did not record it as an auto-merge candidate, so Starfish will not merge it itself. A person decides.",
    };
  }
  if (HELD_BACK_REASONS.includes(reason)) {
    return {
      rule: `auto-merge-${reason}`,
      reason:
        "The pull request is open, but Starfish merged a fix for this incident before, and that merge is still watched for the incident coming back, or was reverted: Starfish will not merge a second fix itself. A person decides.",
    };
  }
  return {
    rule: "auto-merge-floor",
    reason: "The pull request is open, but Starfish may not merge it itself (the change is outside the safety floor, or its head is unknown). A person decides.",
  };
}

interface OpenedPullRequest {
  number: number;
  url: string;
  patchSha256?: string;
  index: boolean;
  /** The cycle's auto-merge record (`summary.merge`) for it, when it holds one (#184): what a person may still be owed (#412). */
  merge?: MergeRecordAtOpen;
  /** The merge case the cycle's triage named, when it named one: only then could the pull request have been a candidate. */
  mergeCase?: string;
  /** The incident's issue, when one was recorded: the message to a person links it. */
  issueNumber?: number;
  issueUrl?: string;
}

/** The pull request this cycle already opened: recorded on the cycle, or found by the opener's own lookup. */
async function openedPullRequest(deps: LoopDeps, id: string): Promise<OpenedPullRequest | null> {
  const snap = await deps.db.collection(deps.config.cycleCollection).doc(id).get();
  const summary = snap.data()?.summary as
    | {
        pr?: { opened?: unknown; number?: unknown; url?: unknown; patchSha256?: unknown };
        index?: unknown;
        merge?: unknown;
        issue?: { state?: unknown; number?: unknown; url?: unknown };
        triage?: { mergeCase?: unknown };
      }
    | undefined;
  // An index cycle's PR is its evidence PR: the cycle keeps the index path (and its runtime record) when it is resumed.
  const index = summary?.index !== undefined;
  const rawMerge = summary?.merge as { state?: unknown; reason?: unknown } | null | undefined;
  const merge = rawMerge === undefined || rawMerge === null ? {} : { merge: { state: rawMerge.state, reason: rawMerge.reason } };
  const mergeCase = typeof summary?.triage?.mergeCase === "string" && summary.triage.mergeCase !== "" ? { mergeCase: summary.triage.mergeCase } : {};
  const issue = summary?.issue;
  const issueFields =
    issue?.state === "opened" && typeof issue.number === "number" && typeof issue.url === "string" ? { issueNumber: issue.number, issueUrl: issue.url } : {};
  const pr = summary?.pr;
  if (pr?.opened === true && typeof pr.number === "number" && typeof pr.url === "string") {
    return { number: pr.number, url: pr.url, ...(typeof pr.patchSha256 === "string" && { patchSha256: pr.patchSha256 }), index, ...merge, ...mergeCase, ...issueFields };
  }
  if (deps.config.dryRun || !deps.openPullRequest || !deps.findPullRequest) return null;
  const found = await deps.findPullRequest(id);
  return found && { ...found, index, ...merge, ...mergeCase, ...issueFields };
}

/**
 * Give up the stranded cycles a sweep found (pass.ts `findStrandedCycles`, #226) and tell a person about each, as
 * `runCycle` does when its own acquire gives one up, unless the incident is no longer open (a person closed it). Takes no
 * lease and runs no stage. Returns the cycles given up by this call; one another worker gave up first is left out (it
 * told them). Throws when the store does.
 */
export async function giveUpStrandedCycles(deps: LoopDeps, keys: readonly CycleKey[]): Promise<{ incidentId: string; reason: "deadline-passed" | "retries-exhausted" }[]> {
  const out: { incidentId: string; reason: "deadline-passed" | "retries-exhausted" }[] = [];
  for (const key of keys) {
    const reason = await giveUpStranded(deps.db, deps.config, key, deps.now());
    if (reason === null) continue;
    // An incident a person has since closed (or that is gone) is not theirs to be told about again.
    const status = await deps.incidentStatus(key.incidentId);
    if (status !== null && (OPEN_INCIDENT_STATUSES as readonly string[]).includes(status)) await announceGivenUp(deps, key, reason);
    out.push({ incidentId: key.incidentId, reason });
  }
  return out;
}

/**
 * A cycle just given up on (its deadline passed, or its attempts ran out) is not left to fail silently (#137): a person
 * is told, once, and the delivery is recorded on the cycle (`summary.notify`). Only the worker whose acquire (or sweep,
 * `giveUpStrandedCycles`) made that transition gets here: every later one finds the cycle closed. No lease is held any
 * more, so the record goes through cycle.ts `updateSettledCycle` (#412), as every write to a settled cycle does: with the
 * same fields a held cycle's delivery records (`at`, `round`), a `notify` run event, and the guest copy refreshed. Never
 * throws: the cycle is already settled, and a failure here must not read as an infrastructure error of the pass.
 */
async function announceGivenUp(deps: LoopDeps, key: CycleKey, rule: "deadline-passed" | "retries-exhausted"): Promise<void> {
  if (!deps.notify) return;
  const id = cycleId(key);
  if (id === null) return;
  const { db, config: cfg } = deps;
  try {
    let result: DeliveryResult | null = null;
    if (!cfg.dryRun) {
      const facts = await storedIncidentFacts(deps, key.incidentId);
      try {
        result = await deps.notify({
          cycleId: id,
          incidentId: key.incidentId,
          ...facts,
          path: "human",
          rule,
          reason:
            rule === "deadline-passed"
              ? "Starfish ran out of time on this incident before it could finish with it, so it has stopped trying."
              : "Starfish tried this incident as many times as it may and could not finish, so it has stopped trying.",
        });
      } catch {
        result = { state: "failed", attempts: 1, reason: "notifier-error" };
      }
    }
    const now = deps.now();
    const delivered = result;
    await updateSettledCycle(db, cfg, id, now, async (_tx, d) => {
      // Only the cycle this call just gave up: a running one belongs to its lease holder.
      if (d === undefined || d.state !== "failed") return { result: undefined };
      const round = roundOf(d);
      const at = now.toISOString();
      if (delivered === null) {
        return {
          result: undefined,
          records: { notify: { state: "dry-run", at, round } },
          event: { stage: "notify", type: "dry-run", summary: "A person would be told here; nothing sent (dry run)" },
        };
      }
      const reason = delivered.reason !== undefined ? clipWellFormed(delivered.reason, 300) : undefined;
      return {
        result: undefined,
        records: { notify: { state: delivered.state, attempts: delivered.attempts, at, round, ...(reason !== undefined && { reason }) } },
        event: {
          stage: "notify",
          type: delivered.state,
          summary: delivered.state === "sent" ? "A person was told" : `A person could not be told: ${reason ?? "unknown"}`,
          data: { attempts: delivered.attempts },
        },
      };
    });
  } catch {
    // The store or the incident read failed: nothing more can be done for a cycle that is already settled.
  }
}
