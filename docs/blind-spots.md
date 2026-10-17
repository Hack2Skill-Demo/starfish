# Known blind spot: logs are not the only signal

> Moved from the README (#391).

Ingestion reads Cloud Logging only. The production pipeline this ingest is adapted from found that
Firebase **gen2** (Cloud Run) functions can fail without emitting an ERROR-severity log at
all: a log-only reader then reports "no errors" while Cloud Monitoring still counts the
failed invocations. The fix there was a second, Monitoring-derived source feeding the same
store.

Starfish now has that second source (#19), **built, tested against fakes only, off by default, and
never run against real Cloud Monitoring** (`STARFISH_MONITORING_ENABLED=false`). Turned on, each ingest
window also reads the watched project's failure metrics (`src/ingest/monitoring.ts`): 5xx responses
from `run.googleapis.com/request_count` (Cloud Run, gen2 functions) and non-ok executions from
`cloudfunctions.googleapis.com/function/execution_count` (gen1), one bounded count per function, each
with its metric, resource type, project and observation window. A function that also logged an
ERROR in that window has its log incidents annotated (`monitoringCount`); one that did not gets a
**Monitoring-only incident** (`signalSource: monitoring`), fingerprinted in a namespace of its own so it
never merges with a log-derived one. A Monitoring read that fails is recorded as unavailable
(`last_run.monitoring.unavailableWindows`), never as zero failures, and that window is not re-read: a
retry would need the window's log incidents to correlate against, and the store's replay guard is per window
and fingerprint for occurrences and readings together, so re-reading one signal alone would either count the
logs twice or drop the annotation.
Triage never declines a Monitoring-only incident because its log counter-check is zero, and never lets
one become `act` without cause evidence on the incident (a cause or a stack trace, which a count of
failures does not carry): it goes to a human (`notify`) instead. Enabling it needs
`roles/monitoring.viewer` on the watched project, which `scripts/deploy-gcp.sh` grants only when run with
`STARFISH_MONITORING_ENABLED=true` (dry-run tested; never run). The Incidents page and the evidence page
badge a Monitoring-only incident and show `monitoringCount` and the latest window's readings (provenance and
count). With it off, which is every deployment today, a clean
ingest run still means *no logged errors*, not *no errors*.

One failure is folded on purpose: a **project-level Cloud Run quota rejection** ("the project exceeded its quota
limit for run.googleapis.com/cpu_allocation", which Google's front end returns for every function at once, often
while a deploy rolls many revisions). Keyed by function, one such event opened one incident per function. Ingest now
folds them into one incident per quota metric (`signalSource: platform-quota`, a fingerprint namespace of its own,
`src/ingest/platformQuota.ts`) whose detail lists the functions it hit; with Monitoring on, those functions'
failure counts in that window annotate it instead of opening a Monitoring-only incident each. Triage hands it to a
person without asking the model, since no code change fixes a quota. A "no available instance" abort is not folded:
it can be one function's real saturation. Unit-tested against a fake Logging; not yet seen on a real project.
