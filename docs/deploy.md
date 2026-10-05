# Deploying the engine (#6)

`scripts/deploy-gcp.sh` puts the ingest on Google Cloud: a Cloud Run **job** that Cloud Scheduler
starts on a cron, under its own service account, with the image built from the `Dockerfile`.

> **Status: written and tested, not deployed.** The script's plan is pinned by
> `scripts/deploy-gcp.test.mjs` (a dry run), and CI builds the image. It has **not** been run
> against a real project, so the first real run may need a fix. Issue #6 stays open until a
> scheduled run writes incidents that the UI shows.

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
image or change the schedule.

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
| Firestore database `starfish`, then `firestore.rules` and indexes | Starfish's own database. `(default)` is refused: its rules would replace the watched app's. |
| Secret `starfish-github-token`, `secretAccessor` for the engine only | see below |
| Cloud Run job `starfish-ingest` | one ingest run per execution; exits 1 when the run failed |
| Service account `starfish-scheduler`, `roles/run.invoker` **on that job only** | the scheduler can start the job and do nothing else |
| Scheduler job `starfish-ingest-tick` | the cron |

The three engine roles are separate bindings on separate projects, so watching one project,
storing in another and running Gemini in a third needs no code and no wider access.

## Secret Manager

The script creates the secret and lets only the engine read it. With `STARFISH_GITHUB_TOKEN` set (not `GITHUB_TOKEN`, which is the Actions workflow's own token and often a personal one in a shell) it stores
the value as a new version (over stdin, never printed or passed as an argument) and mounts it into
the job as `STARFISH_GITHUB_TOKEN`; without a version, Cloud Run would refuse the deploy, so it is
not mounted.

`loadGithubToken()` (`src/config.ts`) reads that variable, and the pull-request opener
(`src/integrations/githubPr.ts`) is its only user. The opener is tested against a local git remote
and a fake GitHub API, **not against real GitHub**, and the only job that calls it (the agent job, never
deployed) is a dry run, so the secret is still plumbing. The deploy script does not set `STARFISH_GITHUB_REPO`; without it the
opener cannot be built.

Starfish pushes only to branches named `starfish/<id>` and the engine checks that, but a GitHub App's
permission cannot be limited to a branch prefix. If "Starfish can write only its own branches" is to be
a guarantee and not a convention, protect the base branch and restrict who may push, with a branch
protection rule or a ruleset on the repository, including who may bypass it.

## The job does not read its own errors

The engine's job logs under `cloud_run_job`; the default log resource types are `cloud_function` and
`cloud_run_revision`. So with the defaults Starfish does not ingest its own failures. As a second guard,
the deploy sets `STARFISH_EXCLUDED_SERVICES=starfish,<job name>` on the job (#32: matched on the exact
name, not a prefix; a trailing `*` in the list does exclude a prefix, such as the demo app's `control-*`), so adding `cloud_run_job` to `STARFISH_LOG_RESOURCE_TYPES` later still would not make
the engine read itself. An explicit `STARFISH_EXCLUDED_SERVICES` in `EXTRA_ENV_VARS` replaces it, so keep the defaults in it: for the demo app,
`EXTRA_ENV_VARS='@STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-agent,traffic-*,control-*,stub-*'`.

## After the first deploy

```bash
PROJECT_ID=my-project SMOKE_ACTOR_UID=<admin uid> scripts/smoke-gcp.sh   # plants one error, runs the job, checks THAT incident, retires it
pnpm status                                    # is the engine alive? (needs GOOGLE_CLOUD_PROJECT and STARFISH_ENV)
gcloud run jobs executions list --job=starfish-ingest --region=us-central1 --project=my-project
```

`scripts/preflight-gcp.sh` is the read-only check to run *before* the deploy.

Then look at `starfish_runs/last_run` in the `starfish` database (it is what the Incidents page
shows as "engine status") and at the incidents collection. A failed run exits 1; a missing run shows
in the UI as stopped, past `VITE_STARFISH_STALE_MINUTES`.

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

- **Trigger: `workflow_dispatch` only.** A merge to `main` cannot change what is running by itself, and each
  run spends a Cloud Build. Deploy-on-merge is a trust choice about how far Starfish's own deploy is
  automated; it is not made here.
- **Approval: a GitHub environment named `deploy`.** The job runs in it, and the Workload Identity provider
  below accepts only tokens minted for that environment, so its protection rules are the real gate. Add
  **required reviewers** for a manual approval, and **limit deployment branches to `main`**: without that,
  anyone who can push a branch can edit `deploy.yml` there and dispatch it.

### One-time setup

Run these as someone with rights to create a pool and a service account on the project. `OWNER/REPO` is this
repository; `PROJECT_ID` is the project Starfish deploys into.

```bash
export PROJECT_ID=my-project REPO=OWNER/REPO
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

# 1. A pool and a GitHub provider. The attribute condition is not optional: without it, any GitHub
#    repository could present a token to this provider. This one accepts only this repository's jobs
#    that run in the `deploy` environment.
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT_ID"
gcloud iam workload-identity-pools create github --project="$PROJECT_ID" --location=global \
  --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github-deploy --project="$PROJECT_ID" \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment" \
  --attribute-condition="assertion.repository == '$REPO' && assertion.environment == 'deploy'"

# 2. The deploy identity: its own service account, separate from starfish-engine (which only runs the
#    job) and starfish-scheduler (which only starts it). Only this repository's pool members may use it.
gcloud iam service-accounts create starfish-deployer --project="$PROJECT_ID" \
  --display-name="Starfish deployer (GitHub Actions)"
gcloud iam service-accounts add-iam-policy-binding \
  "starfish-deployer@$PROJECT_ID.iam.gserviceaccount.com" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"

# 3. Give the deployer what the script needs (the table below), then tell GitHub where to find it.
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER \
  --body "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-deploy"
gh variable set GCP_DEPLOY_SERVICE_ACCOUNT --body "starfish-deployer@$PROJECT_ID.iam.gserviceaccount.com"
gh variable set STARFISH_GCP_PROJECT_ID --body "$PROJECT_ID"
```

Then create the `deploy` environment (Settings → Environments), with reviewers and the `main`-only
deployment branch rule above.

**What the deployer needs, by what the script does.** All on `PROJECT_ID` unless noted:

| The script does | Role |
|---|---|
| enable APIs | `roles/serviceusage.serviceUsageAdmin` (on the Gemini and watched projects too, when they differ) |
| create the engine and scheduler service accounts | `roles/iam.serviceAccountAdmin` |
| run a job, and a scheduler call, *as* those accounts | `roles/iam.serviceAccountUser`, on `starfish-engine`, `starfish-scheduler` and, with `DEPLOY_AGENT`, `starfish-agent` and `starfish-verifier` only, not project-wide |
| bind the engine's three roles | `roles/resourcemanager.projectIamAdmin`, on `PROJECT_ID`, the watched project and the Gemini project (see the warning below) |
| create the `starfish` database, deploy rules and indexes | `roles/datastore.owner`, `roles/firebaserules.admin` |
| create the secret, grant the engine access, add a version | `roles/secretmanager.admin` |
| build from source and deploy the job, bind the scheduler to it | `roles/run.admin`, `roles/cloudbuild.builds.editor`, `roles/artifactregistry.admin`, `roles/storage.admin` (the source bucket Cloud Build uses) |
| create or update the schedule | `roles/cloudscheduler.admin` |

`gcloud run jobs deploy --source` also acts as the project's build service account; if the first run is denied
there, see "The build is denied" below.

> **`projectIamAdmin` is the powerful one.** A principal that can set IAM policy can grant itself anything.
> Limit it to the three roles the script grants with an IAM condition on the deployer's own binding:
> `api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['roles/logging.viewer','roles/datastore.user','roles/aiplatform.user'])`.
> The script's own grants stay inside that list, but this has not been tried: the script reads and writes
> the whole policy, and a conditioned `getIamPolicy` may need adjusting. Until you have checked it, treat the
> deployer as highly privileged, which is a further reason for the `deploy` environment's gate.

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
| `STARFISH_DEPLOY_AGENT`, `STARFISH_AGENT_REPO` | `DEPLOY_AGENT`, `AGENT_REPO` | set `1` and `owner/name` to deploy the agent too ([below](#the-agent-and-where-its-tests-run-74)); default off |
| `STARFISH_VERIFY_ISOLATION`, `STARFISH_VERIFY_CHECKS`, `STARFISH_VERIFY_COMMAND` | `VERIFY_ISOLATION`, `VERIFY_CHECKS`, `VERIFY_COMMAND` | `github-actions` (default) with the check names that must pass, or `cloud-run-job` with a command |
| `STARFISH_VERIFY_TIMEOUT_SECONDS`, `STARFISH_VERIFY_BUCKET`, `STARFISH_AGENT_BASE_BRANCH`, `STARFISH_AGENT_SCHEDULE`, `STARFISH_AGENT_EXTRA_ENV_VARS` | `VERIFY_TIMEOUT_SECONDS`, `VERIFY_BUCKET`, `AGENT_BASE_BRANCH`, `AGENT_SCHEDULE`, `AGENT_EXTRA_ENV_VARS` | default 600, `<project>-starfish-verify`, `main`, `30 * * * *` |

`BUDGET_USD` and `BILLING_ACCOUNT` are not wired: a budget lives on the billing account, which the deployer
has no role on. Create the budget once from a terminal (`docs/setup.md`).

The workflow's inputs are `dry_run` (print the plan, change nothing), `run_after_deploy`, and
`skip_firestore_rules`. The last exists because `firebase-tools` signing in through Workload Identity is the
part least likely to work first time; if it fails, deploy once with the box ticked and the rules from a terminal.

**What the run log holds:** the script's own progress lines and `gcloud` output. The workflow never turns on
shell tracing, passes no secret, and the auth step writes a credentials *file* that refers to the token exchange rather
than holding a key. A real run is the check that no value leaks, and it has not happened (#75's done-when).
A `dry_run` still signs in, so it is the cheapest proof that the pool, provider and bindings work before the
deployer has any project role.

## Deploy the web UI from GitHub Actions (#92)

`.github/workflows/deploy-web.yml` runs `scripts/deploy-web.sh`, unchanged: **Actions → Deploy web UI → Run
workflow**. It uses the same Workload Identity pool, provider, `starfish-deployer` account and `deploy`
environment as the engine deploy above, so there is nothing new to set up in the pool; it is `workflow_dispatch`
only, keyless, uses no GitHub secret, and has the same decisions on trigger and approval (follow whatever you
chose for the engine). Unlike the engine deploy it runs `pnpm install --frozen-lockfile` first, because it builds the UI.

> **Status: written and pinned by a test (`scripts/deploy-workflow.test.mjs`), never run, and the script itself
> has only been dry-run tested.** Whether the Firebase CLI accepts the federated credentials the auth step
> writes (Application Default Credentials) is **not verified**; that is the first thing a run will show. If it
> does not, the fallback is still `firebase login` and `scripts/deploy-web.sh` from a terminal.

**What the deployer needs on top of the engine's list** (a starting set, not a verified minimum; the first run
will name what is missing): Firebase Hosting Admin (`roles/firebasehosting.admin`) to create the site and release
to it, and a role holding `firebase.apps.create` for the one-time web-app registration (the script registers a
web app named `starfish` when the project has none). Keep both off the engine's runtime identity.

**Repository variables** (nothing deployment-specific is in the workflow): the same three required ones, plus
`STARFISH_ENV` (the label the page shows; **`demo` for the public page**), `STARFISH_DATABASE_ID`, and
`STARFISH_WEB_HOSTING_SITE` (default `<project>-starfish`, its own site so the watched app's keeps the default).
Anonymous sign-in is **not** turned on by the workflow: it is project-wide (see `setup.md`). Input: `dry_run`.

## The agent and where its tests run (#74)

`DEPLOY_AGENT=1 AGENT_REPO=owner/name` makes the script also deploy **the agent**: a Cloud Run job `starfish-agent` and a
Scheduler job `starfish-agent-tick` (hourly at :30), under its own service account `starfish-agent` (the store's
`starfish` database only, Gemini, `logging.viewer` on the watched project for the counter-check, the one secret). It
runs `pnpm agent` (`src/agentCli.ts`): pick open incidents with no settled cycle, check the repository out, run triage,
fix, verify and review as a **dry run**.

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
  it spends the target's Actions minutes. `STARFISH_GITHUB_TOKEN` must therefore be set (`preflight` refuses without it) and
  may write branches. Protect the base branch (a ruleset), as above.
- **The fixer's second draft gets thin feedback**: check names, conclusions, their summaries and a few annotations, not the
  test log. Make the workflow emit annotations (`::error file=...::message`) for failures if you want better revisions.
- Only **check runs** are read (what GitHub Actions creates); a CI that reports commit statuses instead is not seen. The
  token needs read access to checks as well as write access to contents.
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
`roles/iam.serviceAccountTokenCreator` on **itself** (to sign the URLs), and `roles/run.invoker` on the verify job,
besides what the loop needs (the store, Gemini, `logging.viewer` on the watched project for the counter-check, the
secret). `run.invoker` may not be enough to start a job with overrides; if the first start is refused (403), the
error names the role, and the likely fix is a role that includes `run.jobs.runWithOverrides` on that job only.

**Failure modes, on purpose:** a command that failed or timed out is a **result**, and the loop sends the patch
back to the fixer once. A verify job that cannot be started, writes no result before the deadline (the command's
limit plus 300 s), or writes something that is not a result **throws**: the cycle's lease expires and it is
resumed, counted against its attempts. A forged or mismatched result is refused.

**What is still not true.** Nothing here has opened a pull request; the agent is a dry run and has never run
against real GitHub, Cloud Logging or Gemini from this job. The ingest's account still holds the secret grant and
mount from #73 although it never reads the token. The verify job's image is this repository's engine image (Node,
pnpm, git): a target repository that needs another toolchain needs another image. The Deploy engine workflow's
deployer needs more roles for this (a bucket, a service account that must not be given any role, `actAs` on three
accounts); see the table above.

```bash
DRY_RUN=1 DEPLOY_AGENT=1 AGENT_REPO=owner/name VERIFY_ISOLATION=cloud-run-job VERIFY_COMMAND='pnpm install --frozen-lockfile && pnpm run verify' \
  PROJECT_ID=my-project scripts/deploy-gcp.sh
```

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

- **The web UI** deploys to Hosting with `scripts/deploy-web.sh`, from a terminal or from the Deploy web UI
  workflow above (never run).
- **An alert when ingestion stops.** The UI shows it; nothing pages anyone (an item on #6).
- **An authenticated "run now" endpoint.** `src/ingest/trigger.ts` is the function; nothing serves
  it. For recording a demo, see [the cadence script](#recording-the-demo-a-shorter-tick-and-a-run-now-65).
- **The agent has never run on a real project.** The agent job deploys with `DEPLOY_AGENT=1`, verified by the target's
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
