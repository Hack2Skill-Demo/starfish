/**
 * Everything that makes Starfish specific to one deployment lives here.
 *
 * This is the only file in src/ allowed to read process.env — enforced by
 * .claude/hooks/config-boundary-guard.sh. Anywhere else, take a StarfishConfig.
 *
 * This is the whole point of the project: the engine itself knows nothing about
 * any particular product. Point it at a different GCP project, give it different
 * service patterns, and it works there.
 */
import { parseAllowedTargets } from "./indexheal/createIndexUrl.js";
import { INDEX_FILE_PATH_RE } from "./indexheal/indexFilePatch.js";
import { parseIndexProbes, type IndexProbeSpec } from "./indexheal/probe.js";
import { validateMergeCases, type MergeCase } from "./settingsSchema.js";
import { validateClassRules, type ClassRule } from "./triageRules.js";

export interface StarfishConfig {
  /** GCP project Starfish runs in: its Firestore store and its Vertex AI calls. */
  projectId: string;
  /**
   * GCP project whose Cloud Logging is read for errors. Defaults to `projectId`
   * (Starfish running inside the project it watches); set it to watch another
   * project. Single-target: one watched project per Starfish deployment, and
   * `environment` must change with it, or two projects' incidents share a label.
   */
  watchedProjectId: string;
  /**
   * GCP project Gemini runs in, and is billed to. Defaults to `projectId`; set it to run Gemini
   * in a different project from the one Starfish's store lives in. It is the project that needs
   * the Vertex AI API enabled and the caller's `roles/aiplatform.user`.
   */
  vertexProjectId: string;
  /**
   * The Vertex AI location Gemini is called in: a region, or `global`. `STARFISH_VERTEX_LOCATION` when set, else
   * `GOOGLE_CLOUD_LOCATION`. Apart from the region the jobs run in, because a model may be served only from `global`
   * while Cloud Run needs a real region: one variable for both made a redeploy move Gemini to the jobs' region.
   */
  location: string;
  /** Gemini model used for triage, fix drafting and adversarial review. */
  model: string;
  /**
   * How long one model call may take before it is abandoned and the stage records a timeout (#334). Without it, Node's
   * fetch gave up after its own 300 s and the stage said only "TypeError".
   */
  modelTimeoutSeconds: number;
  /**
   * The most tokens one model answer may take, thinking included (#418). Set on every call, so an answer cut off at the
   * limit is known as one (the response says MAX_TOKENS) and goes to a person, rather than read as a failed call and
   * retried at temperature 0 into the same cut. Lower it for a model whose own limit is lower.
   */
  modelMaxOutputTokens: number;
  /** Label attached to every incident, so environments can never mix. */
  environment: string;
  /**
   * Firestore collection holding the runtime settings document an admin edits
   * from the UI (src/runtimeSettings.ts). Environment variables are the defaults;
   * a valid settings document overrides the operational ones.
   */
  settingsCollection: string;
  /**
   * The command that proves a patch is acceptable, run in a scratch copy of the target repo with
   * the patch applied (src/agent/verifyGate.ts). Exit 0 is the only thing that passes. Empty means
   * no gate is configured, and then no patch is ever accepted: nothing would have proved it.
   */
  verifyCommand: string;
  /** How long the verify command may run before it is killed and the patch is rejected. */
  verifyTimeoutSeconds: number;
  /**
   * Where the verify command runs (#74). `none` (the default): nowhere, and the agent entrypoint refuses to
   * start, because running the target repository's own tests is running candidate code and how that is
   * isolated is undecided. `in-process`: on this machine, as this process's identity: NOT a sandbox, so only
   * for a machine that holds no credentials the code must not reach. A real isolation (a disposable runner)
   * would be a further value here. `cloud-run-job`: the command runs in a SEPARATE Cloud Run job whose service
   * account holds no roles (src/agent/verifyRemote.ts, src/agent/verifyRunner.ts); the agent never runs it
   * itself. Needs `verifyJobName` and `verifyBucket`. `github-actions`: the patch is pushed to `starfish/<cycle>` and
   * the TARGET repository's own CI, on GitHub's disposable runners, is the judge; the agent never runs the target's
   * code and holds no runner. The target's workflow must run on pushes to `starfish/**`, and must hold no secrets.
   */
  verifyIsolation: "none" | "in-process" | "cloud-run-job" | "github-actions";
  /**
   * With `github-actions` isolation, the names of the check runs on the pushed commit that must all pass
   * (src/agent/verifyCi.ts). Required there and ignored otherwise: naming the judge is not optional, because a
   * repository usually has other checks that say nothing about the patch.
   */
  verifyChecks: string[];
  /**
   * The GitHub App whose check runs count as `verifyChecks` (its slug; `github-actions` by default): a run of the same
   * name posted by any other GitHub App is ignored (#205). It tells apps apart, not workflows: every GitHub Actions
   * workflow in the target repository, and anything holding a workflow's `GITHUB_TOKEN`, posts as `github-actions`, so
   * another workflow in that repository can still post a run of the same name. Used wherever the named checks are
   * judged: the CI verifier, the reconcile step, auto-merge and fast-revert.
   */
  verifyCheckApp: string;
  /** The Cloud Run job that runs the verify command when `verifyIsolation` is `cloud-run-job`. */
  verifyJobName: string;
  /** The bucket the source bundle and the result pass through (one day lifecycle); the verifier job has no access to it except per-run signed URLs. */
  verifyBucket: string;
  /** Region of that job. Defaults to `location`. */
  verifyJobRegion: string;
  /** The most cycles one agent pass starts. */
  maxCyclesPerPass: number;
  /**
   * The most opened pull requests one agent pass reads back from GitHub (#17, src/agent/reconcile.ts): their state
   * (open, closed, merged) and the `verifyChecks` runs on their head, recorded on the cycle as `summary.prState`.
   */
  maxPrChecksPerPass: number;
  /**
   * The most cycles the agent starts in one UTC day in this environment, counted across passes (the spend cap of #5/#7):
   * a cycle created, or a declined one reconsidered, that day counts once. When it is reached a pass starts nothing,
   * not even a resume, until the next UTC day.
   */
  maxCyclesPerDay: number;
  /**
   * Reconsidering a declined incident (#8). A decline is settled until new evidence arrives: an operator asks for a
   * retriage, the occurrences grow by `reconsiderBurstOccurrences` since the decision, or the incident's structural cause
   * changes (an error code, name or HTTP status appears or changes, or a detail or stack trace becomes available).
   * The automatic triggers wait `reconsiderCooldownMinutes` after the decision; an operator's request does not. Either
   * way a cycle is reconsidered at most `reconsiderMaxPerDay` times in 24 hours.
   */
  reconsiderCooldownMinutes: number;
  reconsiderMaxPerDay: number;
  reconsiderBurstOccurrences: number;
  /**
   * Paths a proposed patch may never touch: the built-in `DEFAULT_PATCH_EXCLUDED_PATHS` (CI, secrets, the package
   * manifest and lockfiles, common test, type-check and lint configs) plus whatever the deployment lists, which
   * should name any other file that defines the verify command or the tests that judge it. A trailing `/` is a directory; `*` and `**` are globs; a
   * pattern with no `/` matches that name at any depth. Matching ignores case.
   */
  patchExcludedPaths: string[];
  /**
   * Where the agent looks for the file that exports a failing function when no stack frame names a repository file
   * (#259; src/agent/sourceByName.ts): repo-relative directories, e.g. `functions/src`. Empty (the default): the whole
   * checkout, minus `node_modules`, tests and `patchExcludedPaths`. A repository with more code files than the search
   * reads (2,000) finds nothing by name until this narrows it.
   */
  functionsSourceRoots: string[];
  /**
   * Firestore collection of agent cycles: one document per (incident, recurrence), holding the
   * lease that stops two workers acting on the same cycle, with the cycle's run events in a
   * subcollection (src/agent/cycle.ts).
   */
  cycleCollection: string;
  /**
   * Environments whose records guests (anonymous sessions on the public demo) may see, as a TRIMMED COPY
   * (src/publicView.ts, #18): for an incident, cycle or run event of one of these environments the engine also writes
   * an allowlist projection to the three collections below, and firestore.rules lets guests read only those, never the
   * stored documents. Default `demo`; empty turns the copies off. The rules serve guests the `demo` label only, so
   * another label here also needs a matching change in firestore.rules.
   */
  publicEnvironments: string[];
  /**
   * The public demo's judge sign-in accounts (`pnpm demo-users`, src/demoUsers.ts): the emails it creates, each an
   * `operator` (never admin), with a random password printed once. Only the demo environment may run it. Default three
   * addresses on the reserved `.example` domain, which can receive no mail.
   */
  demoUserEmails: string[];
  /**
   * The public demo's open actions (src/publicDemo.ts): a visitor with no account (an anonymous Firebase Auth session, a
   * "guest") may do what an operator does (acknowledge, resolve, ignore, reopen, "Retry with agent", "Correct triage")
   * and start "Run ingest now" and "Run agent now", always through the admin API (never a Firestore write from the
   * browser), within the per-address and deployment-wide hourly limits below. Settings, On-call and Retire stay
   * admin-only. Honoured only where `environment` is one of `publicEnvironments` (`publicDemoActionsOn`); off by
   * default. The admin API also opens guests' reads of the full stored records while it is on, through the gate
   * document `{runCollection}/public_access` firestore.rules reads (src/publicDemo.ts `syncPublicAccess`).
   */
  publicDemoActions: boolean;
  /** Open actions (status, retry, correction) one address may make per hour while `publicDemoActions` is on. Default 30. */
  publicActionsPerIpPerHour: number;
  /** "Run ingest now" and "Run agent now" starts one address may make per hour, together, while it is on. Default 3. */
  publicRunsPerIpPerHour: number;
  /**
   * Agent passes ALL visitors together may start per hour while it is on, whatever their address: anonymous accounts are
   * free and addresses rotate, and each pass may spend Gemini calls and file issues and pull requests. Default 6.
   */
  publicAgentRunsPerHour: number;
  /**
   * Engine-only collection of the open actions' hourly counters (src/publicDemoLimit.ts): per address (a keyed hash,
   * never the address) and deployment-wide, plus the hash's salt. firestore.rules closes it to every client.
   */
  publicActionCollection: string;
  /** The trimmed copies guests read (src/publicView.ts): incidents, cycles, and run events (one flat collection). */
  publicIncidentCollection: string;
  publicCycleCollection: string;
  publicEventCollection: string;
  /**
   * How long a worker's lease on a cycle lasts before another may take it over. The loop renews it about every
   * third of this while it works (a verify run can wait far longer than one lease, #132), so this bounds how soon a
   * CRASHED worker's cycle is resumed, not how long a stage may take.
   */
  leaseSeconds: number;
  /**
   * The most a cycle may take overall, however many times its lease is renewed or taken over. A released cycle
   * (a missing counter-check, a model error) is retried by the NEXT agent pass, so this must span several of the
   * agent's schedule intervals, or a retry finds the deadline already passed (#137). Unset: 360 (six hourly passes).
   */
  cycleDeadlineMinutes: number;
  /** How many times a cycle may be started (the first try included) before it is given up on. */
  maxCycleAttempts: number;
  /**
   * Dry run: the agent loop drafts and verifies everything but opens nothing. On by default, so
   * nothing leaves Starfish until a deployment turns it off on purpose.
   */
  dryRun: boolean;
  /** Whether a patch must survive the adversarial review before it can become a pull request. */
  reviewRequired: boolean;
  /**
   * The kill switch: when false the agent loop stops at the next step (it is asked before every stage and
   * again before anything is opened). On by default because a dry run is the default guard; an admin turns it
   * off from Settings, and it is read fresh, not once per run (src/agent/automationSwitch.ts).
   */
  automationEnabled: boolean;
  /**
   * The most model calls one cycle may make (triage, each fix attempt, each review): a spend cap. Counted on the cycle
   * across all its attempts (src/agent/cycle.ts `countSpend`); a reconsidered decline starts a fresh count.
   */
  modelCallBudget: number;
  /**
   * The one repository Starfish opens pull requests in, as `owner/name` (src/integrations/githubPr.ts).
   * Empty means none: nothing can be opened. It is also checked against what the API says the token
   * reaches, so a token for another repository cannot be used by mistake.
   */
  githubRepo: string;
  /** The branch pull requests target. Starfish never pushes to it. */
  githubBaseBranch: string;
  /** The GitHub REST API root. Only `https://`, or plain `http://` to localhost for tests. */
  githubApiUrl: string;
  /** Where the repository is fetched from and pushed to. Empty means `https://github.com/<githubRepo>.git`. */
  githubRemoteUrl: string;
  /**
   * `project/database` pairs a missing Firestore index may be created in (src/indexheal/createIndexUrl.ts),
   * e.g. `my-demo/(default)`. Empty by default: nothing is allowed. Starfish's own database is refused
   * even if listed.
   */
  indexAllowedTargets: string[];
  /**
   * Whether Starfish may create a missing index at all (#11). Off by default, and separate from `autoMerge` and
   * from `dryRun`: an index is created only when this is on AND `dryRun` is off AND the automation switch is on.
   */
  indexAutoApply: boolean;
  /** The most indexes Starfish creates per target in one UTC day; the Firestore per-database index limit is why. */
  indexDailyCap: number;
  /**
   * The most composite indexes the target database may already hold for Starfish to add one (#11): at or above it,
   * nothing is created and a person decides. Read live from the Admin API before each create. The default (100) stays
   * well under Firestore's own per-database limit (see its quotas page), which counts indexes nobody here made.
   */
  indexMaxPerDatabase: number;
  /**
   * The failing queries, written down by an operator, that the heal replays (src/indexheal/probe.ts): before creating an
   * index one must fail naming exactly it, and after READY they must pass. Empty by default, so no index is created:
   * a create-index URL alone does not say what the query was.
   */
  indexProbes: IndexProbeSpec[];
  /** The repository's index file, relative to its root: what the evidence pull request adds the entry to. */
  indexFilePath: string;
  /** How long one cycle waits for a created index to be READY before it lets go and a later pass picks it up again. */
  indexWaitMinutes: number;
  /** How long the incident must stay quiet after READY (and the query pass again) before the heal is called healed. */
  indexObserveMinutes: number;
  /**
   * Auto-merge (#9, src/agent/autoMerge.ts) for THIS deployment's target (`githubRepo`): an admin's switch, off by
   * default and editable on the Settings page. Even on, a pull request is merged only when the target is listed in
   * `autoMergeTargets`, `dryRun` is off, the automation switch is on, `mergeFreeze` is off, Gemini named one of
   * `mergeCases`, the safety floor and the required checks pass, and the daily cap allows it. It never turns on index
   * creation (`indexAutoApply`). Starfish runs no deploy itself, but a merge is a release: the target's CI/CD ships it.
   */
  autoMerge: boolean;
  /** The global off switch for merging: true stops every automatic merge and revert, whatever `autoMerge` says. */
  mergeFreeze: boolean;
  /**
   * The repositories (`owner/name`) auto-merge may EVER apply to: the demo target. Environment-only, not an admin
   * setting, so a production target stays PR-only even if an admin turns `autoMerge` on by mistake. Empty by default.
   */
  autoMergeTargets: string[];
  /** Paths auto-merge never touches, on top of the built-in hard-exclude list and `patchExcludedPaths`. */
  autoMergeExcludedPaths: string[];
  /**
   * The kinds of incident Starfish may merge a fix for by itself (docs/design/auto-merge-policy.md): Gemini's triage
   * names one of them, or the fix waits for a person. `missing-index` (`INDEX_MERGE_CASE`) is the index path's, which asks
   * no model. Empty by default: nothing merges. An admin's Settings list replaces this one. Every switch above still
   * applies, and so does the safety floor (blastRadius.ts `assessMergeFloor`) and green required checks.
   */
  mergeCases: MergeCase[];
  /**
   * The rules engine (src/triageRules.ts): incidents matching a rule (error type, error code, service, function) go no
   * further than its level, noise, log or fix, whatever triage chose; an operator's correction of one incident caps it the
   * same way. Rules only hold Starfish back. Empty by default. An admin's Settings list replaces this one.
   */
  classRules: ClassRule[];
  /** The most pull requests Starfish merges per UTC day in this environment (reverts not counted). */
  maxMergesPerDay: number;
  /** How long an auto-merge candidate may wait for its required checks before it is handed to a person. */
  mergeCheckWaitMinutes: number;
  /**
   * Fast-revert (#9, src/agent/fastRevert.ts): an occurrence of the same incident later than `fastRevertGraceMinutes`
   * after Starfish's merge and within `fastRevertMinutes` of it reverts that merge. The window starts at the MERGE,
   * because when a deployment completes is not observable yet; the grace stands in for the deploy. A window no longer
   * than its grace watches nothing, and auto-merge then refuses (`mergeBlockedBy`, #242).
   */
  fastRevertMinutes: number;
  fastRevertGraceMinutes: number;
  /**
   * Recovery observation for MERGED pull requests, whoever merged them (#390, src/agent/recovery.ts). The target's
   * deployment is read from GitHub's Deployments API: the name of the deployment environment its pipeline deploys to
   * (`production`). Empty by default: no deployment can be confirmed, so a merge is reported `unverified` and never
   * `recovered`. The token needs read access to deployments.
   */
  deployEnvironment: string;
  /**
   * After the deployment completes: `recoveryGraceMinutes` for instances still draining the old revision, then a quiet
   * window of `recoveryQuietMinutes`, lengthened so that, at the error's rate before the merge, at least
   * `recoveryMinExpected` occurrences would have shown if the fix had not worked: silence over a window where the
   * error was not expected to show proves nothing. A merge not deployed (or not observable) within
   * `recoveryGiveUpHours` of the merge is reported `unverified`.
   */
  recoveryQuietMinutes: number;
  recoveryGraceMinutes: number;
  recoveryMinExpected: number;
  recoveryGiveUpHours: number;
  /**
   * Browser origins allowed to call the admin API (src/adminApi.ts) from another site: the operator UI's
   * origin, e.g. `https://my-site.web.app`. Empty by default: no browser may. Each entry is an exact origin
   * (https, or http only for localhost); a typo throws at startup instead of widening who may call.
   */
  adminApiOrigins: string[];
  /** The port the admin API listens on. Cloud Run sets `PORT`. */
  adminApiPort: number;
  /**
   * Requests one address may make to the admin API per minute, per instance (src/ipRateLimit.ts); past it, a 429 before
   * any token is checked. The service is public and any guest can mint a valid ID token, so this bounds what one caller
   * can spend. 30 by default: the operator UI makes a few calls per click (a CORS preflight counts).
   */
  adminApiRateLimitPerMinute: number;
  /**
   * The Cloud Run job an admin's "Run agent now" starts (src/agent/trigger.ts, #276): the deployed agent job, the one
   * its schedule starts. Empty by default: the admin API then has no such route. Read by the admin API only; its
   * account needs `roles/run.invoker` on that job (scripts/deploy-gcp.sh sets both when it deploys the two together).
   */
  agentJobName: string;
  /** Region of that job. Defaults to `GOOGLE_CLOUD_LOCATION`, as the verify job's does. */
  agentJobRegion: string;
  /**
   * Require a valid Firebase App Check token (`X-Firebase-AppCheck`) on the admin API's POST routes, on top of the ID
   * token (#12). Off by default: turn it on only once the operator UI is built with an App Check site key
   * (`VITE_STARFISH_APPCHECK_SITE_KEY`), or every admin call is refused with the same 401 as a bad ID token.
   */
  adminApiRequireAppCheck: boolean;
  /**
   * The operator UI's origin, e.g. `https://my-site.web.app`, used to link a Slack message back to the incident and its
   * run (src/integrations/slack.ts). Empty means a message carries no links. Same rules as the admin API's origins.
   */
  uiBaseUrl: string;
  /**
   * Phone escalation (#37, src/oncall/): when an urgent incident's "needs a human" Slack message goes unacknowledged,
   * Starfish phones the on-call people through Twilio. Off by default, because a call costs money: a deployment turns it
   * on here AND an admin turns it on in Settings -> On-call. A dry run (the agent's default) still places no call. Built,
   * tested against a fake Twilio and the Firestore emulator; never run against real Twilio.
   */
  phoneEscalation: boolean;
  /** Firestore collection of the on-call policy (`{this}/policy`): admin-only (firestore.rules). */
  onCallCollection: string;
  /** Firestore collection of the on-call people and their phone numbers: admin-only, personal data (firestore.rules). */
  onCallPeopleCollection: string;
  /** Firestore collection of the call sequences, one per escalated cycle, and the per-person daily call counts. Engine-only. */
  escalationCollection: string;
  /**
   * Firestore collection of the opt-in codes (src/oncall/optIn.ts): one document per person holding the hash of the
   * code last texted, its expiry and the wrong tries, plus one deployment-wide count of opt-in texts per UTC day.
   * Engine-only (firestore.rules: no client reads or writes it), because a six-digit code's hash can be brute-forced
   * offline by anyone who can read it (#302): an admin could otherwise confirm a number its owner never agreed to.
   */
  onCallCodeCollection: string;
  /**
   * The most opt-in texts (a confirmation code) the whole deployment sends in one UTC day (#306), counted in a
   * transaction as each is claimed: a cap on what a compromised admin account can spend on texts, or send to
   * numbers that are not theirs. A send-code over it is refused (`daily-cap`) and audited. Default 20.
   */
  onCallMaxTextsPerDay: number;
  /**
   * The ONE pre-recorded audio file every call plays (https, e.g. a public Cloud Storage object): it says an urgent
   * incident needs a person and the details are in the on-call channel. No incident detail is ever spoken. Empty: no
   * call can be placed.
   */
  onCallAudioUrl: string;
  /** Twilio's REST API root. Only `https://`, or plain `http://` to localhost for tests. */
  twilioApiUrl: string;
  /**
   * The public origin Twilio calls back (the admin API service, src/adminApiServer.ts), e.g.
   * its Cloud Run URL. The webhook signature is checked against this origin plus the path, never
   * the request's own Host header. Empty: no call can be placed (Twilio would have nowhere to report to).
   */
  twilioWebhookUrl: string;
  /** The author and committer on the commit Starfish pushes. */
  githubCommitName: string;
  githubCommitEmail: string;
  /**
   * Firestore collection of operator records ({uid} -> { roles }). The engine reads it to check that
   * whoever asks for an admin action is an admin, the same record firestore.rules reads. Must match
   * the web's VITE_STARFISH_USERS_COLLECTION and the rules, which hardcode `starfish_users`.
   */
  usersCollection: string;
  /** Firestore collection of audit entries for admin actions on the engine (src/ingest/retire.ts). */
  auditCollection: string;
  /**
   * Functions and services whose errors are never ingested, matched on the canonical spelling
   * (lowercased, `_` as `-`) against both the function and the service label. Starfish's own deployed
   * service goes here: when it shares a project with the app it watches (#32), reading its own errors
   * would turn its failures into incidents, and the fixer could then propose patches to Starfish itself.
   * Default `starfish`; set it to whatever the Cloud Run service or job is actually called.
   * Deliberately environment-only, not an admin-editable setting: it is a safety guard against a
   * feedback loop, not an operational preference.
   */
  excludedServices: string[];
  /** Firestore collection holding incidents. */
  incidentCollection: string;
  /**
   * Firestore collection of incident keys: one document per (environment,
   * fingerprint) naming the incident that fingerprint accrues onto. Every write
   * goes through it inside a transaction, which is what makes concurrent ingest
   * runs and operator triage converge on one incident (src/ingest/store.ts).
   * Engine-only: firestore.rules keeps clients out of it.
   */
  incidentKeyCollection: string;
  /**
   * Firestore database id. Defaults to a dedicated named database, "starfish",
   * so Starfish's rules and indexes never touch the watched app's own database.
   * "(default)" opts back into the default database.
   */
  databaseId: string;
  /**
   * Substring → service-name map for attributing a function to a part of the
   * system. A name matching nothing resolves to null, which is stored as
   * "platform" — never silently attributed to whichever service happens to be
   * first in the list.
   */
  servicePatterns: Record<string, string>;
  /** How far back the first aggregation run looks when no checkpoint exists. */
  defaultLookbackHours: number;
  /**
   * How far behind real time an ingest window ends. Cloud Logging makes an entry searchable
   * some time after it happened; a window that ended at "now" would be closed before its last
   * entries arrived, and they would never be counted.
   */
  ingestLagMinutes: number;
  /** The longest span one ingest window may cover, so catching up after downtime is done in bounded reads. */
  ingestMaxWindowHours: number;
  /**
   * The most NEW incidents one function may open in one ingest window (#303). An error that echoes user input
   * ("No such user: alice", "...: bob") keeps its words through normalization, so each distinct word is a distinct
   * fingerprint; without a cap a flood of them opens thousands of incidents, bills a write for each, and crowds the real
   * ones out of the agent's candidate scan. Past the cap, a function's errors that match no stored incident are folded
   * into ONE high-cardinality overflow incident per function and UTC day (aggregate.ts); errors that already have an
   * incident still accrue onto it. Which errors get the cap's places is decided from the window's own entries (most
   * occurrences first), so a replayed window decides the same way.
   */
  maxNewIncidentsPerFunctionPerWindow: number;
  /**
   * How long one ingest run may work before it stops (#221). No new window is started once most of it is spent, and a
   * window's read is given up at what is left, so a stall is recorded as a failed `last_run` before whatever runs the
   * ingest (the Cloud Run job's task timeout, the admin API's request timeout) ends the process. scripts/deploy-gcp.sh
   * sets it and derives both timeouts from it, so they exceed it.
   */
  ingestRunBudgetSeconds: number;
  /**
   * How much log data one window's read may hold, in megabytes (#296): the approximate size of the entries read (their
   * payload and metadata serialised as JSON). A Cloud Logging entry can be 256 KB, so the entry cap alone let a burst
   * of large entries run the job out of memory, on every replay of the same window. A read that reaches it is treated
   * like one that reaches the entry cap: the window is narrowed to the part read in full. Keep it well under the
   * memory whatever runs the ingest has (scripts/deploy-gcp.sh gives the job 512Mi).
   */
  ingestReadBudgetMb: number;
  /**
   * How far the ingest's checkpoint may fall behind the newest logs it could read (#297) before `pnpm status` calls it
   * "behind", in minutes. Unset: twice the interval of `ingestSchedule` when that is known, else the stale threshold.
   */
  ingestBehindMinutes?: number;
  /**
   * The Cloud Scheduler cron that starts the ingest (set by scripts/deploy-gcp.sh and scripts/ingest-cadence.sh).
   * Only told to the UI, through the last-run record, so it can say when the next run is expected; the engine
   * does not schedule itself. Unset: the UI says nothing about the next run.
   */
  ingestSchedule?: string;
  /**
   * The Cloud Scheduler cron that starts the agent pass (set by scripts/deploy-gcp.sh from AGENT_SCHEDULE). Like
   * `ingestSchedule`, only told to the UI, through the agent's last-run record (#274); the agent does not schedule
   * itself. Unset: the UI says nothing about the next pass.
   */
  agentSchedule?: string;
  /**
   * Firestore collection for the run records: `state` (the ingest's checkpoint and the window in
   * flight; engine-only), `last_run` (the outcome of the latest ingest run, which the UI shows) and
   * `agent_last_run` (the outcome of the latest agent pass, #274).
   */
  runCollection: string;
  /** Cloud Logging `resource.type` values whose ERROR entries count as incidents. */
  logResourceTypes: string[];
  /**
   * Message fragments that appear at ERROR severity but are framework noise, not
   * application faults. Excluded at query time and again at parse time.
   */
  ignoredMessages: string[];
  /**
   * Read a Cloud Monitoring failure signal beside the logs (#19): failed invocations that wrote no
   * ERROR log. Off by default: built and tested against fakes only, never run against real Cloud
   * Monitoring. On, each ingest window also reads `monitoringSignals` for the watched project.
   */
  monitoringEnabled: boolean;
  /** Which Monitoring metrics count as failures (`DEFAULT_MONITORING_SIGNALS`, chosen by resource type). */
  monitoringSignals: MonitoringSignalDef[];
  /** The most time series one window's Monitoring read takes, across all signals: a burst never reads unbounded. */
  monitoringMaxSeries: number;
}

