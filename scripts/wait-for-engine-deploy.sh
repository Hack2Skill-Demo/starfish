#!/usr/bin/env bash
# Let the web deploy go second when the same push also starts the engine deploy (#373).
#
# A push to main that changes firestore.rules and the UI starts `Deploy engine` and `Deploy web UI` at the same moment, in
# separate concurrency groups. The engine deploy is what publishes the rules; the web deploy refuses to build while the
# live rules differ from the repository's (scripts/deploy-web.sh, #262). Without an order, the web job checks first and fails.
#
#   GH_TOKEN=... REPO=owner/name SHA=<commit> scripts/wait-for-engine-deploy.sh
#
#   REPO              the repository (github.repository). Required.
#   SHA               the pushed commit (github.sha). Required.
#   ENGINE_WORKFLOW   the engine deploy's workflow file. Default deploy.yml
#   APPEAR_SECONDS    how long to wait for an engine run for this commit to exist before deciding the push did not
#                     start one (a push that touches no engine path, or deploy-on-merge off, starts none). Default 90
#   WAIT_SECONDS      how long to wait for that run to finish. Default 1200: the engine deploy took about 3.5 minutes on the
#                     demo project, but it may first wait for a reviewer to approve the `deploy` environment
#   POLL_SECONDS      Default 15
#
# This only orders the two; it is never the gate. It exits 0 whatever it finds (no run, a run that failed or was
# skipped, a timeout, an API that cannot be read), saying so, and the web deploy's own rules check then decides from
# what is actually live: a failed engine run that did publish the rules does not block the UI, and one that did not
# is stopped there, in words that say to run the engine deploy. Needs `gh` and a token that may read the repository's
# Actions runs (`actions: read`). Tested against a stub `gh`; never run on GitHub.
set -euo pipefail

REPO="${REPO:-}"
SHA="${SHA:-}"
ENGINE_WORKFLOW="${ENGINE_WORKFLOW:-deploy.yml}"
APPEAR_SECONDS="${APPEAR_SECONDS:-90}"
WAIT_SECONDS="${WAIT_SECONDS:-1200}"
POLL_SECONDS="${POLL_SECONDS:-15}"

die() { echo "wait-for-engine-deploy: $*" >&2; exit 1; }
[ -n "$REPO" ] || die "REPO is required"
[ -n "$SHA" ] || die "SHA is required"
case "$REPO" in */*) ;; *) die "REPO must be owner/name" ;; esac
case "$SHA" in *[!0-9a-f]*) die "SHA must be a commit hash" ;; esac
case "$ENGINE_WORKFLOW" in *[!A-Za-z0-9._-]*) die "ENGINE_WORKFLOW must be a plain workflow file name" ;; esac
for n in "$APPEAR_SECONDS" "$WAIT_SECONDS" "$POLL_SECONDS"; do
  case "$n" in ''|*[!0-9]*) die "the three durations must be whole numbers of seconds" ;; esac
done

# "<status> <conclusion>" of the newest engine run for this commit; empty when there is none, "unreadable" when gh failed.
engine_run() {
  local out
  out="$(gh api "repos/$REPO/actions/workflows/$ENGINE_WORKFLOW/runs?head_sha=$SHA&event=push&per_page=5" \
    --jq '.workflow_runs[0] | select(. != null) | "\(.status) \(.conclusion // "none")"' 2>/dev/null)" || { echo unreadable; return; }
  echo "$out"
}

started=$SECONDS
seen=""
while :; do
  state="$(engine_run)"
  elapsed=$((SECONDS - started))
  case "$state" in
    "completed "*)
      conclusion="${state#completed }"
      case "$conclusion" in
        success) echo "wait-for-engine-deploy: Deploy engine finished for $SHA; its rules and indexes are published." ;;
        skipped) echo "wait-for-engine-deploy: Deploy engine was skipped for $SHA (deploy-on-merge is off?); the rules check below decides." ;;
        *) echo "::warning::Deploy engine ended '$conclusion' for $SHA. The rules check below decides whether the live rules are this commit's." ;;
      esac
      exit 0
      ;;
    "")
      # No run: either this push starts none, or it has not appeared yet.
      if [ "$elapsed" -ge "$APPEAR_SECONDS" ]; then
        echo "wait-for-engine-deploy: no Deploy engine run for $SHA after ${elapsed}s: this push does not start one. Not waiting."
        exit 0
      fi
      ;;
    unreadable)
      if [ "$elapsed" -ge "$APPEAR_SECONDS" ] && [ -z "$seen" ]; then
        echo "::warning::could not read the Deploy engine runs for $SHA. Not waiting; the rules check below decides."
        exit 0
      fi
      ;;
    *)
      [ -n "$seen" ] || echo "wait-for-engine-deploy: Deploy engine is running for $SHA ($state); waiting for it, up to ${WAIT_SECONDS}s."
      seen=1
      ;;
  esac
  if [ -n "$seen" ] && [ "$elapsed" -ge "$WAIT_SECONDS" ]; then
    echo "::warning::Deploy engine had not finished for $SHA after ${elapsed}s. Going on; the rules check below decides."
    exit 0
  fi
  sleep "$POLL_SECONDS"
done
