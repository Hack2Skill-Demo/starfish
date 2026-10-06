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
# for the site, so this build can be served from any project. On a site other than the project's default one that
# file carries the config of the Firebase *web app linked to the site*, so: a new site is created linked to the web
# app named "starfish" (registered if there is none); an existing site linked to no app is linked to it (Hosting REST
# sites.patch, which needs `gcloud`; not yet run on a real project); a site already linked is left as it is (#156).
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

# Prints one field of a Firebase CLI --json reply (its `result`, as r), or nothing; fails on a reply that is not JSON.
PICK='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s.slice(s.indexOf("{")))}catch{process.exit(2)}const x=new Function("r","return ("+process.argv[1]+")")(v.result);console.log(x==null?"":String(x))})'

# Sets APP_ID to Starfish's own web app: the one named "starfish", registered if there is none. Never another app
# in the project (the watched app's, say): a site is linked to the app this picks.
starfish_app() {
  local list
  if list="$("${FIREBASE[@]}" apps:list WEB --project "$PROJECT_ID" --json 2>/dev/null)"; then
    APP_ID="$(printf '%s' "$list" | node -e "$PICK" '((r || []).find(a => a.displayName === "starfish") || {}).appId')" \
      || die "could not read apps:list WEB"
  elif [ "$DRY_RUN" = "1" ]; then
    echo "  (could not list the project's web apps; planning as if none is named starfish)"
    APP_ID=""
  else
    die "could not list the web apps of $PROJECT_ID (firebase login?)"
  fi
  if [ -n "$APP_ID" ]; then echo "  (web app starfish: $APP_ID)"; return; fi
  if [ "$DRY_RUN" = "1" ]; then
    run "${FIREBASE[@]}" apps:create WEB starfish --project "$PROJECT_ID" --json
    APP_ID="<web-app-id>"
    return
  fi
  local created
  created="$("${FIREBASE[@]}" apps:create WEB starfish --project "$PROJECT_ID" --json)"
  APP_ID="$(printf '%s' "$created" | node -e "$PICK" 'r && r.appId')" || true
  [ -n "$APP_ID" ] || die "could not create a Firebase web app named starfish in $PROJECT_ID"
}

# Links the existing site to APP_ID. The Firebase CLI links a site only when it creates one (hosting:sites:create
# --app), so this is the Hosting REST API's sites.patch with updateMask=appId. Not yet run on a real project.
link_site() {
  local url="https://firebasehosting.googleapis.com/v1beta1/projects/$PROJECT_ID/sites/$HOSTING_SITE?updateMask=appId"
  local body="{\"appId\":\"$APP_ID\"}"
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ curl -X PATCH -H 'Authorization: Bearer <gcloud access token>' -H 'x-goog-user-project: $PROJECT_ID' -d '$body' $url"
    return
  fi
  local token
  token="$(gcloud auth print-access-token 2>/dev/null || gcloud auth application-default print-access-token 2>/dev/null)" \
    || die "linking $HOSTING_SITE needs an access token from gcloud; or link it in the console (docs/setup.md)"
  # The token goes in on stdin (-H @-), so it is never in curl's argv, which other users of the host can list.
  printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -X PATCH -H @- -H "x-goog-user-project: $PROJECT_ID" \
    -H "Content-Type: application/json" -d "$body" "$url" >/dev/null \
    || die "could not link $HOSTING_SITE to web app $APP_ID; link it in the console (docs/setup.md)"
  local linked
  linked="$("${FIREBASE[@]}" hosting:sites:get "$HOSTING_SITE" --project "$PROJECT_ID" --json 2>/dev/null | node -e "$PICK" 'r && r.appId')" || true
  [ "$linked" = "$APP_ID" ] || die "$HOSTING_SITE still is not linked to web app $APP_ID after the update; link it in the console (docs/setup.md)"
}

step "Hosting site $HOSTING_SITE"
# On a site that is not the project's default one, /__/firebase/init.json carries the config of the web app LINKED to
# that site; with none linked it has no appId and the UI refuses to start (#156). So an existing site is checked too,
# not only a new one. Reads change nothing, so a dry run makes them as well (when this shell can) and plans from them.
SITE_STATE=missing
SITE_APP=""
if site_json="$("${FIREBASE[@]}" hosting:sites:get "$HOSTING_SITE" --project "$PROJECT_ID" --json 2>/dev/null)"; then
  SITE_STATE=exists
  SITE_APP="$(printf '%s' "$site_json" | node -e "$PICK" 'r && r.appId')" || die "could not read hosting:sites:get $HOSTING_SITE"
elif [ "$DRY_RUN" = "1" ]; then
  echo "  (could not read the site: missing, or this shell is not signed in; planning as if missing)"
fi

if [ "$SITE_STATE" = "exists" ] && [ -n "$SITE_APP" ]; then
  # Linked already: leave it. Relinking would change what an existing site serves, and the link may be someone's choice.
  echo "  (exists, linked to web app $SITE_APP)"
else
  # Never link the project's default site: it is the watched app's, not Starfish's.
  [ "$HOSTING_SITE" != "$PROJECT_ID" ] || die "$HOSTING_SITE is the project's default Hosting site, which is not Starfish's; link it in the console if you mean to"
  step "Starfish's Firebase web app (named starfish), so Hosting can serve /__/firebase/init.json"
  starfish_app
  if [ "$SITE_STATE" = "missing" ]; then
    run "${FIREBASE[@]}" hosting:sites:create "$HOSTING_SITE" --app "$APP_ID" --project "$PROJECT_ID"
  else
    echo "  (exists, linked to no web app: linking $APP_ID)"
    link_site
  fi
fi

step "Deploy"
# firebase.json calls the target "starfish"; this points it at the site (written to .firebaserc, not committed).
run "${FIREBASE[@]}" target:apply hosting starfish "$HOSTING_SITE" --project "$PROJECT_ID"
run "${FIREBASE[@]}" deploy --only hosting:starfish --project "$PROJECT_ID"

step "Done"
if [ "$DRY_RUN" = "1" ]; then echo "Dry run: nothing was changed."; else echo "Live at https://$HOSTING_SITE.web.app"; fi
