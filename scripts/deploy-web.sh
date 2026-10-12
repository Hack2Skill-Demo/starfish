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
#   VITE_*                any other web setting (web/.env.example) is passed to the build as it is, among them:
#   VITE_STARFISH_ADMIN_API_URL  the admin API's URL (deploy-gcp.sh's DEPLOY_ADMIN_API=1 prints it): an admin then sees "Run
#                         ingest now" and "Retire". Unset or empty: both are hidden
#   VITE_STARFISH_STALE_MINUTES  how long after the last run the engine line says "stopped". Unset or empty: 90
#   VITE_STARFISH_DEMO_APP_URL  the public demo only: the watched demo app's Lab (https), linked from the Incidents page
#   VITE_STARFISH_DEMO_SIGNIN_HINT  the public demo only: where a visitor finds the sign-in details (never the
#                         credentials: it ships in the bundle). Unset or empty: a generic line
#   DRY_RUN=1             print the commands instead of running them
#   ALLOW_RULES_DRIFT=1   deploy even when the live Firestore rules of STARFISH_DATABASE_ID are not this repository's
#                         firestore.rules, or cannot be read (#262). Default: refuse, and say to run the engine deploy first
#   VITE_STARFISH_APPCHECK_SITE_KEY  optional: build the UI with Firebase App Check (#12; web/.env.example). This only
#                         makes the UI send tokens; turning ENFORCEMENT on is a separate, project-wide console step
#                         (docs/setup.md), deliberately not done here. A debug token (VITE_STARFISH_APPCHECK_DEBUG_TOKEN),
#                         in the environment or in web/.env*, is refused: it is a credential and would ship in the bundle
#   UPTIME_CHECK=1        also create a Cloud Monitoring uptime check on the site (https, every 5 minutes, the page that
#                         proves Hosting serves Starfish's config) and an alert policy that opens an incident when it
#                         fails. Each is created only if none with its name exists. Written and dry-run tested, never run
#   UPTIME_NOTIFICATION_CHANNELS  with UPTIME_CHECK=1, optional: comma-separated notification channels for the alert,
#                         projects/<p>/notificationChannels/<id> (create one in the console: Monitoring → Alerting →
#                         Edit notification channels). Without one the alert still opens incidents in the console, and
#                         notifies nobody
#
# The bundle carries no Firebase project: at startup it reads /__/firebase/init.json, which Hosting serves
# for the site, so this build can be served from any project. On a site other than the project's default one that
# file carries the config of the Firebase *web app linked to the site*, so: a new site is created linked to the web
# app named "starfish" (registered if there is none); an existing site linked to no app is linked to it (Hosting REST
# sites.patch, which needs `gcloud`; not yet run on a real project); a site already linked is left as it is (#156).
#
# The UI reads what firestore.rules allows and what firestore.indexes.json indexes, and a guest reads the trimmed copies
# the engine writes; this script deploys none of them (scripts/deploy-gcp.sh does). So before it builds, it compares the
# live rules release of Starfish's database with the repository's rules file (Firebase Rules REST API) and refuses when
# they differ or cannot be read, and warns about any composite index that is not READY yet (Firestore Admin REST API):
# a UI ahead of its rules or still-building indexes shows "couldn't be read" on every read the rules or an index refuse
# (#262). A dry run prints these reads. Dry-run and stub tested; never run against Google.
#
# Needs: `firebase login` (or Application Default Credentials in CI), `gcloud` signed in (for the rules check), and
# pnpm. Does NOT turn on Anonymous
# sign-in: that is project-wide, so it is a decision for a person (docs/setup.md).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-}"
HOSTING_SITE="${HOSTING_SITE:-${PROJECT_ID:+$PROJECT_ID-starfish}}"
STARFISH_ENV="${STARFISH_ENV:-dev}"
STARFISH_DATABASE_ID="${STARFISH_DATABASE_ID:-starfish}"
DRY_RUN="${DRY_RUN:-0}"
ALLOW_RULES_DRIFT="${ALLOW_RULES_DRIFT:-0}"
UPTIME_CHECK="${UPTIME_CHECK:-0}"
UPTIME_NOTIFICATION_CHANNELS="${UPTIME_NOTIFICATION_CHANNELS:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { echo "deploy-web: $*" >&2; exit 1; }
[ -n "$PROJECT_ID" ] || die "PROJECT_ID is required"
# An App Check debug token lets anyone holding it pass App Check. Vite inlines every VITE_* value of the build's
# environment and of the .env files it loads for a production build, so one set anywhere there would ship in the bundle.
[ -z "${VITE_STARFISH_APPCHECK_DEBUG_TOKEN:-}" ] || die "VITE_STARFISH_APPCHECK_DEBUG_TOKEN is set: a debug token is for local development only, never a deployed build"
for f in .env .env.local .env.production .env.production.local; do
  if [ -f "$REPO_ROOT/web/$f" ] && grep -Eq '^[[:space:]]*VITE_STARFISH_APPCHECK_DEBUG_TOKEN[[:space:]]*=[[:space:]]*["'\'']?[^[:space:]#"'\'']' "$REPO_ROOT/web/$f"; then
    die "web/$f sets VITE_STARFISH_APPCHECK_DEBUG_TOKEN: a debug token is for local development only, never a deployed build"
  fi
done
if [ "$UPTIME_CHECK" = "1" ] && [ -n "$UPTIME_NOTIFICATION_CHANNELS" ]; then
  IFS=',' read -r -a CHANNELS <<< "$UPTIME_NOTIFICATION_CHANNELS"
  for c in "${CHANNELS[@]}"; do
    [[ "$c" =~ ^projects/[a-z0-9-]+/notificationChannels/[0-9]+$ ]] \
      || die "UPTIME_NOTIFICATION_CHANNELS takes projects/<p>/notificationChannels/<id>, comma-separated: $c"
  done
fi
[ "$STARFISH_DATABASE_ID" != "(default)" ] || die "the UI must read Starfish's own database, not (default)"
# It goes into the rules and index URLs below: a Firestore database id is lowercase letters, digits and hyphens.
[[ "$STARFISH_DATABASE_ID" =~ ^[a-z][a-z0-9-]*$ ]] || die "STARFISH_DATABASE_ID must be lowercase letters, digits and hyphens, starting with a letter: $STARFISH_DATABASE_ID"
case "$HOSTING_SITE" in
  *[!a-z0-9-]*|-*|*-) die "HOSTING_SITE must be lowercase letters, digits and hyphens, not starting or ending with one: $HOSTING_SITE" ;;
