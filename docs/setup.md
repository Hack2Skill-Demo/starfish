# Setup day: from an empty project to a running Starfish

The order to follow when you have the time. Everything that can be a command is one; what is left are
the few steps only a person with the console can do.

> **Status: run once, on the demo project (2026-10-05); most of it worked.** The preflight, the ingest deploy (job, Scheduler,
> database and rules), `grant-operator` and the web deploy ran against `hack2skill-demo`, after two fixes the first run found (the
> build account's role, #103; `grant-operator` following the shell's project, #104). The smoke test then passed: a planted error was read into the store and retired. **The agent job has not run.** Every script below is tested against stubs of `gcloud` and `firebase`
> (so the plan, the order and the refusals are pinned; the web deploy is tested against a stub of `pnpm`), and the two CLIs (`grant-operator`, `status`)
> were run end to end against the Firebase emulators. Expect
> to fix one or two things on the first pass of the parts that have not run; [`deploy.md`](deploy.md) lists the likely ones.

## Decide first (no commands)

| Decision | Recommendation | Why |
|---|---|---|
| **Which project** | The demo project (the same-project decision on #6) | Starfish and the demo app share it; the deploy scopes every grant so they do not read each other's data (#32). |
| **Environment label** | `STARFISH_ENV=demo` for the public demo | `firestore.rules` lets a guest read only incidents labelled `demo`. Any other label and the public page is empty. |
| **Anonymous sign-in** | On only for the public demo, and only after reading #32 | It is project-wide. A private deployment leaves it off and requires an operator account. |
| **Schedule** | Hourly normally; `*/5 * * * *` while demoing | A 5-minute tick all month is not free (Cloud Build, the job's runs). |
| **A budget alert** | Yes, set `BUDGET_USD` | It emails at 50% and 90%. It is an alert, **not a cap**: nothing stops spending. |

## Only you can do these (console, once)

1. **A project with billing on.** Create or pick it; link a billing account. (`scripts/preflight-gcp.sh` checks.)
2. **Add Firebase to it** (Firebase console → Add project → choose the existing project). Auth and Hosting need it.
3. **Authentication → Get started → Email/Password → Enable.** The first admin signs in this way. Auth has to be
   initialised in the console once; that step is not scripted. Then **Authentication → Settings → User actions →
   untick "Enable create (sign-up)"**: the web API key is public, so with sign-up on anyone can register
   `you@example.com` before you grant it. Operators are made by `pnpm grant-operator --create`, which needs no
   sign-up. (`grant-operator` also refuses an existing account whose email is not verified, #139.) If you turn on
   Anonymous sign-in below, check a guest visit still works afterwards; whether this setting also stops anonymous
   accounts has not been checked here.
4. **Anonymous sign-in**, only if you decided yes above.
5. **Gemini access.** The deploy enables the Vertex AI API. Confirm the model in `STARFISH_MODEL` is available in
   your region (the default is `gemini-3.1-pro-preview` in `us-central1`); `pnpm spike` makes real Gemini calls (it spends tokens), so run it once, on purpose.

## Then, in this order

```bash
# On your machine (Node 22+, pnpm, gcloud; Docker is NOT needed)
gcloud auth login
gcloud auth application-default login          # for pnpm status / grant-operator
pnpm dlx firebase-tools@14 login               # for the web deploy
pnpm install

export PROJECT_ID=my-demo-project              # the scripts read this
export GOOGLE_CLOUD_PROJECT=$PROJECT_ID        # the engine's own CLIs (grant-operator, status) read this. Cloud Shell sets it to
                                               # whatever project the shell is on, and a shell can change project: export both
                                               # again in every new shell, and check `gcloud config get project`
export STARFISH_ENV=demo                       # both read this: the label stamped on incidents

# 1. Read-only: is everything in place? Fix any FAIL line before going on.
scripts/preflight-gcp.sh

# 2. The engine: Cloud Run job + Scheduler + Secret Manager + IAM + Firestore database and rules.
DRY_RUN=1 scripts/deploy-gcp.sh                # read the plan first
SCHEDULE='*/5 * * * *' BUDGET_USD=20 BILLING_ACCOUNT=0123AB-456CDE-789FGH scripts/deploy-gcp.sh

# 3. The first admin. Creates the account without a password and prints a link for them to choose one.
pnpm grant-operator --project $PROJECT_ID --email you@example.com --role admin --create
# No link (or no email): `--link` on an existing account prints a fresh one to open in a browser.
# An existing account whose email is not verified is refused (anyone could have signed it up); the refusal prints when
# it was made and its providers. Only if it is yours (an earlier `--create`, say): add `--trust-existing`. Otherwise delete it and use `--create`.

# 4. Prove the ingest works end to end: plants one error, waits ~7 minutes, runs the job, checks.
SMOKE_ACTOR_UID=<admin uid> scripts/smoke-gcp.sh

# 5. The operator UI, on its own Hosting site (not the project's default one).
scripts/deploy-web.sh                          # prints https://<project>-starfish.web.app
# It links the site to the web app named starfish (registering it if missing), so the page's init.json has an appId.
# An existing site with no app is linked with the Hosting REST API, which needs `gcloud` signed in; not yet run on a
# real project. If the page says "init.json is missing appId": console → Project settings → Your apps → starfish →
# "Link to a Firebase Hosting site" (#156, docs/deploy.md).
```

Then open the URL, sign in with the link from step 3, and you should see the planted incident. `pnpm status`
at any time says whether the engine is alive (exit 0 = last run ok and recent). `--min-incidents N` also requires
incidents in the store; `--min-entries N` requires that the *last run* read at least N log entries (on a project
with real errors of its own that proves little, so the smoke test does not use it).

The smoke test writes one real incident named `starfish-smoke` into the store and checks **that** incident
(`pnpm smoke-check`: a `starfish-smoke` incident whose last occurrence is after the moment it planted the error),
so it holds even where the logs are not quiet. It then **retires** it with `SMOKE_ACTOR_UID` (the uid of an admin
operator you granted with `pnpm grant-operator`; required), audited, and reads the retirement back. A retired
incident is in no list. If cleanup fails the script says which incident document to delete in the Firestore console
and exits non-zero. Dry-run tested, and run once against the demo project (2026-10-05), where it passed (#6).

**Redeploying later without a local `gcloud`:** the Deploy engine workflow (`.github/workflows/deploy.yml`, Actions → Deploy engine → Run workflow) runs step 2 from GitHub Actions with no stored key. Use it once the one-time Workload Identity setup is done (a console step, in [`deploy.md`](deploy.md#deploy-from-github-actions-75); the workflow is written and pinned by a test, never run). Until then, or for the very first deploy, run `scripts/deploy-gcp.sh` by hand as above. The web UI has its own workflow, Deploy web UI (`.github/workflows/deploy-web.yml`, [`deploy.md`](deploy.md#deploy-the-web-ui-from-github-actions-92); written and never run, and whether the Firebase CLI accepts its credentials is unverified); step 5 below stays the dependable path.

## What you will still not have after this

Be honest with yourself about this list before the demo:

- **No incidents unless something errors.** An engine that finds nothing on a quiet project is working. The
  demo needs a source of real errors: the demo app with its faults (#5), which is not built.
- **The loop is written as a job and has never run.** `DEPLOY_AGENT=1` deploys the agent, whose patches are judged by the
  target repository's own CI on a pushed `starfish/<cycle>` branch (or, heavier, by a separate credential-less job); see
  [`deploy.md`](deploy.md#the-agent-and-where-its-tests-run-74), including the workflow the target needs. It is a dry run
  and opens no pull request, but it pushes branches; nothing has run against real GitHub. So today's deployed Starfish
  *finds and shows* incidents; it does not yet *fix* any.
- **No Slack, no phone call, no issue filed** (#17, #37). The pull-request opener exists
  (`src/integrations/githubPr.ts`, tested against a local git remote and a fake GitHub API, **never against real
  GitHub**) and the mounted GitHub token has that one reader, but nothing that runs deployed calls it.
- **No alert when ingestion stops**, only the UI's "engine stopped" line (#6).
- **No App Check** (#12). The public page shows what really happened and no more, unless you add the synthetic
  history: `STARFISH_ENV=demo pnpm seed-demo -- --apply --project=<id>` writes five made-up incidents and finished
  runs, one per path of the loop, each marked `synthetic: true` and badged "Synthetic" in the UI; `--remove` deletes
  exactly them. It refuses any other environment. What it writes: the README's
  [Synthetic demo history](../README.md#synthetic-demo-history).

Everything here is in the issues; the order that gets to the headline demo fastest is #5 (something to break),
#74 (the loop as a job, once the verify step's isolation is decided), then #11 (the index heal: only its parser
and target guard exist).

## If a step fails

- **Preflight FAIL:** the line says what; fix it and re-run, it only reads.
- **Deploy fails:** the script is idempotent; fix the cause and run it again. Likely causes are in
  [`deploy.md`](deploy.md#what-is-most-likely-to-go-wrong-the-first-time).
- **The UI says "engine never recorded a run"**, but the job ran: the job and the UI are pointing at
  different projects, databases or environment labels. `pnpm status` shows what the engine sees.
- **Take it down:** [`deploy.md`](deploy.md#take-it-down).
