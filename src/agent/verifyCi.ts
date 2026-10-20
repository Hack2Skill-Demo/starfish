/**
 * The CI-backed verify step (#74, `STARFISH_VERIFY_ISOLATION=github-actions`): a drop-in for `verifyPatch` in which the
 * TARGET repository's own CI, on GitHub's disposable runners, runs the tests, and this process runs nothing of the
 * target's.
 *
 *   1. The deterministic half of the gate runs here first (`check`): the patch must apply, touch no excluded path
 *      (`.github/` is one, so a patch cannot rewrite the workflow that judges it), add no link and change no mode.
 *      Nothing the patch contains is executed. A refusal is returned as it is and nothing is pushed.
 *   2. The patch is pushed as one commit on `starfish/<cycle>` on top of the pinned revision (githubPr.ts).
 *   3. The named check runs on that exact commit, posted by `verifyCheckApp` (GitHub Actions unless configured; a run of
 *      that name from another GitHub App is ignored, #205, though every workflow of the target repository posts as
 *      `github-actions`), are waited for. All of them must succeed. The commit is the evidence:
 *      checks belong to a commit, and the commit is the patch applied to the revision it was written against.
 *   4. A branch THIS CALL pushed whose patch did not pass is deleted, so the next draft in the cycle can use the name;
 *      one that passed stays, and the pull request is opened from it (the opener finds it is exactly this change). In a
 *      dry run (`dryRun`) nothing will be opened from it, so a passed branch is deleted too; the check runs, and the
 *      verdict recorded on the cycle, outlive it. A branch this call did not push (the push was refused because a pull
 *      request already uses it, #134) is never deleted, and neither is one once the cycle's lease is lost: the cycle's
 *      new holder may be using it.
 *
 * Verdicts, by the same rule as the reconciler's (reconcile.ts `summarizeChecks`, #428). All named checks succeeded:
 * `passed`. A run of a named check finished any other way: `failed`, at once, whether or not the others have finished
 * (nothing they do can make the patch pass), with what the checks said (names, conclusions, their summaries, a few
 * annotations) as the fixer's feedback; this is thinner than a test log. None failed, and a named check still RUNNING
 * at the deadline: `timeout`. A named check that never appeared, or is still only queued, is the infrastructure's (the
 * target's workflow does not run on `starfish/**`, no runner), not the patch's: it THROWS, and the cycle is resumed and
 * counted against its attempts.
 *
 * Trust, plainly: the target's CI is now the judge and the sandbox. Its workflow runs the patch's code on a push to a
 * branch in the target repository, where that workflow's secrets are available to it; the workflow that judges Starfish's
 * patches must hold none (the deploy docs say so). A branch is pushed even in a dry run.
 *
 * While it waits it calls the request's `heartbeat` on every poll, which keeps the cycle's lease alive and throws once
 * it is lost (#132).
 */
import { createHash } from "node:crypto";
import type { StarfishConfig } from "../config.js";
import { redactHead, redactTail } from "../ingest/redact.js";
import type { CheckAnnotation, CheckRun, GithubClient } from "../integrations/githubPr.js";
import { MAX_OUTPUT_CHARS, verifyPatch, type VerifyRequest, type VerifyResult } from "./verifyGate.js";
import { VerifyRunnerError } from "./verifyProtocol.js";
import { requiredRuns, summarizeChecks } from "./reconcile.js";

export type CiClient = Pick<GithubClient, "pushPatchBranch" | "deleteBranch" | "listCheckRuns" | "annotations">;

