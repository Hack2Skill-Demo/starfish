#!/usr/bin/env bash
# Deploy the Starfish engine's ingest to Google Cloud (#6): a Cloud Run job, run on a schedule by
# Cloud Scheduler, under its own least-privilege service account, with Secret Manager holding the
# credentials. Idempotent: run it again to roll out a new image or change the schedule.
#
#   PROJECT_ID=my-project scripts/deploy-gcp.sh
#   DRY_RUN=1 PROJECT_ID=my-project scripts/deploy-gcp.sh     # print every command, change nothing
#
# Configured, never forked: everything deployment-specific is an environment variable below.
#
#   PROJECT_ID           (required) the GCP project Starfish runs in: its Firestore, job and scheduler
#   REGION               Cloud Run, Scheduler and the image build. Default us-central1
#   WATCHED_PROJECT_ID   project whose Cloud Logging is read. Default PROJECT_ID
#   VERTEX_PROJECT_ID    project Gemini runs in and is billed to. Default PROJECT_ID
#   STARFISH_ENV         the environment label stamped on incidents. Default dev
#   STARFISH_DATABASE_ID Starfish's named Firestore database. Default starfish; "(default)" is refused. The rules and
#                        indexes go to this database: firebase.json's own "database" is replaced in a temporary copy (#148)
#   FIRESTORE_LOCATION   where the database is created if it does not exist. Default REGION
#   SCHEDULE             cron for the ingest tick. Default "0 * * * *" (hourly); "*/5 * * * *" for a demo
#   SCHEDULE_TIME_ZONE   Default Etc/UTC
#   EXTRA_ENV_VARS       more engine settings for the job, "@"-separated: "STARFISH_MODEL=x@STARFISH_LOOKBACK_HOURS=6"
#                        (see .env.example for every name; "@" so a value can hold commas). Each name once: a name the
#                        script already sets, or one set twice, is refused. Added to the agent's and the admin API's too
#   STARFISH_GITHUB_TOKEN  if set, stored as a new version of the starfish-github-token secret. Not
#                        GITHUB_TOKEN: that name is the Actions workflow's own token, and many shells export a
#                        personal one, neither of which should reach Secret Manager by accident. Only the agent's
#                        account may read it and only the agent job mounts it (#146): the ingest never uses it
#   STARFISH_SLACK_WEBHOOK_ONCALL  with DEPLOY_AGENT=1: the Slack incoming-webhook URL the agent posts "needs a human" to
#                        (#17). The URL is the credential: stored over stdin as a version of the starfish-slack-oncall
#                        secret, readable by the agent's account only, mounted on the agent job only, never printed.
#                        Only a https://hooks.slack.com/services/... URL is accepted. Also set the UI's origin so the
#                        message can link back: AGENT_EXTRA_ENV_VARS="STARFISH_UI_URL=https://<site>.web.app"
#   STARFISH_SLACK_WEBHOOK_ALERTS  with DEPLOY_AGENT=1, optional: the #ops-alerts webhook for the "new incident" message
#                        (#17). Handled exactly like the on-call one, in its own secret starfish-slack-alerts.
#   BUDGET_USD           if set (with BILLING_ACCOUNT), create a budget that EMAILS billing admins at 50% and
#                        90% of this monthly amount for PROJECT_ID. An alert, not a cap: nothing stops spending
#   BILLING_ACCOUNT      the billing account id (0123AB-456CDE-789FGH), needed with BUDGET_USD
#   DEPLOY_AGENT=1       also deploy the AGENT (#74): triage -> fix -> verify -> review for open incidents, as a dry run.
#                        A Cloud Run job and Scheduler job for the agent, under its own service account. The agent
#                        holds the store, Logging and Gemini credentials and NEVER runs the target repository's code:
#                        where its tests run is VERIFY_ISOLATION. Needs AGENT_REPO. Off by default
#   AGENT_REPO           owner/name of the repository the agent works on (STARFISH_GITHUB_REPO)
#   VERIFY_ISOLATION     github-actions (default) or cloud-run-job.
#                          github-actions: the patch is pushed to a starfish/<cycle> branch in AGENT_REPO and the
#                            TARGET's own CI, on GitHub's disposable runners, is the judge. No other resource is
#                            deployed. Needs VERIFY_CHECKS, and STARFISH_GITHUB_TOKEN stored (a branch is pushed even
#                            in a dry run). The target's workflow must run on push to starfish/** and hold no secrets
#                          cloud-run-job: a separate Cloud Run job, under a service account that holds NO roles, runs
#                            the command, fed through a private bucket. Needs VERIFY_COMMAND. More infrastructure
#   VERIFY_CHECKS        github-actions: the check runs on the pushed commit that must all pass (STARFISH_VERIFY_CHECKS),
#                        comma-separated, e.g. "verify" or "ci / test"
#   VERIFY_COMMAND       cloud-run-job: the command that proves a patch (STARFISH_VERIFY_COMMAND), run in the verify
#                        job, e.g. "pnpm install --frozen-lockfile && pnpm run verify". That job's image is this
#                        repo's engine image (node, pnpm, git): a target that needs another toolchain needs another
#   VERIFY_TIMEOUT_SECONDS  how long the checks or the command may run. Default 600
#   VERIFY_BUCKET        cloud-run-job: the bucket for bundles and results (objects deleted after a day). Default <PROJECT_ID>-starfish-verify
#   AGENT_BASE_BRANCH    the branch the agent checks out. Default: the engine's own default (main)
#   AGENT_SCHEDULE       cron for the agent tick. Default "30 * * * *" (hourly, after the ingest tick)
#   AGENT_EXTRA_ENV_VARS more settings for the agent job, "@"-separated like EXTRA_ENV_VARS. The only place to turn the
#                        agent's dry run off (STARFISH_DRY_RUN=false); neither list may set STARFISH_VERIFY_* (#147)
#   DEPLOY_ADMIN_API=1   also deploy the admin API (#63, #65): a Cloud Run SERVICE, public on the network on purpose, that
#                        runs ingest now and retires an incident for a caller holding a Firebase ID token AND the admin
#                        role. It reuses the ingest job's image (no second build) and runs as its OWN account (#146),
#                        which holds what an ingest run needs (the watched project's logs, Starfish's database) and no secret
#   ADMIN_SA_NAME        the admin API's service account. Default starfish-admin-api
#   ADMIN_API_ORIGINS    the operator UI's origin(s), comma-separated, allowed to call it from a browser, e.g.
#                        https://my-site.web.app. Empty: no browser may (a server-side caller is not affected)
#   ADMIN_SERVICE_NAME   Default starfish-admin (never ingested: it is added to STARFISH_EXCLUDED_SERVICES)
#   SKIP_FIRESTORE_RULES=1   do not deploy firestore.rules and firestore.indexes.json
#   RUN_AFTER_DEPLOY=1       execute the job once and wait for it
#   BUILD_SERVICE_ACCOUNT   the account Cloud Run builds the image as, which is granted roles/run.builder. Default: the
#                        Compute Engine default account (<project-number>-compute@developer.gserviceaccount.com)
#   DRY_RUN=1                print the commands instead of running them
#
# The person running this needs, on PROJECT_ID, roles to enable APIs, create service accounts, set IAM
# and deploy Cloud Run and Scheduler (Owner is the easy way), plus the matching IAM roles on
# WATCHED_PROJECT_ID and VERTEX_PROJECT_ID when those differ. Nothing here deploys the web UI.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
WATCHED_PROJECT_ID="${WATCHED_PROJECT_ID:-$PROJECT_ID}"
VERTEX_PROJECT_ID="${VERTEX_PROJECT_ID:-$PROJECT_ID}"
STARFISH_ENV="${STARFISH_ENV:-dev}"
STARFISH_DATABASE_ID="${STARFISH_DATABASE_ID:-starfish}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-$REGION}"
SCHEDULE="${SCHEDULE:-0 * * * *}"
SCHEDULE_TIME_ZONE="${SCHEDULE_TIME_ZONE:-Etc/UTC}"
EXTRA_ENV_VARS="${EXTRA_ENV_VARS:-}"
DEPLOY_AGENT="${DEPLOY_AGENT:-0}"
AGENT_REPO="${AGENT_REPO:-}"
AGENT_BASE_BRANCH="${AGENT_BASE_BRANCH:-}"
AGENT_SCHEDULE="${AGENT_SCHEDULE:-30 * * * *}"
AGENT_EXTRA_ENV_VARS="${AGENT_EXTRA_ENV_VARS:-}"
DEPLOY_ADMIN_API="${DEPLOY_ADMIN_API:-0}"
ADMIN_API_ORIGINS="${ADMIN_API_ORIGINS:-}"
ADMIN_SERVICE_NAME="${ADMIN_SERVICE_NAME:-starfish-admin}"
VERIFY_ISOLATION="${VERIFY_ISOLATION:-github-actions}"
VERIFY_CHECKS="${VERIFY_CHECKS:-}"
VERIFY_COMMAND="${VERIFY_COMMAND:-}"
VERIFY_TIMEOUT_SECONDS="${VERIFY_TIMEOUT_SECONDS:-600}"
VERIFY_BUCKET="${VERIFY_BUCKET:-$PROJECT_ID-starfish-verify}"
BUDGET_USD="${BUDGET_USD:-}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
SKIP_FIRESTORE_RULES="${SKIP_FIRESTORE_RULES:-0}"
RUN_AFTER_DEPLOY="${RUN_AFTER_DEPLOY:-0}"
BUILD_SERVICE_ACCOUNT="${BUILD_SERVICE_ACCOUNT:-}"
DRY_RUN="${DRY_RUN:-0}"

