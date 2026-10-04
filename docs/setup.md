# Setup day: from an empty project to a running Starfish

The order to follow when you have the time. Everything that can be a command is one; what is left are
the few steps only a person with the console can do.

> **Status: prepared, not run.** Every script below is tested against stubs of `gcloud` and `firebase`
> (so the plan, the order and the refusals are pinned; the web deploy is tested against a stub of `pnpm`), and the two CLIs (`grant-operator`, `status`)
> were run end to end against the Firebase emulators. **None has run against a real project.** Expect
> to fix one or two things on the first pass; [`deploy.md`](deploy.md) lists the likely ones.

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
   initialised in the console once; that step is not scripted.
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
export GOOGLE_CLOUD_PROJECT=$PROJECT_ID        # the engine's own CLIs (grant-operator, status) read this
export STARFISH_ENV=demo                       # both read this: the label stamped on incidents

# 1. Read-only: is everything in place? Fix any FAIL line before going on.
scripts/preflight-gcp.sh

# 2. The engine: Cloud Run job + Scheduler + Secret Manager + IAM + Firestore database and rules.
DRY_RUN=1 scripts/deploy-gcp.sh                # read the plan first
SCHEDULE='*/5 * * * *' BUDGET_USD=20 BILLING_ACCOUNT=0123AB-456CDE-789FGH scripts/deploy-gcp.sh

# 3. The first admin. Creates the account without a password and prints a link for them to choose one.
pnpm grant-operator --email you@example.com --role admin --create

# 4. Prove the ingest works end to end: plants one error, waits ~7 minutes, runs the job, checks.
SMOKE_ACTOR_UID=<admin uid> scripts/smoke-gcp.sh

# 5. The operator UI, on its own Hosting site (not the project's default one).
scripts/deploy-web.sh                          # prints https://<project>-starfish.web.app
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
and exits non-zero. Written and dry-run tested; never run against a real project (#6).

**Redeploying later without a local `gcloud`:** the Deploy engine workflow (`.github/workflows/deploy.yml`, Actions → Deploy engine → Run workflow) runs step 2 from GitHub Actions with no stored key. Use it once the one-time Workload Identity setup is done (a console step, in [`deploy.md`](deploy.md#deploy-from-github-actions-75); the workflow is written and pinned by a test, never run). Until then, or for the very first deploy, run `scripts/deploy-gcp.sh` by hand as above. The web UI is not part of the workflow: step 5 stays a local `scripts/deploy-web.sh` (#92).

## What you will still not have after this

Be honest with yourself about this list before the demo:

- **No incidents unless something errors.** An engine that finds nothing on a quiet project is working. The
  demo needs a source of real errors: the demo app with its faults (#5), which is not built.
- **The loop is not deployed.** Triage, fix, verify and review exist as tested stages, the loop that orders them
  exists, and so do the pieces of one pass over the store (candidate selection, input assembly, `pnpm agent`).
  Nothing deploys it as a job (#74): the entrypoint refuses to start until the verify step's isolation is set on
  purpose, and that isolation is an open decision. So today's deployed Starfish *finds and shows* incidents;
  it does not yet *fix* any.
- **No Slack, no phone call, no issue filed** (#17, #37). The pull-request opener exists
  (`src/integrations/githubPr.ts`, tested against a local git remote and a fake GitHub API, **never against real
  GitHub**) and the mounted GitHub token has that one reader, but nothing that runs deployed calls it.
- **No alert when ingestion stops**, only the UI's "engine stopped" line (#6).
- **No App Check, no seeded evidence history** (#12). The public page shows what really happened and no more.

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
