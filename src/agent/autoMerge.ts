/**
 * Auto-merge (#9, docs/design/auto-merge-policy.md): Starfish merges a fix itself where Gemini decided the incident is one
 * of the merge cases an admin listed, and hands everything else to a person. Built for the demo target behind default-off
 * switches; never run against real GitHub (tested with fakes and the Firestore emulator).
 *
 * WHO DECIDES: Gemini's triage names the case (triage.ts `mergeCase`), or the missing-index path claims its reserved case
 * (`INDEX_MERGE_CASE`, no model: Google's error names the index). Nothing here second-guesses WHAT KIND of change it is;
 * this step only refuses what must never merge, and waits for proof the change is green.
 *
 * NOTHING MERGES UNLESS ALL OF THIS HOLDS, checked again right before the merge:
 *   switches   automation on (the kill switch), dry run off, `autoMerge` on (an admin's setting, default off),
 *              `mergeFreeze` off (the global off switch), this deployment's `githubRepo` listed in
 *              `autoMergeTargets` (environment-only: the demo), the candidate's case still listed in `mergeCases` (read
 *              fresh: an admin who removes a case stops its merges), and today's merges under `maxMergesPerDay`;
 *   no cap     no admin class rule and no operator's correction holds the incident below "merge" (src/triageRules.ts),
 *              read fresh: a correction made after triage still stops the merge;
 *   the floor  the safety floor on the verified patch (blastRadius.ts `assessMergeFloor`), recorded when the pull request
 *              was opened: one production file, tests only as new files, nothing on the hard-exclude list, and the
 *              changed code's own rules (#295: no deciding line or call removed, no sink or new call added). The index
 *              path's patch is Starfish's own (indexFilePatch.ts: entries only added) and is not run through it;
 *   the PR     still open, from `starfish/<cycle>` into the configured base branch (a retargeted PR is refused, #186),
 *              its head the very commit Starfish built from the verified patch, and every run of every named required
 *              check (`verifyChecks`, posted by `verifyCheckApp`, #205) a success on that head: all of them, re-runs
 *              included (`filter=all`), and a head whose runs cannot all be read is handed to a person;
 *   evidence   posted on the pull request as one comment BEFORE the merge; a merge with no evidence does not happen.
 * Then one squash merge, with GitHub told the exact head (`sha`), so a head that moved refuses.
 *
 * Gate 2 (`certaintyGate`: fails before, passes after, review approved) is no longer required: it is reported in the
 * evidence comment, so a person reading it later sees how certain the change was.
 *
 * Any gate that fails leaves the pull request open and tells a person (the same notify path the loop uses). It
 * never merges on "almost": a check still running waits (at most `mergeCheckWaitMinutes`), anything else is final.
 * A merge interrupted half-way is never retried blindly: the next pass reads the PR back and records what happened,
 * or hands it to a person.
 *
 * Where the pieces run: the loop (loop.ts) records the "fails before" run and gate 1 when it opens the pull request
 * (`summary.before`, `summary.merge` pending); this step, once per agent pass (agentCli.ts), takes each pending
 * candidate to merged or skipped. A merge starts the fast-revert watch (fastRevert.ts). A merge is a release, though Starfish runs no deploy: the
 * target's own CI/CD does, and Starfish cannot see when it finishes.
 */