JOB_NAME="${JOB_NAME:-starfish-ingest}"
ENGINE_SA_NAME="${ENGINE_SA_NAME:-starfish-engine}"
SCHEDULER_SA_NAME="${SCHEDULER_SA_NAME:-starfish-scheduler}"
SCHEDULER_JOB_NAME="${SCHEDULER_JOB_NAME:-$JOB_NAME-tick}"
GITHUB_SECRET="${GITHUB_SECRET:-starfish-github-token}"
SLACK_SECRET="${SLACK_SECRET:-starfish-slack-oncall}"
SLACK_ALERTS_SECRET="${SLACK_ALERTS_SECRET:-starfish-slack-alerts}"
AGENT_JOB_NAME="${AGENT_JOB_NAME:-starfish-agent}"
AGENT_SA_NAME="${AGENT_SA_NAME:-starfish-agent}"
AGENT_SCHEDULER_JOB_NAME="${AGENT_SCHEDULER_JOB_NAME:-$AGENT_JOB_NAME-tick}"
VERIFY_JOB_NAME="${VERIFY_JOB_NAME:-starfish-verify}"
VERIFIER_SA_NAME="${VERIFIER_SA_NAME:-starfish-verifier}"
ADMIN_SA_NAME="${ADMIN_SA_NAME:-starfish-admin-api}"

die() { echo "deploy-gcp: $*" >&2; exit 1; }

[ -n "$PROJECT_ID" ] || die "PROJECT_ID is required"
if [ "$DEPLOY_ADMIN_API" = "1" ]; then
  case "$ADMIN_SERVICE_NAME" in ''|*[!a-z0-9-]*|-*|*-) die "ADMIN_SERVICE_NAME must be lowercase letters, digits and hyphens: $ADMIN_SERVICE_NAME" ;; esac
  case "$ADMIN_API_ORIGINS" in *[[:space:]]*|*[\"\'\@]*) die "ADMIN_API_ORIGINS is a comma-separated list of origins like https://my-site.web.app: $ADMIN_API_ORIGINS" ;; esac
fi
# The lists are joined with "@" by this script, so an empty entry (a leading, trailing or doubled "@") would reach gcloud as
# "Invalid flag value []". Say what is wrong here instead.
for var in EXTRA_ENV_VARS AGENT_EXTRA_ENV_VARS; do
  case "${!var}" in
    @*|*@|*@@*) die "$var is a list of NAME=value entries separated by @ (no leading, trailing or doubled @): ${!var}" ;;
  esac
done
[ "$STARFISH_DATABASE_ID" != "(default)" ] ||
  die "STARFISH_DATABASE_ID=(default) is refused: deploying firestore.rules to the default database would replace the watched app's own rules"