/**
 * One Cloud Monitoring metric that counts failed invocations, and how to read a function out of it.
 * The metric and label names are Google's, not a deployment's; which of them a deployment reads is
 * chosen by `STARFISH_MONITORING_RESOURCE_TYPES`.
 */
export interface MonitoringSignalDef {
  /** The monitored resource type, e.g. `cloud_run_revision`. */
  resourceType: string;
  metricType: string;
  /** A Monitoring filter clause that keeps only the failures (ANDed with the metric and resource type). */
  failureFilter: string;
  /** The resource label naming the function or service (`resource.labels.<this>`). */
  functionLabel: string;
  /** Plain words for what was counted: the Monitoring-only incident's message. Fixed text, never data. */
  description: string;
}

/**
 * Gen2 functions and Cloud Run report requests with a response code class; gen1 functions report
 * executions with a status. Both are DELTA counters. Never run against real Cloud Monitoring.
 */
export const DEFAULT_MONITORING_SIGNALS: readonly MonitoringSignalDef[] = [
  {
    resourceType: "cloud_run_revision",
    metricType: "run.googleapis.com/request_count",
    failureFilter: 'metric.labels.response_code_class = "5xx"',
    functionLabel: "service_name",
    description: "Cloud Monitoring counted 5xx responses (run.googleapis.com/request_count) with no ERROR log entry",
  },
  {
    resourceType: "cloud_function",
    metricType: "cloudfunctions.googleapis.com/function/execution_count",
    failureFilter: 'metric.labels.status != "ok"',
    functionLabel: "function_name",
    description: "Cloud Monitoring counted failed executions (cloudfunctions.googleapis.com/function/execution_count) with no ERROR log entry",
  },
];

