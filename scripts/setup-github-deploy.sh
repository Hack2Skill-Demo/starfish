#!/usr/bin/env bash
# One-time Google Cloud setup so GitHub Actions can deploy Starfish with no key and no secret (#75, #92): a Workload
# Identity pool and provider that trust ONE repository's jobs in the `deploy` environment, and a deployer service
# account those jobs may act as. Run it ONCE, as an owner of the project (Cloud Shell is fine). Idempotent.
#
#   PROJECT_ID=my-project REPO=owner/name scripts/setup-github-deploy.sh
#   DRY_RUN=1 PROJECT_ID=my-project REPO=owner/name scripts/setup-github-deploy.sh      # print every command, change nothing
#
#   PROJECT_ID           (required) the project Starfish runs in
#   REPO                 (required) owner/name of the GitHub repository whose workflows may deploy
#   WATCHED_PROJECT_ID   Default PROJECT_ID. VERTEX_PROJECT_ID likewise. The deployer gets its two project-wide roles there too
#   ENVIRONMENT          the GitHub environment the jobs run in. Default deploy (the workflows are fixed to it)
#   POOL, PROVIDER       Default github, github-deploy
#   DEPLOYER_NAME        Default starfish-deployer
#
# What it makes: the pool, the provider (attribute condition: this repository AND this environment, so no other repository
# and no other environment can present a token), the deployer account, and the roles docs/deploy.md lists. What it does
# NOT make: a key (none exists), the GitHub environment, or the repository variables: it prints them for you to set.
#
# The deployer is powerful. It can create service accounts and bind the roles the deploy script binds, and
# `projectIamAdmin` is limited by an IAM condition to exactly those roles. Anyone who can change a workflow on a branch
# the `deploy` environment allows can use it: limit the environment to `main` and, if you want a person in the loop,
# add required reviewers. Written and tested by a dry run; never run against a real project.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REPO="${REPO:-}"
WATCHED_PROJECT_ID="${WATCHED_PROJECT_ID:-$PROJECT_ID}"
VERTEX_PROJECT_ID="${VERTEX_PROJECT_ID:-$PROJECT_ID}"
ENVIRONMENT="${ENVIRONMENT:-deploy}"
POOL="${POOL:-github}"
PROVIDER="${PROVIDER:-github-deploy}"
DEPLOYER_NAME="${DEPLOYER_NAME:-starfish-deployer}"
DRY_RUN="${DRY_RUN:-0}"