# A Firestore database id: 4 to 63 lowercase letters, digits and hyphens, starting with a letter. It is written into the
# temporary firebase config and into IAM conditions, so nothing else may reach them.
case "$STARFISH_DATABASE_ID" in
  [a-z]*[a-z0-9]) case "$STARFISH_DATABASE_ID" in *[!a-z0-9-]*) die "STARFISH_DATABASE_ID must be lowercase letters, digits and hyphens: $STARFISH_DATABASE_ID" ;; esac ;;
  *) die "STARFISH_DATABASE_ID must start with a letter and end with a letter or digit: $STARFISH_DATABASE_ID" ;;
esac
[ "${#STARFISH_DATABASE_ID}" -ge 4 ] && [ "${#STARFISH_DATABASE_ID}" -le 63 ] ||
  die "STARFISH_DATABASE_ID must be 4 to 63 characters: $STARFISH_DATABASE_ID"
if [ "$DEPLOY_AGENT" = "1" ]; then
  [ -n "$AGENT_REPO" ] || die "DEPLOY_AGENT=1 needs AGENT_REPO (owner/name): the agent has no repository to work on without it"
  case "$AGENT_REPO" in
    */*/*|*[!A-Za-z0-9._/-]*|/*|*/|*..*) die "AGENT_REPO must be owner/name: $AGENT_REPO" ;;
    */*) ;;
    *) die "AGENT_REPO must be owner/name: $AGENT_REPO" ;;
  esac
  case "$VERIFY_ISOLATION" in
    github-actions)
      [ -n "$VERIFY_CHECKS" ] || die "VERIFY_ISOLATION=github-actions needs VERIFY_CHECKS: name the check runs of the target's CI that must pass (a repository has other checks that say nothing about the patch)"
      case "$VERIFY_CHECKS" in
        *@*) die "VERIFY_CHECKS may not contain '@' (it is the separator of the job's environment variables)" ;;
      esac
      ;;
    cloud-run-job)
      [ -n "$VERIFY_COMMAND" ] || die "VERIFY_ISOLATION=cloud-run-job needs VERIFY_COMMAND: with nothing to prove a patch, none would ever be accepted and the agent will not start"
      case "$VERIFY_COMMAND" in
        *@*) die "VERIFY_COMMAND may not contain '@' (it is the separator of the job's environment variables)" ;;
      esac
      case "$VERIFY_BUCKET" in
        *[!a-z0-9._-]*|-*|.*) die "VERIFY_BUCKET must be a bucket name (lowercase letters, digits, - . _): $VERIFY_BUCKET" ;;
      esac
      ;;
    *) die "VERIFY_ISOLATION must be github-actions or cloud-run-job: $VERIFY_ISOLATION" ;;
  esac
  case "$VERIFY_TIMEOUT_SECONDS" in
    ''|*[!0-9]*|0) die "VERIFY_TIMEOUT_SECONDS must be a whole number of seconds above zero: $VERIFY_TIMEOUT_SECONDS" ;;
  esac
  [ "$VERIFY_TIMEOUT_SECONDS" -le 3000 ] || die "VERIFY_TIMEOUT_SECONDS may not exceed 3000: the runner gets that plus a few minutes of its own to start and report, and a verify result is waited for no longer than one hour"
  # The script owns how the agent's verify step is isolated: a person's extra setting must not point it elsewhere,
  # least of all at running the command in the agent's own process. EXTRA_ENV_VARS reaches the agent job too (#147).
  for var in EXTRA_ENV_VARS AGENT_EXTRA_ENV_VARS; do
    case "@${!var}" in
      *@STARFISH_VERIFY_*)
        die "$var may not set STARFISH_VERIFY_*: DEPLOY_AGENT sets them (isolation, checks, job, bucket, command, timeout)" ;;
    esac
  done
  # Turning the agent's dry run off is a decision about the agent alone, so it is made in AGENT_EXTRA_ENV_VARS (or by an
  # admin on the Settings page), never as a side effect of a setting meant for the ingest job.
  case "@$EXTRA_ENV_VARS" in
    *@STARFISH_DRY_RUN=*) die "EXTRA_ENV_VARS may not set STARFISH_DRY_RUN with DEPLOY_AGENT=1: set it in AGENT_EXTRA_ENV_VARS, which only the agent job gets" ;;
  esac
fi
if [ -n "$BUDGET_USD" ]; then
  [ -n "$BILLING_ACCOUNT" ] || die "BUDGET_USD needs BILLING_ACCOUNT (gcloud billing accounts list)"
  case "$BUDGET_USD" in
    ''|*[!0-9]*) die "BUDGET_USD must be a whole number of US dollars: $BUDGET_USD" ;;
  esac
fi
if [ "$DRY_RUN" != "1" ]; then
  command -v gcloud >/dev/null || die "gcloud is not installed"
fi

ENGINE_SA="$ENGINE_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
SCHEDULER_SA="$SCHEDULER_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
AGENT_SA="$AGENT_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
VERIFIER_SA="$VERIFIER_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
ADMIN_SA="$ADMIN_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

step() { printf '\n== %s\n' "$*"; }

# Each name at most once in a job's "@"-separated settings (#147). What gcloud does with a repeated name is not something
# to rely on: were the last one kept, an extra setting would silently replace one this script set on purpose.
unique_names() { # unique_names <what> <list>
  local seen="@" entry name entries=()
  IFS='@' read -ra entries <<<"$2"
  for entry in ${entries[@]+"${entries[@]}"}; do
    name="${entry%%=*}"
    case "$seen" in
      *"@$name@"*) die "$name is set twice for $1: the script sets some names itself (see its header), and EXTRA_ENV_VARS and AGENT_EXTRA_ENV_VARS are added together for the agent; set each name once" ;;
    esac
    seen="$seen$name@"
  done
}

# Every job's settings are composed here, before anything is changed, so a list that would be refused (a name set
# twice) stops the deploy before it starts.
ENV_VARS="GOOGLE_CLOUD_PROJECT=$PROJECT_ID@STARFISH_WATCHED_PROJECT_ID=$WATCHED_PROJECT_ID@STARFISH_VERTEX_PROJECT_ID=$VERTEX_PROJECT_ID"
ENV_VARS="$ENV_VARS@GOOGLE_CLOUD_LOCATION=$REGION@STARFISH_ENV=$STARFISH_ENV@STARFISH_DATABASE_ID=$STARFISH_DATABASE_ID"
# The job is told its own schedule only so the UI can say when the next run is expected (#38).
ENV_VARS="$ENV_VARS@STARFISH_INGEST_SCHEDULE=$SCHEDULE"
# With the admin API, its service name is never ingested either: its errors would otherwise become incidents.
ADMIN_EXCLUDED=""
[ "$DEPLOY_ADMIN_API" != "1" ] || ADMIN_EXCLUDED=",$ADMIN_SERVICE_NAME"
# An explicit list replaces the default, so it must name the admin service too (or cover it with a prefix like starfish-*).
if [ "$DEPLOY_ADMIN_API" = "1" ]; then
  case "@$EXTRA_ENV_VARS" in
    *@STARFISH_EXCLUDED_SERVICES=*)
      case "$EXTRA_ENV_VARS" in
        *"$ADMIN_SERVICE_NAME"*|*starfish-\**) ;;
        *) echo "warning: EXTRA_ENV_VARS sets STARFISH_EXCLUDED_SERVICES without $ADMIN_SERVICE_NAME: the admin API's own errors would be ingested" >&2 ;;
      esac ;;
  esac
fi
# The deployed job's own name is never ingested (STARFISH_EXCLUDED_SERVICES, matched on the exact name, not a
# prefix): were it ever added to the log resource types, the engine would otherwise read its own failures and
# the fixer could be asked to patch Starfish itself (#32). An explicit value in EXTRA_ENV_VARS wins.
case "@$EXTRA_ENV_VARS" in
  *@STARFISH_EXCLUDED_SERVICES=*) ;;
  *) ENV_VARS="$ENV_VARS@STARFISH_EXCLUDED_SERVICES=starfish,$JOB_NAME${ADMIN_EXCLUDED}" ;;
esac
[ -z "$EXTRA_ENV_VARS" ] || ENV_VARS="$ENV_VARS@$EXTRA_ENV_VARS"
unique_names "the ingest job" "$ENV_VARS"
if [ "$DEPLOY_AGENT" = "1" ]; then
  AGENT_ENV="GOOGLE_CLOUD_PROJECT=$PROJECT_ID@STARFISH_WATCHED_PROJECT_ID=$WATCHED_PROJECT_ID@STARFISH_VERTEX_PROJECT_ID=$VERTEX_PROJECT_ID"
  AGENT_ENV="$AGENT_ENV@GOOGLE_CLOUD_LOCATION=$REGION@STARFISH_ENV=$STARFISH_ENV@STARFISH_DATABASE_ID=$STARFISH_DATABASE_ID"
  AGENT_ENV="$AGENT_ENV@STARFISH_GITHUB_REPO=$AGENT_REPO"
  [ -z "$AGENT_BASE_BRANCH" ] || AGENT_ENV="$AGENT_ENV@STARFISH_GITHUB_BASE_BRANCH=$AGENT_BASE_BRANCH"
  AGENT_EXCLUDED="starfish,$JOB_NAME,$AGENT_JOB_NAME${ADMIN_EXCLUDED}"
  [ "$VERIFY_ISOLATION" != "cloud-run-job" ] || AGENT_EXCLUDED="$AGENT_EXCLUDED,$VERIFY_JOB_NAME"
  case "@$EXTRA_ENV_VARS@$AGENT_EXTRA_ENV_VARS" in
    *@STARFISH_EXCLUDED_SERVICES=*) ;;
    *) AGENT_ENV="$AGENT_ENV@STARFISH_EXCLUDED_SERVICES=$AGENT_EXCLUDED" ;;
  esac
  [ -z "$EXTRA_ENV_VARS" ] || AGENT_ENV="$AGENT_ENV@$EXTRA_ENV_VARS"
  [ -z "$AGENT_EXTRA_ENV_VARS" ] || AGENT_ENV="$AGENT_ENV@$AGENT_EXTRA_ENV_VARS"
  # The safety values come last (#147): where the verify step runs, and the dry run. Neither extra list may set the
  # first (checked above), and unique_names refuses any name set twice, so none can be replaced by a later entry.
  AGENT_ENV="$AGENT_ENV@STARFISH_VERIFY_ISOLATION=$VERIFY_ISOLATION@STARFISH_VERIFY_TIMEOUT_SECONDS=$VERIFY_TIMEOUT_SECONDS"
  AGENT_WAIT_SECONDS=$((VERIFY_TIMEOUT_SECONDS + 600))
  if [ "$VERIFY_ISOLATION" = "github-actions" ]; then
    AGENT_ENV="$AGENT_ENV@STARFISH_VERIFY_CHECKS=$VERIFY_CHECKS"
  else
    AGENT_ENV="$AGENT_ENV@STARFISH_VERIFY_JOB=$VERIFY_JOB_NAME@STARFISH_VERIFY_BUCKET=$VERIFY_BUCKET@STARFISH_VERIFY_JOB_REGION=$REGION@STARFISH_VERIFY_COMMAND=$VERIFY_COMMAND"
    AGENT_WAIT_SECONDS=$((VERIFY_TIMEOUT_SECONDS + 300))
  fi
  # The dry run stays on until a person turns it off on purpose (an admin on the Settings page, or AGENT_EXTRA_ENV_VARS).
  # A dry run opens no pull request, files no issue and posts nothing to Slack, but it is not silent: with
  # github-actions isolation it still pushes the model-written patch to a starfish/<cycle> branch of AGENT_REPO, and
  # that repository's CI runs it (src/agent/preflight.ts). With cloud-run-job the patch goes to the verify job's bucket.
  case "@$AGENT_EXTRA_ENV_VARS" in
    *@STARFISH_DRY_RUN=*) ;;
    *) AGENT_ENV="$AGENT_ENV@STARFISH_DRY_RUN=true" ;;
  esac
  unique_names "the agent job" "$AGENT_ENV"
fi
if [ "$DEPLOY_ADMIN_API" = "1" ]; then
  ADMIN_ENV="$ENV_VARS"
  [ -z "$ADMIN_API_ORIGINS" ] || ADMIN_ENV="$ADMIN_ENV@STARFISH_ADMIN_API_ORIGINS=$ADMIN_API_ORIGINS"
  unique_names "the admin API" "$ADMIN_ENV"
fi

# Print the command (single-quoted where it needs it) in a dry run, run it otherwise.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '+'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# Does a resource exist? Always "no" in a dry run, so every create command is shown.
exists() {
  [ "$DRY_RUN" != "1" ] && "$@" >/dev/null 2>&1
}

# Does the secret have an enabled version? Always "no" in a dry run.
has_secret_version() {
  [ "$DRY_RUN" != "1" ] || return 1
  [ -n "$(gcloud secrets versions list "$GITHUB_SECRET" --project="$PROJECT_ID" \
    --filter=state=ENABLED --limit=1 --format='value(name)' 2>/dev/null)" ]
}

BUDGET_NAME="starfish-$PROJECT_ID"
# Is there already a budget by that name? Always "no" in a dry run.
has_budget() {
  [ "$DRY_RUN" != "1" ] || return 1
  [ -n "$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" \
    --filter="displayName=$BUDGET_NAME" --format='value(name)' 2>/dev/null)" ]
}

# A new service account is not visible to IAM for a few seconds: retry the binding.
retry() {
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if run "$@"; then return 0; fi
    [ "$attempt" -lt 6 ] && { echo "  (retrying in 5s: $attempt/6)" >&2; sleep 5; }
  done
  die "failed after 6 attempts: $*"
}

bind() { # bind <project> <member> <role> [IAM condition expression]
  local condition=(--condition=None)
  [ -z "${4:-}" ] || condition=(--condition="expression=$4,title=starfish-database-only")
  retry gcloud projects add-iam-policy-binding "$1" --member="serviceAccount:$2" --role="$3" \
    "${condition[@]}" --quiet --format=none
}

step "APIs on $PROJECT_ID"
run gcloud services enable --project="$PROJECT_ID" \
  run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com \
  logging.googleapis.com iam.googleapis.com
run gcloud services enable aiplatform.googleapis.com --project="$VERTEX_PROJECT_ID"
if [ "$WATCHED_PROJECT_ID" != "$PROJECT_ID" ]; then
  run gcloud services enable logging.googleapis.com --project="$WATCHED_PROJECT_ID"
fi

# `gcloud run jobs deploy --source` builds the image as this account, and a project made recently does not give it
# the right to read the uploaded source ("Build failed because the default service account is missing required
# IAM permissions"). It is the Compute Engine default account unless BUILD_SERVICE_ACCOUNT names another.
step "Build permissions: the account Cloud Run builds the image as"
if [ -n "$BUILD_SERVICE_ACCOUNT" ]; then
  BUILD_SA="$BUILD_SERVICE_ACCOUNT"
elif [ "$DRY_RUN" = "1" ]; then
  BUILD_SA="<project-number>-compute@developer.gserviceaccount.com"
else
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')" \
    || die "could not read the project number of $PROJECT_ID (needed to name the default build account)"
  BUILD_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
fi
bind "$PROJECT_ID" "$BUILD_SA" roles/run.builder

if [ -n "$BUDGET_USD" ]; then
  step "Budget alert: \$$BUDGET_USD a month on $PROJECT_ID (emails billing admins; does not stop spending)"
  run gcloud services enable billingbudgets.googleapis.com --project="$PROJECT_ID"
  if ! has_budget; then
    run gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" --display-name="$BUDGET_NAME" \
      --budget-amount="${BUDGET_USD}USD" --filter-projects="projects/$PROJECT_ID" \
      --threshold-rule=percent=0.5 --threshold-rule=percent=0.9
  fi
fi

step "Service accounts: $ENGINE_SA runs the job, $SCHEDULER_SA only starts it"
if ! exists gcloud iam service-accounts describe "$ENGINE_SA" --project="$PROJECT_ID"; then
  run gcloud iam service-accounts create "$ENGINE_SA_NAME" --project="$PROJECT_ID" \
    --display-name="Starfish engine (ingest job)"
fi
if ! exists gcloud iam service-accounts describe "$SCHEDULER_SA" --project="$PROJECT_ID"; then
  run gcloud iam service-accounts create "$SCHEDULER_SA_NAME" --project="$PROJECT_ID" \
    --display-name="Starfish scheduler (starts the ingest job)"
fi

step "Least-privilege grants for the engine"
# Three projects may be three different places; each grant names the project it applies to.
bind "$WATCHED_PROJECT_ID" "$ENGINE_SA" roles/logging.viewer   # read the watched project's logs
# Read and write Starfish's own database and no other: when the project is shared with the watched
# app, a project-wide role would let the engine reach the app's (default) database too.
DB_RESOURCE="projects/$PROJECT_ID/databases/$STARFISH_DATABASE_ID"
bind "$PROJECT_ID" "$ENGINE_SA" roles/datastore.user \
  "resource.name == \"$DB_RESOURCE\" || resource.name.startsWith(\"$DB_RESOURCE/\")"
bind "$VERTEX_PROJECT_ID" "$ENGINE_SA" roles/aiplatform.user   # call Gemini

step "Firestore database '$STARFISH_DATABASE_ID' (its own, so the watched app's rules are never touched)"
if ! exists gcloud firestore databases describe --database="$STARFISH_DATABASE_ID" --project="$PROJECT_ID"; then
  run gcloud firestore databases create --database="$STARFISH_DATABASE_ID" \
    --location="$FIRESTORE_LOCATION" --type=firestore-native --project="$PROJECT_ID"
fi
if [ "$SKIP_FIRESTORE_RULES" != "1" ]; then
  # firebase.json names a database ("starfish"), and the rules and indexes go to the database it names. So they are
  # deployed from a temporary copy that names STARFISH_DATABASE_ID instead (#148): with any other id, firebase.json
  # itself would send them to a database this deploy did not create or scope its grants to. The copy sits beside
  # firebase.json because the CLI resolves the rules and indexes paths from the config file's directory.
  FIREBASE_CONFIG=".firebase-deploy.json"
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ (write $FIREBASE_CONFIG: firebase.json with \"database\": \"$STARFISH_DATABASE_ID\")"
  else
    trap 'rm -f "$FIREBASE_CONFIG"' EXIT
    command -v node >/dev/null || die "node is needed to write the firebase config for database $STARFISH_DATABASE_ID"
    STARFISH_DATABASE_ID="$STARFISH_DATABASE_ID" node -e '
      const fs = require("fs");
      const config = JSON.parse(fs.readFileSync("firebase.json", "utf8"));
      const entries = [].concat(config.firestore ?? []);
      if (entries.length !== 1) throw new Error("firebase.json must hold exactly one firestore entry");
      config.firestore = [{ ...entries[0], database: process.env.STARFISH_DATABASE_ID }];
      fs.writeFileSync(process.argv[1], JSON.stringify(config, null, 2));
    ' "$FIREBASE_CONFIG" || die "could not write $FIREBASE_CONFIG from firebase.json"
  fi
  run pnpm dlx firebase-tools@14 deploy --only firestore --project "$PROJECT_ID" --config "$FIREBASE_CONFIG"
  [ "$DRY_RUN" = "1" ] || rm -f "$FIREBASE_CONFIG"
fi

step "Secret Manager: $GITHUB_SECRET (the agent's credential: only its account may read it, granted with DEPLOY_AGENT)"
if ! exists gcloud secrets describe "$GITHUB_SECRET" --project="$PROJECT_ID"; then
  run gcloud secrets create "$GITHUB_SECRET" --replication-policy=automatic --project="$PROJECT_ID"
fi
SECRET_VERSION=0
if [ -n "${STARFISH_GITHUB_TOKEN:-}" ]; then
  # The value comes from the environment and goes to Secret Manager over stdin: never an argument
  # (visible in the process list) and never printed.
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ printf %s <STARFISH_GITHUB_TOKEN> | gcloud secrets versions add $GITHUB_SECRET --data-file=- --project=$PROJECT_ID"
  else
    printf %s "$STARFISH_GITHUB_TOKEN" | gcloud secrets versions add "$GITHUB_SECRET" --data-file=- --project="$PROJECT_ID" --format=none
  fi
  SECRET_VERSION=1
elif has_secret_version; then
  SECRET_VERSION=1
fi

step "Cloud Run job '$JOB_NAME' (image built from the Dockerfile)"
DEPLOY_ARGS=(
  gcloud run jobs deploy "$JOB_NAME" --source . --region="$REGION" --project="$PROJECT_ID" --quiet
  --service-account="$ENGINE_SA"
  --max-retries=0 --task-timeout=600s --cpu=1 --memory=512Mi
  --update-env-vars="^@^$ENV_VARS"
)
# No secret is mounted on the ingest job (#146). An existing job may carry the token an earlier version of this script
# mounted: take it off. A new job has nothing to remove, so the flag is only passed to one that exists.
if [ "$DRY_RUN" = "1" ] || exists gcloud run jobs describe "$JOB_NAME" --region="$REGION" --project="$PROJECT_ID"; then
  DEPLOY_ARGS+=(--remove-secrets=STARFISH_GITHUB_TOKEN)
fi
run "${DEPLOY_ARGS[@]}"
# The ingest never reads the token (#146), yet an earlier version of this script let its account read it. Take that
# back, AFTER the job no longer mounts it (an execution cannot start while it mounts a secret it may not read). On a
# project where it was never granted there is nothing to remove, which is not an error.
if [ "$DRY_RUN" = "1" ]; then
  echo "+ (if an earlier deploy granted it) gcloud secrets remove-iam-policy-binding $GITHUB_SECRET: secretAccessor of $ENGINE_SA"
else
  gcloud secrets remove-iam-policy-binding "$GITHUB_SECRET" --project="$PROJECT_ID" \
    --member="serviceAccount:$ENGINE_SA" --role=roles/secretmanager.secretAccessor --quiet --format=none >/dev/null 2>&1 || true
fi
# The scheduler may start this job and nothing else.
retry gcloud run jobs add-iam-policy-binding "$JOB_NAME" --region="$REGION" --project="$PROJECT_ID" \
  --member="serviceAccount:$SCHEDULER_SA" --role=roles/run.invoker --quiet --format=none

step "Cloud Scheduler '$SCHEDULER_JOB_NAME': $SCHEDULE ($SCHEDULE_TIME_ZONE)"
RUN_URI="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/$JOB_NAME:run"
SCHEDULER_ARGS=(
  --project="$PROJECT_ID" --location="$REGION"
  --schedule="$SCHEDULE" --time-zone="$SCHEDULE_TIME_ZONE"
  --uri="$RUN_URI" --http-method=POST
  --oauth-service-account-email="$SCHEDULER_SA"
)
if exists gcloud scheduler jobs describe "$SCHEDULER_JOB_NAME" --project="$PROJECT_ID" --location="$REGION"; then
  run gcloud scheduler jobs update http "$SCHEDULER_JOB_NAME" "${SCHEDULER_ARGS[@]}"
else
  run gcloud scheduler jobs create http "$SCHEDULER_JOB_NAME" "${SCHEDULER_ARGS[@]}"
fi

if [ "$DEPLOY_AGENT" = "1" ]; then
  if [ "$VERIFY_ISOLATION" = "cloud-run-job" ]; then
    step "Verify job '$VERIFY_JOB_NAME' (#74): the only place the target's tests run. $VERIFIER_SA holds NO roles"
    if ! exists gcloud storage buckets describe "gs://$VERIFY_BUCKET" --project="$PROJECT_ID"; then
      run gcloud storage buckets create "gs://$VERIFY_BUCKET" --project="$PROJECT_ID" --location="$REGION" \
        --uniform-bucket-level-access --public-access-prevention
    fi
    # Bundles and results are deleted by the agent when it is done; a day's lifecycle removes what a crash left.
    if [ "$DRY_RUN" = "1" ]; then
      echo "+ gcloud storage buckets update gs://$VERIFY_BUCKET --project=$PROJECT_ID --lifecycle-file=<delete objects after 1 day>"
    else
      LIFECYCLE_FILE="$(mktemp)"
      printf '%s' '{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}' > "$LIFECYCLE_FILE"
      gcloud storage buckets update "gs://$VERIFY_BUCKET" --project="$PROJECT_ID" --lifecycle-file="$LIFECYCLE_FILE"
      rm -f "$LIFECYCLE_FILE"
    fi

    # No grant of any kind is made to this account, on any project or resource. That is the isolation: the code that
    # runs here can use the network and the metadata server, and the token it gets there is worth nothing.
    if ! exists gcloud iam service-accounts describe "$VERIFIER_SA" --project="$PROJECT_ID"; then
      run gcloud iam service-accounts create "$VERIFIER_SA_NAME" --project="$PROJECT_ID" \
        --display-name="Starfish verifier (runs the target's tests; holds no roles)"
    fi
    # The runner reads its whole input from the request the agent passes: no Starfish setting, no secret.
    # The task timeout covers the command's own limit plus the time to start, fetch and report.
    run gcloud run jobs deploy "$VERIFY_JOB_NAME" --source . --region="$REGION" --project="$PROJECT_ID" --quiet \
      --service-account="$VERIFIER_SA" \
      --args=node,--import,tsx,src/verifyRunnerCli.ts \
      --max-retries=0 --task-timeout="$((VERIFY_TIMEOUT_SECONDS + 600))s" --cpu=2 --memory=4Gi
  fi

  step "Agent job '$AGENT_JOB_NAME' (#74): dry run; $AGENT_SA is its own identity and never runs the target's code ($VERIFY_ISOLATION)"
  if [ "$VERIFY_ISOLATION" = "github-actions" ] && [ "$DRY_RUN" != "1" ] && [ "$SECRET_VERSION" != "1" ]; then
    die "VERIFY_ISOLATION=github-actions pushes a branch to $AGENT_REPO for CI to judge, so the agent needs a token: set STARFISH_GITHUB_TOKEN (not GITHUB_TOKEN) and run again"
  fi
  if ! exists gcloud iam service-accounts describe "$AGENT_SA" --project="$PROJECT_ID"; then
    run gcloud iam service-accounts create "$AGENT_SA_NAME" --project="$PROJECT_ID" \
      --display-name="Starfish agent (triage, fix, review)"
  fi
  # What the loop itself needs: the store (its own database only), Gemini, the counter-check's read of the watched
  # project's logs, the one secret. With cloud-run-job it also needs what the isolated verify step asks of it: its
  # bucket, a signature of its own (the signed URLs it hands the runner), and the right to start that one job.
  bind "$WATCHED_PROJECT_ID" "$AGENT_SA" roles/logging.viewer
  bind "$PROJECT_ID" "$AGENT_SA" roles/datastore.user \
    "resource.name == \"$DB_RESOURCE\" || resource.name.startsWith(\"$DB_RESOURCE/\")"
  bind "$VERTEX_PROJECT_ID" "$AGENT_SA" roles/aiplatform.user
  retry gcloud secrets add-iam-policy-binding "$GITHUB_SECRET" --project="$PROJECT_ID" \
    --member="serviceAccount:$AGENT_SA" --role=roles/secretmanager.secretAccessor --quiet --format=none
  # Each Slack webhook (#17) has its OWN secret, read by the agent's account alone (the ingest job never posts anywhere):
  # the on-call one ("needs a human") and the optional #ops-alerts one ("new incident"). A secret exists only when its
  # webhook is given: an empty secret would fail the deploy that mounts it. The value goes over stdin, never printed.
  store_slack_webhook() { # <env var name> <secret name>
    local name="$1" secret="$2" value="${!1:-}"
    case "$value" in
      https://hooks.slack.com/services/*) ;;
      *) die "$name is not a Slack incoming-webhook URL (https://hooks.slack.com/services/...)" ;;
    esac
    if ! exists gcloud secrets describe "$secret" --project="$PROJECT_ID"; then
      run gcloud secrets create "$secret" --replication-policy=automatic --project="$PROJECT_ID"
    fi
    retry gcloud secrets add-iam-policy-binding "$secret" --project="$PROJECT_ID" \
      --member="serviceAccount:$AGENT_SA" --role=roles/secretmanager.secretAccessor --quiet --format=none
    if [ "$DRY_RUN" = "1" ]; then
      echo "+ printf %s <$name> | gcloud secrets versions add $secret --data-file=- --project=$PROJECT_ID"
    else
      printf %s "$value" | gcloud secrets versions add "$secret" --data-file=- --project="$PROJECT_ID" --format=none
    fi
  }
  SLACK_MOUNT=0
  if [ -n "${STARFISH_SLACK_WEBHOOK_ONCALL:-}" ]; then
    store_slack_webhook STARFISH_SLACK_WEBHOOK_ONCALL "$SLACK_SECRET"
    SLACK_MOUNT=1
  fi
  SLACK_ALERTS_MOUNT=0
  if [ -n "${STARFISH_SLACK_WEBHOOK_ALERTS:-}" ]; then
    store_slack_webhook STARFISH_SLACK_WEBHOOK_ALERTS "$SLACK_ALERTS_SECRET"
    SLACK_ALERTS_MOUNT=1
  fi
  if [ "$VERIFY_ISOLATION" = "cloud-run-job" ]; then
    retry gcloud storage buckets add-iam-policy-binding "gs://$VERIFY_BUCKET" --project="$PROJECT_ID" \
      --member="serviceAccount:$AGENT_SA" --role=roles/storage.objectAdmin --quiet --format=none
    retry gcloud iam service-accounts add-iam-policy-binding "$AGENT_SA" --project="$PROJECT_ID" \
      --member="serviceAccount:$AGENT_SA" --role=roles/iam.serviceAccountTokenCreator --quiet --format=none
    # The agent starts the job with its request as a container override (src/agent/cloudRunJob.ts), which takes
    # run.jobs.runWithOverrides, which roles/run.invoker does not hold (#149). This role holds it and run.jobs.run, on this job only.
    retry gcloud run jobs add-iam-policy-binding "$VERIFY_JOB_NAME" --region="$REGION" --project="$PROJECT_ID" \
      --member="serviceAccount:$AGENT_SA" --role=roles/run.jobsExecutorWithOverrides --quiet --format=none
  fi

  # Room for a pass of three cycles, each waiting for a verify run, and no retry: the lease resumes a cycle.
  AGENT_DEPLOY_ARGS=(
    gcloud run jobs deploy "$AGENT_JOB_NAME" --source . --region="$REGION" --project="$PROJECT_ID" --quiet
    --service-account="$AGENT_SA"
    --args=node,--import,tsx,src/agentCli.ts
    --max-retries=0 --task-timeout="$((3 * AGENT_WAIT_SECONDS + 600))s" --cpu=1 --memory=1Gi
    --update-env-vars="^@^$AGENT_ENV"
  )
  # One flag with a comma-separated list: a repeated --update-secrets would keep only the last.
  # Cloud Run fails a deploy that mounts a secret with no version, so the token is mounted only once there is one.
  AGENT_SECRETS=""
  if [ "$SECRET_VERSION" = "1" ]; then
    AGENT_SECRETS="STARFISH_GITHUB_TOKEN=$GITHUB_SECRET:latest"
  else
    echo "  ($GITHUB_SECRET has no version yet: not mounted. Re-run with STARFISH_GITHUB_TOKEN set to add one.)"
  fi
  [ "$SLACK_MOUNT" != "1" ] || AGENT_SECRETS="${AGENT_SECRETS:+$AGENT_SECRETS,}STARFISH_SLACK_WEBHOOK_ONCALL=$SLACK_SECRET:latest"
  [ "$SLACK_ALERTS_MOUNT" != "1" ] || AGENT_SECRETS="${AGENT_SECRETS:+$AGENT_SECRETS,}STARFISH_SLACK_WEBHOOK_ALERTS=$SLACK_ALERTS_SECRET:latest"
  [ -z "$AGENT_SECRETS" ] || AGENT_DEPLOY_ARGS+=(--update-secrets="$AGENT_SECRETS")
  run "${AGENT_DEPLOY_ARGS[@]}"
  retry gcloud run jobs add-iam-policy-binding "$AGENT_JOB_NAME" --region="$REGION" --project="$PROJECT_ID" \
    --member="serviceAccount:$SCHEDULER_SA" --role=roles/run.invoker --quiet --format=none

  step "Cloud Scheduler '$AGENT_SCHEDULER_JOB_NAME': $AGENT_SCHEDULE ($SCHEDULE_TIME_ZONE)"
  AGENT_RUN_URI="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/$AGENT_JOB_NAME:run"
  AGENT_SCHEDULER_ARGS=(
    --project="$PROJECT_ID" --location="$REGION"
    --schedule="$AGENT_SCHEDULE" --time-zone="$SCHEDULE_TIME_ZONE"
    --uri="$AGENT_RUN_URI" --http-method=POST
    --oauth-service-account-email="$SCHEDULER_SA"
  )
  if exists gcloud scheduler jobs describe "$AGENT_SCHEDULER_JOB_NAME" --project="$PROJECT_ID" --location="$REGION"; then
    run gcloud scheduler jobs update http "$AGENT_SCHEDULER_JOB_NAME" "${AGENT_SCHEDULER_ARGS[@]}"
  else
    run gcloud scheduler jobs create http "$AGENT_SCHEDULER_JOB_NAME" "${AGENT_SCHEDULER_ARGS[@]}"
  fi
fi

if [ "$DEPLOY_ADMIN_API" = "1" ]; then
  step "Admin API '$ADMIN_SERVICE_NAME' (#63, #65): public URL; every action needs a Firebase ID token AND the admin role"
  # The same image as the ingest job (no second Cloud Build): only its arguments differ.
  if [ "$DRY_RUN" = "1" ]; then
    ADMIN_IMAGE="<the ingest job's image>"
  else
    ADMIN_IMAGE="$(gcloud run jobs describe "$JOB_NAME" --region="$REGION" --project="$PROJECT_ID" \
      --format='value(spec.template.spec.template.spec.containers[0].image)')"
    [ -n "$ADMIN_IMAGE" ] || die "could not read the image of job $JOB_NAME"
  fi
  # Its own account (#146): a public service should not share an identity with anything else. It holds what one ingest
  # run and a retire need (src/adminApiCli.ts: Firebase Auth's public keys need no role; the watched project's logs;
  # Starfish's database, read and write) and nothing more: no Gemini (ingest makes no model call), no secret.
  if ! exists gcloud iam service-accounts describe "$ADMIN_SA" --project="$PROJECT_ID"; then
    run gcloud iam service-accounts create "$ADMIN_SA_NAME" --project="$PROJECT_ID" \
      --display-name="Starfish admin API (run ingest now, retire)"
  fi
  bind "$WATCHED_PROJECT_ID" "$ADMIN_SA" roles/logging.viewer
  bind "$PROJECT_ID" "$ADMIN_SA" roles/datastore.user \
    "resource.name == \"$DB_RESOURCE\" || resource.name.startsWith(\"$DB_RESOURCE/\")"
  # --allow-unauthenticated: a browser must reach it, so Cloud Run's own IAM check cannot be the gate. An organisation
  # policy that forbids public services will refuse this line, and then the admin API cannot serve a browser.
  # Capped instances and a cheap token check are the only limits on a stranger who calls it.
  run gcloud run deploy "$ADMIN_SERVICE_NAME" --image="$ADMIN_IMAGE" --region="$REGION" --project="$PROJECT_ID" --quiet \
    --service-account="$ADMIN_SA" \
    --args=node,--import,tsx,src/adminApiCli.ts \
    --allow-unauthenticated --max-instances=2 --concurrency=8 --timeout=900 --cpu=1 --memory=512Mi \
    --update-env-vars="^@^$ADMIN_ENV"
fi

if [ "$RUN_AFTER_DEPLOY" = "1" ]; then
  step "First run"
  run gcloud run jobs execute "$JOB_NAME" --region="$REGION" --project="$PROJECT_ID" --wait
fi

step "Done"
if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run: nothing was changed."
else
  echo "Job $JOB_NAME and scheduler $SCHEDULER_JOB_NAME are in place in $PROJECT_ID ($REGION)."
  echo "Run it now:  gcloud run jobs execute $JOB_NAME --region=$REGION --project=$PROJECT_ID --wait"
  echo "Read it:     gcloud run jobs executions list --job=$JOB_NAME --region=$REGION --project=$PROJECT_ID"
  if [ "$DEPLOY_ADMIN_API" = "1" ]; then
    echo "Admin API $ADMIN_SERVICE_NAME: $(gcloud run services describe "$ADMIN_SERVICE_NAME" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
  fi
  if [ "$DEPLOY_AGENT" = "1" ]; then
    echo "Agent $AGENT_JOB_NAME (tick $AGENT_SCHEDULER_JOB_NAME) is in place: a dry run, verified by $VERIFY_ISOLATION."
    [ "$VERIFY_ISOLATION" != "github-actions" ] || echo "Its CI judge: the target's workflow must run on push to starfish/** and report: $VERIFY_CHECKS."
  fi
fi
