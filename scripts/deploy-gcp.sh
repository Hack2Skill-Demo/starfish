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
#   DEPLOY_AGENT=1       also deploy the AGENT (#74): triage -> fix -> verify -> review for open incidents, as a dry run.
#                        Three more things, none of which the ingest has: a Cloud Run job and Scheduler job for the
#                        agent under its own service account; a separate VERIFY job, under a service account that
#                        holds NO roles, which is the only place the target repository's tests run (the agent holds
#                        the store, Logging and Gemini credentials and never runs them); and a bucket the two pass the
#                        source and the result through. Needs AGENT_REPO and VERIFY_COMMAND. Off by default
#   AGENT_REPO           owner/name of the repository the agent works on (STARFISH_GITHUB_REPO)
#   VERIFY_COMMAND       the command that proves a patch (STARFISH_VERIFY_COMMAND), run in the verify job, e.g.
#                        "pnpm install --frozen-lockfile && pnpm run verify". The verify job's image is this repo's
#                        engine image (node, pnpm, git): a target that needs another toolchain needs another image
#   VERIFY_TIMEOUT_SECONDS  how long that command may run. Default 600
#   VERIFY_BUCKET        the bucket for bundles and results (objects deleted after a day). Default <PROJECT_ID>-starfish-verify
#   AGENT_BASE_BRANCH    the branch the agent checks out. Default: the engine's own default (main)
#   AGENT_SCHEDULE       cron for the agent tick. Default "30 * * * *" (hourly, after the ingest tick)
#   AGENT_EXTRA_ENV_VARS more settings for the agent job, "@"-separated like EXTRA_ENV_VARS
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
DEPLOY_AGENT="${DEPLOY_AGENT:-0}"
AGENT_REPO="${AGENT_REPO:-}"
AGENT_BASE_BRANCH="${AGENT_BASE_BRANCH:-}"
AGENT_SCHEDULE="${AGENT_SCHEDULE:-30 * * * *}"
AGENT_EXTRA_ENV_VARS="${AGENT_EXTRA_ENV_VARS:-}"
VERIFY_COMMAND="${VERIFY_COMMAND:-}"
VERIFY_TIMEOUT_SECONDS="${VERIFY_TIMEOUT_SECONDS:-600}"
VERIFY_BUCKET="${VERIFY_BUCKET:-$PROJECT_ID-starfish-verify}"
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
AGENT_JOB_NAME="${AGENT_JOB_NAME:-starfish-agent}"
AGENT_SA_NAME="${AGENT_SA_NAME:-starfish-agent}"
AGENT_SCHEDULER_JOB_NAME="${AGENT_SCHEDULER_JOB_NAME:-$AGENT_JOB_NAME-tick}"
VERIFY_JOB_NAME="${VERIFY_JOB_NAME:-starfish-verify}"
VERIFIER_SA_NAME="${VERIFIER_SA_NAME:-starfish-verifier}"

die() { echo "deploy-gcp: $*" >&2; exit 1; }

[ -n "$PROJECT_ID" ] || die "PROJECT_ID is required"
[ "$STARFISH_DATABASE_ID" != "(default)" ] ||
  die "STARFISH_DATABASE_ID=(default) is refused: deploying firestore.rules to the default database would replace the watched app's own rules"