/** Starfish's own service name: never ingested (see `excludedServices`). */
export const DEFAULT_EXCLUDED_SERVICES = ["starfish"];
export const DEFAULT_DEMO_USERS = ["judge1@demo.starfish.example", "judge2@demo.starfish.example", "judge3@demo.starfish.example"];

/**
 * Never editable by a proposed patch, on top of whatever the deployment lists: secrets, CI, and the common files that
 * define how a JavaScript/TypeScript project is installed, tested, type-checked and linted. Without the manifest a
 * patch could rewrite the `"test"` script and pass (#138). A repository judged by other files (a Makefile, a
 * pytest.ini) lists them in STARFISH_PATCH_EXCLUDED_PATHS.
 */
export const DEFAULT_PATCH_EXCLUDED_PATHS = [
  ".git/",
  ".github/",
  ".claude/",
  "node_modules/",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "vitest.config.*",
  "vitest.workspace.*",
  "vite.config.*",
  "jest.config.*",
  "karma.conf.*",
  "playwright.config.*",
  ".mocharc*",
  "tsconfig*.json",
  "eslint.config.*",
  ".eslintrc*",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  ".npmrc",
  ".netrc",
  "firebase-adminsdk*.json",
  "service-account*.json",
];

/** Firebase gen1 functions log as cloud_function; gen2 and plain Cloud Run as cloud_run_revision. */
export const DEFAULT_LOG_RESOURCE_TYPES = ["cloud_function", "cloud_run_revision"];