import { Timestamp, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { redactPii } from "../ingest/redact.js";
import { inert, type CheckRun, type GithubClient, type PullRequestResult } from "../integrations/githubPr.js";
import type { DeliveryResult, NotifyRequest } from "../integrations/slack.js";
import { OPEN_INCIDENT_STATUSES, type Incident, type IncidentStatus } from "../types.js";
import { INDEX_MERGE_CASE } from "../settingsSchema.js";
import type { LevelCap } from "../triageRules.js";
import type { BlastRadius } from "./blastRadius.js";
import { sanitizeEvent, updateSettledCycle, type CycleConfig, type SettledUpdate } from "./cycle.js";
import { pathsFromStack } from "./pass.js";
import { requiredRuns, summarizeChecks } from "./reconcile.js";

// ---- Switches --------------------------------------------------------------------------------------------------

export type MergeSwitchConfig = Pick<
  StarfishConfig,
  "automationEnabled" | "dryRun" | "autoMerge" | "mergeFreeze" | "githubRepo" | "autoMergeTargets" | "fastRevertMinutes" | "fastRevertGraceMinutes" | "mergeCases"
>;

/**
 * Why nothing may merge right now, or null when the switches allow it. Pure. `automation-disabled` is a PAUSE (#133):
 * nothing is decided while automation is off. Every other reason is a decision: the candidate goes to a person.
 * A fast-revert window that ends before its grace does (`fastRevertMinutes` <= `fastRevertGraceMinutes`) watches
 * nothing, so a merge would have no safety net: that blocks merging too, rather than failing the whole job (#242).
 * With `mergeCase`, that case must also be listed now: removing a case stops the merges it allowed.
 */
export function mergeBlockedBy(cfg: MergeSwitchConfig, mergeCase?: string): string | null {
  if (!cfg.automationEnabled) return "automation-disabled";
  if (cfg.dryRun) return "dry-run";
  if (cfg.mergeFreeze) return "merge-freeze";
  if (!cfg.autoMerge) return "auto-merge-off";
  const repo = cfg.githubRepo.toLowerCase();
  if (repo === "" || !cfg.autoMergeTargets.some((t) => t.toLowerCase() === repo)) return "target-not-allowed";
  if (!(cfg.fastRevertMinutes > cfg.fastRevertGraceMinutes)) return "fast-revert-window-empty";
  if (mergeCase !== undefined && !cfg.mergeCases.some((c) => c.id === mergeCase)) return "case-not-listed";
  return null;
}

// ---- Gate 2 ----------------------------------------------------------------------------------------------------

export type CertaintyCheck = "structural-cause" | "fails-before" | "verify-passed" | "review-approve" | "counter-check";

export interface CertaintyResult {
  pass: boolean;
  /** Every check that did not hold, in a fixed order. Empty when it passed. */
  failedChecks: CertaintyCheck[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});
const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;

/**
 * Gate 2, CERTAINTY, from the cycle's run record (`summary`, as cycle.ts stores it). Pure; every check is required, and
 * a value that is missing or of the wrong type fails it:
 *   structural-cause  triage decided `act` (the model's rule), the fixer proposed, and the incident's own stack trace
 *                     names the one file the patch changes (`merge.causeFrame`, recorded when the PR opened);
 *   fails-before      the fixer says it added a test, and the verify command FAILED with only the patch's test files
 *                     applied to the base revision (`before`), for this very patch (`before.forPatchSha256`);
 *   verify-passed     the full patch passed the verify gate, and the hash it passed on is the pull request's;
 *   review-approve    the adversarial review approved that same hash with zero attacks broken and zero flagged;
 *   counter-check     the independent recount counted errors: a number above zero (missing is not zero, and fails).
 */
export function certaintyGate(summaryRaw: unknown): CertaintyResult {
  const s = rec(summaryRaw);
  const triage = rec(s.triage);
  const fix = rec(s.fix);
  const before = rec(s.before);
  const verify = rec(s.verify);
  const review = rec(s.review);
  const pr = rec(s.pr);
  const merge = rec(s.merge);
  const patch = verify.patchSha256;
  const failed: CertaintyCheck[] = [];

  if (!(triage.decision === "act" && triage.rule === "model-act" && fix.outcome === "proposed" && fix.rule === "fixer-proposed" && merge.causeFrame === true)) {
    failed.push("structural-cause");
  }
  if (!(fix.testAdded === true && before.status === "failed" && before.rule === "command-failed" && typeof patch === "string" && before.forPatchSha256 === patch)) {
    failed.push("fails-before");
  }
  if (!(verify.status === "passed" && verify.rule === "command-passed" && typeof patch === "string" && SHA256_RE.test(patch) && pr.patchSha256 === patch && merge.patchSha256 === patch)) {
    failed.push("verify-passed");
  }
  if (!(review.verdict === "approve" && review.broken === 0 && review.flagged === 0 && typeof patch === "string" && review.patchSha256 === patch)) {
    failed.push("review-approve");
  }
  if (!(typeof triage.counterCount === "number" && Number.isFinite(triage.counterCount) && triage.counterCount > 0)) {
    failed.push("counter-check");
  }
  return { pass: failed.length === 0, failedChecks: failed };
}

// ---- What the loop records when it opens the pull request ------------------------------------------------------

/** The `summary.merge` record the loop writes when it opens a pull request auto-merge could apply to. Flat. */
export function mergeRecordAtOpen(input: {
  /** The safety floor on the verified patch (blastRadius.ts `assessMergeFloor`). */
  floor: BlastRadius;
  /** The merge case Gemini named for the incident (triage.ts): the decision this candidate exists for. */
  mergeCase: string;
  pr: PullRequestResult;
  patchSha256: string;
  /** The revision the patch was verified on: a later change to the same file there was never tested with it. */
  baseRevision: string;
  incident: Pick<Incident, "stackTrace" | "errorCode" | "errorName">;
  /**
   * The checkout's whole file list (`LoopSubject.repoFiles`). The stack is matched against all of it, as the pass
   * matches it: a frame that ends like the changed file but is another file of the repository (`admin/orders/index.ts`
   * against `orders/index.ts`) must not count, and only the full list can show the tie (#203). Empty: no frame counts.
   */
  repoFiles: readonly string[];
  now: Date;
}): Record<string, string | number | boolean | null> {
  const { floor, pr } = input;
  const causeFrame =
    floor.sourceFile !== undefined && input.repoFiles.includes(floor.sourceFile) && pathsFromStack(input.incident.stackTrace, input.repoFiles, [], 5).includes(floor.sourceFile);
  const head = pr.headSha !== undefined && SHA1_RE.test(pr.headSha) ? pr.headSha : null;
  const reason = !floor.allowed ? `floor:${floor.problems.join(",")}` : head === null ? "head-unknown" : null;
  return {
    state: reason === null ? "pending" : "skipped",
    ...(reason !== null && { reason }),
    kind: "code",
    mergeCase: input.mergeCase,
    number: pr.number,
    patchSha256: input.patchSha256,
    headSha: head,
    floor: floor.allowed ? "pass" : "fail",
    sourceFile: floor.sourceFile ?? null,
    baseRevision: input.baseRevision,
    causeFrame,
    causeCode: typeof input.incident.errorCode === "string" || typeof input.incident.errorName === "string",
    pendingSince: input.now.toISOString(),
  };
}

/**
 * The `summary.merge` record of the missing-index path's evidence pull request, when the admin listed its reserved case.
 * No model decided it and no floor is run: the patch is Starfish's own (indexFilePatch.ts adds index entries and nothing
 * else), and the index it records already exists in production. It still waits for green required checks.
 */
export function indexMergeRecordAtOpen(input: { pr: PullRequestResult; patchSha256: string; indexFile: string; baseRevision: string; now: Date }): Record<string, string | number | boolean | null> {
  const head = input.pr.headSha !== undefined && SHA1_RE.test(input.pr.headSha) ? input.pr.headSha : null;
  return {
    state: head === null ? "skipped" : "pending",
    ...(head === null && { reason: "head-unknown" }),
    kind: "index",
    mergeCase: INDEX_MERGE_CASE,
    number: input.pr.number,
    patchSha256: input.patchSha256,
    headSha: head,
    floor: "pass",
    sourceFile: input.indexFile,
    baseRevision: input.baseRevision,
    pendingSince: input.now.toISOString(),
  };
}

// ---- The evidence comment --------------------------------------------------------------------------------------

export interface EvidenceInput {
  cycleId: string;
  summary: Rec;
  checks: readonly CheckRun[];
  requiredChecks: readonly string[];
  headSha: string;
  fastRevertMinutes: number;
}

const codeSpan = (v: unknown, max: number) => `\`${String(v ?? "").replace(/[`\s]+/g, " ").slice(0, max)}\``;