esac

step() { printf '\n== %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
# One release of the Firebase CLI, not a major that moves under the deploy (#301): it runs with the deploy's credentials.
# Bump it on purpose, here and in scripts/deploy-gcp.sh together.
FIREBASE=(pnpm dlx firebase-tools@14.27.0)

# #262: this deploy publishes the UI only. The rules and indexes it needs, and the guests' trimmed copies, come from the
# engine deploy (scripts/deploy-gcp.sh) and the engine. A UI published ahead of them reads "couldn't be read" wherever the
# live rules or a missing (or still-building) index refuse its query, which on a guest's Overview is every tile.
RULES_FILE="$(node -e '
  const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const entries = [].concat(config.firestore ?? []);
  if (entries.length !== 1 || typeof entries[0].rules !== "string") process.exit(2);
  console.log(entries[0].rules);
' "$REPO_ROOT/firebase.json")" || die "firebase.json must hold exactly one firestore entry that names its rules file"
RULES_API="https://firebaserules.googleapis.com/v1"
RELEASE_URL="$RULES_API/projects/$PROJECT_ID/releases/cloud.firestore/$STARFISH_DATABASE_ID"
INDEXES_URL="https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/$STARFISH_DATABASE_ID/collectionGroups/-/indexes?pageSize=1000"
ENGINE_DEPLOY_HINT="run the engine deploy first (scripts/deploy-gcp.sh, or Actions → Deploy engine), which publishes $RULES_FILE and firestore.indexes.json to that database"

# Refuses with the reason, unless ALLOW_RULES_DRIFT=1, which only warns.
rules_drift() {
  if [ "$ALLOW_RULES_DRIFT" = "1" ]; then
    echo "  WARNING: $1"
    echo "  (ALLOW_RULES_DRIFT=1: deploying anyway; reads the live rules refuse will show \"couldn't be read\")"
  else
    die "$1. To fix it, $ENGINE_DEPLOY_HINT; or set ALLOW_RULES_DRIFT=1 to deploy the UI anyway"
  fi
}

# GETs a Google API URL into a file, the access token on stdin (-H @-) so it is never in curl's argv. Prints the HTTP
# status, or 000 when there was no response.
api_get() { # api_get <url> <file>
  local code
  code="$(printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -sS -o "$2" -w '%{http_code}' -H @- \
    -H "x-goog-user-project: $PROJECT_ID" "$1" 2>/dev/null)" || true
  printf '%s' "${code:-000}"
}

# The check's replies sit in a scratch directory, removed however the script ends (a refusal exits from inside it).
CHECK_TMP=""
trap '[ -z "$CHECK_TMP" ] || rm -rf "$CHECK_TMP"' EXIT

check_live_rules() {
  local tmp code ruleset same
  TOKEN="$(gcloud auth print-access-token 2>/dev/null || gcloud auth application-default print-access-token 2>/dev/null)" \
    || { rules_drift "could not read the live rules of database $STARFISH_DATABASE_ID: no access token from gcloud (gcloud auth login?)"; return; }
  tmp="$(mktemp -d)"
  CHECK_TMP="$tmp"  # removed on exit, a refusal included
  code="$(api_get "$RELEASE_URL" "$tmp/release.json")"
  case "$code" in
    200) ;;
    404) rules_drift "no Firestore rules are released for database $STARFISH_DATABASE_ID in $PROJECT_ID"; return ;;
    *) rules_drift "could not read the live rules release of database $STARFISH_DATABASE_ID (HTTP $code from $RELEASE_URL; reading it needs firebaserules.releases.get)"; return ;;
  esac
  ruleset="$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (typeof r.rulesetName !== "string" || !/^projects\/[a-z0-9-]+\/rulesets\/[A-Za-z0-9-]+$/.test(r.rulesetName)) process.exit(2);
    console.log(r.rulesetName);
  ' "$tmp/release.json" 2>/dev/null)" \
    || { rules_drift "the live rules release of database $STARFISH_DATABASE_ID names no ruleset this script can read"; return; }
  code="$(api_get "$RULES_API/$ruleset" "$tmp/ruleset.json")"
  [ "$code" = "200" ] \
    || { rules_drift "could not read the live ruleset $ruleset (HTTP $code; reading it needs firebaserules.rulesets.get)"; return; }
  # The same when the ruleset holds one file whose text is the repository's (line endings aside); anything else differs.
  same="$(node -e '
    const fs = require("fs");
    const files = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))?.source?.files;
    const text = (s) => String(s).replace(/\r\n/g, "\n");
    const local = text(fs.readFileSync(process.argv[2], "utf8"));
    console.log(Array.isArray(files) && files.length === 1 && text(files[0].content) === local ? "same" : "differs");
  ' "$tmp/ruleset.json" "$REPO_ROOT/$RULES_FILE" 2>/dev/null)" || same="unreadable"
  case "$same" in
    same) echo "  (the live rules of database $STARFISH_DATABASE_ID are $RULES_FILE: $ruleset)" ;;
    differs) rules_drift "the live rules of database $STARFISH_DATABASE_ID ($ruleset) are not this repository's $RULES_FILE" ;;
    *) rules_drift "could not compare the live ruleset $ruleset with $RULES_FILE" ;;
  esac

  # Indexes: a warning only. A new composite index takes minutes to build, and until it is READY the query it serves
  # is refused, so the page reads "couldn't be read" for that long. Only the first page of indexes is read.
  code="$(api_get "$INDEXES_URL" "$tmp/indexes.json")"
  if [ "$code" != "200" ]; then
    echo "  WARNING: could not read the indexes of database $STARFISH_DATABASE_ID (HTTP $code), so not whether any is still building"
  else
    node -e '
      const indexes = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).indexes ?? [];
      const building = indexes.filter((i) => i.state !== "READY");
      for (const i of building) {
        const group = String(i.name ?? "").split("/collectionGroups/")[1]?.split("/")[0] ?? "?";
        const fields = (i.fields ?? []).map((f) => f.fieldPath).filter((f) => f !== "__name__").join(", ");
        console.log(`  WARNING: index on ${group} (${fields}) is ${i.state ?? "in an unknown state"}: queries it serves are refused until it is READY`);
      }
      if (building.length === 0) console.log(`  (all ${indexes.length} composite indexes are READY)`);
    ' "$tmp/indexes.json" 2>/dev/null \
      || echo "  WARNING: could not read the indexes' reply, so not whether any is still building"
  fi
}