export const DEFAULT_IGNORED_MESSAGES = [
  // Callable frameworks accept POST only. On every revision rollout something
  // (a console, a health probe) issues a GET, producing this at ERROR severity.
  "Invalid request, unable to process",
  "Request has invalid method",
];

/**
 * Load `.env` when present. `pnpm spike` runs under plain tsx, which does not
 * read it — without this, following the README's `cp .env.example .env` step
 * would still fail on an unset GOOGLE_CLOUD_PROJECT.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file: rely on the ambient environment.
  }
}

export function loadConfig(): StarfishConfig {
  loadDotEnv();
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error("GOOGLE_CLOUD_PROJECT is not set — copy .env.example to .env");
  }
  return {
    projectId,
    watchedProjectId: process.env.STARFISH_WATCHED_PROJECT_ID || projectId,
    vertexProjectId: process.env.STARFISH_VERTEX_PROJECT_ID || projectId,
    // Set-but-blank is unset (#189): an empty environment label or collection name is never what was meant.
    location: textOr(process.env.STARFISH_VERTEX_LOCATION, textOr(process.env.GOOGLE_CLOUD_LOCATION, "us-central1")),
    model: textOr(process.env.STARFISH_MODEL, "gemini-3.1-pro-preview"),
    modelTimeoutSeconds: positiveNumber(process.env.STARFISH_MODEL_TIMEOUT_SECONDS, 600, "STARFISH_MODEL_TIMEOUT_SECONDS"),
    modelMaxOutputTokens: positiveInteger(process.env.STARFISH_MODEL_MAX_OUTPUT_TOKENS, 32_768, "STARFISH_MODEL_MAX_OUTPUT_TOKENS"),
    environment: textOr(process.env.STARFISH_ENV, "dev"),
    settingsCollection: textOr(process.env.STARFISH_SETTINGS_COLLECTION, "starfish_settings"),
    incidentCollection: textOr(process.env.STARFISH_INCIDENT_COLLECTION, "incidents"),
    incidentKeyCollection: textOr(process.env.STARFISH_INCIDENT_KEY_COLLECTION, "incident_keys"),
    databaseId: process.env.STARFISH_DATABASE_ID || "starfish",
    servicePatterns: parseServicePatterns(process.env.STARFISH_SERVICE_PATTERNS),
    verifyCommand: (process.env.STARFISH_VERIFY_COMMAND ?? "").trim(),
    verifyTimeoutSeconds: positiveNumber(
      process.env.STARFISH_VERIFY_TIMEOUT_SECONDS,
      600,
      "STARFISH_VERIFY_TIMEOUT_SECONDS"
    ),
    verifyIsolation: parseVerifyIsolation(process.env.STARFISH_VERIFY_ISOLATION),
    verifyChecks: parseVerifyChecks(process.env.STARFISH_VERIFY_CHECKS),
    verifyCheckApp: (process.env.STARFISH_VERIFY_CHECK_APP ?? "").trim() || "github-actions",
    verifyJobName: (process.env.STARFISH_VERIFY_JOB ?? "").trim(),
    verifyBucket: (process.env.STARFISH_VERIFY_BUCKET ?? "").trim(),
    verifyJobRegion: textOr(process.env.STARFISH_VERIFY_JOB_REGION, textOr(process.env.GOOGLE_CLOUD_LOCATION, "us-central1")),
    maxCyclesPerPass: positiveNumber(process.env.STARFISH_MAX_CYCLES_PER_PASS, 3, "STARFISH_MAX_CYCLES_PER_PASS"),
    maxPrChecksPerPass: positiveNumber(process.env.STARFISH_MAX_PR_CHECKS_PER_PASS, 10, "STARFISH_MAX_PR_CHECKS_PER_PASS"),
    maxCyclesPerDay: positiveNumber(process.env.STARFISH_MAX_CYCLES_PER_DAY, 30, "STARFISH_MAX_CYCLES_PER_DAY"),
    reconsiderCooldownMinutes: positiveNumber(process.env.STARFISH_RECONSIDER_COOLDOWN_MINUTES, 30, "STARFISH_RECONSIDER_COOLDOWN_MINUTES"),
    reconsiderMaxPerDay: positiveNumber(process.env.STARFISH_RECONSIDER_MAX_PER_DAY, 3, "STARFISH_RECONSIDER_MAX_PER_DAY"),
    reconsiderBurstOccurrences: positiveNumber(process.env.STARFISH_RECONSIDER_BURST_OCCURRENCES, 20, "STARFISH_RECONSIDER_BURST_OCCURRENCES"),
    patchExcludedPaths: [
      ...DEFAULT_PATCH_EXCLUDED_PATHS,
      ...(parseList(process.env.STARFISH_PATCH_EXCLUDED_PATHS, ",") ?? []),
    ],
    functionsSourceRoots: validSourceRoots(parseList(process.env.STARFISH_FUNCTIONS_SOURCE_ROOTS, ",") ?? []),
    // Validated like the other numbers (#129): 0, a negative or "24h" made every first run idle while
    // the status line said ok.
    defaultLookbackHours: positiveNumber(process.env.STARFISH_LOOKBACK_HOURS, 24, "STARFISH_LOOKBACK_HOURS"),
    ingestLagMinutes: positiveNumber(process.env.STARFISH_INGEST_LAG_MINUTES, 5, "STARFISH_INGEST_LAG_MINUTES"),
    ...(process.env.STARFISH_INGEST_SCHEDULE?.trim() ? { ingestSchedule: process.env.STARFISH_INGEST_SCHEDULE.trim() } : {}),
    ...(process.env.STARFISH_AGENT_SCHEDULE?.trim() ? { agentSchedule: process.env.STARFISH_AGENT_SCHEDULE.trim() } : {}),
    ingestMaxWindowHours: positiveNumber(
      process.env.STARFISH_INGEST_MAX_WINDOW_HOURS,
      6,
      "STARFISH_INGEST_MAX_WINDOW_HOURS"
    ),
    maxNewIncidentsPerFunctionPerWindow: positiveInteger(
      process.env.STARFISH_MAX_NEW_INCIDENTS_PER_FUNCTION,
      25,
      "STARFISH_MAX_NEW_INCIDENTS_PER_FUNCTION"
    ),
    // 8 minutes: two under the 10-minute task timeout scripts/deploy-gcp.sh derives from it by default.
    ingestRunBudgetSeconds: positiveNumber(process.env.STARFISH_INGEST_RUN_BUDGET_SECONDS, 480, "STARFISH_INGEST_RUN_BUDGET_SECONDS"),
    ingestReadBudgetMb: positiveNumber(process.env.STARFISH_INGEST_READ_BUDGET_MB, 64, "STARFISH_INGEST_READ_BUDGET_MB"),
    ...(process.env.STARFISH_INGEST_BEHIND_MINUTES?.trim()
      ? { ingestBehindMinutes: positiveNumber(process.env.STARFISH_INGEST_BEHIND_MINUTES.trim(), 1, "STARFISH_INGEST_BEHIND_MINUTES") }
      : {}),
    runCollection: process.env.STARFISH_RUN_COLLECTION || "starfish_runs",
    dryRun: parseBoolean(process.env.STARFISH_DRY_RUN, true, "STARFISH_DRY_RUN"),
    reviewRequired: parseBoolean(process.env.STARFISH_REVIEW_REQUIRED, true, "STARFISH_REVIEW_REQUIRED"),
    automationEnabled: parseBoolean(process.env.STARFISH_AUTOMATION_ENABLED, true, "STARFISH_AUTOMATION_ENABLED"),
    modelCallBudget: positiveNumber(process.env.STARFISH_MODEL_CALL_BUDGET, 6, "STARFISH_MODEL_CALL_BUDGET"),
    githubRepo: (process.env.STARFISH_GITHUB_REPO ?? "").trim(),
    githubBaseBranch: (process.env.STARFISH_GITHUB_BASE_BRANCH ?? "").trim() || "main",
    githubApiUrl: (process.env.STARFISH_GITHUB_API_URL ?? "").trim() || "https://api.github.com",
    githubRemoteUrl: (process.env.STARFISH_GITHUB_REMOTE_URL ?? "").trim(),
    indexAllowedTargets: validIndexTargets(parseList(process.env.STARFISH_INDEX_ALLOWED_TARGETS, ",") ?? []),
    indexAutoApply: parseBoolean(process.env.STARFISH_INDEX_AUTO_APPLY, false, "STARFISH_INDEX_AUTO_APPLY"),
    indexDailyCap: positiveNumber(process.env.STARFISH_INDEX_DAILY_CAP, 3, "STARFISH_INDEX_DAILY_CAP"),
    indexMaxPerDatabase: positiveNumber(process.env.STARFISH_INDEX_MAX_PER_DATABASE, 100, "STARFISH_INDEX_MAX_PER_DATABASE"),
    indexProbes: parseIndexProbes(process.env.STARFISH_INDEX_PROBES),
    indexFilePath: validIndexFilePath(process.env.STARFISH_INDEX_FILE),
    indexWaitMinutes: positiveNumber(process.env.STARFISH_INDEX_WAIT_MINUTES, 10, "STARFISH_INDEX_WAIT_MINUTES"),
    indexObserveMinutes: positiveNumber(process.env.STARFISH_INDEX_OBSERVE_MINUTES, 60, "STARFISH_INDEX_OBSERVE_MINUTES"),
    autoMerge: parseBoolean(process.env.STARFISH_AUTO_MERGE, false, "STARFISH_AUTO_MERGE"),
    mergeFreeze: parseBoolean(process.env.STARFISH_MERGE_FREEZE, false, "STARFISH_MERGE_FREEZE"),
    autoMergeTargets: validRepos(parseList(process.env.STARFISH_AUTO_MERGE_TARGETS, ",") ?? []),
    autoMergeExcludedPaths: parseList(process.env.STARFISH_AUTO_MERGE_EXCLUDED_PATHS, ",") ?? [],
    mergeCases: parseMergeCases(process.env.STARFISH_MERGE_CASES),
    classRules: parseClassRules(process.env.STARFISH_CLASS_RULES),
    maxMergesPerDay: positiveNumber(process.env.STARFISH_MAX_MERGES_PER_DAY, 3, "STARFISH_MAX_MERGES_PER_DAY"),
    mergeCheckWaitMinutes: positiveNumber(process.env.STARFISH_MERGE_CHECK_WAIT_MINUTES, 120, "STARFISH_MERGE_CHECK_WAIT_MINUTES"),
    fastRevertMinutes: positiveNumber(process.env.STARFISH_FAST_REVERT_MINUTES, 60, "STARFISH_FAST_REVERT_MINUTES"),
    fastRevertGraceMinutes: positiveNumber(process.env.STARFISH_FAST_REVERT_GRACE_MINUTES, 10, "STARFISH_FAST_REVERT_GRACE_MINUTES"),
    deployEnvironment: deploymentEnvironment(process.env.STARFISH_DEPLOY_ENVIRONMENT),
    recoveryQuietMinutes: positiveNumber(process.env.STARFISH_RECOVERY_QUIET_MINUTES, 60, "STARFISH_RECOVERY_QUIET_MINUTES"),
    recoveryGraceMinutes: positiveNumber(process.env.STARFISH_RECOVERY_GRACE_MINUTES, 5, "STARFISH_RECOVERY_GRACE_MINUTES"),
    recoveryMinExpected: positiveNumber(process.env.STARFISH_RECOVERY_MIN_EXPECTED, 5, "STARFISH_RECOVERY_MIN_EXPECTED"),
    recoveryGiveUpHours: positiveNumber(process.env.STARFISH_RECOVERY_GIVE_UP_HOURS, 24, "STARFISH_RECOVERY_GIVE_UP_HOURS"),
    adminApiOrigins: validOrigins(parseList(process.env.STARFISH_ADMIN_API_ORIGINS, ",") ?? []),
    adminApiPort: positiveNumber(process.env.PORT, 8080, "PORT"),
    adminApiRateLimitPerMinute: positiveInteger(process.env.STARFISH_ADMIN_API_RATE_LIMIT_PER_MINUTE, 30, "STARFISH_ADMIN_API_RATE_LIMIT_PER_MINUTE"),
    agentJobName: (process.env.STARFISH_AGENT_JOB ?? "").trim(),
    agentJobRegion: textOr(process.env.STARFISH_AGENT_JOB_REGION, textOr(process.env.GOOGLE_CLOUD_LOCATION, "us-central1")),
    adminApiRequireAppCheck: parseBoolean(process.env.STARFISH_ADMIN_API_APPCHECK, false, "STARFISH_ADMIN_API_APPCHECK"),
    uiBaseUrl: validOrigins(parseList(process.env.STARFISH_UI_URL, ",") ?? [], "STARFISH_UI_URL")[0] ?? "",
    phoneEscalation: parseBoolean(process.env.STARFISH_PHONE_ESCALATION, false, "STARFISH_PHONE_ESCALATION"),
    onCallCollection: process.env.STARFISH_ONCALL_COLLECTION || "starfish_oncall",
    onCallPeopleCollection: process.env.STARFISH_ONCALL_PEOPLE_COLLECTION || "starfish_oncall_people",
    escalationCollection: process.env.STARFISH_ESCALATION_COLLECTION || "starfish_escalations",
    onCallCodeCollection: process.env.STARFISH_ONCALL_CODE_COLLECTION || "starfish_oncall_codes",
    onCallMaxTextsPerDay: positiveInteger(process.env.STARFISH_ONCALL_MAX_TEXTS_PER_DAY, 20, "STARFISH_ONCALL_MAX_TEXTS_PER_DAY"),
    onCallAudioUrl: validHttpsUrl(process.env.STARFISH_ONCALL_AUDIO_URL, "STARFISH_ONCALL_AUDIO_URL"),
    twilioApiUrl: validApiRoot(process.env.STARFISH_TWILIO_API_URL, "https://api.twilio.com", "STARFISH_TWILIO_API_URL"),
    twilioWebhookUrl: validOrigins(parseList(process.env.STARFISH_TWILIO_WEBHOOK_URL, ",") ?? [], "STARFISH_TWILIO_WEBHOOK_URL")[0] ?? "",
    githubCommitName: (process.env.STARFISH_GITHUB_COMMIT_NAME ?? "").trim() || "Starfish",
    githubCommitEmail: (process.env.STARFISH_GITHUB_COMMIT_EMAIL ?? "").trim() || "starfish@users.noreply.github.com",
    usersCollection: process.env.STARFISH_USERS_COLLECTION || "starfish_users",
    auditCollection: process.env.STARFISH_AUDIT_COLLECTION || "starfish_audit",
    excludedServices: parseList(process.env.STARFISH_EXCLUDED_SERVICES, ",") ?? DEFAULT_EXCLUDED_SERVICES,
    cycleCollection: process.env.STARFISH_CYCLE_COLLECTION || "starfish_cycles",
    publicEnvironments: validEnvironmentLabels(parseList(process.env.STARFISH_PUBLIC_ENVIRONMENTS, ",") ?? ["demo"]),
    demoUserEmails: parseList(process.env.STARFISH_DEMO_USERS, ",") ?? DEFAULT_DEMO_USERS,
    publicDemoActions: parseBoolean(process.env.STARFISH_PUBLIC_DEMO_ACTIONS, false, "STARFISH_PUBLIC_DEMO_ACTIONS"),
    publicActionsPerIpPerHour: positiveInteger(process.env.STARFISH_PUBLIC_ACTIONS_PER_IP_PER_HOUR, 30, "STARFISH_PUBLIC_ACTIONS_PER_IP_PER_HOUR"),
    publicRunsPerIpPerHour: positiveInteger(process.env.STARFISH_PUBLIC_RUNS_PER_IP_PER_HOUR, 3, "STARFISH_PUBLIC_RUNS_PER_IP_PER_HOUR"),
    publicAgentRunsPerHour: positiveInteger(process.env.STARFISH_PUBLIC_AGENT_RUNS_PER_HOUR, 6, "STARFISH_PUBLIC_AGENT_RUNS_PER_HOUR"),
    publicActionCollection: textOr(process.env.STARFISH_PUBLIC_ACTION_COLLECTION, "starfish_public_actions"),
    publicIncidentCollection: textOr(process.env.STARFISH_PUBLIC_INCIDENT_COLLECTION, "starfish_public_incidents"),
    publicCycleCollection: textOr(process.env.STARFISH_PUBLIC_CYCLE_COLLECTION, "starfish_public_cycles"),
    publicEventCollection: textOr(process.env.STARFISH_PUBLIC_EVENT_COLLECTION, "starfish_public_events"),
    leaseSeconds: positiveNumber(process.env.STARFISH_LEASE_SECONDS, 300, "STARFISH_LEASE_SECONDS"),
    cycleDeadlineMinutes: positiveNumber(process.env.STARFISH_CYCLE_DEADLINE_MINUTES, 360, "STARFISH_CYCLE_DEADLINE_MINUTES"),
    maxCycleAttempts: positiveNumber(process.env.STARFISH_MAX_CYCLE_ATTEMPTS, 3, "STARFISH_MAX_CYCLE_ATTEMPTS"),
    logResourceTypes: requireNonEmpty(
      parseList(process.env.STARFISH_LOG_RESOURCE_TYPES, ",") ?? DEFAULT_LOG_RESOURCE_TYPES,
      "STARFISH_LOG_RESOURCE_TYPES"
    ),
    ignoredMessages:
      parseList(process.env.STARFISH_IGNORED_MESSAGES, "|") ?? DEFAULT_IGNORED_MESSAGES,
    ...monitoringSettings(),
    monitoringMaxSeries: positiveNumber(process.env.STARFISH_MONITORING_MAX_SERIES, 500, "STARFISH_MONITORING_MAX_SERIES"),
  };
}

/**
 * The switch and the signals. On with no signal is refused at startup: a read of nothing would answer
 * "no failures", a zero that was never measured.
 */
