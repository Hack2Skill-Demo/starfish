/**
 * `pnpm agent`: one pass of the agent over the incident store (#74): pick open incidents with no settled cycle,
 * assemble each one's source, and run the loop. Dry run by default (nothing is opened), and it refuses to start
 * at all until the verify step's isolation is set on purpose (src/agent/preflight.ts).
 *
 * Where the verify step runs is STARFISH_VERIFY_ISOLATION. `github-actions` pushes the patch to a starfish/<cycle> branch
 * and lets the target's own CI judge it (src/agent/verifyCi.ts). `in-process` runs the target's tests in this process
 * as this identity: not a sandbox, so only where that is acceptable. `cloud-run-job` hands the source and the patch
 * to a separate job whose service account holds no roles and waits for its result, so this process, which holds
 * the credentials, never runs the target's code (src/agent/verifyRemote.ts). `scripts/deploy-gcp.sh` deploys this
 * as a Cloud Run job with DEPLOY_AGENT=1 and the second isolation; neither has run against a real project.
 *
 * It reads the watched project's logs (counter-check and samples), the target repository (a shallow clone,
 * with STARFISH_GITHUB_TOKEN if one is set), writes Starfish's store, and calls Gemini. After the pass, with a GitHub
 * client, it reads back the pull requests earlier cycles opened (src/agent/reconcile.ts), takes auto-merge candidates
 * to merged or to a person (src/agent/autoMerge.ts, #9: only where an admin turned it on for an allowed target), and
 * watches Starfish's own merges for the fast-revert (src/agent/fastRevert.ts). Exits 1 when a cycle threw, the pass
 * stopped early, reading pull requests back stopped (credentials, rate limit) or a merge step failed as a whole, 2 when
 * preflight refused, 0 otherwise.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Logging } from "@google-cloud/logging";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadChildProcessBasics, loadConfig, loadGithubToken, loadSlackAlertsWebhook, loadSlackOnCallWebhook, loadTwilioCredentials } from "./config.js";
import { RuntimeConfigLoader } from "./runtimeSettings.js";
import { createAskJson } from "./vertex.js";
import { redactPii } from "./ingest/redact.js";
import { makeAutomationSwitch, makeMergeSwitch } from "./agent/automationSwitch.js";
import { runAutoMergeStep } from "./agent/autoMerge.js";
import { runFastRevertStep } from "./agent/fastRevert.js";
import { createGitCheckout, createLoader } from "./agent/assemble.js";
import { giveUpStrandedCycles, runCycle } from "./agent/loop.js";
import { countCyclesStartedToday, findStrandedCycles, runAgentPass, selectCandidates } from "./agent/pass.js";
import { reconcilePullRequests } from "./agent/reconcile.js";
import { recordIntegrations } from "./agent/integrations.js";
import { agentPreflight } from "./agent/preflight.js";
import { createCloudRunJobStarter, createGcsStore } from "./agent/cloudRunJob.js";
import { createRemoteVerifier } from "./agent/verifyRemote.js";
import { createCiVerifier } from "./agent/verifyCi.js";
import { createGithubClient } from "./integrations/githubPr.js";
import { createSlackAlerter, createSlackNotifier } from "./integrations/slack.js";
import { INCIDENT_STATUSES, type IncidentStatus } from "./types.js";
import { parseAllowedTargets } from "./indexheal/createIndexUrl.js";
import { createFirestoreAdmin } from "./indexheal/firestoreAdmin.js";
import { observeIndexHeals } from "./indexheal/observe.js";
import { createIndexProbe } from "./indexheal/probe.js";
import { createFirestoreProbeRunner } from "./indexheal/probeFirestore.js";
import type { IndexHealWiring } from "./agent/indexPath.js";
import { runEscalationTick } from "./oncall/escalation.js";
import { createTwilioClient } from "./oncall/twilio.js";

const base = loadConfig();
const token = loadGithubToken();
const slackOnCall = loadSlackOnCallWebhook();
const slackAlerts = loadSlackAlertsWebhook();
const twilioCredentials = loadTwilioCredentials();

const refused = agentPreflight(base, token);
if (refused.length > 0) {
  for (const p of refused) console.error(`agent: ${p}`);
  process.exit(2);
}

const app = initializeApp({ projectId: base.projectId });
const db = getFirestore(base.databaseId);

// One snapshot of the runtime settings for the whole pass; the kill switch below re-reads them every time it is asked.
const settings = new RuntimeConfigLoader(base);
const resolved = await settings.resolve(db);
if (!resolved.actionsAllowed) {
  console.error(`agent: the runtime settings are unusable and nothing good is known (${resolved.problems.join("; ")}); not acting.`);
  process.exit(1);
}
const cfg = resolved.config;
// Tell the Settings page which credentials this job holds (booleans only; best effort, the pass does not depend on it).
if (!(await recordIntegrations(db, cfg, { github: token !== undefined, slackOnCall: slackOnCall !== undefined, slackAlerts: slackAlerts !== undefined, twilio: twilioCredentials !== undefined }))) {
  console.warn("agent: could not record which integrations are configured; the Settings page will not show it.");
}
// Preflight again on what the pass will actually use: an admin can turn the dry run off from Settings (#137).
const refusedAtRuntime = agentPreflight(cfg, token);
if (refusedAtRuntime.length > 0) {
  for (const p of refusedAtRuntime) console.error(`agent: runtime settings: ${p}`);
  process.exit(2);
}
if (cfg.verifyIsolation === "in-process") {
  console.warn("agent: verify runs IN THIS PROCESS (STARFISH_VERIFY_ISOLATION=in-process): not a sandbox.");
}

// One GitHub client for the pull request and, with `github-actions`, for the branch CI judges. Built only when one of
// them needs it, so a dry run with another isolation never constructs it.
const github =
  token && (cfg.verifyIsolation === "github-actions" || !cfg.dryRun)
    ? createGithubClient(cfg, { token, env: loadChildProcessBasics() })
    : undefined;

// `github-actions`: the patch is pushed to a starfish/<cycle> branch and the TARGET's own CI is the judge.
// `cloud-run-job`: the command runs in a separate job whose service account holds no roles. In both this process
// never runs the target's code. Otherwise the loop's own `verifyPatch` runs it in-process (`in-process`, not a sandbox).
const remoteVerify =
  cfg.verifyIsolation === "github-actions" && github
    ? createCiVerifier(cfg, { client: github })
    : cfg.verifyIsolation === "cloud-run-job"
      ? createRemoteVerifier(cfg, {
          store: createGcsStore(app, cfg.verifyBucket),
          startJob: createCloudRunJobStarter({ projectId: cfg.projectId, region: cfg.verifyJobRegion, jobName: cfg.verifyJobName }),
        })
      : undefined;
if (cfg.verifyIsolation === "github-actions") {
  console.warn(`agent: verify is the target's CI (checks: ${cfg.verifyChecks.join(", ")}): a branch starfish/<cycle> is pushed to ${cfg.githubRepo} even in a dry run.`);
}

const loader = createLoader({
  db,
  config: cfg,
  logging: new Logging({ projectId: cfg.watchedProjectId }),
  checkout: createGitCheckout(cfg, { ...(token && { token }), env: loadChildProcessBasics() }),
});

// The missing-index heal (#11) is wired in only when a target is allowed (empty by default): a MissingIndexError incident
// then takes the index path instead of triage. Creating an index still needs STARFISH_INDEX_AUTO_APPLY, the dry run off,
// the automation switch on, a configured probe that confirms the failing query, and room under the daily cap.
const indexProbe = createIndexProbe(cfg.indexProbes, createFirestoreProbeRunner());
const indexHeal: IndexHealWiring | undefined =
  cfg.indexAllowedTargets.length > 0
    ? {
        settings: {
          allowedTargets: parseAllowedTargets(cfg.indexAllowedTargets),
          own: { project: cfg.projectId, database: cfg.databaseId },
          autoApply: cfg.indexAutoApply,
          dailyCap: cfg.indexDailyCap,
          maxIndexes: cfg.indexMaxPerDatabase,
          pollMs: 15_000,
          maxWaitMs: cfg.indexWaitMinutes * 60_000,
        },
        admin: createFirestoreAdmin(),
        probe: indexProbe,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        indexFilePath: cfg.indexFilePath,
        observeMinutes: cfg.indexObserveMinutes,
      }
    : undefined;
if (indexHeal) {
  console.warn(
    `agent: missing-index heal wired for ${cfg.indexAllowedTargets.join(", ")} (create ${cfg.indexAutoApply && !cfg.dryRun ? "allowed by the switches" : "off: dry run or STARFISH_INDEX_AUTO_APPLY"}; ${cfg.indexProbes.length} probe(s)).`
  );
}

const owner = `agent-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const automationEnabled = makeAutomationSwitch(settings, db);
// The merge switches (#9), read fresh: the kill switch, dry run, the merge freeze, `autoMerge`, the target allowlist.
const mergeBlocked = makeMergeSwitch(settings, db);
const incidentStatus = async (id: string): Promise<IncidentStatus | null> => {
  const snap = await db.collection(cfg.incidentCollection).doc(id).get();
  const status = snap.data()?.status;
  return snap.exists && INCIDENT_STATUSES.includes(status as IncidentStatus) ? (status as IncidentStatus) : null;
};
const notify = slackOnCall ? createSlackNotifier({ webhookUrl: slackOnCall, uiBaseUrl: cfg.uiBaseUrl }) : undefined;
const deps = {
  db,
  config: cfg,
  owner,
  now: () => new Date(),
  // The model and region of this pass's snapshot: an admin's override on Settings reaches the call (#7).
  ask: createAskJson(cfg),
  load: loader.load,
  incidentStatus,
  automationEnabled,
  // Auto-merge evidence is prepared only while the merge switches allow it (#9); the loop itself never merges.
  autoMergeAllowed: async () => (await mergeBlocked()) === null,
  reconsider: cfg,
  ...(indexHeal && { indexHeal }),
  ...(remoteVerify && { verify: remoteVerify }),
  // Absent in a dry run: the loop then ends a verified, reviewed patch as "waiting for a person" and opens nothing.
  ...(!cfg.dryRun && github && { openPullRequest: github.openPullRequest, findPullRequest: github.findPullRequest }),
  // Given in a dry run too whenever a token is set, so the cycle records that an issue would have been filed whatever the
  // isolation (#236); the loop files nothing then. A dry run with another isolation builds no client, so it gets a
  // stand-in the loop never calls (its dry-run record comes first).
  ...(github
    ? { openIssue: github.openIssue }
    : cfg.dryRun && token !== undefined && token !== "" && { openIssue: () => Promise.reject(new Error("dry run: no issue is filed")) }),
  // Given in a dry run too, so the cycle records that a person would have been told; the loop sends nothing then.
  ...(notify && { notify }),
  // The optional #ops-alerts channel: one "new incident" message per cycle Starfish acts on or escalates. Dry run: none sent.
  ...(slackAlerts && { alert: createSlackAlerter({ webhookUrl: slackAlerts, uiBaseUrl: cfg.uiBaseUrl }) }),
};

let failed: boolean;
try {
  let scanCapped: number | undefined;
  const summary = await runAgentPass({
    select: (limit) => selectCandidates(db, cfg, limit, { reconsider: cfg, onScanCapped: (n) => (scanCapped = n) }),
    // Released cycles nobody will select again (their incident went quiet) are given up and announced, not stranded (#226).
    sweep: async () => giveUpStrandedCycles(deps, await findStrandedCycles(db, cfg, new Date())),
    run: (c) => runCycle(deps, { incidentId: c.incidentId, environment: cfg.environment, recurrence: c.recurrence }),
    maxCycles: cfg.maxCyclesPerPass,
    daily: { cap: cfg.maxCyclesPerDay, startedToday: () => countCyclesStartedToday(db, cfg, new Date()) },
    describeError: (err) => redactPii(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300),
    // Off (or unreadable): the pass starts no cycle, so nothing is declined while automation is off (#133).
    automationEnabled,
  });
  if (summary.skipped === "automation-disabled") console.log(`agent: automation is off (or the settings could not be read); no cycle started.`);
  if (summary.skipped === "daily-cap") console.log(`agent: the daily cap of ${cfg.maxCyclesPerDay} cycle(s) is reached; no cycle started.`);
  if (summary.daily) console.log(`agent: ${summary.daily.startedBefore} of ${summary.daily.cap} daily cycle(s) started before this pass.`);
  for (const g of summary.gaveUp ?? []) console.log(`  ${g.incidentId}: given up (${g.reason})`);
  if (summary.sweepError) console.error(`agent: the sweep for stranded cycles failed: ${summary.sweepError}`);
  if (scanCapped !== undefined) console.warn(`agent: the candidate scan read its cap of ${scanCapped} incident(s); older open incidents wait for a later pass.`);
  console.log(`agent: ${summary.considered} candidate(s), ${summary.ran} run${cfg.dryRun ? " (dry run)" : ""}`);
  for (const r of summary.results) console.log(`  ${r.incidentId}: ${JSON.stringify(r.result)}`);
  for (const e of summary.errors) console.error(`  ${e.incidentId}: threw: ${e.message}`);
  if (summary.aborted) console.error("agent: stopped early: cycles kept throwing.");
  failed = summary.errors.length > 0 || summary.aborted || summary.sweepError !== undefined;

  // Whether earlier index heals held (#11): READY + the query passing + a quiet window. Writes only the cycle's
  // `summary.index.runtime`; never the incident, never an index.
  if (indexHeal) {
    try {
      const obs = await observeIndexHeals({ db, config: cfg, probe: indexProbe, now: () => new Date() });
      console.log(`agent: ${obs.considered} index heal(s) under observation, ${obs.waiting} still in their window, ${obs.uncovered} waiting for ingest to read through theirs`);
      for (const d of obs.decided) console.log(`  ${d.cycleId}: index heal ${d.runtime}`);
      for (const e of obs.errors) console.error(`  ${e.cycleId}: index heal not decided: ${e.message}`);
    } catch (err) {
      console.error(`agent: checking index heals failed: ${redactPii(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
      failed = true;
    }
  }

  // Read back the pull requests earlier cycles opened (#17): merged, closed or open, and the named checks on their head,
  // recorded on each cycle. Read-only on GitHub; never marks an incident healed. Needs the GitHub client.
  if (github) {
    try {
      const rec = await reconcilePullRequests({ db, config: cfg, client: github, now: () => new Date() });
      console.log(`agent: ${rec.considered} pull request(s) read back, ${rec.recorded} recorded, ${rec.unchanged} unchanged`);
      for (const e of rec.errors) console.error(`  ${e.cycleId}: pull request not reconciled: ${e.message}`);
      if (rec.stoppedBecause) console.error(`agent: stopped reading pull requests back: ${rec.stoppedBecause}`);
      // One PR that cannot be read (deleted, say) is logged, not a failed run: it would fail every run after it. An error
      // every PR would hit (credentials, rate limit) is.
      failed = failed || rec.stoppedBecause !== undefined;
    } catch (err) {
      console.error(`agent: reading pull requests back failed: ${redactPii(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
      failed = true;
    }

    // The fast-revert watch on Starfish's own merges, then auto-merge: a merge that failed is reverted before anything
    // else merges, and a candidate for an incident whose earlier merge is still watched is handed to a person (#240).
    // Each step re-reads the switches itself and does nothing while automation is off; with the switches off, a waiting
    // candidate goes to a person. A dry run merges nothing (it is one of the switches) and tells nobody, like the loop.
    const stepDeps = { db, config: cfg, client: github, now: () => new Date(), owner, blockedBy: mergeBlocked, ...(!cfg.dryRun && notify && { notify }) };
    try {
      const r = await runFastRevertStep(stepDeps);
      console.log(
        `agent: fast-revert: ${r.considered} watched, ${r.cleared} cleared, ${r.uncovered} waiting for ingest to read through theirs, ${r.opened} revert(s) opened, ${r.reverted} reverted, ${r.escalated} escalated${r.paused ? " (automation off: paused)" : ""}`
      );
      for (const e of r.errors) console.error(`  ${e.cycleId}: fast-revert: ${e.message}`);
      const m = await runAutoMergeStep({ ...stepDeps, incidentStatus });
      console.log(`agent: auto-merge: ${m.considered} candidate(s), ${m.merged} merged, ${m.skipped} handed to a person, ${m.waiting} waiting${m.paused ? " (automation off: paused)" : ""}`);
      for (const e of m.errors) console.error(`  ${e.cycleId}: auto-merge: ${e.message}`);
    } catch (err) {
      console.error(`agent: the merge steps failed: ${redactPii(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
      failed = true;
    }
  }

  // Phone escalation (#37): start a call sequence for an urgent cycle whose Slack message went unacknowledged, and take
  // each open one a step further. Off unless STARFISH_PHONE_ESCALATION and the admin's switch are both on; a dry run
  // places no call and records what it would have done.
  try {
    const twilio = twilioCredentials && createTwilioClient({ credentials: twilioCredentials, apiUrl: cfg.twilioApiUrl });
    const t = await runEscalationTick({ db, config: cfg, now: () => new Date(), owner, ...(twilio && { twilio }) });
    if (t.skipped !== "off") console.log(`agent: phone escalation: ${t.skipped === "policy-unreadable" ? "the on-call policy is invalid or unreadable; nothing done" : `${t.armed} armed, ${t.placed} call(s) placed, ${t.closed} closed`}`);
    if (t.scanCapped) console.warn("agent: phone escalation: the scan of waiting cycles hit its cap; any beyond it are armed on a later tick.");
  } catch (err) {
    console.error(`agent: phone escalation failed: ${redactPii(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
    failed = true;
  }
} finally {
  await loader.disposeAll();
}
process.exit(failed ? 1 : 0);
