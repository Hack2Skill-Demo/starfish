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
#   REPO_ID              the repository's numeric id, which the provider trusts (a name can be renamed and then taken by
#                        someone else; the id cannot). Default: looked up with `gh api repos/<REPO>`. To find it yourself:
#                        `gh api repos/OWNER/NAME --jq .id`, or the top-level "id" of https://api.github.com/repos/OWNER/NAME
#   WATCHED_PROJECT_ID   Default PROJECT_ID. VERTEX_PROJECT_ID likewise. The deployer gets its two project-wide roles there too
#   ENVIRONMENT          the GitHub environment the jobs run in. Default deploy (the workflows are fixed to it)
#   POOL, PROVIDER       Default github, github-deploy
#   DEPLOYER_NAME        Default starfish-deployer
#   DEPLOYER_ROLE_ID, SA_IAM_ROLE_ID   the two custom roles this script makes. Default starfishDeployer, starfishServiceAccountIam
#   VERIFY_ISOLATION     what the deploy will use (deploy-gcp.sh's setting). Default github-actions; cloud-run-job also lets
#                        the deployer manage the verify bucket and the agent account's own IAM policy
#   ENGINE_SA_NAME, SCHEDULER_SA_NAME, AGENT_SA_NAME, VERIFIER_SA_NAME, ADMIN_SA_NAME, GITHUB_SECRET, SLACK_SECRET,
#   SLACK_ALERTS_SECRET, TWILIO_SID_SECRET, TWILIO_TOKEN_SECRET, TWILIO_FROM_SECRET, VERIFY_BUCKET
#                        the names deploy-gcp.sh uses, with its defaults: set them here as you set them there
#
# What it makes: the pool, the provider (attribute condition: this repository's id AND this environment, so no other
# repository and no other environment can present a token), the deployer account, and the roles docs/deploy.md lists.
# What it does NOT make: a key (none exists), the GitHub environment, or the repository variables: it prints them for you.
#
# The deployer is powerful, and bounded (#145). Granting roles on the project is limited by an IAM condition to the five
# the deploy script binds. Service accounts: it may create and read them (a custom role), never set their IAM policy,
# except on the agent's own account with cloud-run-job. Secrets and buckets: only Starfish's, by name, through conditions.
# What is still project-wide: Cloud Run, Cloud Build, Artifact Registry, Scheduler, Firestore and the rules (the table in
# docs/deploy.md). Anyone who can change a workflow on a branch the `deploy` environment allows can use it: limit the
# environment to `main` and, if you want a person in the loop, add required reviewers. Written and tested by a dry run;
# never run against a real project.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REPO="${REPO:-}"
WATCHED_PROJECT_ID="${WATCHED_PROJECT_ID:-$PROJECT_ID}"
VERTEX_PROJECT_ID="${VERTEX_PROJECT_ID:-$PROJECT_ID}"
ENVIRONMENT="${ENVIRONMENT:-deploy}"
POOL="${POOL:-github}"
PROVIDER="${PROVIDER:-github-deploy}"
DEPLOYER_NAME="${DEPLOYER_NAME:-starfish-deployer}"
REPO_ID="${REPO_ID:-}"
DEPLOYER_ROLE_ID="${DEPLOYER_ROLE_ID:-starfishDeployer}"
SA_IAM_ROLE_ID="${SA_IAM_ROLE_ID:-starfishServiceAccountIam}"
VERIFY_ISOLATION="${VERIFY_ISOLATION:-github-actions}"
# The same names, and defaults, as scripts/deploy-gcp.sh.
ENGINE_SA_NAME="${ENGINE_SA_NAME:-starfish-engine}"
SCHEDULER_SA_NAME="${SCHEDULER_SA_NAME:-starfish-scheduler}"
AGENT_SA_NAME="${AGENT_SA_NAME:-starfish-agent}"
VERIFIER_SA_NAME="${VERIFIER_SA_NAME:-starfish-verifier}"
ADMIN_SA_NAME="${ADMIN_SA_NAME:-starfish-admin-api}"
GITHUB_SECRET="${GITHUB_SECRET:-starfish-github-token}"
SLACK_SECRET="${SLACK_SECRET:-starfish-slack-oncall}"
SLACK_ALERTS_SECRET="${SLACK_ALERTS_SECRET:-starfish-slack-alerts}"
TWILIO_SID_SECRET="${TWILIO_SID_SECRET:-starfish-twilio-account-sid}"
TWILIO_TOKEN_SECRET="${TWILIO_TOKEN_SECRET:-starfish-twilio-auth-token}"
TWILIO_FROM_SECRET="${TWILIO_FROM_SECRET:-starfish-twilio-from-number}"
VERIFY_BUCKET="${VERIFY_BUCKET:-$PROJECT_ID-starfish-verify}"
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
# These names go into IAM condition expressions and resource paths: nothing but the characters the resources allow.
for var in ENGINE_SA_NAME SCHEDULER_SA_NAME AGENT_SA_NAME VERIFIER_SA_NAME ADMIN_SA_NAME GITHUB_SECRET SLACK_SECRET SLACK_ALERTS_SECRET TWILIO_SID_SECRET TWILIO_TOKEN_SECRET TWILIO_FROM_SECRET VERIFY_BUCKET; do
  case "${!var}" in ''|*[!A-Za-z0-9._-]*) die "$var may hold only letters, digits, . _ -: ${!var}" ;; esac
