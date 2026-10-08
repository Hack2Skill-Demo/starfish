/**
 * Auto-merge (#9, docs/design/auto-merge-policy.md): Starfish merges the pull requests it can prove are safe, and
 * hands everything else to a person. Built for the demo target behind a default-off switch; never run against real
 * GitHub (tested with fakes and the Firestore emulator).
 *
 * NOTHING MERGES UNLESS ALL OF THIS HOLDS, checked again right before the merge:
 *   switches   automation on (the kill switch), dry run off, `autoMerge` on (an admin's setting, default off),
 *              `mergeFreeze` off (the global off switch), this deployment's `githubRepo` listed in
 *              `autoMergeTargets` (environment-only: the demo), and today's merges under `maxMergesPerDay`;
 *   gate 1     low blast radius: a static check of the verified patch (blastRadius.ts), recorded when the pull request
 *              was opened;
 *   gate 2     certainty: a pure function of the cycle's run record (`certaintyGate`): a structural cause, the test
 *              FAILING before the fix and the gate PASSING after it on the exact patch, the adversarial review
 *              approving that same patch with nothing broken or flagged, and a counter-check that counted errors;
 *   the PR     still open, from `starfish/<cycle>` into the configured base branch (a retargeted PR is refused, #186),
 *              its head the very commit Starfish built from the verified patch, and every run of every named required
 *              check (`verifyChecks`, posted by `verifyCheckApp`, #205) a success on that head: all of them, re-runs
 *              included (`filter=all`), and a head whose runs cannot all be read is handed to a person;
 *   evidence   posted on the pull request as one comment BEFORE the merge; a merge with no evidence does not happen.
 * Then one squash merge, with GitHub told the exact head (`sha`), so a head that moved refuses.
 *
 * Any gate that fails leaves the pull request open and tells a person (the same notify path the loop uses). It
 * never merges on "almost": a check still running waits (at most `mergeCheckWaitMinutes`), anything else is final.
 * A merge interrupted half-way is never retried blindly: the next pass reads the PR back and records what happened,
 * or hands it to a person.
 *
 * Where the pieces run: the loop (loop.ts) records the "fails before" run and gate 1 when it opens the pull request
 * (`summary.before`, `summary.merge` pending); this step, once per agent pass (agentCli.ts), takes each pending
 * candidate to merged or skipped. A merge starts the fast-revert watch (fastRevert.ts). Starfish never deploys: the
 * target's own CI/CD does, and Starfish cannot see when it finishes.
 */
import { Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { redactPii } from "../ingest/redact.js";
import { inert, type CheckRun, type GithubClient, type PullRequestResult } from "../integrations/githubPr.js";
import type { DeliveryResult, NotifyRequest } from "../integrations/slack.js";
import { OPEN_INCIDENT_STATUSES, type Incident, type IncidentStatus } from "../types.js";
import type { BlastRadius } from "./blastRadius.js";
import { sanitizeEvent, type CycleConfig } from "./cycle.js";
import { pathsFromStack } from "./pass.js";
import { requiredRuns, summarizeChecks } from "./reconcile.js";

// ---- Switches --------------------------------------------------------------------------------------------------

export type MergeSwitchConfig = Pick<
  StarfishConfig,
  "automationEnabled" | "dryRun" | "autoMerge" | "mergeFreeze" | "githubRepo" | "autoMergeTargets" | "fastRevertMinutes" | "fastRevertGraceMinutes"
>;

/**
 * Why nothing may merge right now, or null when the switches allow it. Pure. `automation-disabled` is a PAUSE (#133):
 * nothing is decided while automation is off. Every other reason is a decision: the candidate goes to a person.
 * A fast-revert window that ends before its grace does (`fastRevertMinutes` <= `fastRevertGraceMinutes`) watches
 * nothing, so a merge would have no safety net: that blocks merging too, rather than failing the whole job (#242).
 */
export function mergeBlockedBy(cfg: MergeSwitchConfig): string | null {
  if (!cfg.automationEnabled) return "automation-disabled";
  if (cfg.dryRun) return "dry-run";
  if (cfg.mergeFreeze) return "merge-freeze";
  if (!cfg.autoMerge) return "auto-merge-off";
  const repo = cfg.githubRepo.toLowerCase();
  if (repo === "" || !cfg.autoMergeTargets.some((t) => t.toLowerCase() === repo)) return "target-not-allowed";
  if (!(cfg.fastRevertMinutes > cfg.fastRevertGraceMinutes)) return "fast-revert-window-empty";
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
  gate1: BlastRadius;
  pr: PullRequestResult;
  patchSha256: string;
  incident: Pick<Incident, "stackTrace" | "errorCode" | "errorName">;
  /**
   * The checkout's whole file list (`LoopSubject.repoFiles`). The stack is matched against all of it, as the pass
   * matches it: a frame that ends like the changed file but is another file of the repository (`admin/orders/index.ts`
   * against `orders/index.ts`) must not count, and only the full list can show the tie (#203). Empty: no frame counts.
   */
  repoFiles: readonly string[];
  now: Date;
}): Record<string, string | number | boolean | null> {
  const { gate1, pr } = input;
  const causeFrame =
    gate1.sourceFile !== undefined && input.repoFiles.includes(gate1.sourceFile) && pathsFromStack(input.incident.stackTrace, input.repoFiles, [], 5).includes(gate1.sourceFile);
  const head = pr.headSha !== undefined && SHA1_RE.test(pr.headSha) ? pr.headSha : null;
  const reason = !gate1.allowed ? `gate1:${gate1.problems.join(",")}` : head === null ? "head-unknown" : null;
  return {
    state: reason === null ? "pending" : "skipped",
    ...(reason !== null && { reason }),
    number: pr.number,
    patchSha256: input.patchSha256,
    headSha: head,
    gate1: gate1.allowed ? "pass" : "fail",
    fixClass: gate1.fixClass ?? null,
    sourceFile: gate1.sourceFile ?? null,
    causeFrame,
    causeCode: typeof input.incident.errorCode === "string" || typeof input.incident.errorName === "string",
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

/** The one comment posted on the pull request before Starfish merges it: what every gate saw. Inert, redacted text. */
export function mergeEvidenceText(input: EvidenceInput): string {
  const s = input.summary;
  const triage = rec(s.triage);
  const fix = rec(s.fix);
  const before = rec(s.before);
  const verify = rec(s.verify);
  const review = rec(s.review);
  const merge = rec(s.merge);
  const named = input.checks.filter((c) => input.requiredChecks.includes(c.name));
  const lines = [
    "## Starfish auto-merge: the evidence",
    "",
    `Every gate passed, so Starfish is squash-merging this pull request at ${codeSpan(input.headSha, 40)}. It does not deploy: this repository's own CI/CD does.`,
    "",
    "### Gate 1: low blast radius",
    "",
    `- Class: ${codeSpan(merge.fixClass, 40)}, in one hunk of ${codeSpan(merge.sourceFile, 200)} with no function or class boundary between its changed lines and at least three lines of context on each side (fewer only at the file's start or end); any other file is a new test file made only of added lines (an existing test file is never changed)`,
    "- The files the verify gate saw the patch change are exactly the files this check read",
    "- Hard-exclude list (auth and access control, security rules, money paths, secrets, schema, dependencies, CI config, shared packages): no path word and no changed line matched it, and no statement that decides something in the whole enclosing function (as the base revision has it) names access control, money or a secret (a word match, not a proof)",
    "",
    "### Gate 2: certainty",
    "",
    `- Structural cause: the incident's stack trace names ${codeSpan(merge.sourceFile, 200)}`,
    `- Test before the fix: **${inert(String(before.status ?? "missing"), 20)}** (the patch's tests alone on the base revision; patch ${codeSpan(String(before.patchSha256 ?? "").slice(0, 12), 12)})`,
    `- Test after the fix: **${inert(String(verify.status ?? "missing"), 20)}** on patch SHA-256 ${codeSpan(verify.patchSha256, 64)}`,
    `- Adversarial review: **${inert(String(review.verdict ?? "missing"), 30)}**: ${Number(review.held ?? 0)} attacks held, ${Number(review.flagged ?? 0)} flagged, ${Number(review.broken ?? 0)} broken`,
    `- Counter-check: ${typeof triage.counterCount === "number" ? triage.counterCount : "missing"} errors over ${inert(String(triage.counterWindow ?? "an unknown window"), 20)}`,
    `- Root cause, as the fixer put it: ${inert(String(fix.rootCause ?? ""), 300).replace(/\s+/g, " ")}`,
    "",
    "### CI on this head",
    "",
    ...(named.length > 0 ? named.map((c) => `- ${codeSpan(c.name, 100)}: ${inert(c.conclusion ?? c.status, 20)} (check run ${c.id}${c.url ? `, ${codeSpan(c.url, 200)}` : ""})`) : ["- none"]),
    "",
    "Every run of each named check counts, re-runs included. Runs are counted only from the configured GitHub App; that tells apps apart, not workflows: every GitHub Actions workflow in this repository posts as the same app.",
    "",
    `If this error comes back within ${input.fastRevertMinutes} minutes of the merge, Starfish opens and merges a revert of it, and tells a person.`,
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
  /** The switches, read FRESH each time it is asked (`mergeBlockedBy` over the current runtime settings). */
  blockedBy: () => Promise<string | null>;
  /** The incident's status right now, or null if it is gone. */
  incidentStatus: (incidentId: string) => Promise<IncidentStatus | null>;
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
 * The cycles of this environment whose `summary.<stage>.state` is one of `states`, at most `limit`. Equality only: no
 * composite index. A seeded synthetic cycle (seedDemo.ts) is never one: nothing it names exists (#192).
 */
export async function cyclesInState(db: Firestore, cfg: Pick<AutoMergeConfig, "cycleCollection" | "environment">, stage: "merge" | "revert", states: string[], limit: number) {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const snap = await db.collection(cfg.cycleCollection).where("environment", "==", cfg.environment).where(`summary.${stage}.state`, "in", states).limit(limit).get();
  return snap.docs.filter((d) => d.data().synthetic !== true).map((d) => ({ id: d.id, data: d.data() }));
}

/**
 * Replace `summary.<stage>` on a finished cycle that opened a pull request, in a transaction, only while the current
 * record still satisfies `expect`: two passes racing cannot both move one candidate. With `counter`, the same
 * transaction also counts today's merge (and refuses at the cap). Returns false when the record had moved on, or the cap
 * was reached.
 */
export async function moveRecord(
  db: Firestore,
  cfg: Pick<AutoMergeConfig, "cycleCollection">,
  id: string,
  stage: "merge" | "revert",
  expect: (current: Rec) => boolean,
  next: Record<string, unknown>,
  opts: { counter?: { ref: DocumentReference; cap: number }; also?: Record<string, Record<string, unknown>> } = {}
): Promise<boolean> {
  const ref = db.collection(cfg.cycleCollection).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const counterSnap = opts.counter ? await tx.get(opts.counter.ref) : undefined;
    const d = snap.data();
    if (!d || d.state !== "done" || rec(rec(d.summary).pr).opened !== true) return false;
    if (!expect(rec(rec(d.summary)[stage]))) return false;
    if (opts.counter) {
      const used = Number(counterSnap?.data()?.count ?? 0);
      if (used >= opts.counter.cap) return false;
      tx.set(opts.counter.ref, { count: used + 1 }, { merge: true });
    }
    const update: Record<string, unknown> = { [`summary.${stage}`]: flat(next) };
    for (const [k, v] of Object.entries(opts.also ?? {})) update[`summary.${k}`] = flat(v);
    tx.update(ref, update);
    return true;
  });
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
  if (reason.startsWith("gate2:")) return `Gate 2 (certainty) did not hold: ${reason.slice(6)}. The pull request stays open for a person.`;
  if (reason.startsWith("gate1:")) return `Gate 1 (low blast radius) did not hold: ${reason.slice(6)}. The pull request stays open for a person.`;
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
      const moved = await moveRecord(db, cfg, cycle.id, "merge", from, { ...merge, state: "skipped", reason, escalation, decidedAt: now.toISOString() });
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

    // The switches, fresh. Automation off pauses; anything else is decided.
    const blocked = await d.blockedBy();
    if (blocked === "automation-disabled") return "paused";
    if (blocked !== null) return skip(`switch:${blocked}`);

    const incidentId = String(cycle.data.incidentId ?? "");
    const status = await d.incidentStatus(incidentId);
    if (status === null) return skip("incident-gone");
    if (!OPEN.includes(status)) return skip(`incident-${status}`);

    if (merge.gate1 !== "pass") return skip(`gate1:${String(merge.reason ?? "not-recorded")}`);
    const gate2 = certaintyGate(summary);
    if (!gate2.pass) return skip(`gate2:${gate2.failedChecks.join(",")}`);

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
    const baseRevision = rec(summary.verify).baseRevision;
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
    const claimed = await moveRecord(db, cfg, cycle.id, "merge", isPending, { ...merge, state: "merging", claimedBy: d.owner, claimedAt }, { counter: { ref: counter, cap: cfg.maxMergesPerDay } });
    if (!claimed) {
      const fresh = rec(rec((await db.collection(cfg.cycleCollection).doc(cycle.id).get()).data()?.summary).merge);
      return fresh.state === "pending" ? skip("daily-merge-cap") : "unchanged";
    }
    const mine = (m: Rec) => m.state === "merging" && m.claimedAt === claimedAt && m.claimedBy === d.owner;
    const claimedMerge = { ...merge, claimedBy: d.owner, claimedAt };

    // Asked once more right before acting: an admin who just turned it off, or an operator who just resolved, wins.
    const late = await d.blockedBy();
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
        title: `Starfish: merge #${number} (${String(merge.fixClass ?? "fix")})`,
        body: `Auto-merged by Starfish after every gate passed; the evidence is on the pull request.\n\nRun: ${cycle.id}\nPatch SHA-256: ${String(merge.patchSha256 ?? "")}`,
      });
    } catch (err) {
      return skipClaimed(`merge-refused:${ruleOf(err)}`);
    }
    return (await recordMerged(d, cycle, claimedMerge, merged.sha, now.toISOString(), mine)) ? "merged" : "unchanged";

    async function skipClaimed(reason: string): Promise<"skipped" | "unchanged"> {
      const escalation = QUIET.has(reason) ? "none" : await escalate(d, cycle, `auto-merge-${reason.split(":")[0]}`, skipSentence(reason));
      const moved = await moveRecord(db, cfg, cycle.id, "merge", mine, { ...claimedMerge, state: "skipped", reason, escalation, decidedAt: now.toISOString() });
      return moved ? "skipped" : "unchanged";
    }
  }

  /** The merge, and the fast-revert watch it starts, in one write. */
  async function recordMerged(d: AutoMergeDeps, cycle: { id: string }, merge: Rec, mergeSha: string, mergedAt: string, from: (m: Rec) => boolean): Promise<boolean> {
    const at = Date.parse(mergedAt);
    const until = new Date((Number.isFinite(at) ? at : d.now().getTime()) + d.config.fastRevertMinutes * 60_000).toISOString();
    return moveRecord(d.db, d.config, cycle.id, "merge", from, { ...merge, state: "merged", mergeSha, mergedAt, decidedAt: d.now().toISOString() }, {
      also: { revert: { state: "watching", mergeSha, mergedAt, until } },
    });
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