die() { echo "setup-github-deploy: $*" >&2; exit 1; }
[ -n "$PROJECT_ID" ] || die "PROJECT_ID is required"
[ -n "$REPO" ] || die "REPO is required (owner/name)"
case "$REPO" in
  */*/*|*[!A-Za-z0-9._/-]*|/*|*/|*..*) die "REPO must be owner/name: $REPO" ;;
  */*) ;;
  *) die "REPO must be owner/name: $REPO" ;;
esac
case "$ENVIRONMENT$POOL$PROVIDER$DEPLOYER_NAME" in *[!A-Za-z0-9._-]*) die "ENVIRONMENT, POOL, PROVIDER and DEPLOYER_NAME may hold only letters, digits, . _ -" ;; esac

step() { printf '\n== %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
# Does a resource exist? Always "no" in a dry run, so every create command is shown.
exists() { [ "$DRY_RUN" != "1" ] && "$@" >/dev/null 2>&1; }

DEPLOYER="$DEPLOYER_NAME@$PROJECT_ID.iam.gserviceaccount.com"
if [ "$DRY_RUN" = "1" ]; then PROJECT_NUMBER="<project-number>"; else
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')" || die "cannot read the project number of $PROJECT_ID"
fi
POOL_PATH="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL"

bind() { # bind <project> <role> [condition expression]
  local condition=(--condition=None)
  # The expression holds commas, so the key=value pairs are separated by ";" instead (gcloud's "^;^" prefix).
  [ -z "${3:-}" ] || condition=(--condition="^;^expression=$3;title=starfish-deployer-grants")
  run gcloud projects add-iam-policy-binding "$1" --member="serviceAccount:$DEPLOYER" --role="$2" "${condition[@]}" --quiet --format=none
}

step "APIs"
run gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT_ID"

step "Workload Identity pool '$POOL' and provider '$PROVIDER': only $REPO, only the $ENVIRONMENT environment"
if ! exists gcloud iam workload-identity-pools describe "$POOL" --project="$PROJECT_ID" --location=global; then
  run gcloud iam workload-identity-pools create "$POOL" --project="$PROJECT_ID" --location=global --display-name="GitHub Actions"
fi
PROVIDER_ARGS=(
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL"
  --issuer-uri="https://token.actions.githubusercontent.com"
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment"
  --attribute-condition="assertion.repository == '$REPO' && assertion.environment == '$ENVIRONMENT'"
)
if exists gcloud iam workload-identity-pools providers describe "$PROVIDER" --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL"; then
  run gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" "${PROVIDER_ARGS[@]}"
else
  run gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" "${PROVIDER_ARGS[@]}"
fi

step "Deployer service account $DEPLOYER (its own, apart from the engine's and the scheduler's)"
if ! exists gcloud iam service-accounts describe "$DEPLOYER" --project="$PROJECT_ID"; then
  run gcloud iam service-accounts create "$DEPLOYER_NAME" --project="$PROJECT_ID" --display-name="Starfish deployer (GitHub Actions)"
fi
run gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/$POOL_PATH/attribute.repository/$REPO"

step "Roles on $PROJECT_ID (what scripts/deploy-gcp.sh does; docs/deploy.md has the table)"
for role in roles/serviceusage.serviceUsageAdmin roles/iam.serviceAccountAdmin roles/datastore.owner roles/firebaserules.admin \
            roles/secretmanager.admin roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.admin \
            roles/storage.admin roles/cloudscheduler.admin; do
  bind "$PROJECT_ID" "$role"
done
# Granting roles is limited to the four the deploy script binds: the deployer cannot hand itself, or anyone, any other.
GRANTABLE="api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['roles/logging.viewer','roles/datastore.user','roles/aiplatform.user','roles/run.builder'])"
bind "$PROJECT_ID" roles/resourcemanager.projectIamAdmin "$GRANTABLE"
for other in "$WATCHED_PROJECT_ID" "$VERTEX_PROJECT_ID"; do
  [ "$other" != "$PROJECT_ID" ] || continue
  bind "$other" roles/serviceusage.serviceUsageAdmin
  bind "$other" roles/resourcemanager.projectIamAdmin "$GRANTABLE"
done

step "May act as the accounts the deploy creates and runs jobs as (only those, not project-wide)"
for sa in starfish-engine starfish-scheduler starfish-agent starfish-verifier; do
  account="$sa@$PROJECT_ID.iam.gserviceaccount.com"
  if [ "$DRY_RUN" != "1" ] && ! gcloud iam service-accounts describe "$account" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "  ($account does not exist yet: skipped; run this script again after the first deploy that creates it)"
    continue
  fi
  run gcloud iam service-accounts add-iam-policy-binding "$account" --project="$PROJECT_ID" \
    --role=roles/iam.serviceAccountUser --member="serviceAccount:$DEPLOYER"
done

step "Done on the Google Cloud side. Now, in GitHub ($REPO):"
cat <<NEXT
1. Settings > Environments > New environment: "$ENVIRONMENT". Under "Deployment branches", choose "Selected branches" and add: main.
   (Add "Required reviewers" if you want a person to approve each deploy; leave it empty for a fully automatic one.)
2. Settings > Secrets and variables > Actions > Variables > New repository variable, each of:
     GCP_WORKLOAD_IDENTITY_PROVIDER = $POOL_PATH/providers/$PROVIDER
     GCP_DEPLOY_SERVICE_ACCOUNT     = $DEPLOYER
     STARFISH_GCP_PROJECT_ID        = $PROJECT_ID
     STARFISH_ENV                   = (the label you deployed with, e.g. demo)
     STARFISH_WEB_HOSTING_SITE      = (your Hosting site, e.g. ocean-starfish)
     STARFISH_SCHEDULE              = (e.g. */5 * * * *; empty means hourly)
     STARFISH_EXTRA_ENV_VARS        = (e.g. STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-agent,traffic-*,control-*,stub-*)
3. To deploy on every merge to main that changes what runs, also set:   STARFISH_DEPLOY_ON_MERGE = true
   Until you do, the workflows only run when you start them (Actions > Deploy engine / Deploy web UI > Run workflow).
4. Try it first: Actions > Deploy engine > Run workflow, with "dry_run" ticked. It signs in, so it proves this setup.
NEXT
