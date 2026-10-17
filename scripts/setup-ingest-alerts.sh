#!/usr/bin/env bash
# External alerts for the scheduled ingest (#387): one for a job that has stopped succeeding, one for a checkpoint that
# falls behind. Neither depends on the ingest job or on the web uptime check (scripts/deploy-web.sh, UPTIME_CHECK=1),
# which only proves Hosting serves the UI: a healthy site does not quiet them.
#
#   PROJECT_ID=my-project INGEST_ALERT_NOTIFICATION_CHANNELS=projects/my-project/notificationChannels/123 \
#     scripts/setup-ingest-alerts.sh
#   DRY_RUN=1 PROJECT_ID=my-project scripts/setup-ingest-alerts.sh      # print every command and policy, change nothing
#
#   PROJECT_ID            the project the ingest job runs in (the same as scripts/deploy-gcp.sh). Required
#   JOB_NAME              the ingest Cloud Run job. Default starfish-ingest
#   INGEST_ALERT_MISSED_MINUTES  alert when the job has had no SUCCESSFUL execution for this long. Cloud Monitoring's own
#                         metric for Cloud Run job executions (run.googleapis.com/job/completed_execution_count, result
#                         succeeded), read by Google, not by the job: it covers a job that never starts (the scheduler
#                         paused or failing, the job deleted or mis-deployed), one killed before it records anything, and
#                         one that exits non-zero every time. Default 180 (three hourly ticks); 5 to 1410, Monitoring's
#                         longest absence window is 23.5 hours. Set it to about three times SCHEDULE
#   INGEST_ALERT_LAG_MINUTES  alert when a run leaves the checkpoint further than this behind the newest logs it could
#                         read (`lagSeconds`, src/ingest/run.ts; the run prints it as one structured line,
#                         src/ingest/lagLog.ts, which a log-based metric reads). The case of a run that records ok while
#                         it falls behind under a flood (#297). Default 120. Independent of the UI's own "behind" threshold
#                         (STARFISH_INGEST_BEHIND_MINUTES), which it does not read
#   INGEST_ALERT_NOTIFICATION_CHANNELS  optional: comma-separated notification channels, projects/<p>/notificationChannels/<id>
#                         (Monitoring -> Alerting -> Edit notification channels: email, Slack, SMS, PagerDuty). Without one
#                         the alerts still open incidents in the console and notify nobody: this script says so
#
# Each policy, and the log-based metric, is created only if none with its name exists (the names carry the job, not the
# thresholds), so it is safe to re-run; it never changes or deletes one that does: change a threshold by editing the
# policy in the console, or delete the policy and re-run with the new value.
# Needs `gcloud` signed in, `curl`, `node`, and on PROJECT_ID roles/monitoring.alertPolicyEditor and
# roles/logging.configWriter: the Actions deployer holds neither (scripts/setup-github-deploy.sh), so this is run by a person.
#
# What it cannot do, so it does not claim to:
#   - A Monitoring absence condition only fires for a series that has reported before. A job that has NEVER succeeded in
#     this project raises nothing from the missed-run policy; and after a long stop, once the series is more than a day
#     old, the policy goes quiet again. Run the ingest once (scripts/smoke-gcp.sh does) before relying on it.
#   - The lag policy sees a run's lag only when a run prints it: a job that stops running is the missed-run policy's case.
#   - Cost: a user-defined log-based metric is chargeable under Cloud Monitoring's pricing beyond its free monthly
#     allotment (one small data point per run); alert policies are not. That is why this is a script a person runs.
# Written and dry-run tested against stubs; the metric and filter names are from Google's documentation. Never run
# against Google: see docs/deploy.md ("Alerting on a stopped ingest").
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
JOB_NAME="${JOB_NAME:-starfish-ingest}"
INGEST_ALERT_MISSED_MINUTES="${INGEST_ALERT_MISSED_MINUTES:-180}"
INGEST_ALERT_LAG_MINUTES="${INGEST_ALERT_LAG_MINUTES:-120}"
INGEST_ALERT_NOTIFICATION_CHANNELS="${INGEST_ALERT_NOTIFICATION_CHANNELS:-}"
DRY_RUN="${DRY_RUN:-0}"