/** The one comment posted on the pull request before Starfish merges it: what decided it and what every check saw. Inert, redacted text. */
export function mergeEvidenceText(input: EvidenceInput): string {
  const s = input.summary;
  const triage = rec(s.triage);
  const fix = rec(s.fix);
  const before = rec(s.before);
  const verify = rec(s.verify);
  const review = rec(s.review);
  const merge = rec(s.merge);
  const named = input.checks.filter((c) => input.requiredChecks.includes(c.name));
  const index = merge.kind === "index";
  const certainty = certaintyGate(s);
  const lines = [
    "## Starfish auto-merge: the evidence",
    "",
    `Every check passed, so Starfish is squash-merging this pull request at ${codeSpan(input.headSha, 40)}. Starfish runs no deploy itself, but this merge is a release: this repository's own CI/CD ships it.`,
    "",
    "### The decision",
    "",
    index
      ? `- Merge case ${codeSpan(merge.mergeCase, 40)}, listed by an admin: a missing Firestore index. No model decided it: Google's error named the exact index, which already exists in production; this adds its entry to ${codeSpan(merge.sourceFile, 200)} and nothing else.`
      : `- Gemini triaged the incident as merge case ${codeSpan(merge.mergeCase, 40)}, which an admin listed: ${inert(String(triage.reason ?? ""), 300).replace(/\s+/g, " ")}`,
    "",
    ...(index
      ? []
      : [
          "### The safety floor",
          "",
          `- One production file, ${codeSpan(merge.sourceFile, 200)}; any other file is a new test file made only of added lines (an existing test file is never changed)`,
          "- The files the verify gate saw the patch change are exactly the files this check read",
          "- Hard-exclude list (auth and access control, security rules, money paths, secrets, schema, dependencies, CI config, shared packages): no path word and no changed line matched it, and no statement of the function around any change (as the base revision has it) names access control, money or a secret (a word match, not a proof)",
          "- The changed code: at most 40 changed lines in the production file; no deciding line and no call removed; no network, process, dynamic-code, destructive or file-system call and no address added; no call added that the file did not already make (read by a scanner, not a proof)",
          "",
          "### How certain (reported, not required)",
          "",
          `- Test before the fix: **${inert(String(before.status ?? "missing"), 20)}** (the patch's tests alone on the base revision)`,
          `- Test after the fix: **${inert(String(verify.status ?? "missing"), 20)}** on patch SHA-256 ${codeSpan(verify.patchSha256, 64)}`,
          `- Adversarial review: **${inert(String(review.verdict ?? "missing"), 30)}**: ${Number(review.held ?? 0)} attacks held, ${Number(review.flagged ?? 0)} flagged, ${Number(review.broken ?? 0)} broken`,
          `- Counter-check: ${typeof triage.counterCount === "number" ? triage.counterCount : "missing"} errors over ${inert(String(triage.counterWindow ?? "an unknown window"), 20)}`,
          `- The old certainty gate: ${certainty.pass ? "would have passed" : `would not have passed (${certainty.failedChecks.join(", ")})`}`,
          `- Root cause, as the fixer put it: ${inert(String(fix.rootCause ?? ""), 300).replace(/\s+/g, " ")}`,
          "",
        ]),
    "### CI on this head",
    "",
    ...(named.length > 0 ? named.map((c) => `- ${codeSpan(c.name, 100)}: ${inert(c.conclusion ?? c.status, 20)} (check run ${c.id}${c.url ? `, ${codeSpan(c.url, 200)}` : ""})`) : ["- none"]),
    "",
    "Every run of each named check counts, re-runs included. Runs are counted only from the configured GitHub App; that tells apps apart, not workflows: every GitHub Actions workflow in this repository posts as the same app.",
    "",
    index
      ? "A revert of this change would not remove the index, so no revert watch is started; if the error comes back, the index path's own observation tells a person."
      : `If this error comes back within ${input.fastRevertMinutes} minutes of the merge, Starfish opens and merges a revert of it, and tells a person.`,
    "",
    `Run: ${codeSpan(input.cycleId, 128)}`,
    "",
  ];
  return redactPii(lines.join("\n")).slice(0, 12_000);
}

