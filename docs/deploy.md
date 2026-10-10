# Deploying the engine (#6)

`scripts/deploy-gcp.sh` puts the ingest on Google Cloud: a Cloud Run **job** that Cloud Scheduler
starts on a cron, under its own service account, with the image built from the `Dockerfile`.

> **Status: the ingest part has run once, on the demo project (2026-10-05)**, from a terminal: the ingest job and its
> schedule, followed by the smoke test (`scripts/smoke-gcp.sh`). The agent job (`DEPLOY_AGENT=1`, `github-actions`
> isolation) was deployed there from a terminal on 2026-10-07 and runs hourly **in dry run**: on 2026-10-08 it triaged three
> incidents with Gemini and its fix stage declined each (#259); verify, review and a pull request have not been reached on a
> real incident. The `cloud-run-job` verify job has never been deployed. The admin API (`DEPLOY_ADMIN_API=1`) was deployed once
> on 2026-10-07 (see its section), and the GitHub Actions workflows below have **never run**. The script's whole plan is pinned by `scripts/deploy-gcp.test.mjs`
> (a dry run), and CI builds the image.

## Run it

The whole sequence, in order, with the console steps only a person can do, is in [`setup.md`](setup.md).
This page is the reference for the deploy script itself.

```bash
DRY_RUN=1 PROJECT_ID=my-project scripts/deploy-gcp.sh   # prints every command, changes nothing
PROJECT_ID=my-project scripts/deploy-gcp.sh             # does it
```

Everything deployment-specific is an environment variable (the header of the script lists them
all): `PROJECT_ID`, `REGION`, `WATCHED_PROJECT_ID`, `VERTEX_PROJECT_ID`, `STARFISH_ENV`,
`SCHEDULE`, `EXTRA_ENV_VARS` for any other engine setting in `.env.example`. A demo wants
`SCHEDULE='*/5 * * * *'`; the default is hourly. It is idempotent: run it again to ship a new
image or change the schedule. Each name may appear once in a job's settings: an `EXTRA_ENV_VARS` entry that repeats a name the
script sets (or one set twice) is refused before anything changes, so a setting is never silently replaced (#147).

**Taking a name out of `EXTRA_ENV_VARS` or `AGENT_EXTRA_ENV_VARS` does not unset it.** Every job is deployed with
`gcloud ... --update-env-vars`, which changes the names it is given and keeps every other one as it was deployed. So the
switches that let Starfish act on its own are always set by the script, to the engine's default, unless a list sets them
(#174): `STARFISH_AUTO_MERGE=false`, `STARFISH_AUTO_MERGE_TARGETS=` (none), `STARFISH_PHONE_ESCALATION=false`,
`STARFISH_INDEX_AUTO_APPLY=false`, `STARFISH_INDEX_ALLOWED_TARGETS=` (none), `STARFISH_REVIEW_REQUIRED=true`, on every job
the run deploys, and `STARFISH_DRY_RUN=true` on the agent. Remove one from the list and the next deploy turns it off. The
names the script fills from its own settings are always set too, empty included (empty is the engine's default), so
emptying the setting reverts the job: `STARFISH_GITHUB_BASE_BRANCH` (`AGENT_BASE_BRANCH`), `STARFISH_VERIFY_CHECK_APP`
(`VERIFY_CHECK_APP`) and the admin API's `STARFISH_ADMIN_API_ORIGINS` (`ADMIN_API_ORIGINS`) (#229, #233). Any
other name keeps its last deployed value when it leaves a list: to undo it, set it to its default
(`.env.example`) instead of deleting it. The script does not switch to `--set-env-vars`, which would replace the whole set:
whether that leaves the secrets mounted with `--update-secrets` in place has not been checked.
`STARFISH_MONITORING_ENABLED=true` turns on the Cloud Monitoring failure signal (#19): the script sets it on the ingest
job (and the admin API) and only then grants their accounts `roles/monitoring.viewer` on the watched project and enables
the Monitoring API there. It is refused in `EXTRA_ENV_VARS`, so the setting and its role can't disagree. Turning it off
again stops the reads but does not remove a role granted earlier. Dry-run tested only; never run against a real project.

The person running it needs rights to enable APIs, create service accounts, set IAM and deploy
Cloud Run and Scheduler on `PROJECT_ID` (Owner is the easy way), plus IAM rights on the watched and
Gemini projects when those are different. `gcloud auth login` first.

## What it creates

| Resource | Why |
|---|---|
| APIs: Cloud Run, Scheduler, Secret Manager, Cloud Build, Artifact Registry, Firestore, Logging, IAM, Vertex AI | what the rest needs |
| Service account `starfish-engine` | the identity the job runs as |
| `roles/logging.viewer` on the **watched** project | read its logs |
| `roles/datastore.user` on Starfish's project, **conditioned to the `starfish` database** | read and write the store and nothing else in the project (the watched app's `(default)` database stays out of reach when the project is shared) |
| `roles/aiplatform.user` on the **Gemini** project | call Gemini |
| Firestore database `starfish` (`STARFISH_DATABASE_ID`), then `firestore.rules` and indexes **to that database** | Starfish's own database. `(default)` is refused: its rules would replace the watched app's. `firebase.json` names `starfish`; the script deploys from a temporary copy that names the configured id instead (#148), so a custom id needs no file edited |
| Secret `starfish-github-token`, readable **by the agent's account only** (with `DEPLOY_AGENT=1`) | see below. The engine's account gets no access, and an access an earlier version granted it is removed |
| Cloud Run job `starfish-ingest`, **no secret mounted** | one ingest run per execution; exits 1 when the run failed |
| Service account `starfish-scheduler`, `roles/run.invoker` **on that job only** | the scheduler can start the job and do nothing else |
| Scheduler job `starfish-ingest-tick` | the cron |

The three engine roles are separate bindings on separate projects, so watching one project,
storing in another and running Gemini in a third needs no code and no wider access.

## Secret Manager

The script creates the secret. Only `src/agentCli.ts` uses the token, so only the **agent's** account may read it and only the
**agent** job mounts it (#146); the ingest job and the admin API have neither the access nor the mount (a re-deploy removes both
where an earlier version of the script had set them). With `STARFISH_GITHUB_TOKEN` set (not `GITHUB_TOKEN`, which is the Actions workflow's own token and often a personal one in a shell) it stores
the value as a new version (over stdin, never printed or passed as an argument), and the agent job mounts it as
`STARFISH_GITHUB_TOKEN`; without a version, Cloud Run would refuse the deploy, so it is not mounted.

**What the Settings page shows.** Storing a secret does not change the Settings page by itself: the secrets are mounted on the agent job only, and the
browser can't read them. At the start of each `pnpm agent` pass the job writes which of them it holds (booleans, never a value) to
`starfish_runs/integrations`, and GitHub and Slack then read "Token configured" / "Webhook configured" with the time it was reported. Until the
agent has run once the cards say "Not connected yet". "Configured" means set, not working: nothing has called GitHub or Slack for real.

**Slack (#17).** With `DEPLOY_AGENT=1` and `STARFISH_SLACK_WEBHOOK_ONCALL=https://hooks.slack.com/services/...` set, the script stores the
webhook as a version of its own secret, `starfish-slack-oncall` (over stdin, never printed; any other URL is refused, unechoed),
lets only the **agent's** account read it, and mounts it on the **agent** job only, in the same `--update-secrets` flag as the
GitHub token. Add `AGENT_EXTRA_ENV_VARS="STARFISH_UI_URL=https://<site>.web.app"` so the message can link back to the incident and its run.
Without a webhook nothing Slack-shaped is created. The agent is a dry run by default and a dry run **sends nothing**: the cycle's
record says `dry-run`. To post for real, turn dry run off (`STARFISH_DRY_RUN=false` in `AGENT_EXTRA_ENV_VARS`, or an admin on the Settings page; `EXTRA_ENV_VARS` may not set it, #147), which also lets a configured GitHub client open pull requests.
A failed delivery is recorded on the cycle (`summary.notify`: `failed`, the status and Slack's short error code, never the URL) and the cycle still
finishes. Delivery is at-least-once: after a crash between the post and its record a resumed cycle posts again. Never run against real Slack.
The optional `#ops-alerts` "new incident" webhook, `STARFISH_SLACK_WEBHOOK_ALERTS`, is handled exactly the same way in a secret of its own,
`starfish-slack-alerts` (agent's account, agent job, the same `--update-secrets` flag), and recorded as `summary.alert`.

**Phone escalation (#37). It costs money: a Twilio phone number is a monthly charge, and every call and text is billed by
Twilio.** It is off by default and nothing here turns it on. What the operator must provide:

- **A Twilio account and a voice-capable number.** Give the script all three of `STARFISH_TWILIO_ACCOUNT_SID`,
  `STARFISH_TWILIO_AUTH_TOKEN` and `STARFISH_TWILIO_FROM_NUMBER` (E.164, `+15551234567`): it stores each over stdin as a
  version of its own secret (`starfish-twilio-account-sid`, `-auth-token`, `-from-number`; never printed; a partial set or
  a value of the wrong shape is refused by name, unechoed), lets only the **agent's** and the **admin API's** accounts read
  them, and mounts them on those two only (the agent places calls; the admin API serves Twilio's webhooks, which it checks
  against the auth token, and texts the opt-in codes). Without them nothing Twilio-shaped is created.
- **The recording.** One audio file (MP3 or WAV) saying, in your words, that an urgent incident needs a person and the
  details are in the on-call channel. It must name no incident: every call plays the same file. Twilio fetches it, so it
  must be public over https, e.g. an object in a Cloud Storage bucket with `allUsers` as `roles/storage.objectViewer` on
  that object only. Set `STARFISH_ONCALL_AUDIO_URL` to it.
- **Where Twilio calls back.** Deploy the admin API (`DEPLOY_ADMIN_API=1`) and set `STARFISH_TWILIO_WEBHOOK_URL` to its
  URL (the origin only, e.g. the `https://...run.app` the script prints). The signature on each webhook is checked against
  this configured origin, never the request's Host header.

Then, in `EXTRA_ENV_VARS` (so the agent and the admin API agree): `STARFISH_PHONE_ESCALATION=true`,
`STARFISH_ONCALL_AUDIO_URL=...`, `STARFISH_TWILIO_WEBHOOK_URL=...` and `STARFISH_UI_URL=...` (the link a "2" texts). An
admin then adds the on-call people in Settings -> On-call, has each one confirm their number with the code Starfish texts
on request, and turns the admin's switch on. Calls are placed only with the agent's dry run off; a dry run records on the
cycle what it would have done. The waits (10 minutes, then 2) are checked at each agent pass and whenever Twilio reports a
call's end; for tighter timing, schedule `pnpm escalate` more often (this script does not). Built, tested against a fake
Twilio and the Firestore emulator; **never run against real Twilio**.

`loadGithubToken()` (`src/config.ts`) reads that variable, and the pull-request opener
(`src/integrations/githubPr.ts`) is its only user. The opener is tested against a local git remote
and a fake GitHub API, **not against real GitHub**, and the only job that calls it (the agent job, deployed
2026-10-07) runs in dry run, so the token has cloned the repository but opened nothing. The deploy script sets `STARFISH_GITHUB_REPO` (from `AGENT_REPO`) on the
agent job only; without it the opener cannot be built.

**The incident's issue (#17).** For every incident the agent acts on or escalates (not a declined one) it files one GitHub issue in
`STARFISH_GITHUB_REPO`, labelled `starfish`, with what is failing, the evidence (fingerprint, the independent counter-check, the suspected
cause), what Starfish will do, and links to the incident and the run (with `STARFISH_UI_URL`). The token therefore needs **Issues: read and
write** as well as contents and pull requests. A retry after a crash or timeout finds the issue it already filed (a marker in its body, among the
newest `starfish`-labelled issues in the repository's own list, not the search index, which lags) and files no second. A pull request the cycle
opens says `Closes #N`; the Slack message links the issue. A failure to file is recorded on the cycle (`summary.issue`: `failed`, GitHub's rule)
and the cycle goes on, because the issue is the incident's history and not a step the fix depends on. A dry run files nothing and says so.
Tested against a fake GitHub API over local HTTP; never run against real GitHub.

Starfish pushes only to branches named `starfish/<id>` and the engine checks that, but a GitHub App's
permission cannot be limited to a branch prefix. If "Starfish can write only its own branches" is to be
a guarantee and not a convention, protect the base branch and restrict who may push, with a branch
protection rule or a ruleset on the repository, including who may bypass it.

## The job does not read its own errors

The engine's job logs under `cloud_run_job`; the default log resource types are `cloud_function` and
`cloud_run_revision`. So with the defaults Starfish does not ingest its own failures. As a second guard,
the deploy sets `STARFISH_EXCLUDED_SERVICES=starfish,<job name>,<admin API service>` on the job (#32: matched on the exact
name, not a prefix; a trailing `*` in the list does exclude a prefix, such as the demo app's `control-*`), so adding `cloud_run_job` to `STARFISH_LOG_RESOURCE_TYPES` later still would not make
the engine read itself. The admin API's service name (`starfish-admin`, `ADMIN_SERVICE_NAME`) is in that list on every
deploy, with or without `DEPLOY_ADMIN_API=1` (#177): a later run that leaves the admin API out (the Actions workflow
without `STARFISH_DEPLOY_ADMIN_API`, say) must not start ingesting the service an earlier run deployed, and a name no
service has costs nothing. The agent's list adds the agent job and, with `cloud-run-job`, the verify job.
When `STARFISH_ENV=demo`, both jobs also exclude `traffic-*`, `control-*` and `stub-*` by default.
An explicit `STARFISH_EXCLUDED_SERVICES` in `EXTRA_ENV_VARS` replaces it, so keep the defaults in it: for the demo app,
`EXTRA_ENV_VARS='STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-agent,starfish-admin,traffic-*,control-*,stub-*'` (the entries
are separated by `@`, which the script adds: no leading or trailing `@`).

## After the first deploy

```bash
PROJECT_ID=my-project SMOKE_ACTOR_UID=<admin uid> scripts/smoke-gcp.sh   # plants one error, runs the job, checks THAT incident, retires it
pnpm status                                    # is the engine alive? (needs GOOGLE_CLOUD_PROJECT and STARFISH_ENV; a runtime-settings environment overrides it, as for the job; like a job run it may refresh the settings' last-good copy)
gcloud run jobs executions list --job=starfish-ingest --region=us-central1 --project=my-project
```

`pnpm status` exits 0 when the engine is ok, 1 when it is not, and 2 when the store could not be read at all, which says
nothing about the engine: expired or missing credentials (Google Workspace asks for a new sign-in on a schedule; the line it
prints says to run `gcloud auth application-default login`) or an account that may not read the database.

`scripts/preflight-gcp.sh` is the read-only check to run *before* the deploy.

Then look at `starfish_runs/last_run` in the `starfish` database (it is what the Incidents page
shows as "engine status") and at the incidents collection. A failed run exits 1; a missing run shows
in the UI as stopped, past `VITE_STARFISH_STALE_MINUTES`.

### The guests' trimmed copies (#18)

Guests (the public demo's anonymous visitors) no longer read the incidents, cycles and run events: the rules serve them
only the trimmed copies the engine writes for `STARFISH_PUBLIC_ENVIRONMENTS` (default `demo`) into
`starfish_public_incidents`, `starfish_public_cycles` and `starfish_public_events` (`src/publicView.ts`). Two steps are a
person's, once, on a deployment that already holds demo records; **neither has been run on a real project**:

1. **Deploy the rules and indexes together.** `scripts/deploy-gcp.sh` deploys `firestore.rules` and `firestore.indexes.json`
   in one step, and the indexes include three new composite ones, `environment` + `lastOccurredAt` on
   `starfish_public_incidents`, `environment` + `updatedAt` on `starfish_public_cycles` and `environment` + `at` on
   `starfish_public_events`. Until they finish building, a guest's Incidents, Runs and Overview pages say they could not
   read the data (Firestore refuses the query); operators are unaffected.
2. **Copy what is already stored**: `pnpm public-view` counts what it would write and remove, and
   `pnpm public-view -- --apply --project=<id>` writes the copies (and removes any whose record is gone, retired or
   private). Until then a guest sees only what the engine has written or touched since the deploy: new incidents, and the
   newest 50 incidents and cycles the jobs sweep after each run. `pnpm seed-demo -- --apply` writes its own copies.

The ingest job (and the agent job, when deployed) keeps the copies up to date as it writes and sweeps the newest 50 after
each run; an operator's triage reaches a guest at the next run.

## Deploy from GitHub Actions (#75)

`.github/workflows/deploy.yml` runs the same `scripts/deploy-gcp.sh`, unchanged, so a teammate with no
local `gcloud` can roll out the engine: **Actions → Deploy engine → Run workflow**. The job swaps
GitHub's short-lived OIDC token for short-lived Google credentials (Workload Identity Federation), so
there is **no service-account key** and **no GitHub secret**. The script is never handed the workflow's
`GITHUB_TOKEN`; it reads `STARFISH_GITHUB_TOKEN`, which the workflow leaves unset, so the existing
`starfish-github-token` version and its mount are left as they are (set it once from a terminal, see above).

> **Status: written and pinned by a test (`scripts/deploy-workflow.test.mjs`), never run.** Nothing below
> has been exercised against a real project or a real runner. The role list is a starting set derived from
> the commands the script runs, not a verified minimum: the first run will probably name a missing
> permission, and the fix is to add that role here and in the table, not to widen it to Owner.

**Decisions made (both can be changed by a person; neither is a code change in the engine):**

- **Trigger: by hand, and on merge only when a person turns that on.** The workflow also runs on a push to
  `main` that changes what the engine runs (`src/` outside tests, the Dockerfile, the lockfile, the rules, the
  deploy script), but only when the repository variable `STARFISH_DEPLOY_ON_MERGE` is `true`; unset, a merge
  changes nothing. Each run spends a Cloud Build. With it on, whoever can merge to `main` changes what is
  running: add required reviewers to the `deploy` environment to keep a person in that loop. The web UI
  workflow works the same way for `web/`.
- **Approval: a GitHub environment named `deploy`.** The job runs in it, and the Workload Identity provider
  below accepts only tokens minted for that environment, so its protection rules are the real gate. Add
  **required reviewers** for a manual approval, and **limit deployment branches to `main`**: without that,
  anyone who can push a branch can edit `deploy.yml` there and dispatch it.

### One-time setup

**One command, from Cloud Shell, as an owner of the project:**
`PROJECT_ID=my-project REPO=owner/name scripts/setup-github-deploy.sh` (`DRY_RUN=1` prints the plan). It does
everything in the block below except the GitHub side, which it prints for you: the `deploy` environment and the
repository variables. Dry-run tested; never run against a real project. The block below is the same thing by hand.

Run these as someone with rights to create a pool and a service account on the project. `OWNER/REPO` is this
repository; `PROJECT_ID` is the project Starfish deploys into.

```bash
export PROJECT_ID=my-project REPO=OWNER/REPO
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

export REPO_ID=$(gh api "repos/$REPO" --jq .id)   # the repository's numeric id

# 1. A pool and a GitHub provider. The attribute condition is not optional: without it, any GitHub
#    repository could present a token to this provider. This one accepts only this repository's jobs
#    that run in the `deploy` environment, by the repository's id: a name can be renamed and then
#    registered again by someone else, an id cannot (#145).
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT_ID"
gcloud iam workload-identity-pools create github --project="$PROJECT_ID" --location=global \
  --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github-deploy --project="$PROJECT_ID" \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository=assertion.repository,attribute.environment=assertion.environment" \
  --attribute-condition="assertion.repository_id == '$REPO_ID' && assertion.environment == 'deploy'"

# 2. The deploy identity: its own service account, separate from starfish-engine (which only runs the
#    job) and starfish-scheduler (which only starts it). Only this repository's pool members may use it.
gcloud iam service-accounts create starfish-deployer --project="$PROJECT_ID" \
  --display-name="Starfish deployer (GitHub Actions)"
gcloud iam service-accounts add-iam-policy-binding \
  "starfish-deployer@$PROJECT_ID.iam.gserviceaccount.com" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$REPO_ID"

# 3. Give the deployer what the script needs (the table below), then tell GitHub where to find it.
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER \
  --body "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-deploy"
gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --body "starfish-deployer@$PROJECT_ID.iam.gserviceaccount.com"
gh variable set STARFISH_GCP_PROJECT_ID --body "$PROJECT_ID"
```

Then create the `deploy` environment (Settings → Environments), with reviewers and the `main`-only
deployment branch rule above.

**What the deployer needs, by what the script does.** All on `PROJECT_ID` unless noted. The account names, secret names and
verify bucket follow the same variables as `deploy-gcp.sh` (`ENGINE_SA_NAME`, `AGENT_SA_NAME`, `GITHUB_SECRET`, `VERIFY_BUCKET`, ...):
set them for `setup-github-deploy.sh` as you set them for the deploy.

| The script does | Role |
|---|---|
| enable APIs | `roles/serviceusage.serviceUsageAdmin` (on the Gemini and watched projects too, when they differ) |
| create and read the service accounts | custom role `starfishDeployer`: `iam.serviceAccounts.create`, `iam.serviceAccounts.get` (and the two creates below). **Not** `roles/iam.serviceAccountAdmin`, which would let it set the IAM policy of every account in the project (#145) |
| run a job, the admin API and a scheduler call *as* those accounts | `roles/iam.serviceAccountUser`, on `starfish-engine`, `starfish-scheduler`, `starfish-agent`, `starfish-verifier` and `starfish-admin-api` only, not project-wide |
| build the images from source | `roles/iam.serviceAccountUser` on the account Cloud Run builds as (`BUILD_SERVICE_ACCOUNT`, else the Compute Engine default account): Cloud Build refuses a caller that may not act as it. What that account may do, the deployer can do through a build, so it should hold `roles/run.builder` and nothing more |
| with `cloud-run-job`: let the agent's account sign URLs as itself | custom role `starfishServiceAccountIam` (`get`, `getIamPolicy`, `setIamPolicy`) on **`starfish-agent` only**; the deployer already acts as that account, so this reaches no new one |
| bind the engine's, agent's and admin API's roles | `roles/resourcemanager.projectIamAdmin`, on `PROJECT_ID`, the watched project and the Gemini project, each conditioned to the roles the script binds on **that** project (see the warning below) |
| create the `starfish` database, deploy rules and indexes | `roles/datastore.owner`, `roles/firebaserules.admin` |
| create the secrets, grant the agent access, add a version | `secretmanager.secrets.create` (in `starfishDeployer`), and `roles/secretmanager.admin` **conditioned to `starfish-github-token`, `starfish-slack-oncall`, `starfish-slack-alerts` and the three `starfish-twilio-*` secrets by name**: the watched app's secrets, when it shares the project, stay out of reach |
| build from source and deploy the jobs, bind the scheduler to them | `roles/run.admin`, `roles/cloudbuild.builds.editor`, `roles/artifactregistry.admin`; `storage.buckets.create` and `storage.buckets.list` (in `starfishDeployer`), and `roles/storage.admin` **conditioned to the source bucket** (`run-sources-<project>-*`, or the older `<project>_cloudbuild`) and, with `cloud-run-job`, the verify bucket |
| create or update the schedule | `roles/cloudscheduler.admin` |

`gcloud run jobs deploy --source` also acts as the project's build service account; if the first run is denied
there, see "The build is denied" below.

> **`projectIamAdmin` is the powerful one.** A principal that can set IAM policy can grant itself anything.
> Limit it, on each project, to the roles the script grants on **that** project (#228), with an IAM condition on the
> deployer's own binding there, `api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([...])`:
>
> | Project | The deployer may grant only |
> |---|---|
> | `PROJECT_ID` | `roles/run.builder` (the build account), `roles/datastore.user` (the engine's, the agent's and the admin API's, conditioned to Starfish's database), `roles/firebaseauth.viewer` (the admin API's account only) |
> | the watched project | `roles/logging.viewer` (the engine, the agent, the admin API), `roles/monitoring.viewer` (the engine and the admin API, only with `STARFISH_MONITORING_ENABLED=true`, #176) |
> | the Gemini project | `roles/aiplatform.user` (the engine, the agent) |
>
> A project that is more than one of these (by default all three are `PROJECT_ID`) gets one binding with the roles of each.
> So on a watched project of its own, the app's production, the deployer can hand out reading its logs and metrics and
> nothing else: not a database role or Firebase Auth's viewer, which there would reach the app's data and users (#213).
> `scripts/setup-github-deploy.sh` applies these conditions, and on a re-run first removes the deployer's `projectIamAdmin`
> bindings on each project (IAM would otherwise keep an earlier, wider one beside the new one). A test checks each list
> against what a dry run of `deploy-gcp.sh` binds on each project, with the agent, the admin API and the Monitoring signal
> on and off, and with the three projects one, two or three. None of this has been tried: the script reads and writes
> the whole policy, and a conditioned `getIamPolicy` may need adjusting.
>
> **The condition only governs the project's own policy.** A grant on a service account, a secret, a bucket or a Cloud Run job
> goes on that resource's policy, where it does not apply. That is why the deployer gets no project-wide
> `roles/iam.serviceAccountAdmin`, `roles/secretmanager.admin` or `roles/storage.admin` (#145): with them it could make itself a
> token creator on any account (the Compute default account is often Editor) or read every secret and bucket. **Still
> project-wide**: `roles/run.admin` (every Cloud Run service and job in the project, including the watched app's when it shares the
> project, and their IAM policies), `roles/artifactregistry.admin`, `roles/cloudbuild.builds.editor`, `roles/datastore.owner` (every
> database, the app's `(default)` too) and `roles/cloudscheduler.admin`. Treat the deployer as highly privileged, which is the
> reason for the `deploy` environment's gate. Whether Cloud Storage and Secret Manager accept these name conditions for every call
> the deploy makes has **not been tried**; the first run will say if a permission is missing.

### Repository variables

Set under Settings → Secrets and variables → Actions → Variables. Nothing deployment-specific is in the
workflow file. The first three are required; the rest are the script's own settings and fall back to its
defaults when empty.

| Variable | Script setting | |
|---|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | (auth) | required: the provider's full resource name |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | (auth) | required: `starfish-deployer@…` |
| `STARFISH_GCP_PROJECT_ID` | `PROJECT_ID` | required |
| `STARFISH_REGION` | `REGION` | default `us-central1` |
| `STARFISH_WATCHED_PROJECT_ID`, `STARFISH_VERTEX_PROJECT_ID` | `WATCHED_PROJECT_ID`, `VERTEX_PROJECT_ID` | default the project itself |
| `STARFISH_ENV` | `STARFISH_ENV` | default `dev` |
| `STARFISH_DATABASE_ID`, `STARFISH_FIRESTORE_LOCATION` | `STARFISH_DATABASE_ID`, `FIRESTORE_LOCATION` | |
| `STARFISH_SCHEDULE`, `STARFISH_SCHEDULE_TIME_ZONE` | `SCHEDULE`, `SCHEDULE_TIME_ZONE` | default hourly, UTC |
| `STARFISH_EXTRA_ENV_VARS` | `EXTRA_ENV_VARS` | `A=1@B=2` |
| `STARFISH_MONITORING_ENABLED` | `STARFISH_MONITORING_ENABLED` | `true` turns on the Cloud Monitoring signal (#19) and grants `roles/monitoring.viewer` on the watched project; default off |
| `STARFISH_VERTEX_LOCATION` | `VERTEX_LOCATION` | where Gemini is called (`STARFISH_VERTEX_LOCATION` on every job): a region, or `global` for a model served only there; default the region. Apart from `STARFISH_REGION`, which Cloud Run needs to be a real region |
| `STARFISH_INDEX_TARGETS` | `INDEX_TARGETS` | with the agent: the databases the missing-index repair may create an index in, `project/database` comma-separated (`STARFISH_INDEX_ALLOWED_TARGETS`). Grants the agent `roles/datastore.indexAdmin` and `roles/datastore.viewer` on each, conditioned to that database. Creating still needs `STARFISH_INDEX_AUTO_APPLY=true` in `STARFISH_AGENT_EXTRA_ENV_VARS`. Run `setup-github-deploy.sh` again with the same `INDEX_TARGETS` first, so the deployer may grant them |
| `STARFISH_DEPLOY_AGENT`, `STARFISH_AGENT_REPO` | `DEPLOY_AGENT`, `AGENT_REPO` | set `1` and `owner/name` to deploy the agent too ([below](#the-agent-and-where-its-tests-run-74)); default off |
| `STARFISH_VERIFY_ISOLATION`, `STARFISH_VERIFY_CHECKS`, `STARFISH_VERIFY_COMMAND` | `VERIFY_ISOLATION`, `VERIFY_CHECKS`, `VERIFY_COMMAND` | `github-actions` (default) with the check names that must pass, or `cloud-run-job` with a command |
| `STARFISH_VERIFY_CHECK_APP` | `VERIFY_CHECK_APP` | the slug of the GitHub App whose check runs count (#229); default the engine's, `github-actions`. Always set on the agent job, so emptying it restores the default |
| `STARFISH_VERIFY_TIMEOUT_SECONDS`, `STARFISH_VERIFY_BUCKET`, `STARFISH_AGENT_BASE_BRANCH`, `STARFISH_AGENT_SCHEDULE`, `STARFISH_AGENT_EXTRA_ENV_VARS` | `VERIFY_TIMEOUT_SECONDS`, `VERIFY_BUCKET`, `AGENT_BASE_BRANCH`, `AGENT_SCHEDULE`, `AGENT_EXTRA_ENV_VARS` | default 600, `<project>-starfish-verify`, `main`, `30 * * * *`. The base branch is always set on the agent job, so emptying it restores `main` (#233) |
| `STARFISH_DEPLOY_ADMIN_API`, `STARFISH_ADMIN_API_ORIGINS` | `DEPLOY_ADMIN_API`, `ADMIN_API_ORIGINS` | set `1` and the site's origin to deploy the admin API too ([below](#the-admin-api-run-ingest-now-and-retire-an-incident-63-65)); default off. Its service name is kept out of ingest either way (#177) |

`BUDGET_USD` and `BILLING_ACCOUNT` are not wired: a budget lives on the billing account, which the deployer
has no role on. Create the budget once from a terminal (`docs/setup.md`).

The workflow's inputs are `dry_run` (print the plan, change nothing), `run_after_deploy`, and
`skip_firestore_rules`. The last exists because `firebase-tools` signing in through Workload Identity is the
part least likely to work first time; if it fails, deploy once with the box ticked and the rules from a terminal.

**What the run log holds:** the script's own progress lines and `gcloud` output. The workflow never turns on
shell tracing, passes no secret, and the auth step writes a credentials *file* that refers to the token exchange rather
than holding a key. A real run is the check that no value leaks, and it has not happened (#75's done-when).

**What a `dry_run` checks (#175).** The script's dry run makes no `gcloud` call, and the auth step only writes a
credentials file, so neither touches Google. A `dry_run` therefore adds one step before the script, "Check the sign-in",
with two read-only calls that fail the run if they fail: `gcloud projects describe "$PROJECT_ID"` and
`gcloud iam service-accounts describe <the deployer> --project="$PROJECT_ID"`. They pass only if Google accepts this job's
OIDC token at the provider (this repository's id, the `deploy` environment), the job may act as the deployer
(`roles/iam.workloadIdentityUser`), and the deployer may read the project (`resourcemanager.projects.get`) and its own
account (`iam.serviceAccounts.get`, in `starfishDeployer`). They check none of the other roles the deploy needs: the
first real run is that check. This step has never run.

## Deploy the web UI from GitHub Actions (#92)

`.github/workflows/deploy-web.yml` runs `scripts/deploy-web.sh`, unchanged: **Actions → Deploy web UI → Run
workflow**. It uses the same Workload Identity pool, provider, `starfish-deployer` account and `deploy`
environment as the engine deploy above, so there is nothing new to set up in the pool; it runs by hand, or on a push to `main` that
changes `web/` or an engine file the UI bundles (`src/settingsSchema.ts`, `src/oncallSchema.ts`; a test derives the list from
the UI's imports, #178) when `STARFISH_DEPLOY_ON_MERGE` is `true`; keyless, uses no GitHub secret, and has the same decisions on trigger and approval (follow whatever you
chose for the engine). Unlike the engine deploy it runs `pnpm install --frozen-lockfile` first, because it builds the UI.
Its `dry_run` prints the plan, the build included, without running it, and makes the same two read-only sign-in calls as
the engine's (above); the script's own reads in a dry run fail open, so they check nothing.

> **Status: written and pinned by a test (`scripts/deploy-workflow.test.mjs`), never run. The script itself ran once
> from a terminal, on the demo project (2026-10-05).** Whether the Firebase CLI accepts the federated credentials the auth step
> writes (Application Default Credentials) is **not verified**; that is the first thing a run will show. If it
> does not, the fallback is still `firebase login` and `scripts/deploy-web.sh` from a terminal.

**What the deployer needs on top of the engine's list** (a starting set, not a verified minimum; the first run
will name what is missing): Firebase Hosting Admin (`roles/firebasehosting.admin`) to create the site and release
to it (and to link an existing site to the web app, below), and a role holding `firebase.apps.create` for the
one-time web-app registration (the script registers a web app named `starfish` when the project has none by that
name). Keep both off the engine's runtime identity. Linking an existing site also uses `gcloud`, which the workflow sets
up with the federated credentials (never run); if that call fails, link the site once from a terminal or the console.

**The site must be linked to a web app (#156).** On a Hosting site that is not the project's default one,
`/__/firebase/init.json` carries the config of the web app linked to that site; with none linked it has no `appId`
and the UI stops with "init.json is missing appId". `scripts/deploy-web.sh` therefore: creates a new site linked to
the web app named `starfish` (registering it if missing; never another app in the project); links an existing site
that has no app to that same app, with the Hosting REST API's `sites.patch` (`updateMask=appId`, token from
`gcloud auth print-access-token`) and reads the site back to confirm; and leaves a site that is already linked as it
is. It never links the project's default site. A dry run makes the two reads (`hosting:sites:get`, `apps:list`)
when it can and prints which of these it would do. **The linking call is dry-run tested only, not yet run on a real
project**; whether Hosting accepts a web app already linked to another site is not known. If it fails, the manual
fix is the console: Project settings → Your apps → the `starfish` web app → "Link to a Firebase Hosting site".

**Repository variables** (nothing deployment-specific is in the workflow): the same three required ones, plus
`STARFISH_ENV` (the label the page shows; **`demo` for the public page**), `STARFISH_DATABASE_ID`, and
`STARFISH_WEB_HOSTING_SITE` (default `<project>-starfish`, its own site so the watched app's keeps the default), and
optionally `STARFISH_WEB_APPCHECK_SITE_KEY` (App Check, below; unset = off), `STARFISH_WEB_ADMIN_API_URL` (the admin API's
URL, built in as `VITE_STARFISH_ADMIN_API_URL`: without it an admin sees no "Run ingest now" or "Retire", #230; [below](#the-admin-api-run-ingest-now-and-retire-an-incident-63-65))
and `STARFISH_WEB_STALE_MINUTES` (`VITE_STARFISH_STALE_MINUTES`, when the engine line calls a run stopped; unset = 90).
Anonymous sign-in is **not** turned on by the workflow: it is project-wide (see `setup.md`). Input: `dry_run`.

### App Check and the uptime check (#12)

**App Check (optional, off by default).** Build the UI with `VITE_STARFISH_APPCHECK_SITE_KEY=<reCAPTCHA site key>`
(and `VITE_STARFISH_APPCHECK_PROVIDER=v3` for a reCAPTCHA v3 key; Enterprise is the default) and it initialises Firebase
App Check before its first Firestore call (`web/src/lib/appCheck.ts`), so every read, a guest's included, carries a token
from the registered web app; the admin API call carries one too, as `X-Firebase-AppCheck`. With no key nothing changes:
App Check is not initialised and the UI, guests included, works as before. On the emulators it is skipped (they do not
check tokens). For local development against a real project with enforcement on, `VITE_STARFISH_APPCHECK_DEBUG_TOKEN`
(a registered debug token, or `true` to have the SDK print one) works in the dev server only; `scripts/deploy-web.sh`
refuses to build with one set, in the environment or in `web/.env*`, because Vite would put it in the bundle.

The admin API can require it too: `STARFISH_ADMIN_API_APPCHECK=true` (through `EXTRA_ENV_VARS`; default off). A POST
then needs a valid App Check token as well as the ID token, checked with the Admin SDK (`getAppCheck().verifyToken`), and
a missing or rejected one gets the same 401 as a bad ID token. Turn it on only after the site is built with a site key.

**Enforcement is a console step, and deliberately not scripted.** Sending tokens protects nothing until Firestore
*requires* them, and that switch is per product (Cloud Firestore), not per database as far as the console shows (the
question in #12; not verified here). In a project shared with the watched app (#32), enforcing would refuse that app's
Firestore clients too unless they also attest. So, by hand:

1. Create a reCAPTCHA Enterprise key for the site's domain (Google Cloud console → Security → reCAPTCHA; a score-based
   web key, domain `<site>.web.app`). reCAPTCHA Enterprise has a free monthly allotment of assessments and bills beyond
   it: check its pricing before a public demo.
2. Firebase console → App Check → Apps → the `starfish` web app → register it with that key.
3. Redeploy the UI with `VITE_STARFISH_APPCHECK_SITE_KEY=<key> scripts/deploy-web.sh`.
4. App Check → APIs → Cloud Firestore: watch the request metrics until the traffic you expect is verified (and the
   watched app's, if it shares the project), then **Enforce**. Leave Authentication unenforced: anonymous guest sign-in
   needs nothing more.

> **Status: written and unit-tested (the UI's initialisation and token header with a stubbed SDK; the admin API's check
> with stubs and over a local HTTP server). Never run against a real project, real reCAPTCHA, or enforcement.**

**Uptime check and alert (optional).** `UPTIME_CHECK=1 scripts/deploy-web.sh` also enables Cloud Monitoring and creates,
each only if none by its name exists: an uptime check `starfish-web <site>` (https, every 5 minutes, on
`/__/firebase/init.json` and passing only when it contains `"appId"`, which is what the UI needs to start; `/` would pass
even on a broken site, since Hosting answers it with `index.html`), and an alert policy `starfish-web down: <site>` (Google's
uptime template: the check failing from more than one region in 20 minutes), created through the Monitoring REST API
because `gcloud` has alert policies only in alpha/beta. `UPTIME_NOTIFICATION_CHANNELS=projects/<p>/notificationChannels/<id>,...`
sends it somewhere; without one it opens incidents in the console and notifies nobody (make a channel in Monitoring →
Alerting → Edit notification channels). Uptime checks are billed beyond a free monthly allotment; this one is well inside it.

> **Status: written and dry-run tested (the plan, the policy's JSON, the channel validation). Never run on a real project.**

## The agent and where its tests run (#74)

`DEPLOY_AGENT=1 AGENT_REPO=owner/name` makes the script also deploy **the agent**: a Cloud Run job `starfish-agent` and a
Scheduler job `starfish-agent-tick` (hourly at :30), under its own service account `starfish-agent` (the store's
`starfish` database only, Gemini, `logging.viewer` on the watched project for the counter-check, the one secret). It
runs `pnpm agent` (`src/agentCli.ts`): pick open incidents with no settled cycle, check the repository out, run triage,
fix, verify and review as a **dry run** (which, with `github-actions` isolation, still pushes the patch to a `starfish/<cycle>` branch: below).

The agent holds those credentials, so it **never runs the target repository's code**: the verify step is isolated, and
`VERIFY_ISOLATION` says where. There are two, and the first is the default and the one decided for the demo.

### `github-actions`: the target's own CI is the judge

> **Status: written and tested against real git, a fake GitHub API and a fake CI; never run against real GitHub or a
> real workflow.**

1. The agent runs the deterministic half of the verify gate itself, without executing anything of the patch: it must
   apply, touch no excluded path (`.github/` is one, so **a patch cannot rewrite the workflow that judges it**), add no
   link and change no file mode. A refusal stops here and nothing is pushed.
2. It pushes the patch as one commit on `starfish/<cycle>` on top of the revision it was written against.
3. It waits for the **named check runs on that exact commit** (`VERIFY_CHECKS`) and requires all of them to succeed.
   Checks belong to a commit, and the commit is the patch applied to its base, so the evidence is for this patch and no
   other. A check that failed or was cancelled is a result (the fixer sees what the checks said, once); one still
   running at the deadline is a timeout; one that never appears, or is only queued, is the infrastructure's and throws, so
   the cycle resumes.
4. A branch whose patch did not pass is deleted, so the next draft in the cycle can use the name. One that passed stays,
   and the pull request is later opened from it.

**What you must do in the target repository, once**, because the target's CI is the judge *and* the sandbox:

```yaml
# .github/workflows/starfish-verify.yml in the TARGET repository
name: starfish-verify
on:
  push:
    branches: ['starfish/**']
permissions:
  contents: read
jobs:
  verify:                         # the check run's name: VERIFY_CHECKS=verify
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<a full commit SHA>
        with:
          persist-credentials: false
      - run: pnpm install --frozen-lockfile && pnpm run verify   # whatever proves a patch in this repository
```

- **Reference no secret in that workflow**, and **make sure no other workflow runs on a push to `starfish/**`** (check
  their `branches` filters, or add `branches-ignore: ['starfish/**']`): a workflow triggered by that push runs the
  patch's code with whatever secrets it uses. This is the whole trust boundary, and it is a convention in someone else's
  repository, not something Starfish can enforce.
- **A branch is pushed even in a dry run.** The dry run opens no pull request; it does not stop the push that CI needs, and
  it spends the target's Actions minutes. In a dry run the branch is deleted once CI has judged it, passed or not (its
  check runs stay on the commit, and the verdict is recorded on the cycle), so `starfish/*` branches do not pile up. `STARFISH_GITHUB_TOKEN` must therefore be set (`preflight` refuses without it) and
  may write branches. Protect the base branch (a ruleset), as above.
- **The fixer's second draft gets thin feedback**: check names, conclusions, their summaries and a few annotations, not the
  test log. Make the workflow emit annotations (`::error file=...::message`) for failures if you want better revisions.
- Only **check runs** are read (what GitHub Actions creates); a CI that reports commit statuses instead is not seen. The
  token needs read access to checks as well as write access to contents.
- Only runs posted by **one GitHub App** count (`STARFISH_VERIFY_CHECK_APP`, default `github-actions`); a run of the same
  name from any other app is ignored. A CI that posts as another app (its slug, e.g. `my-ci-app`) is named with the script's
  `VERIFY_CHECK_APP` (#229; neither extra list may set a `STARFISH_VERIFY_*` name). The script sets it on every deploy,
  empty included, so emptying it restores `github-actions`.
- **Not exercised:** a real push triggering a real workflow, the check-run names GitHub actually reports for a job or a
  matrix, and rate limits when polling.

Deploy: `DRY_RUN=1 DEPLOY_AGENT=1 AGENT_REPO=owner/name VERIFY_CHECKS=verify PROJECT_ID=my-project scripts/deploy-gcp.sh`.
Nothing else is created: no bucket, no verify job, no extra account.

### `cloud-run-job`: a separate job with no roles (the heavier option)

Set `VERIFY_ISOLATION=cloud-run-job` and `VERIFY_COMMAND='…'` for targets whose CI cannot be trusted with this. The script
then also deploys the verify job and a bucket:

| Resource | What it is |
|---|---|
| Cloud Run job `starfish-verify`, service account `starfish-verifier` which **holds no roles** | the **only** place the target repository's tests run (`src/verifyRunnerCli.ts`) |
| Bucket `<project>-starfish-verify` (private, objects deleted after a day) | where the agent and the verify job pass the source and the result |

> **Status: written, and tested against fakes and a local stand-in for the bucket; never deployed.** The deploy plan
> is pinned by a dry run. The two halves of the protocol (`verifyRemote.ts`, `verifyRunner.ts`) are tested together,
> with the real verify gate running a real command, over a local HTTP server that, like a signed URL, allows one
> method on one object. **Not exercised:** Cloud Storage signing, the Cloud Run API call, the entrypoint's
> privilege drop in the real image, and the guarantee that the verifier's account can do nothing. Expect fixes on
> the first real run.

**Why a separate job.** The agent holds the store, Logging and Gemini credentials. The verify gate runs the target
repository's own tests, which is running candidate code (a model wrote the patch from log text an attacker can
influence), and `verifyGate.ts` is not a sandbox. In the agent's own process that code could read the metadata
server's token and reach the store. So the agent never runs it:

1. The agent packs the source snapshot (no `.git`, no `node_modules`) and the patch into a bundle in the bucket.
2. It mints two signed URLs for this run only (read the bundle, write the result), starts `starfish-verify` through
   the Cloud Run API with them as one environment override, and polls for the result object.
3. The verify job fetches the bundle, applies and judges the patch (the same gate: excluded paths, links, modes,
   size), runs the command, and writes the result to its URL.
4. The agent validates the result (typed, bounded, tied to the SHA-256 of the exact patch it sent, a pass only if
   the command exited 0), redacts its text again, and deletes the objects.

**What the verify job can and cannot do**, stated plainly: its account holds no role on any project or resource
(the script grants it nothing; a test pins that). It has no Starfish setting and no secret. The command runs as an
unprivileged user (uid 65534), in a scratch copy it owns, with a scrubbed environment: the runner starts as root
only to hand the command over, so the command cannot read the runner's memory or environment, where its result URL
is held. **It can still** use the network and the metadata server (a token for an account with no roles), so
candidate code can send out the source snapshot it was given, which is the target repository's own source. A
private repository's code leaves its network. Restricting the job's egress (a VPC with a firewall) would stop that
and would also stop the command installing dependencies, so it is not done.

**What it costs the agent in permissions:** `roles/storage.objectAdmin` on that bucket,
`roles/iam.serviceAccountTokenCreator` on **itself** (to sign the URLs), and `roles/run.jobsExecutorWithOverrides` on the
verify job only, besides what the loop needs (the store, Gemini, `logging.viewer` on the watched project for the counter-check,
the secret). The agent passes its request as a container override (`src/agent/cloudRunJob.ts`), which takes
`run.jobs.runWithOverrides`; `roles/run.invoker` does not hold it (#149). Not yet exercised against the real Cloud Run API.

**Failure modes, on purpose:** a command that failed or timed out is a **result**, and the loop sends the patch
back to the fixer once. A verify job that cannot be started, writes no result before the deadline (the command's
limit plus 300 s), or writes something that is not a result **throws**: the cycle's lease expires and it is
resumed, counted against its attempts. A forged or mismatched result is refused.

**What is still not true.** Nothing here has opened a pull request: the agent runs in dry run. It has read Cloud Logging
and asked Gemini on the demo project (2026-10-08), but no patch of its own has yet reached verify. The verify job's image is this repository's engine image (Node,
pnpm, git): a target repository that needs another toolchain needs another image. The Deploy engine workflow's
deployer needs more for this (the verify bucket, the agent account's own IAM policy): run `setup-github-deploy.sh` with
`VERIFY_ISOLATION=cloud-run-job`; see the table above.

```bash
DRY_RUN=1 DEPLOY_AGENT=1 AGENT_REPO=owner/name VERIFY_ISOLATION=cloud-run-job VERIFY_COMMAND='pnpm install --frozen-lockfile && pnpm run verify' \
  PROJECT_ID=my-project scripts/deploy-gcp.sh
```

## The admin API: run ingest now, and retire an incident (#63, #65)

`DEPLOY_ADMIN_API=1 ADMIN_API_ORIGINS=https://<your-site>.web.app scripts/deploy-gcp.sh` also deploys a Cloud Run **service**,
`starfish-admin`, from the ingest job's own image (no second build), under **its own account**, `starfish-admin-api`
(`ADMIN_SA_NAME`; #146): a public service shares an identity with nothing else. That account holds what one ingest run and a
retire need, `logging.viewer` on the watched project, `datastore.user` conditioned to Starfish's database and `firebaseauth.viewer` on Starfish's project (every token is checked for revocation with one account lookup; without that role every sign-in gets the same 401, which reads as an expired session), and nothing more:
no Gemini (ingest makes no model call), no secret but Twilio's when they are given (#37: the phone escalation's webhooks and opt-in routes, `POST /twilio/*` and `POST /api/oncall/people/<id>/send-code|confirm`, all a 404 without them). Two
actions, both admin-only, both audited, both the functions that already existed (`triggerIngest`, `retireIncident`); with Twilio
mounted, the two opt-in routes too, admin-only and audited the same way (`sendConfirmationCode`, `confirmNumber`, #172):

| Call | What it does |
|---|---|
| `POST /api/ingest/run` | one ingest run, the same `runIngest` a tick runs; the answer is the run's counts. One at a time per instance (a second is a 409) |
| `POST /api/incidents/<id>/retire` with `{"reason": "..."}` | closes the incident for good and frees its fingerprint, so the demo's reset can replay a fault |
| `POST /api/oncall/people/<id>/send-code` | texts a six-digit code to that person's pending number (#37); at most one a minute |
| `POST /api/oncall/people/<id>/confirm` with `{"code": "123456"}` | marks the number confirmed when the code matches; five wrong tries end it |
| `GET /api/health` | `{ok:true}`, no token: the probe to use on Cloud Run. `GET /healthz` answers the same elsewhere, but on a `run.app` URL Google's front end answers it with its own 404 before it reaches the service (#212) |

The audit trail is `starfish_audit` (`STARFISH_AUDIT_COLLECTION`): admin-readable, engine-written. An ingest run or a retire an
admin made is recorded before the run or in the retire's own transaction (a refused one is not). The opt-in routes record every
attempt by an admin, refusals included (too soon, wrong code, too many tries, escalation off); a caller who is not an
admin is refused and not recorded, so a guest cannot fill the audit collection: who, which person, the outcome
and when, never the number or the code. A send-code's entry commits before the text is sent, and if it cannot be written nothing
is sent.

**Who may call.** The caller sends `Authorization: Bearer <Firebase ID token>`. The token is checked (signature, expiry, and
not revoked: a disabled account is refused at once), and
its uid is all that is believed; whether that uid is an admin is read from `starfish_users/{uid}.roles` on every call,
so revoking the role stops the next request even though the token lives an hour. One 401 for any bad token, one 403
for a non-admin; no error text from inside ever leaves. The reason for a 401 is written to the service's own log, not
sent to the caller (a `WARNING` entry, "admin API refused a call", with the error's code and a bounded message, token-shaped
strings removed), so a missing Auth permission can be told from an expired session. A header token, not a cookie, so another site cannot make a
browser send it; browsers are allowed only from `ADMIN_API_ORIGINS`. For a script (the demo's reset), sign a
dedicated admin account in through the Firebase Auth REST API and send its ID token.

**It is public on the network on purpose** (`--allow-unauthenticated`: a browser must reach it, so Cloud Run's own IAM check
cannot be the gate), capped at two instances, with no rate limit beyond that. An organisation policy that forbids public
services will refuse the deploy line. Its name is in the default `STARFISH_EXCLUDED_SERVICES` of every deploy, with or without
`DEPLOY_ADMIN_API=1` (#177), so its own errors are never ingested; an explicit list in `EXTRA_ENV_VARS` replaces that default,
and the script warns if it leaves the service out (on a run that deploys it). From GitHub Actions, set the repository variables
`STARFISH_DEPLOY_ADMIN_API=1` and `STARFISH_ADMIN_API_ORIGINS`.

**The buttons.** The web UI shows an admin "Run ingest now" on the Incidents page and "Retire" on an incident, only when the site is
built with `VITE_STARFISH_ADMIN_API_URL=<the service URL>` (a bad or non-https value shows nothing). They send the signed-in admin's
ID token; the server re-checks the role, so hiding them from others is a courtesy and not the gate. A finished run reports the
engine's own counts, a failed one says it failed. Order: deploy the service with `ADMIN_API_ORIGINS` set to the site, read its URL
(`gcloud run services describe starfish-admin --project <p> --region <r> --format='value(status.url)'`), then redeploy the site
with that URL: `VITE_STARFISH_ADMIN_API_URL=<url> PROJECT_ID=<p> scripts/deploy-web.sh`, or, from GitHub Actions, set the
repository variable `STARFISH_WEB_ADMIN_API_URL` to it and run Deploy web UI (#230; that workflow has never run). Emptying
`ADMIN_API_ORIGINS` and redeploying takes every browser origin away again: the script always sets it, empty included (#233).

> **Status: written; tested with stubs for every rule and over a real local HTTP server; the deploy plan is pinned by a dry
> run. Deployed once to the demo project on 2026-10-07 from a terminal. The real token check against Firebase Auth ran there: an
> unauthenticated call got the 401, every sign-in got the same 401 until the service's account was given
> `roles/firebaseauth.viewer` by hand (the revocation check is an Auth lookup; the script now grants it), and then
> "Run ingest now" ran from the UI as an admin. Retire, the Twilio routes, App Check and a call from another origin have not
> been exercised, and `GET /healthz` is not reachable on a `run.app` URL (Google's front end answers it; `GET /api/health` was added for that,
> and has not been tried on Cloud Run yet).**

## Recording the demo: a shorter tick, and a run now (#65)

`scripts/ingest-cadence.sh` changes the Scheduler job's cron and puts it back; it holds no state between calls, so
`restore` takes the schedule you deployed with (`NORMAL_SCHEDULE`, default the deploy script's hourly).

```bash
PROJECT_ID=my-project scripts/ingest-cadence.sh status      # the current schedule, and the lag if one is set on the job
PROJECT_ID=my-project scripts/ingest-cadence.sh recording   # tick every minute
PROJECT_ID=my-project NORMAL_SCHEDULE='0 * * * *' scripts/ingest-cadence.sh restore
PROJECT_ID=my-project scripts/ingest-cadence.sh now         # one run of the job right now (two together converge)
```

**A one-minute tick does not by itself make a fault show up in about a minute.** A window ends
`STARFISH_INGEST_LAG_MINUTES` (default 5) behind real time, because Cloud Logging indexes entries late and a window
is read once. A fault reaches the store after about *lag + tick*. `RECORDING_LAG_MINUTES` / `NORMAL_LAG_MINUTES` set the
lag on the job for the recording and put it back, but a lag shorter than the indexing delay can lose an occurrence for
good, so try it on a rehearsal first. Left unset, the lag is not touched.

Written and tested with a dry run only; never run against a real project. `now` is not the admin-only, audited
trigger #65 asks for: anyone with `roles/run.developer` on the job can run it.

## What is most likely to go wrong the first time

The ingest path ran once on a real project (the demo project, 2026-10-05); the smoke test passed there too; the agent job and the Actions workflows have not run. The likely first failures, and what they mean:

- **The build is denied** ("Build failed because the default service account is missing required IAM permissions", seen
  on a first run). `gcloud run jobs deploy --source` builds as the Compute Engine default account, which a newer
  project does not let read the uploaded source. The script grants it `roles/run.builder` (the Cloud Run Builder role)
  before the deploy; name another account with `BUILD_SERVICE_ACCOUNT`. If it still fails, the account may also need
  `roles/cloudbuild.builds.builder`: grant it yourself if you accept that on a shared account.
- **The job cannot read or write Firestore.** The `datastore.user` grant carries an IAM condition on
  the database resource name. If a call is refused, check that condition first.
- **The first deploy takes minutes**: it creates the Artifact Registry repository and builds the image.

## Not covered

- **The web UI** deploys to Hosting with `scripts/deploy-web.sh`, from a terminal (run once, on the demo project,
  2026-10-05) or from the Deploy web UI workflow above (never run).
- **An alert when ingestion stops.** The UI shows it; nothing pages anyone (an item on #6).
- **The admin API has run once, not fully.** It was deployed to the demo project on 2026-10-07 and "Run ingest now" worked from the UI
  ([above](#the-admin-api-run-ingest-now-and-retire-an-incident-63-65)); Retire has not been tried against it. The UI's two buttons appear only once the site is built with the service's URL. Without it, for recording a demo, see [the cadence script](#recording-the-demo-a-shorter-tick-and-a-run-now-65).
- **The agent has run only in dry run.** Deployed to the demo project on 2026-10-07; triage and fix drafting have run on real
  incidents, verify, review and a pull request have not. The agent job deploys with `DEPLOY_AGENT=1`, verified by the target's
  CI or by a separate credential-less job ([above](#the-agent-and-where-its-tests-run-74)); `in-process` verification is
  not a sandbox and is for a machine with nothing to protect.
- **Cost.** Cloud Run jobs, Scheduler (three free jobs) and Secret Manager (a few free versions) sit
  inside the free tiers at one tick an hour. Cloud Build and Artifact Registry storage, and a 5-minute
  tick running all month, are not free; Gemini calls are billed to the Gemini project. Each Actions deploy runs one Cloud Build.

## Take it down

```bash
gcloud scheduler jobs delete starfish-ingest-tick --location=us-central1 --project=my-project
gcloud run jobs delete starfish-ingest --region=us-central1 --project=my-project
gcloud secrets delete starfish-github-token --project=my-project
```

The Firestore database and the service accounts stay; delete them on purpose, not by script.
