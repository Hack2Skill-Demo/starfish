#!/usr/bin/env bash
# Change how often the deployed ingest runs, for recording the demo, and put it back; or run it once, now (#65).
#
#   PROJECT_ID=my-project scripts/ingest-cadence.sh status       # the current schedule and lag
#   PROJECT_ID=my-project scripts/ingest-cadence.sh recording    # tick every minute (RECORDING_SCHEDULE)
#   PROJECT_ID=my-project scripts/ingest-cadence.sh restore      # back to NORMAL_SCHEDULE
#   PROJECT_ID=my-project scripts/ingest-cadence.sh now          # one run of the job right now
#   DRY_RUN=1 PROJECT_ID=my-project scripts/ingest-cadence.sh recording    # print every command, change nothing
#
# Same variables as scripts/deploy-gcp.sh (PROJECT_ID, REGION, JOB_NAME, SCHEDULER_JOB_NAME), plus
#   RECORDING_SCHEDULE   cron for `recording`. Default "* * * * *" (every minute)
#   NORMAL_SCHEDULE      cron for `restore`. Default "0 * * * *", the deploy script's default: pass the SCHEDULE you
#                        deployed with if it was different. Nothing is remembered between the two calls
#   RECORDING_LAG_MINUTES / NORMAL_LAG_MINUTES
#                        optional. Set STARFISH_INGEST_LAG_MINUTES on the job (`recording` / `restore`). Unset = the
#                        lag is not touched. READ THIS BEFORE USING IT: a window ends this many minutes behind real
#                        time because Cloud Logging indexes entries late, and a window is read once, so a lag shorter
#                        than the indexing delay can lose an occurrence for good. A fault appears in the store after
#                        about (lag + tick); with the default lag of 5 minutes, a one-minute tick does not make it
#                        "about a minute", only a shorter lag does
#
# `now` runs the same job a schedule tick would (same windows, checkpoint and last-run record), so two runs started
# together converge instead of double-counting (scenario ING-13). It is NOT the admin-only, audited trigger #65 asks
# for: whoever holds roles/run.developer on the job can do this. That trigger is the admin API's POST /api/ingest/run
# (src/adminApi.ts over src/ingest/trigger.ts; DEPLOY_ADMIN_API=1 in scripts/deploy-gcp.sh): built and tested, never
# deployed.
# Needs: gcloud, and roles to update the Scheduler job (`recording`/`restore`) or run the Cloud Run job (`now`).
set -euo pipefail

MODE="${1:-}"
PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
JOB_NAME="${JOB_NAME:-starfish-ingest}"
SCHEDULER_JOB_NAME="${SCHEDULER_JOB_NAME:-$JOB_NAME-tick}"
RECORDING_SCHEDULE="${RECORDING_SCHEDULE:-* * * * *}"
NORMAL_SCHEDULE="${NORMAL_SCHEDULE:-0 * * * *}"
RECORDING_LAG_MINUTES="${RECORDING_LAG_MINUTES:-}"
NORMAL_LAG_MINUTES="${NORMAL_LAG_MINUTES:-}"
DRY_RUN="${DRY_RUN:-0}"

die() { echo "ingest-cadence: $*" >&2; exit 1; }
[ -n "$PROJECT_ID" ] || die "PROJECT_ID is required"
case "$MODE" in status|recording|restore|now) ;; *) die "usage: ingest-cadence.sh status|recording|restore|now" ;; esac

# A cron is five fields of cron characters: it goes into a command line, and a bad one must fail here, not in the job.
valid_cron() {
  case "$1" in *[!0-9*/,\ -]*) return 1 ;; esac
  local fields
  read -r -a fields <<< "$1"   # not `set -- $1`: an unquoted * would expand to file names
  [ "${#fields[@]}" -eq 5 ]
}
valid_lag() { case "$1" in ''|*[!0-9.]*|.*|*.|*.*.*) return 1 ;; esac; [ "$1" != "0" ]; }
valid_cron "$RECORDING_SCHEDULE" || die "RECORDING_SCHEDULE must be a five-field cron: $RECORDING_SCHEDULE"
valid_cron "$NORMAL_SCHEDULE" || die "NORMAL_SCHEDULE must be a five-field cron: $NORMAL_SCHEDULE"
[ -z "$RECORDING_LAG_MINUTES" ] || valid_lag "$RECORDING_LAG_MINUTES" || die "RECORDING_LAG_MINUTES must be a positive number"
[ -z "$NORMAL_LAG_MINUTES" ] || valid_lag "$NORMAL_LAG_MINUTES" || die "NORMAL_LAG_MINUTES must be a positive number"

step() { printf '\n== %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

set_schedule() { # set_schedule <cron> [lag minutes]
  step "Cloud Scheduler '$SCHEDULER_JOB_NAME': $1"
  run gcloud scheduler jobs update http "$SCHEDULER_JOB_NAME" --project="$PROJECT_ID" --location="$REGION" --schedule="$1"
  # The job is told its schedule (so the UI can say when the next run is expected, #38), and the lag when one is given.
  local env="STARFISH_INGEST_SCHEDULE=$1"
  [ -z "${2:-}" ] || env="$env@STARFISH_INGEST_LAG_MINUTES=$2"
  step "Job '$JOB_NAME': ${env//@/, }"
  run gcloud run jobs update "$JOB_NAME" --project="$PROJECT_ID" --region="$REGION" \
    --update-env-vars="^@^$env"
}

case "$MODE" in
  status)
    step "Schedule"
    run gcloud scheduler jobs describe "$SCHEDULER_JOB_NAME" --project="$PROJECT_ID" --location="$REGION" \
      --format='value(schedule,timeZone,state)'
    step "Job environment (STARFISH_INGEST_LAG_MINUTES is absent when the default of 5 applies)"
    run gcloud run jobs describe "$JOB_NAME" --project="$PROJECT_ID" --region="$REGION" \
      --format='value(spec.template.spec.template.spec.containers[0].env)'
    ;;
  recording)
    set_schedule "$RECORDING_SCHEDULE" "$RECORDING_LAG_MINUTES"
    echo
    echo "Recording mode is ON: ingest ticks on '$RECORDING_SCHEDULE'. Put it back afterwards with:"
    echo "  PROJECT_ID=$PROJECT_ID NORMAL_SCHEDULE='$NORMAL_SCHEDULE'${RECORDING_LAG_MINUTES:+ NORMAL_LAG_MINUTES=<the lag you deployed with>} scripts/ingest-cadence.sh restore"
    ;;
  restore)
    set_schedule "$NORMAL_SCHEDULE" "$NORMAL_LAG_MINUTES"
    ;;
  now)
    step "One run of '$JOB_NAME' now"
    run gcloud run jobs execute "$JOB_NAME" --project="$PROJECT_ID" --region="$REGION" --wait
    ;;
esac
