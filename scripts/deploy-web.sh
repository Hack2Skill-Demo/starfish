#!/usr/bin/env bash
# Build the operator UI and deploy it to its own Firebase Hosting site (#12). Idempotent.
#
#   PROJECT_ID=my-project scripts/deploy-web.sh
#   DRY_RUN=1 PROJECT_ID=my-project scripts/deploy-web.sh     # print every command, change nothing
#
#   PROJECT_ID            (required) the Firebase/GCP project the UI connects to
#   HOSTING_SITE          the Hosting site to deploy to. Default <PROJECT_ID>-starfish: its OWN site, so the
#                         watched app (or the demo app sharing this project) keeps the default one
#   STARFISH_ENV          the environment label the UI shows until settings say otherwise. Default dev
#   STARFISH_DATABASE_ID  the named database the UI reads. Default starfish
#   VITE_*                any other web setting (web/.env.example) is passed to the build as it is
#   DRY_RUN=1             print the commands instead of running them
#
# The bundle carries no Firebase project: at startup it reads /__/firebase/init.json, which Hosting serves
# for the project, so this build can be served from any project. That needs a Firebase *web app* registered
# in the project; this script registers one named "starfish" if there is none.
#
# Needs: `firebase login` (or Application Default Credentials in CI), and pnpm. Does NOT turn on Anonymous
# sign-in: that is project-wide, so it is a decision for a person (docs/setup.md).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
HOSTING_SITE="${HOSTING_SITE:-${PROJECT_ID:+$PROJECT_ID-starfish}}"
STARFISH_ENV="${STARFISH_ENV:-dev}"
STARFISH_DATABASE_ID="${STARFISH_DATABASE_ID:-starfish}"
DRY_RUN="${DRY_RUN:-0}"

die() { echo "deploy-web: $*" >&2; exit 1; }
[ -n "$PROJECT_ID" ] || die "PROJECT_ID is required"
[ "$STARFISH_DATABASE_ID" != "(default)" ] || die "the UI must read Starfish's own database, not (default)"
case "$HOSTING_SITE" in
  *[!a-z0-9-]*|-*|*-) die "HOSTING_SITE must be lowercase letters, digits and hyphens, not starting or ending with one: $HOSTING_SITE" ;;
esac

step() { printf '\n== %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
FIREBASE=(pnpm dlx firebase-tools@14)

step "Build the UI (environment label: $STARFISH_ENV)"
run env "VITE_STARFISH_ENV=${VITE_STARFISH_ENV:-$STARFISH_ENV}" "VITE_STARFISH_DATABASE_ID=${VITE_STARFISH_DATABASE_ID:-$STARFISH_DATABASE_ID}" pnpm run build

step "A Firebase web app, so Hosting can serve /__/firebase/init.json"
APP_ID=""
if [ "$DRY_RUN" = "1" ]; then
  echo "+ ${FIREBASE[*]} apps:list WEB --json --project $PROJECT_ID   (create one named starfish if the list is empty)"
  APP_ID="<web-app-id>"
else
  list="$("${FIREBASE[@]}" apps:list WEB --json --project "$PROJECT_ID")"
  APP_ID="$(printf '%s' "$list" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result||[];console.log(r[0]?r[0].appId:"")})')"
  if [ -z "$APP_ID" ]; then
    created="$("${FIREBASE[@]}" apps:create WEB starfish --json --project "$PROJECT_ID")"
    APP_ID="$(printf '%s' "$created" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log((JSON.parse(s).result||{}).appId||"")})')"
  fi
  [ -n "$APP_ID" ] || die "could not find or create a Firebase web app in $PROJECT_ID"
fi

step "Hosting site $HOSTING_SITE"
if [ "$DRY_RUN" = "1" ]; then
  echo "+ ${FIREBASE[*]} hosting:sites:get $HOSTING_SITE --project $PROJECT_ID   (create it if missing)"
  run "${FIREBASE[@]}" hosting:sites:create "$HOSTING_SITE" --app "$APP_ID" --project "$PROJECT_ID"
elif ! "${FIREBASE[@]}" hosting:sites:get "$HOSTING_SITE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  run "${FIREBASE[@]}" hosting:sites:create "$HOSTING_SITE" --app "$APP_ID" --project "$PROJECT_ID"
else
  echo "  (exists)"
fi

step "Deploy"
# firebase.json calls the target "starfish"; this points it at the site (written to .firebaserc, not committed).
run "${FIREBASE[@]}" target:apply hosting starfish "$HOSTING_SITE" --project "$PROJECT_ID"
run "${FIREBASE[@]}" deploy --only hosting:starfish --project "$PROJECT_ID"

step "Done"
if [ "$DRY_RUN" = "1" ]; then echo "Dry run: nothing was changed."; else echo "Live at https://$HOSTING_SITE.web.app"; fi