// ---- The merge step --------------------------------------------------------------------------------------------

export type AutoMergeConfig = Pick<
  StarfishConfig,
  "environment" | "incidentCollection" | "runCollection" | "verifyChecks" | "verifyCheckApp" | "maxPrChecksPerPass" | "maxMergesPerDay" | "mergeCheckWaitMinutes" | "fastRevertMinutes"
> &
  CycleConfig;

export type MergeClient = Pick<GithubClient, "readPullRequest" | "listCheckRuns" | "mergePullRequest" | "commentOnPullRequest" | "filesChangedSince">;

export interface AutoMergeDeps {
  db: Firestore;
  config: AutoMergeConfig;
  client: MergeClient;
  now: () => Date;
  /** This worker, for the claim on a candidate. */
  owner: string;
  /**
   * The switches, read FRESH each time it is asked (`mergeBlockedBy` over the current runtime settings). With a case:
   * that case must still be listed.
   */
  blockedBy: (mergeCase?: string) => Promise<string | null>;
  /** The incident's status right now, or null if it is gone. */
  incidentStatus: (incidentId: string) => Promise<IncidentStatus | null>;
  /**
   * The rules engine's cap on the incident right now (src/triageRules.ts `levelCap`: the admin's class rules and an
   * operator's correction), read fresh, or null when nothing holds it back. Any cap stops the merge: a cap is at most
   * "fix". Throws when it can't be read, so the candidate waits for the next pass rather than merging on a guess.
   */
  incidentCap: (incidentId: string) => Promise<LevelCap | null>;
  /** Tells a person. Never throws (slack.ts); absent: nobody is told, and the record says so. */
  notify?: (req: NotifyRequest) => Promise<DeliveryResult>;
}

export interface AutoMergeSummary {
  considered: number;
  merged: number;
  skipped: number;
  /** Still waiting on required checks. */
  waiting: number;
  errors: { cycleId: string; message: string }[];
  /** Automation is off: nothing was decided this pass. */
  paused?: boolean;
}

/** How long a claim on a candidate may stand before it is taken as interrupted. */
export const CLAIM_STALE_MS = 15 * 60_000;
const OPEN: readonly string[] = OPEN_INCIDENT_STATUSES;

const describe = (err: unknown) => redactPii(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300);
const ruleOf = (err: unknown) => {
  const rule = (err as { rule?: unknown } | null)?.rule;
  return typeof rule === "string" ? rule : "error";
};

/** A flat record as cycle.ts stores one: redacted, bounded, no nested values. */
export function flat(record: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return sanitizeEvent({ stage: "merge", type: "record", summary: "", record: record as Record<string, string | number | boolean | null> }).record ?? {};
}

/**
 * The finished (`done`) cycles of this environment whose `summary.<stage>.state` is one of `states`, at most `limit`.
 * Equality filters only, which Firestore can serve by merging single-field indexes; firestore.indexes.json also
 * carries the (environment, state, summary.<stage>.state) composite, so the query never depends on that. A seeded synthetic cycle (seedDemo.ts) is never one: nothing it names exists (#192).
 * A cycle still running (the loop records the merge candidate just before it finishes), or one that ended otherwise, is
 * never one either: `moveRecord` refuses to move its record, and a refusal read as the daily cap told a person every
 * pass that the cap was reached (#364). A revert record is only ever written on a done cycle, and done is final.
 */
export async function cyclesInState(db: Firestore, cfg: Pick<AutoMergeConfig, "cycleCollection" | "environment">, stage: "merge" | "revert", states: string[], limit: number) {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const snap = await db
    .collection(cfg.cycleCollection)
    .where("environment", "==", cfg.environment)
    .where("state", "==", "done")
    .where(`summary.${stage}.state`, "in", states)
    .limit(limit)
    .get();
  return snap.docs.filter((d) => d.data().synthetic !== true).map((d) => ({ id: d.id, data: d.data() }));
}