function monitoringSettings(): Pick<StarfishConfig, "monitoringEnabled" | "monitoringSignals"> {
  const monitoringEnabled = parseBoolean(process.env.STARFISH_MONITORING_ENABLED, false, "STARFISH_MONITORING_ENABLED");
  const monitoringSignals = parseMonitoringSignals(process.env.STARFISH_MONITORING_RESOURCE_TYPES);
  if (monitoringEnabled && monitoringSignals.length === 0) {
    throw new Error("STARFISH_MONITORING_ENABLED is on but STARFISH_MONITORING_RESOURCE_TYPES lists none: unset it for the defaults");
  }
  return { monitoringEnabled, monitoringSignals };
}

/** The built-in signals for the listed resource types (all of them when unset). An unknown type is refused at startup. */
function parseMonitoringSignals(raw: string | undefined): MonitoringSignalDef[] {
  const types = parseList(raw, ",");
  if (types === undefined) return DEFAULT_MONITORING_SIGNALS.map((s) => ({ ...s }));
  return types.map((t) => {
    const def = DEFAULT_MONITORING_SIGNALS.find((s) => s.resourceType === t);
    if (!def) {
      const known = DEFAULT_MONITORING_SIGNALS.map((s) => s.resourceType).join(", ");
      throw new Error(`STARFISH_MONITORING_RESOURCE_TYPES lists "${t}"; known: ${known}`);
    }
    return { ...def };
  });
}

