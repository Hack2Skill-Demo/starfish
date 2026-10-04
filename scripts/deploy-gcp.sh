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
#   STARFISH_DATABASE_ID Starfish's named Firestore database. Default starfish; "(default)" is refused
#   FIRESTORE_LOCATION   where the database is created if it does not exist. Default REGION
#   SCHEDULE             cron for the ingest tick. Default "0 * * * *" (hourly); "*/5 * * * *" for a demo
#   SCHEDULE_TIME_ZONE   Default Etc/UTC
#   EXTRA_ENV_VARS       more engine settings for the job, "@"-separated: "STARFISH_MODEL=x@STARFISH_LOOKBACK_HOURS=6"
#                        (see .env.example for every name; "@" so a value can hold commas)
#   STARFISH_GITHUB_TOKEN  if set, stored as a new version of the starfish-github-token secret. Not
#                        GITHUB_TOKEN: that name is the Actions workflow's own token, and many shells export a
#                        personal one, neither of which should reach Secret Manager by accident
#   BUDGET_USD           if set (with BILLING_ACCOUNT), create a budget that EMAILS billing admins at 50% and
#                        90% of this monthly amount for PROJECT_ID. An alert, not a cap: nothing stops spending
#   BILLING_ACCOUNT      the billing account id (0123AB-456CDE-789FGH), needed with BUDGET_USD
#   SKIP_FIRESTORE_RULES=1   do not deploy firestore.rules and firestore.indexes.json
#   RUN_AFTER_DEPLOY=1       execute the job once and wait for it
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
BUDGET_USD="${BUDGET_USD:-}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
SKIP_FIRESTORE_RULES="${SKIP_FIRESTORE_RULES:-0}"
RUN_AFTER_DEPLOY="${RUN_AFTER_DEPLOY:-0}"
DRY_RUN="${DRY_RUN:-0}"

JOB_NAME="${JOB_NAME:-starfish-ingest}"
ENGINE_SA_NAME="${ENGINE_SA_NAME:-starfish-engine}"
SCHEDULER_SA_NAME="${SCHEDULER_SA_NAME:-starfish-scheduler}"
SCHEDULER_JOB_NAME="${SCHEDULER_JOB_NAME:-$JOB_NAME-tick}"
GITHUB_SECRET="${GITHUB_SECRET:-starfish-github-token}"

die() { echo "deploy-gcp: $*" >&2; exit 1; }

[ -n "$PROJECT_ID" ] || die "PROJECT_ID is required"
[ "$STARFISH_DATABASE_ID" != "(default)" ] ||
  die "STARFISH_DATABASE_ID=(default) is refused: deploying firestore.rules to the default database would replace the watched app's own rules"
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

step() { printf '\n== %s\n' "$*"; }

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
  # firebase.json names the database, so this deploys to it and to no other.
  run pnpm dlx firebase-tools@14 deploy --only firestore --project "$PROJECT_ID"
fi

step "Secret Manager: $GITHUB_SECRET (the credential the pull-request step will need)"
if ! exists gcloud secrets describe "$GITHUB_SECRET" --project="$PROJECT_ID"; then
  run gcloud secrets create "$GITHUB_SECRET" --replication-policy=automatic --project="$PROJECT_ID"
fi
retry gcloud secrets add-iam-policy-binding "$GITHUB_SECRET" --project="$PROJECT_ID" \
  --member="serviceAccount:$ENGINE_SA" --role=roles/secretmanager.secretAccessor --quiet --format=none
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
ENV_VARS="GOOGLE_CLOUD_PROJECT=$PROJECT_ID@STARFISH_WATCHED_PROJECT_ID=$WATCHED_PROJECT_ID@STARFISH_VERTEX_PROJECT_ID=$VERTEX_PROJECT_ID"
ENV_VARS="$ENV_VARS@GOOGLE_CLOUD_LOCATION=$REGION@STARFISH_ENV=$STARFISH_ENV@STARFISH_DATABASE_ID=$STARFISH_DATABASE_ID"
# The deployed job's own name is never ingested (STARFISH_EXCLUDED_SERVICES, matched on the exact name, not a
# prefix): were it ever added to the log resource types, the engine would otherwise read its own failures and
# the fixer could be asked to patch Starfish itself (#32). An explicit value in EXTRA_ENV_VARS wins.
case "@$EXTRA_ENV_VARS" in
  *@STARFISH_EXCLUDED_SERVICES=*) ;;
  *) ENV_VARS="$ENV_VARS@STARFISH_EXCLUDED_SERVICES=starfish,$JOB_NAME" ;;
esac
[ -z "$EXTRA_ENV_VARS" ] || ENV_VARS="$ENV_VARS@$EXTRA_ENV_VARS"
DEPLOY_ARGS=(
  gcloud run jobs deploy "$JOB_NAME" --source . --region="$REGION" --project="$PROJECT_ID" --quiet
  --service-account="$ENGINE_SA"
  --max-retries=0 --task-timeout=600s --cpu=1 --memory=512Mi
  --update-env-vars="^@^$ENV_VARS"
)
# Cloud Run mounts the secret as an environment variable; it fails the deploy if the secret has no
# version, so it is mounted only once there is one.
if [ "$SECRET_VERSION" = "1" ]; then
  DEPLOY_ARGS+=(--update-secrets="STARFISH_GITHUB_TOKEN=$GITHUB_SECRET:latest")
else
  echo "  ($GITHUB_SECRET has no version yet: not mounted. Re-run with STARFISH_GITHUB_TOKEN set to add one.)"
fi
run "${DEPLOY_ARGS[@]}"
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
fi
