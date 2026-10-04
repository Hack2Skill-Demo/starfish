#!/usr/bin/env bash
# Prove the deployed ingest works end to end, with no demo app: plant ONE error in the watched project's
# Cloud Logging, run the job, and check that the engine recorded a run and an incident for it.
#
#   PROJECT_ID=my-project scripts/smoke-gcp.sh
#   DRY_RUN=1 PROJECT_ID=my-project scripts/smoke-gcp.sh      # print every command, change nothing
#
# Same variables as scripts/deploy-gcp.sh (PROJECT_ID, REGION, WATCHED_PROJECT_ID, JOB_NAME), plus
#   SMOKE_WAIT_SECONDS   how long to wait before the run. Default 420: ingest windows end
#                        STARFISH_INGEST_LAG_MINUTES (default 5) behind real time, so an entry written now is not
#                        in any window for that long, plus a little for Cloud Logging to index it
#
#   SMOKE_ACTOR_UID      the uid of an ADMIN operator (pnpm grant-operator). Required: the planted incident is retired
#                        with it afterwards, audited, so no starfish-smoke incident is left in any list
#
# This WRITES: one ERROR log entry (named starfish-smoke) and, from it, one incident in the store, which the script
# retires afterwards (src/ingest/retire.ts). The check is of THAT incident (a starfish-smoke incident whose last
# occurrence is after the plant), so it holds on a project that has real errors of its own. If cleanup fails the
# script says which incident to delete and exits non-zero. STARFISH_ENV must be the label the job was deployed with
# (default dev). Do it before the public demo is shown, not during it.
# Needs: a deployed job, roles/logging.logWriter on the watched project, application-default credentials
# (gcloud auth application-default login) for the checks.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
WATCHED_PROJECT_ID="${WATCHED_PROJECT_ID:-$PROJECT_ID}"
JOB_NAME="${JOB_NAME:-starfish-ingest}"
SMOKE_WAIT_SECONDS="${SMOKE_WAIT_SECONDS:-420}"
SMOKE_ACTOR_UID="${SMOKE_ACTOR_UID:-}"
DRY_RUN="${DRY_RUN:-0}"

die() { echo "smoke-gcp: $*" >&2; exit 1; }
[ -n "$PROJECT_ID" ] || die "PROJECT_ID is required"
[ -n "$SMOKE_ACTOR_UID" ] || die "SMOKE_ACTOR_UID is required: the uid of an admin operator, used to retire the planted incident afterwards"
case "$SMOKE_ACTOR_UID" in *[!A-Za-z0-9_-]*) die "SMOKE_ACTOR_UID must be a plain uid" ;; esac
case "$SMOKE_WAIT_SECONDS" in ''|*[!0-9]*) die "SMOKE_WAIT_SECONDS must be a whole number of seconds" ;; esac

step() { printf '\n== %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

# Taken before the entry is written, so an incident from an earlier run (older occurrence) cannot satisfy the check.
PLANTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

step "Plant one error in $WATCHED_PROJECT_ID"
# resource.type cloud_function with a function_name label is what the ingest reads (src/ingest/parseLogEntry.ts).
run gcloud logging write starfish-smoke "Starfish smoke test: this error was planted on purpose by scripts/smoke-gcp.sh" \
  --severity=ERROR --project="$WATCHED_PROJECT_ID" \
  --monitored-resource-type=cloud_function \
  --monitored-resource-labels="project_id=$WATCHED_PROJECT_ID,function_name=starfish-smoke,region=$REGION"

step "Wait $SMOKE_WAIT_SECONDS s so the entry falls inside an ingest window"
if [ "$DRY_RUN" = "1" ]; then echo "+ sleep $SMOKE_WAIT_SECONDS"; else sleep "$SMOKE_WAIT_SECONDS"; fi

step "Run the job once and wait for it"
run gcloud run jobs execute "$JOB_NAME" --region="$REGION" --project="$PROJECT_ID" --wait

step "Is the engine alive, and did it read THIS error?"
# GOOGLE_CLOUD_PROJECT is how the engine's CLIs find the project; the rest of the engine's settings
# (STARFISH_ENV, STARFISH_DATABASE_ID, ...) come from the caller's environment, as for `pnpm ingest`.
# status: the last run is recent and ok. smoke-check: a starfish-smoke incident whose last occurrence is after
# the plant exists (so it is this entry, not any other), and then every live one is retired and read back.
run env "GOOGLE_CLOUD_PROJECT=$PROJECT_ID" pnpm status --stale-minutes 15
run env "GOOGLE_CLOUD_PROJECT=$PROJECT_ID" pnpm smoke-check --since "$PLANTED_AT" --cleanup --actor "$SMOKE_ACTOR_UID"

step "Done"
if [ "$DRY_RUN" = "1" ]; then echo "Dry run: nothing was changed."; else echo "Smoke test passed: the deployed ingest read the planted error into the store, and the incident was retired."; fi