/**
 * The GitHub token for the pull-request step, or undefined. Deliberately not a field of
 * StarfishConfig: a config object is copied into snapshots and test fixtures, and a secret
 * must not travel with it. Mounted from Secret Manager on Cloud Run (docs/deploy.md).
 */
export function loadGithubToken(): string | undefined {
  const token = (process.env.STARFISH_GITHUB_TOKEN ?? "").trim();
  return token === "" ? undefined : token;
}

/** Slack incoming webhooks have their own host; a test may point one at localhost over plain http. */
const SLACK_WEBHOOK_RE = /^(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{10,200}|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/[A-Za-z0-9_/-]{0,200})$/;

/**
 * The Slack incoming-webhook URL the "needs a human" message is posted to, or undefined (src/integrations/slack.ts).
 * The URL is the credential: anyone who has it can post to the channel. So, like the GitHub token, it is not a field
 * of StarfishConfig, and a bad value is refused by NAME, never echoed. Mounted from Secret Manager on Cloud Run.
 */
export function loadSlackOnCallWebhook(): string | undefined {
  return slackWebhook("STARFISH_SLACK_WEBHOOK_ONCALL");
}

/**
 * The Slack incoming-webhook URL the "new incident" message is posted to (the design's `#ops-alerts`), or undefined.
 * Optional and separate from the on-call one: another channel, another credential. Same rules as the on-call one.
 */