/**
 * Replace `summary.<stage>` on a finished cycle that opened a pull request, only while the current record still
 * satisfies `expect`: two passes racing cannot both move one candidate. With `counter`, the same transaction also counts
 * today's merge (and refuses at the cap). Returns false when the record had moved on, or the cap was reached. Each move
 * is also a run event (stage `merge` or `revert`, its new state as the type), through cycle.ts `updateSettledCycle`, so
 * the Runs page shows a merge, a skip or a revert, not only the candidate it recorded first (#421).
 */
export async function moveRecord(
  db: Firestore,
  cfg: CycleConfig,
  id: string,
  now: Date,
  stage: "merge" | "revert",
  expect: (current: Rec) => boolean,
  next: Record<string, unknown>,
  opts: { counter?: { ref: DocumentReference; cap: number }; also?: Record<string, Record<string, unknown>> } = {}
): Promise<boolean> {
  return updateSettledCycle(db, cfg, id, now, async (tx, d): Promise<SettledUpdate<boolean>> => {
    const counterSnap = opts.counter ? await tx.get(opts.counter.ref) : undefined;
    if (!d || d.state !== "done" || rec(rec(d.summary).pr).opened !== true) return { result: false };
    if (!expect(rec(rec(d.summary)[stage]))) return { result: false };
    let used = 0;
    if (opts.counter) {
      used = Number(counterSnap?.data()?.count ?? 0);
      if (used >= opts.counter.cap) return { result: false };
    }
    const counter = opts.counter;
    const records: Record<string, Record<string, unknown>> = { [stage]: flat(next) };
    for (const [k, v] of Object.entries(opts.also ?? {})) records[k] = flat(v);
    return {
      result: true,
      records,
      event: { stage, type: String(next.state), summary: moveSummary(stage, next), data: { ...(typeof next.reason === "string" && { reason: next.reason }) } },
      ...(counter && { also: (t: Transaction) => t.set(counter.ref, { count: used + 1 }, { merge: true }) }),
    };
  });
}

/** The one line a record's move puts in the run's event: fixed words per state, the PR number and the reason only. */
export function moveSummary(stage: "merge" | "revert", next: Record<string, unknown>): string {
  const n = typeof next.number === "number" ? ` #${next.number}` : "";
  const why = typeof next.reason === "string" && next.reason !== "" ? `: ${next.reason}` : "";
  if (stage === "merge") {
    switch (next.state) {
      case "merging":
        return `Merging the pull request${n}: its required checks passed`;
      case "merged":
        return `Starfish merged the pull request${n}`;
      case "skipped":
        return `Not auto-merged${why}`;
      default:
        return `Auto-merge: ${String(next.state)}${why}`;
    }
  }
  switch (next.state) {
    case "clear":
      return "The fast-revert watch saw no recurrence: the merge stands";
    case "opening":
      return "The incident came back after the merge: opening a revert";
    case "pending":
      return `Revert pull request${n} opened: waiting for its checks`;
    case "merging":
      return `Merging the revert${n}`;
    case "reverted":
      return next.by === "person" ? "A person merged the revert" : "Starfish merged the revert";
    case "escalated":
      return `Fast revert handed to a person${why}`;
    default:
      return `Fast revert: ${String(next.state)}${why}`;
  }
}

/** Tell a person about a candidate that will not merge. Never throws; returns what to record. */
export async function escalate(
  deps: { db: Firestore; config: Pick<AutoMergeConfig, "incidentCollection">; notify?: AutoMergeDeps["notify"] },
  cycle: { id: string; data: Rec },
  rule: string,
  reason: string
): Promise<string> {
  if (!deps.notify) return "none";
  try {
    const incidentId = String(cycle.data.incidentId ?? "");
    const incident = incidentId ? ((await deps.db.collection(deps.config.incidentCollection).doc(incidentId).get()).data() ?? {}) : {};
    const text = (v: unknown, fallback: string) => (typeof v === "string" && v !== "" ? v : fallback);
    const result = await deps.notify({
      cycleId: cycle.id,
      incidentId,
      functionName: text(incident.functionName, "unknown function"),
      service: text(incident.service, "unknown"),
      errorType: text(incident.errorType, "unknown"),
      occurrenceCount: typeof incident.occurrenceCount === "number" && Number.isFinite(incident.occurrenceCount) ? incident.occurrenceCount : null,
      path: "human",
      rule,
      reason,
    });
    return result.state;
  } catch {
    return "failed";
  }
}

