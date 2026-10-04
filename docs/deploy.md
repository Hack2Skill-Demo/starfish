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
and a fake GitHub API, **not against real GitHub**, and no job runs the agent loop, so the secret is
still plumbing until one does. The deploy script does not set `STARFISH_GITHUB_REPO`; without it the
opener cannot be built.

Starfish pushes only to branches named `starfish/<id>` and the engine checks that, but a GitHub App's
permission cannot be limited to a branch prefix. If "Starfish can write only its own branches" is to be
a guarantee and not a convention, protect the base branch and restrict who may push, with a branch
protection rule or a ruleset on the repository, including who may bypass it.

## The job does not read its own errors

The engine's job logs under `cloud_run_job`; the default log resource types are `cloud_function` and
`cloud_run_revision`. So with the defaults Starfish does not ingest its own failures. As a second guard,
the deploy sets `STARFISH_EXCLUDED_SERVICES=starfish,<job name>` on the job (#32: matched on the exact
name, not a prefix), so adding `cloud_run_job` to `STARFISH_LOG_RESOURCE_TYPES` later still would not make
the engine read itself. An explicit `STARFISH_EXCLUDED_SERVICES` in `EXTRA_ENV_VARS` replaces it.

## After the first deploy

```bash
PROJECT_ID=my-project scripts/smoke-gcp.sh     # plants one error, runs the job, checks the incident arrived
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
| run a job, and a scheduler call, *as* those accounts | `roles/iam.serviceAccountUser`, on `starfish-engine` and `starfish-scheduler` only, not project-wide |
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

## What is most likely to go wrong the first time

None of this has run against a real project. The likely first failures, and what they mean:

- **The build is denied** (permission denied for the default compute service account). Newer projects
  need that account to hold `roles/cloudbuild.builds.builder` for source deploys. The script does
  not grant it, because that widens a shared account; grant it yourself if you accept that.
- **The job cannot read or write Firestore.** The `datastore.user` grant carries an IAM condition on
  the database resource name. If a call is refused, check that condition first.
- **The first deploy takes minutes**: it creates the Artifact Registry repository and builds the image.

## Not covered

- **The web UI** deploys to Hosting with `scripts/deploy-web.sh`; the Actions workflow does not run it.
- **An alert when ingestion stops.** The UI shows it; nothing pages anyone (an item on #6).
- **An authenticated "run now" endpoint.** `src/ingest/trigger.ts` is the function; nothing serves
  it. For recording a demo, a short `SCHEDULE` or `gcloud run jobs execute` does the job.
- **The agent loop as a job.** Triage, fix, verify and review exist as stages and are run by
  nothing; the loop needs a repo checkout and the pull-request opener first.
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