export function loadSlackAlertsWebhook(): string | undefined {
  return slackWebhook("STARFISH_SLACK_WEBHOOK_ALERTS");
}

/** A Slack incoming-webhook URL from `name`, or undefined. A bad value is refused by NAME, never echoed. */
function slackWebhook(name: "STARFISH_SLACK_WEBHOOK_ONCALL" | "STARFISH_SLACK_WEBHOOK_ALERTS"): string | undefined {
  const url = (process.env[name] ?? "").trim();
  if (url === "") return undefined;
  if (!SLACK_WEBHOOK_RE.test(url)) {
    throw new Error(`${name} is not a Slack incoming-webhook URL (https://hooks.slack.com/services/...)`);
  }
  return url;
}

/** Twilio's credentials (#37): the account SID, its auth token, and the number calls and texts come from. */
export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

/**
 * Twilio's credentials, or undefined when none are set (src/oncall/twilio.ts). Like the Slack webhook, not a field of
 * StarfishConfig: the auth token both places calls (which cost money) and signs Twilio's webhooks, so it must not travel
 * with a config snapshot. Mounted from Secret Manager on Cloud Run (docs/deploy.md). All three or none: a partial set,
 * or a value of the wrong shape, is refused by NAME, never echoed.
 */
export function loadTwilioCredentials(): TwilioCredentials | undefined {
  const accountSid = (process.env.STARFISH_TWILIO_ACCOUNT_SID ?? "").trim();
  const authToken = (process.env.STARFISH_TWILIO_AUTH_TOKEN ?? "").trim();
  const fromNumber = (process.env.STARFISH_TWILIO_FROM_NUMBER ?? "").trim();
  const set = [accountSid, authToken, fromNumber].filter((v) => v !== "").length;
  if (set === 0) return undefined;
  if (set !== 3) throw new Error("STARFISH_TWILIO_ACCOUNT_SID, STARFISH_TWILIO_AUTH_TOKEN and STARFISH_TWILIO_FROM_NUMBER must be set together");
  if (!/^AC[0-9a-f]{32}$/.test(accountSid)) throw new Error("STARFISH_TWILIO_ACCOUNT_SID is not a Twilio account SID (AC + 32 hex)");
  if (!/^[0-9a-f]{32}$/.test(authToken)) throw new Error("STARFISH_TWILIO_AUTH_TOKEN is not a Twilio auth token (32 hex)");
  if (!/^\+[1-9]\d{6,14}$/.test(fromNumber)) throw new Error("STARFISH_TWILIO_FROM_NUMBER is not an E.164 number (+15551234567)");
  return { accountSid, authToken, fromNumber };
}

/**
 * The request the agent hands the verify job (src/agent/verifyRunner.ts), or undefined. Read here because this is
 * the only file that reads the environment; the verifier job is given nothing else, no Starfish setting and no
 * credential, which is the point of it.
 */
export function loadVerifyRunnerRequest(): string | undefined {
  const raw = process.env.STARFISH_VERIFY_REQUEST ?? "";
  return raw.trim() === "" ? undefined : raw;
}

/**
 * The two variables a child `git` needs to find itself and a home directory, and nothing else: a child
 * process must not inherit the engine's environment (the GitHub token is in it).
 */
export function loadChildProcessBasics(): { PATH?: string; HOME?: string } {
  return { PATH: process.env.PATH, HOME: process.env.HOME };
}

/**
 * What the verify gate's command may inherit from this process (src/agent/verifyGate.ts): PATH to find its tools and
 * LANG for its locale. HOME is not here: the gate gives the command a scratch home of its own.
 */
export function loadVerifyCommandBasics(): { PATH?: string; LANG: string } {
  return { PATH: process.env.PATH, LANG: textOr(process.env.LANG, "C.UTF-8") };
}

/** Where the replay harness (`pnpm replay`, src/scoreboard/replay.ts, #10) reads its corpus and writes its results. */
export interface ReplayConfig {
  /** The corpus directory: a `manifest.json` and the files it names. */
  corpusDir: string;
  /** Where the results file is written: the directory `pnpm scoreboard` reads. */
  resultsDir: string;
  /** The longest one case may take before it is recorded as a timeout (a timeout counts against the agent). */
  caseTimeoutSeconds: number;
}

/**
 * The replay harness's own settings. Separate from `loadConfig()` because they are about the evaluation, not the
 * deployment; the model, the verify timeout, the excluded paths and the budgets come from `loadConfig()` as for
 * the agent, so a replay measures the configuration the agent would run with.
 */
