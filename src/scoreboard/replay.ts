/**
 * The replay harness (#10): the agent's stages over a corpus of cases with known answers, written as one results
 * file in the scoreboard format (scoreboard/FORMAT.md), checked by the same strict parser `pnpm scoreboard` uses.
 *
 * It calls the loop's own stage functions (triageIncident, proposeFix, verifyPatch, reviewPatch) in the loop's order,
 * and takes the loop's own decisions after each (loop.ts `triageOptionsFor`, `afterFix`, `afterVerify`, `afterReview`,
 * #420): triage gets the admin's merge cases and class rules, the revision is the loop's one shared revision with the
 * loop's feedback, and a failure is retried or handed to a person by the same rule. It keeps its own model-call budget
 * count. What it does not run is what needs the store: the lease, run events, issues, Slack and the pull request. A
 * replay is always a dry run, so `openedPr` here means the cycle reached the pull-request step, where a live run would
 * open one. Nothing is opened, pushed or sent.
 *
 * Per case:
 *   code-fix / notify / decline   triage; on `act`, fix -> verify gate -> review (with one revision), and a patch that
 *                                  reaches the pull-request step is judged by the case's PRIVATE evaluator
 *                                  (evaluate.ts): `fixPassed` is that verdict, never the model's own claim. A patch
 *                                  the agent would not ship is `fixPassed: false`; no patch at all leaves it out.
 *   bad-patch                      the planted patch through the verify gate (it must pass, or the reviewer is never
 *                                  reached), then the reviewer: `reviewerBlocked` is whether it blocked. The reviewer
 *                                  runs here whatever `reviewRequired` says: it is what the case measures.
 * A model failure, a refused review, or a case that cannot run is `error`; a case over its time limit is `timeout`.
 * Both count against the agent (results.ts). Cost is left out: the model client reports no usage, and a missing
 * measurement is not a zero.
 *
 * Before any model call the corpus is checked (`checkCorpus`): a held-out case must still hash to what it was frozen
 * with; every code-fix evaluator must FAIL on the unpatched snapshot (the defect reproduces); every planted bad patch
 * must pass the target's gate and FAIL its evaluator (it really is bad). A corpus that fails any of these is not run.
 *
 * Not a sandbox: the corpus's commands and the model's patches run in this process (`pnpm replay` therefore requires
 * STARFISH_VERIFY_ISOLATION=in-process, said on purpose).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StarfishConfig } from "../config.js";
import { afterFix, afterReview, afterVerify, MAX_REVISIONS, triageOptionsFor } from "../agent/loop.js";
import { proposeFix, type FixRequest, type SourceFile } from "../agent/fixer.js";
import { reviewPatch } from "../agent/reviewer.js";
import { triageIncident, type AskJson, type TriageSubject } from "../agent/triage.js";
import { verifyPatch, type VerifyConfig } from "../agent/verifyGate.js";
import { caseHashOf, evaluatorProblems, readIncident, type Corpus, type CorpusCase } from "./corpus.js";
import { checkReproduces, evaluatePatch } from "./evaluate.js";
import { parseRun, type CaseOutcome, type CaseResult, type ScoreboardRun, type TriageCall } from "./results.js";

export type ReplayAgentConfig = Pick<
  StarfishConfig,
  "model" | "location" | "verifyTimeoutSeconds" | "patchExcludedPaths" | "reviewRequired" | "modelCallBudget" | "mergeCases" | "classRules"
>;

export interface ReplayOptions {
  corpus: Corpus;
  cfg: ReplayAgentConfig;
  /** The model. `askJson` (Gemini on Vertex) from the CLI; a stub in tests. */
  ask: AskJson;
  runId: string;
  starfishRevision: string;
  caseTimeoutMs: number;
  now?: () => Date;
  /** Told each case's ending, with a short reason made of rule names only (no model or log text). */
  onCase?: (caseId: string, outcome: CaseOutcome, note: string) => void;
}

export class ReplayError extends Error {}

/** A case that cannot be scored as it stands: recorded as `error`, with a rule-name note. */
class CaseError extends Error {}

const gateFor = (cfg: Pick<ReplayAgentConfig, "verifyTimeoutSeconds" | "patchExcludedPaths">, verifyCommand: string): VerifyConfig => ({
  verifyCommand,
  verifyTimeoutSeconds: cfg.verifyTimeoutSeconds,
  patchExcludedPaths: cfg.patchExcludedPaths,
});

function readFiles(c: CorpusCase): SourceFile[] {
  return c.files.map((path) => ({ path, content: readFileSync(join(c.repoDir!, path), "utf8") }));
}

/**
 * Everything that must hold before a model is asked anything, as a list of problems (empty: ready). Runs the
 * evaluators and the target's gate on the snapshots, so it executes the corpus's own commands, but nothing a model
 * wrote.
 */