die() { echo "setup-ingest-alerts: $*" >&2; exit 1; }
[ -n "$PROJECT_ID" ] || die "PROJECT_ID is required"
[[ "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "PROJECT_ID is not a project id: $PROJECT_ID"
# Both go into a Monitoring filter, a policy name and a metric name.
[[ "$JOB_NAME" =~ ^[a-z][a-z0-9-]{0,48}[a-z0-9]$ ]] || die "JOB_NAME must be a Cloud Run job name (lowercase letters, digits, hyphens): $JOB_NAME"
whole() { case "$2" in ''|*[!0-9]*) die "$1 must be a whole number of minutes: $2" ;; esac; }
whole INGEST_ALERT_MISSED_MINUTES "$INGEST_ALERT_MISSED_MINUTES"
whole INGEST_ALERT_LAG_MINUTES "$INGEST_ALERT_LAG_MINUTES"
{ [ "$INGEST_ALERT_MISSED_MINUTES" -ge 5 ] && [ "$INGEST_ALERT_MISSED_MINUTES" -le 1410 ]; } \
  || die "INGEST_ALERT_MISSED_MINUTES must be 5 to 1410 (Cloud Monitoring's longest absence window is 23.5 hours): $INGEST_ALERT_MISSED_MINUTES"
[ "$INGEST_ALERT_LAG_MINUTES" -ge 1 ] || die "INGEST_ALERT_LAG_MINUTES must be at least 1"
CHANNELS_JSON=""
if [ -n "$INGEST_ALERT_NOTIFICATION_CHANNELS" ]; then
  IFS=',' read -r -a CHANNELS <<< "$INGEST_ALERT_NOTIFICATION_CHANNELS"
  for c in "${CHANNELS[@]}"; do
    [[ "$c" =~ ^projects/[a-z0-9-]+/notificationChannels/[0-9]+$ ]] \
      || die "INGEST_ALERT_NOTIFICATION_CHANNELS takes projects/<p>/notificationChannels/<id>, comma-separated: $c"
  done
  CHANNELS_JSON="\"$(printf '%s' "$INGEST_ALERT_NOTIFICATION_CHANNELS" | sed 's/,/","/g')\""
fi

step() { printf '\n== %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

METRIC_NAME="starfish_ingest_checkpoint_lag_seconds"
# The line src/ingest/lagLog.ts prints; the test pins that these two are the same string.
CHECKPOINT_MESSAGE="starfish ingest checkpoint"
MISSED_POLICY="starfish ingest: no successful run ($JOB_NAME)"
LAG_POLICY="starfish ingest: checkpoint behind ($JOB_NAME)"
POLICIES_URL="https://monitoring.googleapis.com/v3/projects/$PROJECT_ID/alertPolicies"

MISSED_JSON="$(cat <<JSON
{"displayName":"$MISSED_POLICY","combiner":"OR","notificationChannels":[$CHANNELS_JSON],
"documentation":{"mimeType":"text/markdown","content":"The Starfish ingest job $JOB_NAME has had no successful execution for $INGEST_ALERT_MISSED_MINUTES minutes, so no new errors reach the incident store. Check, in order: the Cloud Scheduler job ($JOB_NAME-tick) is enabled and its last attempt succeeded; the job's latest executions in Cloud Run (a failure names its reason in the log); then run \`pnpm status\`. Recovery is by itself: the next successful run reads the windows it missed from its checkpoint, nothing is lost, and this alert closes (docs/deploy.md)."},
"conditions":[{"displayName":"No successful execution of $JOB_NAME","conditionAbsent":{
"filter":"metric.type=\"run.googleapis.com/job/completed_execution_count\" AND resource.type=\"cloud_run_job\" AND resource.label.job_name=\"$JOB_NAME\" AND metric.label.result=\"succeeded\"",
"aggregations":[{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_SUM","crossSeriesReducer":"REDUCE_SUM"}],
"duration":"$((INGEST_ALERT_MISSED_MINUTES * 60))s","trigger":{"count":1}}}]}
JSON
)"

LAG_JSON="$(cat <<JSON
{"displayName":"$LAG_POLICY","combiner":"OR","notificationChannels":[$CHANNELS_JSON],
"documentation":{"mimeType":"text/markdown","content":"A Starfish ingest run left its checkpoint more than $INGEST_ALERT_LAG_MINUTES minutes behind the newest logs it could read: the job runs, but is not keeping up (usually a flood of errors; each run then narrows its window). New errors reach the store late. See the UI's engine line, \`pnpm status\`, and last_run.lagSeconds (docs/deploy.md). It closes by itself when a run leaves the checkpoint closer than the threshold."},
"conditions":[{"displayName":"Checkpoint behind by more than $INGEST_ALERT_LAG_MINUTES min","conditionThreshold":{
"filter":"metric.type=\"logging.googleapis.com/user/$METRIC_NAME\" AND resource.type=\"cloud_run_job\" AND resource.label.job_name=\"$JOB_NAME\"",
"aggregations":[{"alignmentPeriod":"600s","perSeriesAligner":"ALIGN_PERCENTILE_99","crossSeriesReducer":"REDUCE_MAX"}],
"comparison":"COMPARISON_GT","thresholdValue":$((INGEST_ALERT_LAG_MINUTES * 60)),"duration":"0s","trigger":{"count":1}}}],
"alertStrategy":{"autoClose":"86400s"}}
JSON
)"

METRIC_JSON="$(cat <<JSON
{"name":"$METRIC_NAME","description":"How far behind the newest readable logs the Starfish ingest left its checkpoint, per run (src/ingest/lagLog.ts)",
"filter":"resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$JOB_NAME\" AND jsonPayload.message=\"$CHECKPOINT_MESSAGE\"",
"valueExtractor":"EXTRACT(jsonPayload.ingestCheckpointLagSeconds)",
"metricDescriptor":{"metricKind":"DELTA","valueType":"DISTRIBUTION","unit":"s"},
"bucketOptions":{"exponentialBuckets":{"numFiniteBuckets":32,"growthFactor":2,"scale":1}}}
JSON
)"

step "Log-based metric '$METRIC_NAME' (the checkpoint lag each run prints)"
run gcloud services enable monitoring.googleapis.com logging.googleapis.com --project="$PROJECT_ID"
if [ "$DRY_RUN" = "1" ]; then
  echo "+ gcloud logging metrics create $METRIC_NAME --project=$PROJECT_ID --config-from-file=<the metric below>"
  printf '%s\n' "$METRIC_JSON"
elif gcloud logging metrics describe "$METRIC_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "  (log-based metric exists: $METRIC_NAME)"
else
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  printf '%s\n' "$METRIC_JSON" > "$tmp"
  gcloud logging metrics create "$METRIC_NAME" --project="$PROJECT_ID" --config-from-file="$tmp" \
    || die "could not create the log-based metric (roles/logging.configWriter on $PROJECT_ID); create it in the console (docs/deploy.md)"
fi

step "Alert policies on $PROJECT_ID"
if [ "$DRY_RUN" = "1" ]; then
  for json in "$MISSED_JSON" "$LAG_JSON"; do
    echo "+ curl -X POST -H 'Authorization: Bearer <gcloud access token>' -H 'x-goog-user-project: $PROJECT_ID' $POLICIES_URL"
    printf '%s\n' "$json"
  done
else
  token="$(gcloud auth print-access-token 2>/dev/null || gcloud auth application-default print-access-token 2>/dev/null)" \
    || die "the alert policies need an access token from gcloud; or create them in the console (docs/deploy.md)"
  # The token goes in on stdin (-H @-), never in curl's argv. The names of the policies there already are (pageSize caps the read).
  existing="$(printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -H @- -H "x-goog-user-project: $PROJECT_ID" \
    "$POLICIES_URL?pageSize=1000" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);for(const p of v.alertPolicies||[])console.log(p.displayName)})')" \
    || die "could not list the alert policies of $PROJECT_ID"
  for pair in "$MISSED_POLICY|$MISSED_JSON" "$LAG_POLICY|$LAG_JSON"; do
    name="${pair%%|*}"; json="${pair#*|}"
    if printf '%s\n' "$existing" | grep -Fxq "$name"; then
      echo "  (alert policy exists: $name)"
    else
      printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -X POST -H @- -H "x-goog-user-project: $PROJECT_ID" \
        -H "Content-Type: application/json" -d "$json" "$POLICIES_URL" >/dev/null \
        || die "could not create the alert policy '$name' (roles/monitoring.alertPolicyEditor on $PROJECT_ID); create it in the console (docs/deploy.md)"
      echo "  created: $name"
    fi
  done
fi
[ -n "$INGEST_ALERT_NOTIFICATION_CHANNELS" ] || echo "  (no INGEST_ALERT_NOTIFICATION_CHANNELS: the alerts open incidents in the console and notify nobody)"

step "Done"
if [ "$DRY_RUN" = "1" ]; then echo "Dry run: nothing was changed."; fi
echo "Check it: Monitoring -> Alerting shows both policies; stop the scheduler job (gcloud scheduler jobs pause $JOB_NAME-tick) past $INGEST_ALERT_MISSED_MINUTES minutes, or lower the threshold to see it fire (docs/deploy.md)."
