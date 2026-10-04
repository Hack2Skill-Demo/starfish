/**
 * One run of the agent job (#74): resolve this run's settings, pick the incidents that need a cycle, check out
 * the target repository ONCE at its current head, and run each cycle through the loop (loop.ts) against it.
 * `src/agentCli.ts` is the entrypoint; everything here takes its readers and writers as arguments, so it is
 * tested with a real store, a real local git remote and a scripted model.
 *
 * What it will not do, on purpose:
 *   - Run a verify command in this process unless `agentAllowLocalVerify` says so. This job holds the store,
 *     Logging and Gemini credentials; the verify gate runs the target repository's own tests and is not a
 *     sandbox. With a verify command set and no allowance it REFUSES to start. The deployed job sets neither, so
 *     it never runs candidate code, and no patch is ever accepted: every cycle that reaches a patch ends
 *     waiting for a person. A separate credential-less runner for the verify step is not built (docs/deploy.md).
 *   - Open a pull request in a dry run (the default), without a token, or without a target repository.
 *   - Act when the runtime settings are unusable and no earlier valid ones are known (`actionsAllowed`), or when an
 *     admin has switched automation off: checked before anything is cloned and again before every stage.
 *   - Clone anything when there is nothing to work on.
 */
import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import type { EntryReader } from "../ingest/counterCheck.js";
import { redactPii } from "../ingest/redact.js";
import { createPullRequestOpener, type RunGit } from "../integrations/githubPr.js";
import type { RuntimeConfigLoader } from "../runtimeSettings.js";
import { OPEN_INCIDENT_STATUSES, type IncidentStatus } from "../types.js";
import { makeAutomationSwitch } from "./automationSwitch.js";
import { checkoutSource, type Checkout } from "./checkout.js";
import { runCycle, type LoopDeps } from "./loop.js";
import { runAgentPass, selectCandidates, type PassSummary } from "./pass.js";
import { buildLoopSubject, incidentFromDoc } from "./subject.js";
import type { AskJson } from "./triage.js";

export interface AgentJobDeps {
  db: Firestore;
  /** Reads the settings document each time it is asked: the kill switch is checked live, not once at start. */
  loader: RuntimeConfigLoader;
  /** The Cloud Logging reader for the WATCHED project (counter-check and samples). */
  logging: EntryReader;
  /** For a private repository and for opening a pull request. */
  githubToken?: string;
  /** What a child git may inherit: `loadChildProcessBasics()`. */
  childEnv: { PATH?: string; HOME?: string };
  now?: () => Date;
  ask?: AskJson;
  runGit?: RunGit;
  fetch?: typeof fetch;
  tmpDir?: string;
}

export type AgentJobResult =
  | { kind: "refused"; reason: string }
  | { kind: "skipped"; reason: string }
  /** An admin turned automation off: a deliberate stop, not a failure. */
  | { kind: "stopped"; reason: string }
  | { kind: "ran"; summary: PassSummary; source: string; problems: string[] };

/**
 * A run succeeded when it ran and nothing in it threw, or an admin switched automation off on purpose. A refusal
 * or a skip is a configuration to fix, so it fails.
 */
export function jobSucceeded(result: AgentJobResult): boolean {
  if (result.kind === "stopped") return true;
  return result.kind === "ran" && result.summary.errors.length === 0 && !result.summary.aborted;
}

const describeError = (err: unknown) => redactPii(err instanceof Error ? err.message : String(err)).slice(0, 300);

export async function runAgentJob(deps: AgentJobDeps): Promise<AgentJobResult> {
  const now = deps.now ?? (() => new Date());
  const resolved = await deps.loader.resolve(deps.db);
  const cfg: StarfishConfig = resolved.config;

  if (cfg.verifyCommand !== "" && !cfg.agentAllowLocalVerify) {
    return {
      kind: "refused",
      reason:
        "STARFISH_VERIFY_COMMAND is set, and this job holds the store, Logging and Gemini credentials. The verify gate runs the target " +
        "repository's own tests and is not a sandbox. Unset the command, or set STARFISH_AGENT_ALLOW_LOCAL_VERIFY=true on a machine that holds nothing worth stealing.",
    };
  }
  if (!resolved.actionsAllowed) return { kind: "skipped", reason: "the runtime settings are unusable and none is known good" };
  if (!cfg.automationEnabled) return { kind: "stopped", reason: "automation is switched off in the settings" };
  if (cfg.githubRepo === "") return { kind: "skipped", reason: "STARFISH_GITHUB_REPO is not set: there is no repository to work on" };

  const token = deps.githubToken?.trim() ? deps.githubToken.trim() : undefined;
  const openPullRequest =
    !cfg.dryRun && token !== undefined
      ? createPullRequestOpener(cfg, { token, env: deps.childEnv, ...(deps.fetch && { fetch: deps.fetch }), ...(deps.runGit && { runGit: deps.runGit }), ...(deps.tmpDir && { tmpDir: deps.tmpDir }) })
      : undefined;

  // One checkout for the whole run, taken when the first cycle needs it. A failed clone is not remembered:
  // the next candidate tries again, and `runAgentPass` stops after a few failures in a row.
  let checkout: Promise<Checkout> | undefined;
  const source = () => {
    checkout ??= checkoutSource(cfg, { ...(token && { token }), env: deps.childEnv, ...(deps.runGit && { runGit: deps.runGit }), ...(deps.tmpDir && { tmpDir: deps.tmpDir }) });
    checkout.catch(() => {
      checkout = undefined;
    });
    return checkout;
  };

  const owner = `agent-${randomUUID().slice(0, 8)}`;
  const incidents = deps.db.collection(cfg.incidentCollection);
  const readStatus = async (incidentId: string): Promise<IncidentStatus | null> => {
    const d = (await incidents.doc(incidentId).get()).data();
    return d === undefined ? null : (d.status as IncidentStatus);
  };

  const loop: LoopDeps = {
    db: deps.db,
    config: cfg,
    owner,
    now,
    ...(deps.ask && { ask: deps.ask }),
    incidentStatus: readStatus,
    // The kill switch, read fresh before every stage and failing closed (automationSwitch.ts).
    automationEnabled: makeAutomationSwitch(deps.loader, deps.db),
    ...(openPullRequest && { openPullRequest }),
    load: async (incidentId) => {
      const snap = await incidents.doc(incidentId).get();
      if (!snap.exists) return null;
      const status = snap.data()?.status as IncidentStatus;
      if (!(OPEN_INCIDENT_STATUSES as readonly string[]).includes(status)) return null;
      return buildLoopSubject(cfg, deps.logging, await source(), incidentFromDoc(incidentId, snap.data() ?? {}), status);
    },
  };

  try {
    const summary = await runAgentPass({
      select: (limit) => selectCandidates(deps.db, cfg, limit),
      run: (candidate) => runCycle(loop, { incidentId: candidate.incidentId, environment: cfg.environment, recurrence: candidate.recurrence }),
      maxCycles: cfg.agentMaxCycles,
      describeError,
    });
    return { kind: "ran", summary, source: resolved.source, problems: resolved.problems };
  } finally {
    if (checkout) await checkout.then((c) => c.cleanup()).catch(() => undefined);
  }
}