done
case "$DEPLOYER_ROLE_ID$SA_IAM_ROLE_ID" in *[!A-Za-z0-9_.]*) die "DEPLOYER_ROLE_ID and SA_IAM_ROLE_ID may hold only letters, digits, _ ." ;; esac
case "$VERIFY_ISOLATION" in github-actions|cloud-run-job) ;; *) die "VERIFY_ISOLATION must be github-actions or cloud-run-job: $VERIFY_ISOLATION" ;; esac

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

# The provider trusts the repository's id, not its name (#145): a renamed repository's name can be registered again by
# anyone, and a condition on the name would then trust their workflows.
if [ -z "$REPO_ID" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    REPO_ID="<id of $REPO>"
  else
    command -v gh >/dev/null || die "REPO_ID is not set and gh is not installed to look it up: set REPO_ID to the id of $REPO (the top-level \"id\" of https://api.github.com/repos/$REPO)"
    REPO_ID="$(gh api "repos/$REPO" --jq .id)" || die "could not read the id of $REPO with gh: set REPO_ID"
  fi
fi
case "$REPO_ID" in "<id of $REPO>") ;; ''|*[!0-9]*) die "REPO_ID must be the repository's numeric id: $REPO_ID" ;; esac

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
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository=assertion.repository,attribute.environment=assertion.environment"
  --attribute-condition="assertion.repository_id == '$REPO_ID' && assertion.environment == '$ENVIRONMENT'"
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
  --member="principalSet://iam.googleapis.com/$POOL_PATH/attribute.repository_id/$REPO_ID"

# A custom role on the project: create it, or bring an existing one's permissions back to this list.
custom_role() { # custom_role <id> <title> <permissions, comma-separated>
  if exists gcloud iam roles describe "$1" --project="$PROJECT_ID"; then
    run gcloud iam roles update "$1" --project="$PROJECT_ID" --permissions="$3" --quiet --format=none
  else
    run gcloud iam roles create "$1" --project="$PROJECT_ID" --title="$2" --permissions="$3" --stage=GA --quiet --format=none
  fi
}

step "Custom roles: only the parts of the broad roles the deploy uses (#145)"
# roles/iam.serviceAccountAdmin would hold iam.serviceAccounts.setIamPolicy on EVERY account in the project, so the
# deployer could make itself a token creator on any of them (the Compute default account is often Editor) and act with
# its roles; the project-level condition below never applies to a grant on an account's own policy. So: create and read
# accounts, nothing else. Creating a secret or a bucket is checked on the project, where a condition on the secret's or
# the bucket's name cannot match, so those two creates are here too (a new one is empty and no one can read it); listing
# buckets is what `run jobs deploy --source` does to check that its source bucket is the project's own (names only).
DEPLOYER_ROLE="projects/$PROJECT_ID/roles/$DEPLOYER_ROLE_ID"
custom_role "$DEPLOYER_ROLE_ID" "Starfish deployer" \
  "iam.serviceAccounts.create,iam.serviceAccounts.get,secretmanager.secrets.create,storage.buckets.create,storage.buckets.list"

step "Roles on $PROJECT_ID (what scripts/deploy-gcp.sh does; docs/deploy.md has the table)"
for role in roles/serviceusage.serviceUsageAdmin "$DEPLOYER_ROLE" roles/datastore.owner roles/firebaserules.admin \
            roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.admin roles/cloudscheduler.admin; do
  bind "$PROJECT_ID" "$role"