export interface CiVerifyDeps {
  client: CiClient;
  /** The gate's own checks without running anything: defaults to `verifyPatch` with the no-op command `true`. */
  check?: (req: VerifyRequest) => Promise<VerifyResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export type CiVerifyConfig = Pick<StarfishConfig, "verifyTimeoutSeconds" | "verifyChecks" | "verifyCheckApp" | "dryRun">;

/** Time for a runner to be assigned and start, on top of the limit for the checks themselves. */
export const CI_SLACK_SECONDS = 600;
const MAX_FAILED_DETAILS = 5;
const MAX_ANNOTATIONS_SHOWN = 5;

/** The default `check`: the gate with a command that executes nothing of the patch's. */
const localCheck = (req: VerifyRequest): Promise<VerifyResult> => verifyPatch({ ...req, config: { ...req.config, verifyCommand: "true" } });

export function createCiVerifier(cfg: CiVerifyConfig, deps: CiVerifyDeps): (req: VerifyRequest) => Promise<VerifyResult> {
  if (cfg.verifyChecks.length === 0) throw new VerifyRunnerError("no check is named as the judge (STARFISH_VERIFY_CHECKS)");
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 10_000;
  const check = deps.check ?? localCheck;
  const { client } = deps;

  return async (req) => {
    const started = now();
    if (req.cycleId === undefined) throw new VerifyRunnerError("the CI verifier needs the cycle id to name the branch");
    if (req.baseRevision === undefined) throw new VerifyRunnerError("the CI verifier needs the pinned base revision");
    const patchSha256 = createHash("sha256").update(req.patch).digest("hex");

    // Step 1: everything the gate can judge without running the patch's code. Refused here, nothing leaves this process.
    const local = await check(req);
    if (local.status !== "passed") return local;

    const done = (status: VerifyResult["status"], rule: VerifyResult["rule"], reason: string, output: string, exitCode: number | null): VerifyResult => ({
      status,
      rule,
      reason: redactHead(reason, 500),
      patchSha256,
      baseRevision: req.baseRevision,
      changedFiles: local.changedFiles,
      exitCode,
      output: redactTail(output, MAX_OUTPUT_CHARS),
      durationMs: now() - started,
    });

    // Step 4 deletes only what this call pushed, and nothing once the lease is gone (#134, #132).
    let pushed = false;
    let kept = false;
    let leaseGone = false;
    const beat = async (): Promise<void> => {
      if (!req.heartbeat) return;
      try {
        await req.heartbeat();
      } catch (err) {
        leaseGone = true;
        throw err;
      }
    };
    try {
      // Step 2.
      const { commit } = await client.pushPatchBranch({ cycleId: req.cycleId, baseRevision: req.baseRevision, patch: req.patch, patchSha256, rootCause: "a proposed fix, being verified" });
      pushed = true;
      const where = commit.slice(0, 12);
      const names = cfg.verifyChecks;

      // Step 3.
      const deadline = now() + (cfg.verifyTimeoutSeconds + CI_SLACK_SECONDS) * 1000;
      for (;;) {
        const all = await client.listCheckRuns(commit);
        const runs = requiredRuns(all, names, cfg.verifyCheckApp);
        const judged = summarizeChecks(all, names, cfg.verifyCheckApp).checks;
        if (judged === "passed") {
          kept = !cfg.dryRun;
          return done("passed", "command-passed", `The target's CI passed (${names.join(", ")}) on ${where}.`, summarize(runs, []), 0);
        }
        if (judged === "failed") {
          const bad = runs.filter((r) => r.status === "completed" && r.conclusion !== "success");
          const details = await describeFailures(client, bad);
          return done("failed", "command-failed", `The target's CI did not pass on ${where}: ${bad.map((r) => `${r.name} ${r.conclusion ?? r.status}`).join(", ")}.`, summarize(runs, details), 1);
        }
        const missing = names.filter((n) => !runs.some((r) => r.name === n));
        const unfinished = runs.filter((r) => r.status !== "completed");
        if (now() >= deadline) {
          if (missing.length === 0 && unfinished.some((r) => r.status === "in_progress")) {
            return done("timeout", "command-timeout", `The target's CI had not finished on ${where} within ${cfg.verifyTimeoutSeconds + CI_SLACK_SECONDS} seconds.`, summarize(runs, []), null);
          }
          throw new VerifyRunnerError(
            missing.length > 0
              ? `CI reported no check named ${missing.map((m) => `"${m}"`).join(", ")} on ${where}: does the target's workflow run on push to starfish/**, under that name?`
              : `CI had not started ${unfinished.map((r) => `"${r.name}"`).join(", ")} on ${where} by the deadline (no runner?)`
          );
        }
        await beat();
        await sleep(pollMs);
      }
    } finally {
      // Step 4. Best effort: a branch left behind is a nuisance, and the next push of this cycle replaces it.
      if (pushed && !kept && !leaseGone) await client.deleteBranch(req.cycleId).catch(() => undefined);
    }
  };
}

interface FailureDetail {
  run: CheckRun;
  annotations: CheckAnnotation[];
}

async function describeFailures(client: CiClient, bad: CheckRun[]): Promise<FailureDetail[]> {
  const out: FailureDetail[] = [];
  for (const run of bad.slice(0, MAX_FAILED_DETAILS)) {
    // The annotations are the closest the API gives to "what failed". Missing is not an error: the verdict stands.
    out.push({ run, annotations: await client.annotations(run.id).catch(() => []) });
  }
  return out;
}

/**
 * GitHub's annotation levels, most telling first. A runner adds its own warnings to every job (a deprecated Node for
 * the actions, say), often before the step's error; the run event keeps only the first few hundred characters of the
 * output, so a warning listed first hid the error that failed the patch. Unknown levels go last; order is otherwise kept.
 */
const LEVEL_ORDER = ["failure", "warning", "notice"];

function failuresFirst(annotations: CheckAnnotation[]): CheckAnnotation[] {
  const rank = (a: CheckAnnotation): number => {
    const i = LEVEL_ORDER.indexOf(a.level);
    return i === -1 ? LEVEL_ORDER.length : i;
  };
  return [...annotations].sort((a, b) => rank(a) - rank(b));
}

/** What the checks said, for the fixer and for people. Every string in it was scrubbed by the client and is bounded. */
function summarize(runs: CheckRun[], failures: FailureDetail[]): string {
  const lines = runs.map((r) => `${r.name}: ${r.conclusion ?? r.status}${r.url ? ` (${r.url})` : ""}`);
  for (const { run, annotations } of failures) {
    if (run.title || run.summary) lines.push(`${run.name}: ${[run.title, run.summary].filter(Boolean).join(" - ")}`);
    for (const a of failuresFirst(annotations).slice(0, MAX_ANNOTATIONS_SHOWN)) lines.push(`  ${a.level} ${a.path}${a.line ? `:${a.line}` : ""} ${a.message}`);
  }
  return lines.join("\n");
}
