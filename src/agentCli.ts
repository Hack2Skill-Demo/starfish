/**
 * `pnpm agent`: one run of the agent job (see src/agent/job.ts): pick the open incidents that need a cycle, check
 * out the target repository, and run triage -> fix -> verify -> review for each, by default as a DRY RUN that
 * opens nothing. The Cloud Run job's command is this file (scripts/deploy-gcp.sh, with DEPLOY_AGENT=1, which
 * has not been run against a real project). Exits 1 when a cycle threw, the run stopped early, or the job
 * refused to start, so Cloud Run, a scheduler or a shell sees it.
 *
 * It needs the store, Cloud Logging of the watched project (the counter-check) and Gemini; a GitHub token only
 * for a private repository and for opening pull requests, which a dry run never does.
 */
import { Logging } from "@google-cloud/logging";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadChildProcessBasics, loadConfig, loadGithubToken } from "./config.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { jobSucceeded, runAgentJob } from "./agent/job.js";

const config = loadConfig();
initializeApp({ projectId: config.projectId });
const db = getFirestore(config.databaseId);
const token = loadGithubToken();

const result = await runAgentJob({
  db,
  loader: new RuntimeConfigLoader(config),
  // Scoped to the watched project explicitly, as the ingest is: ambient resolution can read the wrong one.
  logging: new Logging({ projectId: config.watchedProjectId }),
  ...(token && { githubToken: token }),
  childEnv: loadChildProcessBasics(),
});

if (result.kind === "ran") {
  const s = result.summary;
  const states = s.results.map((r) => (r.result.kind === "finished" ? r.result.state : r.result.kind));
  console.log(`agent: ${s.considered} candidate(s), ${s.ran} run: ${states.join(", ") || "none"}${s.aborted ? " (stopped early: cycles kept failing)" : ""}`);
  for (const e of s.errors) console.error(`agent: ${e.incidentId}: ${e.message}`);
  console.log(`config from ${result.source}${result.problems.length ? `; settings not used: ${result.problems.join("; ")}` : ""}`);
} else if (result.kind === "stopped") {
  console.log(`agent: stopped: ${result.reason}`);
} else {
  console.error(`agent: ${result.kind}: ${result.reason}`);
}
process.exit(jobSucceeded(result) ? 0 : 1);