step "Firestore rules and indexes of database $STARFISH_DATABASE_ID: what this UI reads must be deployed (#262)"
if [ "$DRY_RUN" = "1" ]; then
  echo "+ curl -H 'Authorization: Bearer <gcloud access token>' -H 'x-goog-user-project: $PROJECT_ID' $RELEASE_URL"
  echo "+ curl -H 'Authorization: Bearer <gcloud access token>' -H 'x-goog-user-project: $PROJECT_ID' $RULES_API/<the release's rulesetName>"
  if [ "$ALLOW_RULES_DRIFT" = "1" ]; then
    echo "  (the ruleset's source is compared with $RULES_FILE; ALLOW_RULES_DRIFT=1: a difference, or a read that fails, only warns)"
  else
    echo "  (the ruleset's source is compared with $RULES_FILE; a difference, or a read that fails, stops the deploy here)"
  fi
  echo "+ curl -H 'Authorization: Bearer <gcloud access token>' -H 'x-goog-user-project: $PROJECT_ID' $INDEXES_URL"
  echo "  (a warning for each composite index not READY yet)"
else
  check_live_rules
fi

step "Build the UI (environment label: $STARFISH_ENV)"
run env "VITE_STARFISH_ENV=${VITE_STARFISH_ENV:-$STARFISH_ENV}" "VITE_STARFISH_DATABASE_ID=${VITE_STARFISH_DATABASE_ID:-$STARFISH_DATABASE_ID}" pnpm run build