const SKIP_WORDS: Record<string, string> = {
  "checks-failed": "A required check failed on the pull request's head.",
  "checks-timeout": "The required checks did not finish in time.",
  "checks-unreadable": "Starfish could not read every check run on the pull request's head, so a failure among them could not be ruled out.",
  "no-required-checks": "No required check is named, so nothing proves the pull request's head is green.",
  "head-changed": "The pull request's head is no longer the commit Starfish built from the verified patch.",
  "wrong-base": "The pull request no longer targets the configured base branch, so Starfish will not merge it anywhere.",
  "base-changed-same-file": "The base branch changed the same file after the fix was verified, so the merge was never tested.",
  "base-unknown": "Starfish could not tell what changed on the base branch since the fix was verified.",
  "daily-merge-cap": "Today's auto-merge cap is reached.",
  "evidence-not-posted": "The evidence could not be posted on the pull request, and Starfish never merges without it.",
  interrupted: "An earlier attempt to merge was interrupted, and a merge is never retried blindly.",
  "incident-reverted-before": "Starfish already reverted one of its own merges for this incident, or handed a person what its watch of one found.",
  "no-merge-case": "No merge case was decided for this incident, so it is not Starfish's to merge.",
  "incident-merge-watched": "Starfish merged a fix for this incident earlier, and that merge is still being watched for the incident coming back (or being reverted); a second fix must not take the revert's place.",
};

/** The most merged cycles of one incident read to confirm each one's watch closed clear. */
const MERGED_READ_CAP = 20;
/** Where an earlier merge's watch has not ended: it may still revert. */
const REVERT_OPEN_STATES = ["watching", "opening", "pending", "merging"];
/** Where an earlier merge was reverted, or its revert went to a person. */
const REVERT_DONE_STATES = ["reverted", "escalated"];

/**
 * Why an earlier Starfish merge for this incident holds a new one back, or null. `incident-merge-watched`: an earlier
 * merge's fast-revert watch has not ended, so the incident coming back now is that merge failing, and its revert, not a
 * second fix, is what follows (#240). `incident-reverted-before`: Starfish already reverted one (or a person was handed
 * its revert). A watch that closed `clear` holds nothing back. `self`, the cycle asking, never holds itself back (two
 * passes racing on one candidate). Equality queries only.
 */
export async function earlierMergeHolds(db: Firestore, cfg: Pick<CycleConfig, "cycleCollection">, incidentId: string, self?: string): Promise<string | null> {
  const cycles = db.collection(cfg.cycleCollection).where("incidentId", "==", incidentId);
  const others = async (q: typeof cycles, limit: number) => (await q.limit(limit + 1).get()).docs.filter((d) => d.id !== self).slice(0, limit);
  if ((await others(cycles.where("summary.revert.state", "in", REVERT_OPEN_STATES), 1)).length > 0) return "incident-merge-watched";
  if ((await others(cycles.where("summary.revert.state", "in", REVERT_DONE_STATES), 1)).length > 0) return "incident-reverted-before";
  // A merge under way has no watch yet; a merge recorded with no watch at all is not known to have been watched to the
  // end. Either holds the next one back. More merged cycles than are read here: not certain, so held as well.
  if ((await others(cycles.where("summary.merge.state", "==", "merging"), 1)).length > 0) return "incident-merge-watched";
  const merged = await others(cycles.where("summary.merge.state", "==", "merged"), MERGED_READ_CAP);
  if (merged.length >= MERGED_READ_CAP || merged.some((d) => rec(rec(d.data().summary).revert).state !== "clear")) return "incident-merge-watched";
  return null;
}

function skipSentence(reason: string): string {
  if (reason.startsWith("floor:")) return `The safety floor did not hold: ${reason.slice(6)}. The pull request stays open for a person.`;
  if (reason.startsWith("merge-refused:")) return `GitHub refused the merge (${reason.slice(14)}). The pull request stays open for a person.`;
  if (reason.startsWith("switch:")) return `Auto-merge is not allowed now (${reason.slice(7)}). The pull request stays open for a person.`;
  return `${SKIP_WORDS[reason] ?? `Auto-merge stopped: ${reason}.`} The pull request stays open for a person.`;
}

/** A pull request a person closed or merged, or an incident a person settled or that is gone, needs nobody told. */
const QUIET: ReadonlySet<string> = new Set(["pr-closed", "pr-merged-by-person", "incident-gone", "incident-resolved", "incident-ignored"]);

