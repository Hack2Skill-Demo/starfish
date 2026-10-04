/**
 * `pnpm agent`: one pass of the agent over the incident store (#74): pick open incidents with no settled cycle,
 * assemble each one's source, and run the loop. Dry run by default (nothing is opened), and it refuses to start
 * at all until the verify step's isolation is set on purpose (src/agent/preflight.ts).
 *
 * NOT the deployed job. It is not in the Dockerfile and `scripts/deploy-gcp.sh` does not schedule it: the
 * engine's own job must not run candidate code under the engine's credentials. Run it where that is acceptable.
 *
 * It reads the watched project's logs (counter-check and samples), the target repository (a shallow clone,
 * with STARFISH_GITHUB_TOKEN if one is set), writes Starfish's store, and calls Gemini. Exits 1 when a cycle
 * threw or the pass stopped early, 2 when preflight refused, 0 otherwise.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Logging } from "@google-cloud/logging";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadChildProcessBasics, loadConfig, loadGithubToken } from "./config.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { askJson } from "./vertex.js";
import { redactPii } from "./ingest/redact.js";
import { makeAutomationSwitch } from "./agent/automationSwitch.js";
import { createGitCheckout, createLoader } from "./agent/assemble.js";
import { runCycle } from "./agent/loop.js";
import { runAgentPass, selectCandidates } from "./agent/pass.js";
import { agentPreflight } from "./agent/preflight.js";
import { createPullRequestOpener } from "./integrations/githubPr.js";
import { INCIDENT_STATUSES, type IncidentStatus } from "./types.js";

const base = loadConfig();
const token = loadGithubToken();

const refused = agentPreflight(base, token);
if (refused.length > 0) {
  for (const p of refused) console.error(`agent: ${p}`);
  process.exit(2);
}

initializeApp({ projectId: base.projectId });
const db = getFirestore(base.databaseId);

// One snapshot of the runtime settings for the whole pass; the kill switch below re-reads them every time it is asked.
const settings = new RuntimeConfigLoader(base);
const resolved = await settings.resolve(db);
if (!resolved.actionsAllowed) {
  console.error(`agent: the runtime settings are unusable and nothing good is known (${resolved.problems.join("; ")}); not acting.`);
  process.exit(1);
}
const cfg = resolved.config;
if (cfg.verifyIsolation === "in-process") {
  console.warn("agent: verify runs IN THIS PROCESS (STARFISH_VERIFY_ISOLATION=in-process): not a sandbox.");
}

const loader = createLoader({
  db,
  config: cfg,
  logging: new Logging({ projectId: cfg.watchedProjectId }),
  checkout: createGitCheckout(cfg, { ...(token && { token }), env: loadChildProcessBasics() }),
});

const owner = `agent-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const deps = {
  db,
  config: cfg,
  owner,
  now: () => new Date(),
  ask: askJson,
  load: loader.load,
  incidentStatus: async (id: string): Promise<IncidentStatus | null> => {
    const snap = await db.collection(cfg.incidentCollection).doc(id).get();
    const status = snap.data()?.status;
    return snap.exists && INCIDENT_STATUSES.includes(status as IncidentStatus) ? (status as IncidentStatus) : null;
  },
  automationEnabled: makeAutomationSwitch(settings, db),
  // Absent in a dry run: the loop then ends a verified, reviewed patch as "waiting for a person" and opens nothing.
  ...(!cfg.dryRun && token && { openPullRequest: createPullRequestOpener(cfg, { token, env: loadChildProcessBasics() }) }),
};

let failed: boolean;
try {
  const summary = await runAgentPass({
    select: (limit) => selectCandidates(db, cfg, limit),
    run: (c) => runCycle(deps, { incidentId: c.incidentId, environment: cfg.environment, recurrence: c.recurrence }),
    maxCycles: cfg.maxCyclesPerPass,
    describeError: (err) => redactPii(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300),
  });
  console.log(`agent: ${summary.considered} candidate(s), ${summary.ran} run${cfg.dryRun ? " (dry run)" : ""}`);
  for (const r of summary.results) console.log(`  ${r.incidentId}: ${JSON.stringify(r.result)}`);
  for (const e of summary.errors) console.error(`  ${e.incidentId}: threw: ${e.message}`);
  if (summary.aborted) console.error("agent: stopped early: cycles kept throwing.");
  failed = summary.errors.length > 0 || summary.aborted;
} finally {
  await loader.disposeAll();
}
process.exit(failed ? 1 : 0);