# Prints one field of a Firebase CLI --json reply (its `result`, as r), or nothing; fails on a reply that is not JSON.
PICK='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s.slice(s.indexOf("{")))}catch{process.exit(2)}const x=new Function("r","return ("+process.argv[1]+")")(v.result);console.log(x==null?"":String(x))})'
# Prints a failed Firebase CLI --json reply's `error` text (#284), else the raw reply, on one line and at most 300
# characters: the CLI says what is wrong ("Your credentials are no longer valid. Please run firebase login --reauth").
CLI_ERROR='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let t="";try{const e=JSON.parse(s.slice(s.indexOf("{"))).error;t=typeof e==="string"?e:e&&typeof e.message==="string"?e.message:""}catch{}console.log((t||s).replace(/\s+/g," ").trim().slice(0,300)||"no reply")})'
cli_error() { printf '%s' "$1" | node -e "$CLI_ERROR" 2>/dev/null || echo "no reply"; }
# What to do about a refused read. For a person, an expired session: `firebase login` alone answers "Already logged in".
LOGIN_HINT="from a terminal, an expired Firebase session is the usual cause: run firebase login --reauth"

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
    die "could not list the web apps of $PROJECT_ID ($(cli_error "${list:-}")): $LOGIN_HINT. From GitHub Actions the deployer neither lists nor registers web apps: create and link the site once from a terminal (docs/deploy.md), and Actions redeploys it from then on"
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
elif ! printf '%s' "${site_json:-}" | grep -Eqi '(^|[^0-9])404([^0-9]|$)|not found'; then
  # Only a 404 means "no such site". Any other failed read (a 403 from an account with no Hosting role, #265) is not
  # taken as missing: that would go on to create a site that exists, or to register a web app, and fail there instead.
  die "could not read Hosting site $HOSTING_SITE, and the reply was not a 404 ($(cli_error "${site_json:-}")): $LOGIN_HINT. From GitHub Actions the deployer needs roles/firebasehosting.admin (scripts/setup-github-deploy.sh, docs/deploy.md)"
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