/** One bounded round of auto-merging. Never throws for one candidate: its error is kept and the next goes ahead. */
export async function runAutoMergeStep(deps: AutoMergeDeps): Promise<AutoMergeSummary> {
  const { db, config: cfg, client } = deps;
  const out: AutoMergeSummary = { considered: 0, merged: 0, skipped: 0, waiting: 0, errors: [] };
  const firstBlock = await deps.blockedBy();
  if (firstBlock === "automation-disabled") return { ...out, paused: true };
  const candidates = await cyclesInState(db, cfg, "merge", ["pending", "merging"], cfg.maxPrChecksPerPass);
  out.considered = candidates.length;

  for (const cycle of candidates) {
    try {
      const r = await mergeOne(deps, cycle);
      if (r === "merged") out.merged += 1;
      else if (r === "waiting") out.waiting += 1;
      else if (r === "paused") return { ...out, paused: true };
      else out.skipped += 1;
    } catch (err) {
      out.errors.push({ cycleId: cycle.id, message: describe(err) });
    }
  }
  return out;

  async function mergeOne(d: AutoMergeDeps, cycle: { id: string; data: Rec }): Promise<"merged" | "skipped" | "waiting" | "paused" | "unchanged"> {
    const summary = rec(cycle.data.summary);
    const merge = rec(summary.merge);
    const number = merge.number;
    const headSha = merge.headSha;
    const now = d.now();
    const isPending = (m: Rec) => m.state === "pending";
    // Only a finished cycle's candidate is decided (#364): before then nothing is sent, merged or counted.
    if (cycle.data.state !== "done") return "unchanged";
    // A PR retargeted to another base is refused by the client (#186): a decision for a person, not an error to retry.
    const readPr = async (n: number) => {
      try {
        return await client.readPullRequest(cycle.id, n);
      } catch (err) {
        if (ruleOf(err) === "wrong-base") return "wrong-base" as const;
        throw err;
      }
    };

    const skip = async (reason: string, from: (m: Rec) => boolean = isPending): Promise<"skipped" | "unchanged"> => {
      const escalation = QUIET.has(reason) ? "none" : await escalate(d, cycle, `auto-merge-${reason.split(":")[0]}`, skipSentence(reason));
      const moved = await moveRecord(db, cfg, cycle.id, now, "merge", from, { ...merge, state: "skipped", reason, escalation, decidedAt: now.toISOString() });
      return moved ? "skipped" : "unchanged";
    };

    // A claim left by a worker that stopped half-way: what happened on GitHub decides; a merge is never retried blindly.
    if (merge.state === "merging") {
      const claimedAt = Date.parse(String(merge.claimedAt ?? ""));
      if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < CLAIM_STALE_MS) return "unchanged";
      const stillMerging = (m: Rec) => m.state === "merging" && m.claimedAt === merge.claimedAt;
      if (typeof number === "number") {
        const pr = await readPr(number);
        if (pr !== "wrong-base" && pr.state === "merged" && pr.headSha === headSha && pr.mergeCommitSha) {
          return (await recordMerged(d, cycle, merge, pr.mergeCommitSha, pr.mergedAt ?? now.toISOString(), stillMerging)) ? "merged" : "unchanged";
        }
      }
      return skip("interrupted", stillMerging);
    }

    if (typeof number !== "number" || typeof headSha !== "string" || !SHA1_RE.test(headSha)) return skip("head-unknown");

    // The decision this candidate exists for: Gemini's merge case (or the index path's). None: a person's.
    const mergeCase = typeof merge.mergeCase === "string" && merge.mergeCase !== "" ? merge.mergeCase : undefined;
    if (mergeCase === undefined) return skip("no-merge-case");

    // The switches, fresh, with the case still listed. Automation off pauses; anything else is decided.
    const blocked = await d.blockedBy(mergeCase);
    if (blocked === "automation-disabled") return "paused";
    if (blocked !== null) return skip(`switch:${blocked}`);

    const incidentId = String(cycle.data.incidentId ?? "");
    const status = await d.incidentStatus(incidentId);
    if (status === null) return skip("incident-gone");
    if (!OPEN.includes(status)) return skip(`incident-${status}`);
    // An admin's rule or an operator's correction made since triage: "no further than fix" is a person merging.
    const cap = await d.incidentCap(incidentId);
    if (cap !== null) return skip(`capped:${cap.by}`);

    if (merge.floor !== "pass") return skip(`floor:${String(merge.reason ?? "not-recorded")}`);

    // An earlier merge for this incident still watched, or already reverted: a second try goes to a person (#240).
    const held = await earlierMergeHolds(db, cfg, incidentId, cycle.id);
    if (held !== null) return skip(held);

    const pr = await readPr(number);
    if (pr === "wrong-base") return skip("wrong-base");
    if (pr.state === "closed") return skip("pr-closed");
    if (pr.state === "merged") return skip("pr-merged-by-person");
    if (pr.headSha !== headSha) return skip("head-changed");

    // The checks ran on the base revision the patch was verified on. A later commit on the base branch that changed the
    // same file was never tested with it: a person merges that.
    const baseRevision = merge.baseRevision ?? rec(summary.verify).baseRevision;
    if (typeof baseRevision !== "string" || !SHA1_RE.test(baseRevision)) return skip("base-unknown");
    let changed: string[];
    try {
      changed = await client.filesChangedSince(baseRevision);
    } catch {
      return skip("base-unknown");
    }
    if (typeof merge.sourceFile !== "string" || changed.includes(merge.sourceFile)) return skip("base-changed-same-file");

    let runs: Awaited<ReturnType<MergeClient["listCheckRuns"]>> = [];
    try {
      if (cfg.verifyChecks.length > 0) runs = await client.listCheckRuns(headSha);
    } catch (err) {
      // Runs read only in part could hide the failure that matters (#205): a person decides, it is not retried.
      if (ruleOf(err) === "too-many-check-runs") return skip("checks-unreadable");
      throw err;
    }
    const checks = summarizeChecks(runs, cfg.verifyChecks, cfg.verifyCheckApp);
    if (checks.checks === "not-configured") return skip("no-required-checks");
    if (checks.checks === "failed") return skip("checks-failed");
    if (checks.checks !== "passed") {
      const since = Date.parse(String(merge.pendingSince ?? ""));
      if (!Number.isFinite(since) || now.getTime() - since > cfg.mergeCheckWaitMinutes * 60_000) return skip("checks-timeout");
      return "waiting";
    }

    // Claim it, counting today's merge in the same transaction: at the cap, it goes to a person.
    const day = now.toISOString().slice(0, 10);
    const counter = db.collection(cfg.runCollection).doc(`automerge_${cfg.environment}_${day}`);
    const claimedAt = now.toISOString();
    const claimed = await moveRecord(db, cfg, cycle.id, now, "merge", isPending, { ...merge, state: "merging", claimedBy: d.owner, claimedAt }, { counter: { ref: counter, cap: cfg.maxMergesPerDay } });
    if (!claimed) {
      // Refused with the record still pending on a finished cycle is the cap; anything else moved on without this pass.
      const doc = (await db.collection(cfg.cycleCollection).doc(cycle.id).get()).data();
      const fresh = rec(rec(doc?.summary).merge);
      return doc?.state === "done" && fresh.state === "pending" ? skip("daily-merge-cap") : "unchanged";
    }
    const mine = (m: Rec) => m.state === "merging" && m.claimedAt === claimedAt && m.claimedBy === d.owner;
    const claimedMerge = { ...merge, claimedBy: d.owner, claimedAt };

    // Asked once more right before acting: an admin who just turned it off, or an operator who just resolved, wins.
    const late = await d.blockedBy(mergeCase);
    const lateStatus = await d.incidentStatus(incidentId);
    if (late !== null || lateStatus === null || !OPEN.includes(lateStatus)) {
      return skipClaimed(late !== null ? `switch:${late}` : `incident-${lateStatus ?? "gone"}`);
    }

    try {
      await client.commentOnPullRequest(cycle.id, number, mergeEvidenceText({ cycleId: cycle.id, summary, checks: requiredRuns(runs, cfg.verifyChecks, cfg.verifyCheckApp), requiredChecks: cfg.verifyChecks, headSha, fastRevertMinutes: cfg.fastRevertMinutes }));
    } catch {
      return skipClaimed("evidence-not-posted");
    }
    let merged: { sha: string };
    try {
      merged = await client.mergePullRequest(cycle.id, number, headSha, {
        title: `Starfish: merge #${number} (${mergeCase})`,
        body: `Auto-merged by Starfish: merge case ${mergeCase}, and every check passed; the evidence is on the pull request.\n\nRun: ${cycle.id}\nPatch SHA-256: ${String(merge.patchSha256 ?? "")}`,
      });
    } catch (err) {
      return skipClaimed(`merge-refused:${ruleOf(err)}`);
    }
    return (await recordMerged(d, cycle, claimedMerge, merged.sha, now.toISOString(), mine)) ? "merged" : "unchanged";

    async function skipClaimed(reason: string): Promise<"skipped" | "unchanged"> {
      const escalation = QUIET.has(reason) ? "none" : await escalate(d, cycle, `auto-merge-${reason.split(":")[0]}`, skipSentence(reason));
      const moved = await moveRecord(db, cfg, cycle.id, now, "merge", mine, { ...claimedMerge, state: "skipped", reason, escalation, decidedAt: now.toISOString() });
      return moved ? "skipped" : "unchanged";
    }
  }

  /**
   * The merge, and the fast-revert watch it starts, in one write. An index evidence pull request starts none: reverting
   * the index file would not remove the index (and a deploy of the reverted file could), so its watch is closed `clear`
   * at once and the index path's own observation (observe.ts) tells a person if the error comes back.
   */
  async function recordMerged(d: AutoMergeDeps, cycle: { id: string }, merge: Rec, mergeSha: string, mergedAt: string, from: (m: Rec) => boolean): Promise<boolean> {
    const at = Date.parse(mergedAt);
    const until = new Date((Number.isFinite(at) ? at : d.now().getTime()) + d.config.fastRevertMinutes * 60_000).toISOString();
    const revert = merge.kind === "index" ? { state: "clear", reason: "index-not-reverted", mergeSha, mergedAt } : { state: "watching", mergeSha, mergedAt, until };
    return moveRecord(d.db, d.config, cycle.id, d.now(), "merge", from, { ...merge, state: "merged", mergeSha, mergedAt, decidedAt: d.now().toISOString() }, { also: { revert } });
  }
}

/** Firestore timestamp or ISO string, as milliseconds; undefined when neither. */
export function millis(v: unknown): number | undefined {
  if (v instanceof Timestamp) return v.toMillis();
  const t = v as { toMillis?: unknown } | null | undefined;
  if (typeof t?.toMillis === "function") return t.toMillis() as number;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