export async function checkCorpus(corpus: Corpus, cfg: Pick<ReplayAgentConfig, "verifyTimeoutSeconds" | "patchExcludedPaths">): Promise<string[]> {
  const problems: string[] = [];
  for (const c of corpus.cases) {
    const where = `case "${c.caseId}"`;
    if (c.caseHash !== undefined) {
      const now = await caseHashOf(c);
      if (now !== c.caseHash) problems.push(`${where}: it no longer hashes to its frozen caseHash (now ${now}); a changed held-out case must be re-frozen and the change reported`);
    }
    try {
      readIncident(c);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
    const layout = await evaluatorProblems(c);
    problems.push(...layout);
    // An evaluator that cannot be laid over its snapshot cannot be run either.
    if (layout.length > 0) continue;
    if (c.path === "code-fix" && c.evaluator && c.repoDir) {
      const before = await checkReproduces({ repoDir: c.repoDir, evaluator: c.evaluator }, cfg);
      if (!before.reproduces) problems.push(`${where}: the evaluator does not fail on the unpatched snapshot (${before.result.rule}), so no fix could be credited`);
    }
    if (c.path === "bad-patch" && c.evaluator && c.repoDir && c.plantedPatchFile && c.verifyCommand) {
      const planted = readFileSync(c.plantedPatchFile, "utf8");
      const gate = await verifyPatch({ sourceDir: c.repoDir, patch: planted, config: gateFor(cfg, c.verifyCommand) });
      if (gate.status !== "passed") problems.push(`${where}: the planted patch does not pass the target's gate (${gate.rule}), so the reviewer would never see it`);
      const judged = await evaluatePatch({ repoDir: c.repoDir, evaluator: c.evaluator }, planted, cfg);
      if (judged.passed) problems.push(`${where}: the planted patch passes its evaluator, so it is not a bad patch`);
    }
  }
  return problems;
}

/** What the run of one non-bad-patch case came to. */
async function replayIncidentCase(c: CorpusCase, opts: ReplayOptions): Promise<{ outcome: CaseOutcome; note: string }> {
  const { cfg, ask } = opts;
  const subject: TriageSubject = { incident: readIncident(c), status: "new" };
  let modelCalls = 1;
  // As the loop does (#371): triage sees the files the fixer will, when the case has a snapshot, under the same rules.
  const files = c.repoDir ? readFiles(c) : [];
  const triage = await triageIncident(subject, ask, triageOptionsFor(cfg, files));
  if (triage.decision !== "act" && triage.decision !== "notify" && triage.decision !== "decline") {
    throw new CaseError(`triage ${triage.rule}`);
  }
  const call: TriageCall = triage.decision;
  const ended = (note: string, extra: Partial<CaseOutcome> = {}) => ({ outcome: { status: "completed" as const, triage: call, openedPr: false, ...extra }, note });
  if (call !== "act") return ended(`triage ${triage.rule}`);
  if (!c.repoDir || !c.verifyCommand) return ended("triage model-act; the case has no snapshot to fix");

  let feedback: FixRequest["feedback"];
  let proposedAny = false;
  const notShipped = (note: string) => ended(note, proposedAny ? { fixPassed: false } : {});
  for (let revisions = 0; ; revisions++) {
    if (modelCalls >= cfg.modelCallBudget) return notShipped("budget-exceeded");
    modelCalls += 1;
    const fix = await proposeFix({ subject, files, ...(feedback && { feedback }) }, ask);
    // A patch the agent would not ship counts as proposed (fixPassed false); no patch at all (a decline, a cut answer) does not.
    if (fix.outcome === "proposed" || fix.rule.startsWith("patch-")) proposedAny = true;
    const fixed = afterFix(fix);
    // What the loop would release for another attempt is a failure here: the replay has one attempt per case.
    if (fixed.next === "retry") throw new CaseError(`fix ${fixed.rule}`);
    if (fixed.next !== "verify") return notShipped(`fix ${fixed.rule}`);

    const verified = await verifyPatch({ sourceDir: c.repoDir, patch: fixed.patch, config: gateFor(cfg, c.verifyCommand) });
    const checked = afterVerify(verified, fixed.patch, revisions);
    if (checked.next === "revise") {
      feedback = checked.feedback;
      continue;
    }
    if (checked.next !== "review") return notShipped(checked.rule);

    if (cfg.reviewRequired) {
      if (modelCalls >= cfg.modelCallBudget) return notShipped("budget-exceeded");
      modelCalls += 1;
      const reviewed = await reviewPatch({ subject, patch: fixed.patch, verify: verified, files, claimed: { rootCause: fix.rootCause, risk: fix.risk ?? "" } }, ask);
      const judged = afterReview(reviewed, fixed.patch, revisions);
      if (judged.next === "revise") {
        feedback = judged.feedback;
        continue;
      }
      if (judged.next === "retry") throw new CaseError(`review ${judged.rule}`);
      if (judged.next === "person") {
        // A review that never happened is the harness's failure; a blocked one is the agent not shipping.
        if (reviewed.verdict === undefined) throw new CaseError(`review ${judged.rule}`);
        return notShipped(judged.rule);
      }
    }

    // The pull-request step. Only a code-fix case carries an evaluator; for any other the call to act was already wrong.
    if (!c.evaluator) return ended("reached the pull-request step (dry run)", { openedPr: true });
    const judgedByEvaluator = await evaluatePatch({ repoDir: c.repoDir, evaluator: c.evaluator }, fixed.patch, cfg);
    return ended(`reached the pull-request step (dry run); evaluator ${judgedByEvaluator.result.rule}`, { openedPr: true, fixPassed: judgedByEvaluator.passed });
  }
}

async function replayBadPatchCase(c: CorpusCase, opts: ReplayOptions): Promise<{ outcome: CaseOutcome; note: string }> {
  const subject: TriageSubject = { incident: readIncident(c), status: "new" };
  const patch = readFileSync(c.plantedPatchFile!, "utf8");
  const verified = await verifyPatch({ sourceDir: c.repoDir!, patch, config: gateFor(opts.cfg, c.verifyCommand!) });
  if (verified.status !== "passed") throw new CaseError(`planted patch verify-${verified.rule}`);
  const reviewed = await reviewPatch({ subject, patch, verify: verified, files: readFiles(c), claimed: c.claimed! }, opts.ask);
  if (reviewed.verdict === undefined) throw new CaseError(`review ${reviewed.rule}`);
  return { outcome: { status: "completed", reviewerBlocked: reviewed.verdict === "block" }, note: `review ${reviewed.verdict}` };
}

class CaseTimeout extends Error {}

/** One case to its ending. Never throws: an error or a timeout is that case's outcome. */
async function replayCase(c: CorpusCase, opts: ReplayOptions): Promise<{ outcome: CaseOutcome; note: string }> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CaseTimeout()), opts.caseTimeoutMs);
  });
  try {
    const work = c.path === "bad-patch" ? replayBadPatchCase(c, opts) : replayIncidentCase(c, opts);
    // The losing promise is left to settle on its own: the gate's command has its own timeout, a model call ends.
    work.catch(() => undefined);
    const r = await Promise.race([work, deadline]);
    return { outcome: { ...r.outcome, latencyMs: Date.now() - started }, note: r.note };
  } catch (e) {
    const latencyMs = Date.now() - started;
    if (e instanceof CaseTimeout) return { outcome: { status: "timeout", latencyMs }, note: `over ${opts.caseTimeoutMs} ms` };
    // A CaseError's message is rule names; anything else is reduced to its name, since a message can quote case text.
    return { outcome: { status: "error", latencyMs }, note: e instanceof CaseError ? e.message : `threw ${e instanceof Error ? e.name : "a non-error"}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks the corpus, runs every case in manifest order, and returns the results file, already validated by the
 * scoreboard's strict parser. Throws ReplayError (and asks the model nothing) when the corpus is not fit to run.
 */
export async function runReplay(opts: ReplayOptions): Promise<ScoreboardRun> {
  const { corpus, cfg } = opts;
  const problems = await checkCorpus(corpus, cfg);
  if (problems.length > 0) throw new ReplayError(`the corpus is not fit to run:\n  ${problems.join("\n  ")}`);
  const ranAt = (opts.now ?? (() => new Date()))().toISOString();
  const cases: CaseResult[] = [];
  for (const c of corpus.cases) {
    const { outcome, note } = await replayCase(c, opts);
    opts.onCase?.(c.caseId, outcome, note);
    cases.push({
      caseId: c.caseId,
      split: c.split,
      path: c.path,
      ...(c.expectedTriage !== undefined && { expectedTriage: c.expectedTriage }),
      ...(c.caseHash !== undefined && { caseHash: c.caseHash }),
      outcome,
    });
  }
  const run = {
    version: 1,
    runId: opts.runId,
    corpusVersion: corpus.corpusVersion,
    appRevision: corpus.appRevision,
    starfishRevision: opts.starfishRevision,
    model: cfg.model,
    ranAt,
    configuration: {
      harness: "replay",
      dryRun: true,
      syntheticCorpus: corpus.synthetic,
      location: cfg.location,
      reviewRequired: cfg.reviewRequired,
      modelCallBudget: cfg.modelCallBudget,
      revisionBudget: MAX_REVISIONS,
      verifyTimeoutSeconds: cfg.verifyTimeoutSeconds,
      caseTimeoutSeconds: opts.caseTimeoutMs / 1000,
      verifyIsolation: "in-process",
    },
    cases,
  };
  // The same check `pnpm scoreboard` applies: a file this writes is a file the scoreboard accepts.
  return parseRun(JSON.parse(JSON.stringify(run)));
}
