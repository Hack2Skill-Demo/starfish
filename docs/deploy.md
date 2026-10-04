# Deploying the engine (#6)

`scripts/deploy-gcp.sh` puts the ingest on Google Cloud: a Cloud Run **job** that Cloud Scheduler
starts on a cron, under its own service account, with the image built from the `Dockerfile`.

> **Status: written and tested, not deployed.** The script's plan is pinned by
> `scripts/deploy-gcp.test.mjs` (a dry run), and CI builds the image. It has **not** been run
> against a real project, so the first real run may need a fix. Issue #6 stays open until a
> scheduled run writes incidents that the UI shows.

## Run it

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

**Nothing in the engine reads that variable yet.** The step that opens pull requests (the
`openPullRequest` interface in `src/agent/loop.ts`) is not built; it will be the first reader. The
secret is plumbing, not a feature, until then.

## The job does not read its own errors

The engine's job logs under `cloud_run_job`; the default log resource types are `cloud_function` and
`cloud_run_revision`. So with the defaults Starfish does not ingest its own failures. If you add
`cloud_run_job` to `STARFISH_LOG_RESOURCE_TYPES` you also need the self-exclusion of #32.

## After the first deploy

```bash
gcloud run jobs execute starfish-ingest --region=us-central1 --project=my-project --wait
gcloud run jobs executions list --job=starfish-ingest --region=us-central1 --project=my-project
```

Then look at `starfish_runs/last_run` in the `starfish` database (it is what the Incidents page
shows as "engine status") and at the incidents collection. A failed run exits 1; a missing run shows
in the UI as stopped, past `VITE_STARFISH_STALE_MINUTES`.

## What is most likely to go wrong the first time

None of this has run against a real project. The likely first failures, and what they mean:

- **The build is denied** (permission denied for the default compute service account). Newer projects
  need that account to hold `roles/cloudbuild.builds.builder` for source deploys. The script does
  not grant it, because that widens a shared account; grant it yourself if you accept that.
- **The job cannot read or write Firestore.** The `datastore.user` grant carries an IAM condition on
  the database resource name. If a call is refused, check that condition first.
- **The first deploy takes minutes**: it creates the Artifact Registry repository and builds the image.

## Not covered

- **The web UI** deploys to Hosting; there is no script for it yet.
- **An alert when ingestion stops.** The UI shows it; nothing pages anyone (an item on #6).
- **An authenticated "run now" endpoint.** `src/ingest/trigger.ts` is the function; nothing serves
  it. For recording a demo, a short `SCHEDULE` or `gcloud run jobs execute` does the job.
- **The agent loop as a job.** Triage, fix, verify and review exist as stages and are run by
  nothing; the loop needs a repo checkout and the pull-request opener first.
- **Cost.** Cloud Run jobs, Scheduler (three free jobs) and Secret Manager (a few free versions) sit
  inside the free tiers at one tick an hour. Cloud Build and Artifact Registry storage, and a 5-minute
  tick running all month, are not free; Gemini calls are billed to the Gemini project.

## Take it down

```bash
gcloud scheduler jobs delete starfish-ingest-tick --location=us-central1 --project=my-project
gcloud run jobs delete starfish-ingest --region=us-central1 --project=my-project
gcloud secrets delete starfish-github-token --project=my-project
```

The Firestore database and the service accounts stay; delete them on purpose, not by script.