if [ "$UPTIME_CHECK" = "1" ]; then
  # #12: an uptime check and an alert on it. Not run on a real project yet. Cloud Monitoring bills uptime checks beyond
  # a free monthly allotment; this one (every 5 minutes, from Monitoring's default regions) stays well inside it.
  HOST="$HOSTING_SITE.web.app"
  CHECK_NAME="starfish-web $HOSTING_SITE"
  POLICY_NAME="starfish-web down: $HOSTING_SITE"
  step "Uptime check '$CHECK_NAME' on https://$HOST, and the alert policy '$POLICY_NAME'"
  run gcloud services enable monitoring.googleapis.com --project="$PROJECT_ID"

  # /__/firebase/init.json, not /: Hosting answers / with index.html even for a site whose config is broken, while this
  # file holds an appId only when the site is linked to Starfish's web app (#156), which is what the UI needs to start.
  # The id of the uptime check named CHECK_NAME (the last part of projects/<p>/uptimeCheckConfigs/<id>), or nothing.
  uptime_check_id() {
    local name
    name="$(gcloud monitoring uptime list-configs --project="$PROJECT_ID" \
      --filter="displayName=\"$CHECK_NAME\"" --format='value(name)')" || die "could not list the uptime checks of $PROJECT_ID"
    name="$(printf '%s\n' "$name" | head -n1)"
    printf '%s' "${name##*/}"
  }
  CHECK_ID=""
  [ "$DRY_RUN" = "1" ] || CHECK_ID="$(uptime_check_id)"
  if [ -n "$CHECK_ID" ]; then
    echo "  (uptime check exists: $CHECK_ID)"
  else
    run gcloud monitoring uptime create "$CHECK_NAME" --project="$PROJECT_ID" \
      --resource-type=uptime-url --resource-labels="host=$HOST,project_id=$PROJECT_ID" \
      --protocol=https --path=/__/firebase/init.json --validate-ssl=true --status-classes=2xx \
      --matcher-type=contains-string --matcher-content='"appId"' --period=5 --timeout=10
    if [ "$DRY_RUN" = "1" ]; then
      CHECK_ID="<uptime-check-id>"
    else
      CHECK_ID="$(uptime_check_id)"
      [ -n "$CHECK_ID" ] || die "created the uptime check but could not read its id back"
    fi
  fi

  # The alert: Google's own uptime-check template. Fires when the check failed from more than one region in the last
  # 20 minutes, so one flaky region does not page anyone. Monitoring REST API (alertPolicies), since gcloud has the
  # alert-policy commands only in alpha/beta.
  CHANNELS_JSON=""
  if [ -n "$UPTIME_NOTIFICATION_CHANNELS" ]; then
    CHANNELS_JSON="\"$(printf '%s' "$UPTIME_NOTIFICATION_CHANNELS" | sed 's/,/","/g')\""
  fi
  POLICY_JSON="$(cat <<JSON
{"displayName":"$POLICY_NAME","combiner":"OR","notificationChannels":[$CHANNELS_JSON],
"documentation":{"mimeType":"text/markdown","content":"The Starfish operator UI at https://$HOST failed its uptime check (/__/firebase/init.json) from more than one region. Check the Hosting site and its link to the starfish web app (docs/setup.md)."},
"conditions":[{"displayName":"Uptime check failing: https://$HOST","conditionThreshold":{
"filter":"metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"$CHECK_ID\" AND resource.type=\"uptime_url\"",
"aggregations":[{"alignmentPeriod":"1200s","perSeriesAligner":"ALIGN_NEXT_OLDER","crossSeriesReducer":"REDUCE_COUNT_FALSE","groupByFields":["resource.label.project_id","resource.label.host"]}],
"comparison":"COMPARISON_GT","thresholdValue":1,"duration":"60s","trigger":{"count":1}}}]}
JSON
)"
  POLICIES_URL="https://monitoring.googleapis.com/v3/projects/$PROJECT_ID/alertPolicies"
  if [ "$DRY_RUN" = "1" ]; then
    echo "+ curl -X POST -H 'Authorization: Bearer <gcloud access token>' -H 'x-goog-user-project: $PROJECT_ID' $POLICIES_URL"
    printf '%s\n' "$POLICY_JSON"
  else
    token="$(gcloud auth print-access-token 2>/dev/null || gcloud auth application-default print-access-token 2>/dev/null)" \
      || die "the alert policy needs an access token from gcloud; or create it in the console (docs/setup.md)"
    # The token goes in on stdin (-H @-), never in curl's argv. Is there a policy by this name already? (pageSize caps the read.)
    has_policy="$(printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -H @- -H "x-goog-user-project: $PROJECT_ID" \
      "$POLICIES_URL?pageSize=1000" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log((v.alertPolicies||[]).some(p=>p.displayName===process.argv[1])?"yes":"no")})' "$POLICY_NAME")" \
      || die "could not list the alert policies of $PROJECT_ID"
    if [ "$has_policy" = "yes" ]; then
      echo "  (alert policy exists: $POLICY_NAME)"
    else
      printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -X POST -H @- -H "x-goog-user-project: $PROJECT_ID" \
        -H "Content-Type: application/json" -d "$POLICY_JSON" "$POLICIES_URL" >/dev/null \
        || die "could not create the alert policy; create it in the console (docs/setup.md)"
    fi
    [ -n "$UPTIME_NOTIFICATION_CHANNELS" ] || echo "  (no UPTIME_NOTIFICATION_CHANNELS: the alert opens incidents in the console and notifies nobody)"
  fi
fi

step "Done"
if [ "$DRY_RUN" = "1" ]; then echo "Dry run: nothing was changed."; else echo "Live at https://$HOSTING_SITE.web.app"; fi
if [ "${VITE_STARFISH_ENV:-$STARFISH_ENV}" = "demo" ]; then
  # A guest reads only the trimmed copies the engine writes (#18); records stored before it wrote them have none.
  echo "Guests read the trimmed copies the engine writes. For records stored before it did, with GOOGLE_CLOUD_PROJECT=$PROJECT_ID"
  echo "and STARFISH_DATABASE_ID=$STARFISH_DATABASE_ID: pnpm public-view counts them, pnpm public-view -- --apply --project=$PROJECT_ID writes them"
fi
