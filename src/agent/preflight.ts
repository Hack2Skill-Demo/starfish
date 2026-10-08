/**
 * What must be true before the agent entrypoint may run anything (#74). Pure, so the refusals are tested.
 * Each problem is a sentence a person can act on; no problems means "may start", not "will succeed".
 * The entrypoint asks it twice: of the environment before anything is touched, and of the runtime settings
 * the pass will actually use (an admin can turn the dry run off from Settings, #137).
 */
import type { StarfishConfig } from "../config.js";
import { CI_SLACK_SECONDS } from "./verifyCi.js";
import { RUNNER_SLACK_SECONDS } from "./verifyRemote.js";

export type PreflightConfig = Pick<
  StarfishConfig,
  | "verifyIsolation"
  | "verifyCommand"
  | "githubRepo"
  | "dryRun"
  | "environment"
  | "verifyJobName"
  | "verifyBucket"
  | "verifyChecks"
  | "verifyTimeoutSeconds"
  | "leaseSeconds"
  | "cycleDeadlineMinutes"
  | "autoMerge"
  | "autoMergeTargets"
>;

/** A lease shorter than this could run out inside one model call, which nothing renews from the inside. */
export const MIN_LEASE_SECONDS = 60;

/** The longest one verify run may keep the loop waiting, by where it runs. */
export function verifyWaitSeconds(cfg: Pick<StarfishConfig, "verifyIsolation" | "verifyTimeoutSeconds">): number {
  if (cfg.verifyIsolation === "github-actions") return cfg.verifyTimeoutSeconds + CI_SLACK_SECONDS;
  if (cfg.verifyIsolation === "cloud-run-job") return cfg.verifyTimeoutSeconds + RUNNER_SLACK_SECONDS;
  return cfg.verifyTimeoutSeconds;
}

/**
 * Whether auto-merge's evidence (the "fails before" verify run) can be prepared for this target: the admin's switch on,
 * the target on the allowlist, and not a dry run. The automation switch and the merge freeze are left out: they are
 * pauses that change without a new pass, so the deadline is sized as if they allowed it.
 */
export function autoMergeMayApply(cfg: Pick<StarfishConfig, "autoMerge" | "autoMergeTargets" | "githubRepo" | "dryRun">): boolean {
  const repo = cfg.githubRepo.trim().toLowerCase();
  return cfg.autoMerge && !cfg.dryRun && repo !== "" && cfg.autoMergeTargets.some((t) => t.toLowerCase() === repo);
}

export function agentPreflight(cfg: PreflightConfig, token: string | undefined): string[] {
  const problems: string[] = [];
  if (cfg.verifyIsolation === "none") {
    problems.push(
      "STARFISH_VERIFY_ISOLATION is none: the verify step has nowhere safe to run, so the agent will not start. " +
        "How it is isolated is an open decision (#74); in-process is not a sandbox."
    );
  }
  if (cfg.verifyIsolation === "cloud-run-job") {
    if (cfg.verifyJobName === "") problems.push("STARFISH_VERIFY_ISOLATION is cloud-run-job but STARFISH_VERIFY_JOB is empty: there is no job to run the verify command in.");
    if (cfg.verifyBucket === "") problems.push("STARFISH_VERIFY_ISOLATION is cloud-run-job but STARFISH_VERIFY_BUCKET is empty: the source and the result have nowhere to pass through.");
  }
  if (cfg.verifyIsolation === "github-actions") {
    if (cfg.verifyChecks.length === 0) problems.push("STARFISH_VERIFY_ISOLATION is github-actions but STARFISH_VERIFY_CHECKS is empty: name the check runs of the target's CI that must pass.");
    if (token === undefined || token === "") problems.push("STARFISH_VERIFY_ISOLATION is github-actions, which pushes a branch for CI to judge even in a dry run, but STARFISH_GITHUB_TOKEN is not set.");
  }
  // With github-actions the target's CI is the judge and there is no command of our own to run.
  if (cfg.verifyIsolation !== "github-actions" && cfg.verifyCommand.trim() === "") {
    problems.push("STARFISH_VERIFY_COMMAND is empty: with nothing to prove a patch, none would ever be accepted.");
  }
  if (cfg.githubRepo.trim() === "") {
    problems.push("STARFISH_GITHUB_REPO is empty: there is no repository to read source from or open a pull request in.");
  }
  if (!cfg.dryRun && (token === undefined || token === "")) {
    problems.push("Dry run is off but STARFISH_GITHUB_TOKEN is not set: a pull request could not be opened.");
  }
  if (cfg.leaseSeconds < MIN_LEASE_SECONDS) {
    problems.push(
      `STARFISH_LEASE_SECONDS is ${cfg.leaseSeconds}: a lease under ${MIN_LEASE_SECONDS} seconds can run out inside one model call, and another worker would take the cycle over.`
    );
  }
  // One attempt can verify twice (one revision), and a resumed one first waits out the crashed worker's lease (#137).
  // Where auto-merge can apply, each of those also runs the patch's tests alone on the base revision first (the
  // "fails before" run, loop.ts), through the same verifier: two verify waits per try, four per attempt (#235).
  const mergeMayApply = autoMergeMayApply(cfg);
  const waitsPerTry = mergeMayApply ? 2 : 1;
  const minDeadlineSeconds = 2 * (waitsPerTry * verifyWaitSeconds(cfg) + cfg.leaseSeconds);
  if (cfg.cycleDeadlineMinutes * 60 < minDeadlineSeconds) {
    problems.push(
      `STARFISH_CYCLE_DEADLINE_MINUTES is ${cfg.cycleDeadlineMinutes}: shorter than twice ` +
        (mergeMayApply ? "two verify waits (auto-merge also runs the patch's tests alone first)" : "one verify wait") +
        ` plus the lease (${Math.ceil(minDeadlineSeconds / 60)} minutes here), so a cycle could die at its deadline in the middle of a verify. ` +
        "Keep it at several agent schedule intervals: a released cycle is retried by the next pass."
    );
  }
  return problems;
}