export function loadReplayConfig(): ReplayConfig {
  loadDotEnv();
  return {
    corpusDir: (process.env.STARFISH_REPLAY_CORPUS ?? "").trim() || "scoreboard/corpus",
    resultsDir: (process.env.STARFISH_REPLAY_RESULTS_DIR ?? "").trim() || "scoreboard/results",
    caseTimeoutSeconds: positiveNumber(process.env.STARFISH_REPLAY_CASE_TIMEOUT_SECONDS, 1800, "STARFISH_REPLAY_CASE_TIMEOUT_SECONDS"),
  };
}

/** True when the Firestore Admin SDK is pointed at the emulator (FIRESTORE_EMULATOR_HOST), for CLIs that say so. */
export function usingFirestoreEmulator(): boolean {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

/** The entries unchanged if each is `project/database`; a typo throws at startup rather than widening what is allowed. */
function validIndexTargets(entries: string[]): string[] {
  parseAllowedTargets(entries);
  return entries;
}

/** The index file's path in the target repository; a path that could leave the checkout throws at startup. */
function validIndexFilePath(raw: string | undefined): string {
  const path = (raw ?? "").trim() || "firestore.indexes.json";
  if (!INDEX_FILE_PATH_RE.test(path)) throw new Error(`STARFISH_INDEX_FILE must be a plain relative .json path, got "${raw}"`);
  return path;
}

/**
 * `STARFISH_FUNCTIONS_SOURCE_ROOTS`: repo-relative directories, `/`-separated. A leading `./` and trailing `/` are dropped;
 * an absolute path, a `..` segment or a backslash throws at startup, since a root outside the checkout means nothing.
 */
function validSourceRoots(entries: string[]): string[] {
  return entries.map((entry) => {
    const root = entry.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (root === "" || root === "." || root.startsWith("/") || root.includes("\\") || root.split("/").some((s) => s === "" || s === "." || s === "..")) {
      throw new Error(`STARFISH_FUNCTIONS_SOURCE_ROOTS entry "${entry}" must be a directory inside the repository, like functions/src`);
    }
    return root;
  });
}

/** `owner/name` entries, unchanged; a typo throws at startup rather than naming a repository nobody meant. */
function validRepos(entries: string[]): string[] {
  for (const entry of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/.test(entry)) {
      throw new Error(`STARFISH_AUTO_MERGE_TARGETS entry "${entry}" must be a repository as owner/name`);
    }
  }
  return entries;
}

/**
 * `STARFISH_MERGE_CASES`: a JSON list of `{ "id": …, "description": … }` (settingsSchema.ts `validateMergeCases`). Unset
 * or blank: none, so nothing merges. Anything else that does not validate throws at startup: a typo must not quietly
 * become "nothing merges" or, worse, a case nobody meant.
 */
function parseMergeCases(raw: string | undefined): MergeCase[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("STARFISH_MERGE_CASES must be a JSON list of { id, description }");
  }
  const checked = validateMergeCases(parsed);
  if (!checked.ok) throw new Error(`STARFISH_MERGE_CASES: ${checked.problem}`);
  return checked.cases;
}

/**
 * `STARFISH_CLASS_RULES`: a JSON list of `{ "id", "match": { errorType?, errorCode?, service?, functionName? }, "maxLevel",
 * "note"? }` (triageRules.ts `validateClassRules`). Unset or blank: none. Anything else that does not validate throws at
 * startup: a typo must not quietly drop a rule someone relies on to hold Starfish back.
 */
function parseClassRules(raw: string | undefined): ClassRule[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("STARFISH_CLASS_RULES must be a JSON list of { id, match, maxLevel, note? }");
  }
  const checked = validateClassRules(parsed);
  if (!checked.ok) throw new Error(`STARFISH_CLASS_RULES: ${checked.problem}`);
  return checked.rules;
}

/** Environment labels as the settings schema allows them (ENVIRONMENT in src/settingsSchema.ts); a typo is refused at startup. */
function validEnvironmentLabels(entries: string[]): string[] {
  for (const entry of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry)) {
      throw new Error(`STARFISH_PUBLIC_ENVIRONMENTS entry "${entry}" is not an environment label (letters, digits, . _ -; at most 64)`);
    }
  }
  return entries;
}

/** Exact web origins (`https://host[:port]`, or `http://localhost[:port]`), no path: one wrong entry would widen who may call. */
function validOrigins(entries: string[], name = "STARFISH_ADMIN_API_ORIGINS"): string[] {
  return entries.map((entry) => {
    let u: URL;
    try {
      u = new URL(entry);
    } catch {
      throw new Error(`${name} entry "${entry}" is not an origin like https://my-site.web.app`);
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if ((u.protocol !== "https:" && !(local && u.protocol === "http:")) || u.origin !== entry.replace(/\/$/, "") || u.username || u.password) {
      throw new Error(`${name} entry "${entry}" must be an exact https origin (no path, no credentials)`);
    }
    return u.origin;
  });
}

/** An https URL (no credentials), or "" when unset; anything else throws at startup, by name. */
function validHttpsUrl(raw: string | undefined, name: string): string {
  const v = (raw ?? "").trim();
  if (v === "") return "";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (u.protocol !== "https:" || u.username || u.password) throw new Error(`${name} must be an https URL with no credentials`);
  return u.toString();
}

/** An API root: https, or http to localhost (tests); the default when unset. No trailing slash. */
function validApiRoot(raw: string | undefined, fallback: string, name: string): string {
  const v = (raw ?? "").trim();
  if (v === "") return fallback;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if ((u.protocol !== "https:" && !(local && u.protocol === "http:")) || u.username || u.password) {
    throw new Error(`${name} must be https (or http to localhost)`);
  }
  return v.replace(/\/+$/, "");
}

/** The value trimmed, or the default when it is unset or blank. */
/** A GitHub deployment environment name: plain characters only, or startup stops (it goes into an API path). */
function deploymentEnvironment(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (v === "") return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,99}$/.test(v)) throw new Error("STARFISH_DEPLOY_ENVIRONMENT must be a plain deployment environment name such as production.");
  return v;
}

function textOr(raw: string | undefined, fallback: string): string {
  return (raw ?? "").trim() || fallback;
}

/** A number above zero, or the default when unset. A window of zero or negative length would never advance. */
function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a number above zero, got "${raw}"`);
  return n;
}

/** A whole number above zero, or the default when unset: a count of requests, where 2.5 means nothing. */
function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const n = positiveNumber(raw, fallback, name);
  if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number above zero, got "${raw}"`);
  return n;
}

/** `none` when unset; anything but the two known values is a mistake worth refusing at startup. */
function parseVerifyIsolation(raw: string | undefined): "none" | "in-process" | "cloud-run-job" | "github-actions" {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "none") return "none";
  if (v === "in-process" || v === "cloud-run-job" || v === "github-actions") return v;
  throw new Error(`STARFISH_VERIFY_ISOLATION must be none, in-process, cloud-run-job or github-actions, got "${raw}"`);
}

/** `"verify, lint"` -> `["verify", "lint"]`: the check runs that must pass. At most 20, each at most 200 characters. */
function parseVerifyChecks(raw: string | undefined): string[] {
  const names = (parseList(raw, ",") ?? []).filter((n) => n.length <= 200);
  if (names.length > 20) throw new Error("STARFISH_VERIFY_CHECKS names more than 20 checks");
  return names;
}

/** true/false/1/0/yes/no, or the default when unset. Anything else is a mistake worth refusing at startup. */
function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes"].includes(v)) return true;
  if (["false", "0", "no"].includes(v)) return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

/** `"api:api,worker:jobs"` → `{ api: "api", worker: "jobs" }`. Empty is valid. */
function parseServicePatterns(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [pattern, service] = pair.split(":").map((s) => s.trim());
    if (pattern && service) out[pattern.toLowerCase()] = service;
  }
  return out;
}

/**
 * An empty resource-type list would build the filter `()`, which Cloud Logging
 * rejects — every ingest run would fail. Fail at startup, where it's legible.
 */
function requireNonEmpty(list: string[], name: string): string[] {
  if (list.length === 0) {
    throw new Error(`${name} is set but empty — unset it for the defaults, or list at least one type`);
  }
  return list;
}

/** Unset means "use the defaults"; set-but-empty means "none". */
function parseList(raw: string | undefined, separator: string): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
}