if [ "$DEPLOY_AGENT" = "1" ]; then
  [ -n "$AGENT_REPO" ] || die "DEPLOY_AGENT=1 needs AGENT_REPO (owner/name): the agent has no repository to work on without it"
  case "$AGENT_REPO" in
    */*/*|*[!A-Za-z0-9._/-]*|/*|*/|*..*) die "AGENT_REPO must be owner/name: $AGENT_REPO" ;;
    */*) ;;
    *) die "AGENT_REPO must be owner/name: $AGENT_REPO" ;;
  esac
  [ -n "$VERIFY_COMMAND" ] || die "DEPLOY_AGENT=1 needs VERIFY_COMMAND: with nothing to prove a patch, none would ever be accepted and the agent will not start"
  case "$VERIFY_COMMAND" in
    *@*) die "VERIFY_COMMAND may not contain '@' (it is the separator of the job's environment variables)" ;;
  esac
  case "$VERIFY_TIMEOUT_SECONDS" in
    ''|*[!0-9]*|0) die "VERIFY_TIMEOUT_SECONDS must be a whole number of seconds above zero: $VERIFY_TIMEOUT_SECONDS" ;;
  esac
  [ "$VERIFY_TIMEOUT_SECONDS" -le 3000 ] || die "VERIFY_TIMEOUT_SECONDS may not exceed 3000: the runner gets that plus 300 s of its own to start and report, and a verify result is waited for no longer than one hour"
  case "$VERIFY_BUCKET" in
    *[!a-z0-9._-]*|-*|.*) die "VERIFY_BUCKET must be a bucket name (lowercase letters, digits, - . _): $VERIFY_BUCKET" ;;
  esac
  # The script owns how the agent's verify step is isolated: a person's extra setting must not point it elsewhere,
  # least of all at running the command in the agent's own process.
  case "@$AGENT_EXTRA_ENV_VARS" in
    *@STARFISH_VERIFY_ISOLATION=*|*@STARFISH_VERIFY_JOB=*|*@STARFISH_VERIFY_BUCKET=*|*@STARFISH_VERIFY_COMMAND=*|*@STARFISH_VERIFY_JOB_REGION=*|*@STARFISH_VERIFY_TIMEOUT_SECONDS=*)
      die "AGENT_EXTRA_ENV_VARS may not set STARFISH_VERIFY_*: DEPLOY_AGENT sets them (isolation, job, bucket, command, timeout)" ;;
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

if [ "$DEPLOY_AGENT" = "1" ]; then
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

  step "Agent job '$AGENT_JOB_NAME' (#74): dry run; $AGENT_SA is its own identity and never runs the target's code"
  if ! exists gcloud iam service-accounts describe "$AGENT_SA" --project="$PROJECT_ID"; then
    run gcloud iam service-accounts create "$AGENT_SA_NAME" --project="$PROJECT_ID" \
      --display-name="Starfish agent (triage, fix, review)"
  fi
  # What the loop itself needs: the store (its own database only), Gemini, the counter-check's read of the watched
  # project's logs, the one secret; and what the isolated verify step needs of it: its bucket, a signature of its own
  # (the signed URLs it hands the runner), and the right to start that one job.
  bind "$WATCHED_PROJECT_ID" "$AGENT_SA" roles/logging.viewer
  bind "$PROJECT_ID" "$AGENT_SA" roles/datastore.user \
    "resource.name == \"$DB_RESOURCE\" || resource.name.startsWith(\"$DB_RESOURCE/\")"
  bind "$VERTEX_PROJECT_ID" "$AGENT_SA" roles/aiplatform.user
  retry gcloud secrets add-iam-policy-binding "$GITHUB_SECRET" --project="$PROJECT_ID" \
    --member="serviceAccount:$AGENT_SA" --role=roles/secretmanager.secretAccessor --quiet --format=none
  retry gcloud storage buckets add-iam-policy-binding "gs://$VERIFY_BUCKET" --project="$PROJECT_ID" \
    --member="serviceAccount:$AGENT_SA" --role=roles/storage.objectAdmin --quiet --format=none
  retry gcloud iam service-accounts add-iam-policy-binding "$AGENT_SA" --project="$PROJECT_ID" \
    --member="serviceAccount:$AGENT_SA" --role=roles/iam.serviceAccountTokenCreator --quiet --format=none
  retry gcloud run jobs add-iam-policy-binding "$VERIFY_JOB_NAME" --region="$REGION" --project="$PROJECT_ID" \
    --member="serviceAccount:$AGENT_SA" --role=roles/run.invoker --quiet --format=none

  AGENT_ENV="GOOGLE_CLOUD_PROJECT=$PROJECT_ID@STARFISH_WATCHED_PROJECT_ID=$WATCHED_PROJECT_ID@STARFISH_VERTEX_PROJECT_ID=$VERTEX_PROJECT_ID"
  AGENT_ENV="$AGENT_ENV@GOOGLE_CLOUD_LOCATION=$REGION@STARFISH_ENV=$STARFISH_ENV@STARFISH_DATABASE_ID=$STARFISH_DATABASE_ID"
  AGENT_ENV="$AGENT_ENV@STARFISH_GITHUB_REPO=$AGENT_REPO"
  [ -z "$AGENT_BASE_BRANCH" ] || AGENT_ENV="$AGENT_ENV@STARFISH_GITHUB_BASE_BRANCH=$AGENT_BASE_BRANCH"
  AGENT_ENV="$AGENT_ENV@STARFISH_VERIFY_ISOLATION=cloud-run-job@STARFISH_VERIFY_JOB=$VERIFY_JOB_NAME@STARFISH_VERIFY_BUCKET=$VERIFY_BUCKET"
  AGENT_ENV="$AGENT_ENV@STARFISH_VERIFY_JOB_REGION=$REGION@STARFISH_VERIFY_TIMEOUT_SECONDS=$VERIFY_TIMEOUT_SECONDS@STARFISH_VERIFY_COMMAND=$VERIFY_COMMAND"
  # Nothing leaves Starfish until a person turns the dry run off on purpose (an admin on the Settings page, or here).
  case "@$AGENT_EXTRA_ENV_VARS" in
    *@STARFISH_DRY_RUN=*) ;;
    *) AGENT_ENV="$AGENT_ENV@STARFISH_DRY_RUN=true" ;;
  esac
  case "@$EXTRA_ENV_VARS@$AGENT_EXTRA_ENV_VARS" in
    *@STARFISH_EXCLUDED_SERVICES=*) ;;
    *) AGENT_ENV="$AGENT_ENV@STARFISH_EXCLUDED_SERVICES=starfish,$JOB_NAME,$AGENT_JOB_NAME,$VERIFY_JOB_NAME" ;;
  esac
  [ -z "$EXTRA_ENV_VARS" ] || AGENT_ENV="$AGENT_ENV@$EXTRA_ENV_VARS"
  [ -z "$AGENT_EXTRA_ENV_VARS" ] || AGENT_ENV="$AGENT_ENV@$AGENT_EXTRA_ENV_VARS"
  # Room for a pass of three cycles, each waiting for a verify run, and no retry: the lease resumes a cycle.
  AGENT_DEPLOY_ARGS=(
    gcloud run jobs deploy "$AGENT_JOB_NAME" --source . --region="$REGION" --project="$PROJECT_ID" --quiet
    --service-account="$AGENT_SA"
    --args=node,--import,tsx,src/agentCli.ts
    --max-retries=0 --task-timeout="$((3 * (VERIFY_TIMEOUT_SECONDS + 300) + 600))s" --cpu=1 --memory=1Gi
    --update-env-vars="^@^$AGENT_ENV"
  )
  if [ "$SECRET_VERSION" = "1" ]; then
    AGENT_DEPLOY_ARGS+=(--update-secrets="STARFISH_GITHUB_TOKEN=$GITHUB_SECRET:latest")
  fi
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
  [ "$DEPLOY_AGENT" != "1" ] || echo "Agent $AGENT_JOB_NAME (tick $AGENT_SCHEDULER_JOB_NAME) and verify job $VERIFY_JOB_NAME are in place: a dry run; the tests run only in $VERIFY_JOB_NAME."
fi
