#!/bin/sh
# The engine image's entrypoint. Everything runs as the unprivileged user `node`, EXCEPT the verify runner
# (src/verifyRunnerCli.ts, #74), which starts as root on purpose: it hands the target repository's command to
# another unprivileged user (uid 65534) so that the command cannot read the runner's memory or its environment,
# where the URL the result is written to is held. Cloud Run's `--args` replaces the CMD and keeps this entrypoint;
# `--command` would replace it, so the deploy script never uses it.
set -eu
case "$*" in
  *verifyRunnerCli*)
    exec "$@"
    ;;
  *)
    HOME=/home/node exec setpriv --reuid=node --regid=node --init-groups -- "$@"
    ;;
esac
