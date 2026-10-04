/**
 * What must be true before the agent entrypoint may run anything (#74). Pure, so the refusals are tested.
 * Each problem is a sentence a person can act on; no problems means "may start", not "will succeed".
 */
import type { StarfishConfig } from "../config.js";

export type PreflightConfig = Pick<
  StarfishConfig,
  "verifyIsolation" | "verifyCommand" | "githubRepo" | "dryRun" | "environment"
>;

export function agentPreflight(cfg: PreflightConfig, token: string | undefined): string[] {
  const problems: string[] = [];
  if (cfg.verifyIsolation === "none") {
    problems.push(
      "STARFISH_VERIFY_ISOLATION is none: the verify step has nowhere safe to run, so the agent will not start. " +
        "How it is isolated is an open decision (#74); in-process is not a sandbox."
    );
  }
  if (cfg.verifyCommand.trim() === "") {
    problems.push("STARFISH_VERIFY_COMMAND is empty: with nothing to prove a patch, none would ever be accepted.");
  }
  if (cfg.githubRepo.trim() === "") {
    problems.push("STARFISH_GITHUB_REPO is empty: there is no repository to read source from or open a pull request in.");
  }
  if (!cfg.dryRun && (token === undefined || token === "")) {
    problems.push("Dry run is off but STARFISH_GITHUB_TOKEN is not set: a pull request could not be opened.");
  }
  return problems;
}
