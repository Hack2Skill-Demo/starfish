#!/usr/bin/env bash
# Is this machine and this project ready for scripts/deploy-gcp.sh? Read-only: it changes nothing, so it
# is safe to run first and to re-run. Takes the same variables as the deploy script.
#
#   PROJECT_ID=my-project scripts/preflight-gcp.sh
#
# Prints one line per check: "ok", "warn" (worth knowing, may not stop you) or "FAIL" (the deploy will
# not get through). Exits 1 if anything FAILed. Docker is NOT needed: Cloud Build makes the image.
#
# A check that could not be made says so ("warn: could not read ...") rather than passing; a missing
# permission it cannot see is not proof you lack it.
set -uo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
WATCHED_PROJECT_ID="${WATCHED_PROJECT_ID:-$PROJECT_ID}"
VERTEX_PROJECT_ID="${VERTEX_PROJECT_ID:-$PROJECT_ID}"
STARFISH_DATABASE_ID="${STARFISH_DATABASE_ID:-starfish}"
JOB_NAME="${JOB_NAME:-starfish-ingest}"
SCHEDULER_JOB_NAME="${SCHEDULER_JOB_NAME:-$JOB_NAME-tick}"

FAILS=0
ok() { printf 'ok    %s\n' "$*"; }
warn() { printf 'warn  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }

if [ -z "$PROJECT_ID" ]; then
  fail "PROJECT_ID is not set"
  exit 1
fi
if [ "$STARFISH_DATABASE_ID" = "(default)" ]; then
  fail "STARFISH_DATABASE_ID=(default) would put Starfish's rules on the watched app's database; the deploy refuses it"
fi

echo "Preflight for $PROJECT_ID ($REGION); logs read from $WATCHED_PROJECT_ID, Gemini in $VERTEX_PROJECT_ID"

# ---- this machine
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -ge 22 ] 2>/dev/null; then ok "node $(node -v)"; else fail "node 22 or newer is needed (found: ${node_major:-none})"; fi
if command -v pnpm >/dev/null 2>&1; then ok "pnpm $(pnpm -v 2>/dev/null)"; else fail "pnpm is not installed (corepack enable pnpm)"; fi
if ! command -v gcloud >/dev/null 2>&1; then
  fail "gcloud is not installed (https://cloud.google.com/sdk/docs/install)"
  echo; echo "Stopped: nothing below can be checked without gcloud."; exit 1
fi
ok "gcloud $(gcloud --version 2>/dev/null | head -1 | sed 's/Google Cloud SDK //')"

# ---- who you are
account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
if [ -n "$account" ]; then ok "gcloud signed in as $account"; else fail "not signed in: gcloud auth login"; fi
if gcloud auth application-default print-access-token >/dev/null 2>&1; then
  ok "application-default credentials present (pnpm status / grant-operator will work)"
else
  warn "no application-default credentials: run 'gcloud auth application-default login' before pnpm status or grant-operator"
fi

# ---- the projects
check_project() { # check_project <label> <id>
  if gcloud projects describe "$2" --format='value(projectId)' >/dev/null 2>&1; then
    ok "$1 project $2 is reachable"
    return 0
  fi
  fail "$1 project $2 was not found, or you cannot see it"
  return 1
}
if check_project "Starfish" "$PROJECT_ID"; then
  billing="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || true)"
  case "$billing" in
    True|true) ok "billing is enabled on $PROJECT_ID" ;;
    False|false) fail "billing is NOT enabled on $PROJECT_ID (Cloud Run, Scheduler and Cloud Build need it)" ;;
    *) warn "could not read billing for $PROJECT_ID; confirm it in the console" ;;
  esac

  # What the deploy will do needs these permissions; testIamPermissions answers for the caller only.
  token="$(gcloud auth print-access-token 2>/dev/null || true)"
  perms='"serviceusage.services.enable","iam.serviceAccounts.create","resourcemanager.projects.setIamPolicy","run.jobs.create","cloudscheduler.jobs.create","secretmanager.secrets.create","cloudbuild.builds.create","artifactregistry.repositories.create","datastore.databases.create"'
  if [ -n "$token" ]; then
    answer="$(curl -sS --max-time 20 -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
      -d "{\"permissions\":[$perms]}" \
      "https://cloudresourcemanager.googleapis.com/v1/projects/$PROJECT_ID:testIamPermissions" 2>/dev/null || true)"
    missing=""
    IFS=',' read -ra wanted <<<"${perms//\"/}"
    for p in "${wanted[@]}"; do
      case "$answer" in *"\"$p\""*) ;; *) missing="$missing $p" ;; esac
    done
    case "$answer" in
      *'"permissions"'*)
        if [ -z "$missing" ]; then ok "you hold every permission the deploy uses on $PROJECT_ID"
        else warn "not seen in your permissions on $PROJECT_ID:$missing (Owner covers all; a narrower role may still work)"; fi ;;
      *) warn "could not read your permissions on $PROJECT_ID (the Resource Manager API may be off); Owner is the easy way" ;;
    esac
  else
    warn "no access token, so your permissions on $PROJECT_ID were not checked"
  fi

  # Informational: is this a first deploy or a redeploy?
  if gcloud firestore databases describe --database="$STARFISH_DATABASE_ID" --project="$PROJECT_ID" >/dev/null 2>&1; then
    ok "Firestore database '$STARFISH_DATABASE_ID' already exists (the deploy keeps it)"
  else
    ok "Firestore database '$STARFISH_DATABASE_ID' does not exist yet (the deploy creates it)"
  fi
  if gcloud run jobs describe "$JOB_NAME" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    ok "Cloud Run job '$JOB_NAME' exists: this deploy updates it"
  else
    ok "Cloud Run job '$JOB_NAME' does not exist yet: this is a first deploy"
  fi
  if gcloud scheduler jobs describe "$SCHEDULER_JOB_NAME" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    ok "Scheduler job '$SCHEDULER_JOB_NAME' exists: the deploy updates its schedule"
  fi
fi
if [ "$WATCHED_PROJECT_ID" != "$PROJECT_ID" ]; then check_project "Watched" "$WATCHED_PROJECT_ID" || true; fi
if [ "$VERTEX_PROJECT_ID" != "$PROJECT_ID" ]; then check_project "Gemini" "$VERTEX_PROJECT_ID" || true; fi

# ---- things only you can do in the console
warn "not checkable from here, see docs/setup.md: Firebase Auth turned on (Get started), Anonymous sign-in decision, Gemini model access in $REGION"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "No blockers found. Next: scripts/deploy-gcp.sh"
else
  echo "$FAILS blocker(s). Fix the FAIL lines, then run this again."
  exit 1
fi