done
# Secrets: Starfish's own, by name, and no other (the watched app's, when it shares the project, stay out of reach): the
# GitHub token, the Slack on-call and #ops-alerts webhooks (#169), and Twilio's three for the phone escalation (#37).
# Secret Manager names a secret by the project NUMBER.
secret_is() { echo "resource.name == \"projects/$PROJECT_NUMBER/secrets/$1\" || resource.name.startsWith(\"projects/$PROJECT_NUMBER/secrets/$1/\")"; }
bind "$PROJECT_ID" roles/secretmanager.admin "$(secret_is "$GITHUB_SECRET") || $(secret_is "$SLACK_SECRET") || $(secret_is "$SLACK_ALERTS_SECRET") || $(secret_is "$TWILIO_SID_SECRET") || $(secret_is "$TWILIO_TOKEN_SECRET") || $(secret_is "$TWILIO_FROM_SECRET")"
# Buckets: the source bucket `run jobs deploy --source` uploads to (run-sources-<project>-<region>, or the older
# <project>_cloudbuild) and, with cloud-run-job, the verify bucket; their objects too. No other bucket.
bucket_is() { echo "resource.name == \"projects/_/buckets/$1\" || resource.name.startsWith(\"projects/_/buckets/$1/\")"; }
BUCKETS="resource.name.startsWith(\"projects/_/buckets/run-sources-$PROJECT_ID-\") || $(bucket_is "${PROJECT_ID}_cloudbuild")"
[ "$VERIFY_ISOLATION" != "cloud-run-job" ] || BUCKETS="$BUCKETS || $(bucket_is "$VERIFY_BUCKET")"
bind "$PROJECT_ID" roles/storage.admin "$BUCKETS"
# Granting roles is limited to the five the deploy script binds (roles/monitoring.viewer only with STARFISH_MONITORING_ENABLED=true,
# #176): the deployer cannot hand itself, or anyone, any other.
GRANTABLE="api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['roles/logging.viewer','roles/datastore.user','roles/aiplatform.user','roles/run.builder','roles/monitoring.viewer'])"
bind "$PROJECT_ID" roles/resourcemanager.projectIamAdmin "$GRANTABLE"
for other in "$WATCHED_PROJECT_ID" "$VERTEX_PROJECT_ID"; do
  [ "$other" != "$PROJECT_ID" ] || continue
  bind "$other" roles/serviceusage.serviceUsageAdmin
  bind "$other" roles/resourcemanager.projectIamAdmin "$GRANTABLE"
done

# Does the account exist? In a dry run, say yes so every grant is shown. A grant on an account must wait for the account.
account_ready() {
  [ "$DRY_RUN" = "1" ] && return 0
  gcloud iam service-accounts describe "$1" --project="$PROJECT_ID" >/dev/null 2>&1 && return 0
  echo "  ($1 does not exist yet: skipped; run this script again after the first deploy that creates it)"
  return 1
}

step "May act as the accounts the deploy creates and runs jobs and the admin API as (only those, not project-wide)"
for sa in "$ENGINE_SA_NAME" "$SCHEDULER_SA_NAME" "$AGENT_SA_NAME" "$VERIFIER_SA_NAME" "$ADMIN_SA_NAME"; do
  account="$sa@$PROJECT_ID.iam.gserviceaccount.com"
  account_ready "$account" || continue
  run gcloud iam service-accounts add-iam-policy-binding "$account" --project="$PROJECT_ID" \
    --role=roles/iam.serviceAccountUser --member="serviceAccount:$DEPLOYER"
done

if [ "$VERIFY_ISOLATION" = "cloud-run-job" ]; then
  # With cloud-run-job the deploy lets the agent's account sign URLs as itself (a grant on that account's own policy),
  # so the deployer may set that one account's policy and no other's. It already acts as that account, so this adds
  # no account it could reach.
  step "May set the IAM policy of $AGENT_SA_NAME, and of no other account (cloud-run-job)"
  custom_role "$SA_IAM_ROLE_ID" "Starfish service account IAM" \
    "iam.serviceAccounts.get,iam.serviceAccounts.getIamPolicy,iam.serviceAccounts.setIamPolicy"
  account="$AGENT_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
  if account_ready "$account"; then
    run gcloud iam service-accounts add-iam-policy-binding "$account" --project="$PROJECT_ID" \
      --role="projects/$PROJECT_ID/roles/$SA_IAM_ROLE_ID" --member="serviceAccount:$DEPLOYER"
  fi
fi

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
     STARFISH_EXTRA_ENV_VARS        = (e.g. STARFISH_EXCLUDED_SERVICES=starfish,starfish-ingest,starfish-agent,starfish-admin,traffic-*,control-*,stub-*)
     STARFISH_DEPLOY_ADMIN_API      = (1 to deploy the admin API too, with STARFISH_ADMIN_API_ORIGINS = https://<your site>.web.app)
3. To deploy on every merge to main that changes what runs, also set:   STARFISH_DEPLOY_ON_MERGE = true
   Until you do, the workflows only run when you start them (Actions > Deploy engine / Deploy web UI > Run workflow).
4. Try it first: Actions > Deploy engine > Run workflow, with "dry_run" ticked. Besides printing the plan, it makes two read-only
   calls as the deployer (describe the project, describe the deployer account), which fail the run unless the pool, the
   provider and the workloadIdentityUser binding work. They do not check the deployer's other roles: the first real run does.
NEXT
