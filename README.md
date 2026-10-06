# Starfish

**An AI ops engineer for teams that don't have one.**

Starfish watches a production Firebase/GCP project, judges which incidents are actually
urgent, drafts a fix, adversarially reviews its own work, and opens a verified pull request
— then stops and waits for a human.

Named for the animal that regrows what it loses.

---

## Why

Sentry's Seer needs Sentry and a team around it. Google's Gemini Cloud Assist is built for
enterprises that already employ SREs. Both assume an engineering organisation exists.

Nobody builds for the two-person company running real production for real users — which is
the long tail of most software that actually matters to the people using it.

That's the gap Starfish is for.

## Design goal: configured, never forked

Starfish is meant to be **generic** — one engine, pointed at different projects by
configuration alone. The test is deliberately falsifiable:

> **Nobody should have to edit `src/` to run Starfish against their own project.**

Everything deployment-specific belongs in `src/config.ts` and nowhere else. If adopting
Starfish somewhere new requires touching engine code, that's a bug in the design, not a
missing feature.

Where it currently holds, and where it doesn't:

| | Status |
|---|---|
| Service attribution | ✅ config patterns — no hardcoded service list |
| Project, environment, collection, database, lookback | ✅ config (engine `src/config.ts`, UI `web/src/lib/config.ts`); these are the defaults, and the engine's need a redeploy to change |
| Watched project, environment label, log resource types, service patterns, noise list, and the pipeline switches (dry run, review required, model calls per cycle) | ⚠️ an admin edits them on the Settings page; the engine validates the saved document and applies it over the defaults, falling back to the last good one (`src/runtimeSettings.ts`). `firestore.rules` let only admins write it, each save in one batch with an immutable audit entry (before and after) and a separate operator copy; the engine's last-good copy and any secret-shaped key are closed to clients. The editor and the engine run the same validator (`src/settingsSchema.ts`). Rules check each list's shape and size but not each entry (they have no loops); the engine checks entries on read. Tested on the emulator, and the editor's own save is the one the rules suite runs. `pnpm ingest` reads it on each run (`src/ingest/run.ts`), and `scripts/deploy-gcp.sh` defines the scheduled job that runs it, but that script has **not been run against a real project yet** (#6), so until it has, a saved document is read only when someone runs `pnpm ingest`; secrets (Secret Manager and its endpoint). The pipeline switches (dry run, review required, automation, model calls) are stored and applied the same way, but **no deployed job runs the agent loop yet** (`DEPLOY_AGENT=1` would deploy one; it has never run), so today they change nothing; the verify command, its timeout and the excluded paths stay environment-only on purpose (an editable command would be code execution on the engine host, and the excluded paths guard the judge). Single-target: one watched project per deployment |
| Vertex project, model and region | ⚠️ environment only (`STARFISH_VERTEX_PROJECT_ID`, defaulting to `GOOGLE_CLOUD_PROJECT`, so Gemini can run in a different project from the store): `vertex.ts` reads them itself, so a settings document can't change them yet |
| Firebase project the UI connects to | ✅ read at startup from Hosting's `/__/firebase/init.json`, so one build serves any project (`VITE_FIREBASE_*` is the local-dev fallback). `scripts/deploy-web.sh` deploys it to its own Hosting site; written and dry-run tested, **untested against a real Hosting site** (#12) |
| UI environment label | ✅ follows the runtime settings once signed in (the build-time `VITE_STARFISH_ENV` is the fallback when none is set or the read fails) |
| UI collections and region | ⚠️ still `VITE_*`, baked in at build time |
| Collection names in `firestore.rules` | ⚠️ hardcoded `incidents` / `starfish_users`; rules can't read config, so a renamed collection means editing the rules file |
| Dry run, review required, model-call budget, automation kill switch | ⚠️ environment defaults (`STARFISH_DRY_RUN` on by default, `STARFISH_REVIEW_REQUIRED`, `STARFISH_MODEL_CALL_BUDGET`, `STARFISH_AUTOMATION_ENABLED` on by default) that an admin can override on the Settings page (first row); the loop reads them; the agent job that runs it is deployable (`DEPLOY_AGENT=1`) and has never run. The kill switch is read fresh before every stage (`src/agent/automationSwitch.ts`) and fails closed: if the settings cannot be resolved and nothing good is known, it reads as off |
| GitHub target (repository, base branch, API and remote URL, commit identity) and token | ⚠️ environment only (`STARFISH_GITHUB_REPO` empty by default, so nothing can be opened; `STARFISH_GITHUB_BASE_BRANCH`, `_API_URL`, `_REMOTE_URL`, `_COMMIT_NAME`, `_COMMIT_EMAIL`); the token is read on its own from `STARFISH_GITHUB_TOKEN` and is not part of the config object. One repository per deployment |
| Where a missing index may be created | ⚠️ environment only (`STARFISH_INDEX_ALLOWED_TARGETS`, empty by default: nothing allowed; a malformed entry stops startup); nothing creates an index yet |
| Verify isolation, cycles per agent pass | ⚠️ environment only (`STARFISH_VERIFY_ISOLATION`, default `none`: the agent will not start; `in-process` is not a sandbox; `github-actions` (the demo's choice) pushes the patch to a `starfish/<cycle>` branch and lets the target's own CI judge it, with `STARFISH_VERIFY_CHECKS` naming the checks; `cloud-run-job` runs the command in a separate job whose service account holds no roles, with `STARFISH_VERIFY_JOB`, `_BUCKET`, `_JOB_REGION` (both written, never run, #74); `STARFISH_MAX_CYCLES_PER_PASS`, default 3) |
| Agent cycle collection, lease length, cycle deadline, attempts | ⚠️ environment only (`STARFISH_CYCLE_COLLECTION`, `STARFISH_LEASE_SECONDS`, `STARFISH_CYCLE_DEADLINE_MINUTES`, `STARFISH_MAX_CYCLE_ATTEMPTS`); the rules name `starfish_cycles` too |
| Ingest lag, longest window, run-record collection | ⚠️ environment only (`STARFISH_INGEST_LAG_MINUTES`, `STARFISH_INGEST_MAX_WINDOW_HOURS`, `STARFISH_RUN_COLLECTION`); the rules name `starfish_runs` too |
| Services Starfish never ingests (its own) | ✅ config (`STARFISH_EXCLUDED_SERVICES`, default `starfish`), applied at query time and at parse time; environment-only on purpose, because it guards against a feedback loop and is not an operational preference. Set it to the name Starfish is actually deployed under; nothing is deployed yet (#6, #32) |
| Log source resource types | ⚠️ config, but attribution reads only `function_name` / `service_name`, so only Cloud Functions and Cloud Run work |
| Framework-noise suppression list | ✅ config, callable GET-probe noise by default |
| Deployment: project, region, schedule, the watched and Gemini projects, the environment label | ✅ environment variables of `scripts/deploy-gcp.sh`; no file is edited. Run once, on the demo project (2026-10-05): the ingest job, its schedule, the database and rules deployed and a scheduled run succeeded (#6). The agent job (`DEPLOY_AGENT=1`) has not run. `.github/workflows/deploy.yml` runs the same script by hand-dispatch with Workload Identity Federation and repository variables, no stored key; written and pinned by a test, **never run** (#75) |
| Incident store | ❌ assumes Firestore |
| Verify-gate command, timeout and excluded paths | ⚠️ environment only (`STARFISH_VERIFY_COMMAND`, `STARFISH_VERIFY_TIMEOUT_SECONDS`, `STARFISH_PATCH_EXCLUDED_PATHS`); `src/agent/verifyGate.ts` reads them; in the isolated deployment only the verify job runs it (written, never run) |

The ❌ rows are tracked work, not accepted limitations.

## Known blind spot: logs are not the only signal

Ingestion reads Cloud Logging only. The production pipeline this ingest is adapted from found that
Firebase **gen2** (Cloud Run) functions can fail without emitting an ERROR-severity log at
all: a log-only reader then reports "no errors" while Cloud Monitoring still counts the
failed invocations. The fix there was a second, Monitoring-derived source feeding the same
store. Starfish does not have that yet, so until it does, a clean ingest run means *no
logged errors*, not *no errors*.

## How it works

```
Cloud Logging  ──▶  incident store  ──▶  Gemini triage      "is this actually urgent?"
                    (fingerprint,          │
                     occurrence count,     ▼
                     counter-check)      Gemini fix-draft   "what's the minimal patch?"
                                           │
                                           ▼
                                         verify gate        lint · typecheck · test · build
                                           │                (deterministic — NOT the model)
                                           ▼
                                         Gemini review      adversarial: try to break it
                                           │
                                           ▼
                                         pull request       ← stops here. A human merges.
```

The verify gate is deliberately *not* an LLM. The model proposes; the test suite disposes.

## The trust ladder

Writing a fix is the easy part. Knowing when it's allowed to act is the hard part.

Today Starfish never merges and never deploys. The direction is to **merge what it can prove
is safe and escalate the rest**: rung 4 is scoped to classes with low blast radius and
structural certainty, such as a missing composite index, starting with the demo project. That
is decided in [`docs/design/auto-merge-policy.md`](docs/design/auto-merge-policy.md) and
**not built yet**.
Autonomy is earned in stages, not switched on:

| Rung | Guardrail | Status |
|------|-----------|--------|
| 0 | Full verify gate on every patch | designed |
| 0 | Adversarial self-review before a human sees it | designed |
| 0 | Human-gated stop at PR — never merges, never deploys | designed |
| 1 | Integration-suite re-run required for merge eligibility | planned |
| 2 | End-to-end coverage of the affected user flow | planned |
| 3 | Blast-radius limits + rollback/canary story | planned |
| 4 | Scoped auto-merge: low blast radius **and** proven cause (policy written) | blocked on 1–3 |

Each rung is a prerequisite for the next. Rung 4 is not a switch we get to flip on our own.

## Where the UI is heading

**Mostly designed, not built.** The operator UI today has sign-in, an **Overview** landing page, the
incidents table, an editable settings page, a **Runs** page and an incident evidence page. The mockups below show where it is going and how the
demo runs.

- **Live runs:** a first version is built: the **Runs** page lists the agent's cycles and draws
  each one's steps (triage, fix, verify, review, pull request) from the events the engine records,
  live. A step with no event reads "not reached", and a run with no worker holding it is not shown
  as in progress. **The agent job that would fill it is deployable (`DEPLOY_AGENT=1`) and has never run, so on a real
  deployment the page is empty;** it is exercised against the emulator with seeded data. The header shows the path, the
  triage rule, progress (steps recorded) and the engine's last run. The GitHub-issue and Slack steps appear when a run
  recorded them. Not built: the index, deploy, phone and recovery steps (the
  loop has no code for them), and the four MVP cases observed end to end (#33 stays open).
- **Incident evidence:** a first version is built: `/incidents/:id`, linked from the incidents table
  and from the Runs page, shows what was detected and, from the agent's run record, the triage,
  fix, verify, review and pull request results, with "not reached" for any stage not recorded. It
  draws the incident's last 24 hours of occurrences as bars, and shows the independent raw-log recount triage
  judged on (beside the store's count, with the exact filter when it is short enough to keep whole; a missing
  recount says missing, never zero), the model that decided, the alternatives the fixer rejected and each
  attack the reviewer tried. It does **not** show the patch text (only its SHA-256 is stored; #39 stays open
  for that decision).
- **Overview:** a first version is built and is the page the app opens on: how many runs wait on a
  human, runs in progress, open incidents, regressions, errors per hour (from the incidents' hourly
  buckets), key figures (pull requests opened and failed runs, each as "n of N finished runs"; median run length; untriaged open incidents; errors this hour against the hours before it), what the agent did by path (each row opens the Runs list filtered to runs that ended that way), the latest runs and the engine's status. Every figure is a
  count or median of stored records, not an accuracy score (no run has been scored; see `scoreboard/FORMAT.md`). It does **not** show a run "healed on its own" or merged (nothing records
  one), or run events as a feed
  (it lists the latest runs); on a real deployment the run counts are zero until a job runs the agent
  loop (#38 stays open).
- **Slack messages and GitHub issue/PR bodies:** what Starfish posts elsewhere.
- **Pre-recorded phone call:** to the on-call person when Slack goes unanswered.
- **Settings:** connections, the engine's rules and on-call.

The Incidents page opens with a line saying whether the engine is running (from the engine's last-run record: failed, stopped past a configurable threshold, read capped, or never recorded), so a quiet list can't pass for good news; nothing writes that record in production until the ingest job is deployed and scheduled: `scripts/deploy-gcp.sh` does both but has not been run against a real project yet (#6).

The public demo needs no sign-in: a visitor is signed in anonymously and sees the Overview, the incidents and their evidence, the Runs page and a view-only Settings page, all for the `demo` environment only, with no triage buttons (#12). That needs Anonymous sign-in enabled in the Firebase project and only `demo`-labelled data; App Check, the seeded evidence history and the uptime check are not built. A private deployment leaves Anonymous sign-in disabled and still requires an operator account.

![Live runs: a missing-index fault, from first error to an evidence PR waiting for a human](docs/design/screens/live-runs-index.png)

Every screen, and what each one is for: [`docs/design/mockups.md`](docs/design/mockups.md). To click
through them, open [`docs/design/html/index.html`](docs/design/html/index.html) in a browser after cloning
(GitHub shows HTML files as source, not as pages).

## Google Cloud stack

What each service does here, and how far it has got. "Written" means the code or script exists and
is tested; "deployed" would mean it has run in a real project, and **nothing has yet** (#6).

| Service | Used for | Status |
|---|---|---|
| Vertex AI (Gemini) | triage, fix drafting, adversarial review | built as stages with a stubbed model; the spike runs real Gemini on fixtures |
| Cloud Logging | the errors Starfish watches | built (ingest) |
| Firestore (its own `starfish` database) | incidents, settings, cycles, run records | built; rules and store tested on the emulator |
| Firebase Auth | operator sign-in, guest view | built |
| Cloud Run (a job) | runs one ingest per tick, as its own least-privilege service account | `Dockerfile` and deploy script written; not deployed |
| Cloud Run: agent job and verify job, Cloud Storage bucket | the agent runs triage → fix → review; the target's tests run only in a separate job whose service account holds no roles, fed through the bucket (`DEPLOY_AGENT=1`) | in the deploy script (`docs/deploy.md`); never deployed |
| Cloud Scheduler | starts that job on a cron (`SCHEDULE`, hourly by default) | in the deploy script; not deployed |
| Secret Manager | the GitHub token the pull-request step uses | secret, access grant and mount are in the deploy script, and `loadGithubToken()` reads it; the opener is built and tested against a local git remote and a fake API, **not against real GitHub**; its only caller is the agent job (a dry run, never run) |
| Firebase Hosting | the operator UI, on its own site (not the project's default one) | `scripts/deploy-web.sh` and the Hosting config written; not deployed |
| Cloud Build, Artifact Registry | build the image (`gcloud run jobs deploy --source`; one build per job) | in the deploy script; not deployed |
| Cloud Monitoring | a second signal beside logs (see the blind spot above) | planned |

## Status

Early, but not from scratch. The ingestion half is adapted from an incident pipeline the
authors run in production for their own product: Cloud Logging query and false-positive suppression, error
classification, fingerprint dedup, rolling occurrence buckets, redaction. Most of its
apparent over-engineering is scar tissue from real incidents, and the tests in
`src/ingest/ingest.test.ts` pin the behaviours that were learned the expensive way:

- classification trusts what the source asserted before guessing from message text
- an unattributable function resolves to `"platform"` — never to whichever service is
  listed first, which is a real bug that mislabelled alerts for weeks
- audit logs and callable-framework GET probes are dropped at both query and parse time
- a resolved incident that fires again is re-opened as `recurred`, a regression that keeps
  the resolution that didn't hold; an ignored one is never re-opened (`store.test.ts`)
- an open incident is found by its fingerprint, so a busy function's burst can't fork one
  incident into several (`store.test.ts`)
- every write is one Firestore transaction through a per-fingerprint key document, so
  concurrent ingest runs converge on one incident, lose no hourly count, and an operator
  resolving an incident mid-run either lands after the occurrence or turns it into exactly
  one recurrence (`store.emulator.test.ts`, on the emulator)
- an ingest run reads one bounded window of logs at a time, (start, end], ending a few minutes
  behind the clock so late-arriving entries are in it. The window is saved as *pending* before
  anything is read, the checkpoint advances only after every upsert of it has committed, and a
  retry replays the same window, and two runs that overlap are given the same one (claimed in a transaction); the incident key remembers the windows it applied, so a window
  replayed after a half-failed run counts once, even under concurrency (`run.emulator.test.ts`,
  `store.emulator.test.ts`). A window is read oldest first; a read that hits the 5,000-entry cap
  writes nothing and narrows the pending window to the part it read in full, and the rest is read by
  the windows after it (#127). Only a window with more than 5,000 entries in its first millisecond is
  processed as read and flagged capped on the run record. `pnpm ingest` runs this once; the Cloud Run job and Scheduler that would run it on a schedule are written (`scripts/deploy-gcp.sh`) but not yet deployed anywhere (#6). The checkpoint
  is per (watched project, environment) and is not carried over when settings change either
- an admin can retire an incident (`src/ingest/retire.ts`): it is closed for good with its history
  kept, its incident key is removed, and the same error firing again opens a **new** incident
  instead of coming back as `recurred`. One transaction does it together with an audit entry
  (`starfish_audit`, admin-readable, engine-written), so a retire racing an occurrence loses none
  (`retire.emulator.test.ts`). Admin is checked from the operator record, not from anything the caller
  passes. The admin API (`src/adminApi.ts`, a Cloud Run service, `DEPLOY_ADMIN_API=1`) is the endpoint the demo's reset script
  calls: built, tested with stubs and over local HTTP, **never deployed or run**. The UI has the two controls for admins (`Retire` on an incident, `Run ingest now` on Incidents), shown only when the site is built with `VITE_STARFISH_ADMIN_API_URL`; unit-tested with stubs, never clicked against a real service. **Not built:** the fast-revert watch (#9) it is meant to disarm; `retired` is the flag that watch must
  honour
- ingest can be run on demand by an admin (`src/ingest/trigger.ts`): the **same** `runIngest` as a scheduled
  run (same windows, checkpoint and last-run record, and two together converge), behind an admin check
  made from the operator record and an audit entry written before the run. The admin API (see above) is the endpoint that calls it: never deployed; the Incidents page has a "Run ingest now" button for admins when the site knows the admin API's URL (built, never run against a real service). The short schedule for recording the demo is the `SCHEDULE` of
  the deploy script (#6; the ingest job has been deployed once, to the demo project, and `scripts/ingest-cadence.sh` changes the tick); a setting nothing reads would be a control that does nothing
- a fingerprint ignores what varies per occurrence (ids, paths, timestamps, counts) but not
  what makes a bug distinct (status codes, quoted property names), and treats a function's
  first- and second-generation spellings as one
- credentials (bearer tokens, JWTs, API keys, signed-URL parameters) are redacted from
  everything stored and everything sent to the model, not just the counter-check samples
- a log's `error` field is kept apart from its title: the title keys the fingerprint, the
  error is the cause a fixer needs

- one redaction policy (`src/ingest/redact.ts`) covers emails and credentials: token
  shapes (JWTs, bearer headers, Google/GitHub/AWS/Slack/Stripe keys), private keys,
  URL credentials and credential-named `key=value` pairs. The store re-applies it on
  every write, so no caller can persist a seeded secret; the model prompt, model error
  messages and the spike's printed output go through it too (`redact.test.ts`)
- what the agent loop records and sends is checked end to end: one emulator test runs a whole
  cycle with every seeded credential planted in the incident's message, detail and stack, the source
  files, the verify command's output and each model answer, and asserts none of them appears in a
  prompt, a stored cycle or event, or the pull request opener's payload (`loop.emulator.test.ts`).
  The patch itself is the exception: it is a diff of the repository's own files, goes only to a pull
  request in that repository, and the fixer refuses a patch that *adds* a credential shape
  (a secret already sitting in a context or removed line is not caught)

**Redaction limits.** It is pattern matching: a credential in a format nobody listed will
get through, and free-form PII (names, addresses, record ids) is not detectable at all —
`truncate` bounds how much raw text leaves, it does not clean it. The store redacts new
writes; incidents stored **before** the policy are scrubbed in place by `pnpm scrub` (a dry
run that counts what it would change; `pnpm scrub -- --apply --project=<id>` rewrites, and
refuses unless the project matches `GOOGLE_CLOUD_PROJECT`). It redacts the same four fields the
store does, recomputes each changed record's fingerprint (the store fingerprints the redacted
text, so otherwise the next occurrence would fork a duplicate), removes the stale incident
key, and is safe to re-run (`scrub.test.ts`, `scrub.emulator.test.ts`). Run it before real
data is exposed to anyone. It does not touch Firestore exports or backups, logs, or anything
outside the incident collection, and it finds only what the pattern list finds. The one
Slack message (`needs a human`) is built from redacted, bounded, plain-text fields and tested for seeded credentials; there is no
issue/PR-text allowlist beyond the PR opener's own bounded fields, so that surface is still to be built (issue #18). What a demo guest can read of the agent's work is already an allowlist:
events and the run record are flat, key-filtered, redacted and bounded (`sanitizeEvent`); the
incident documents guests read are the redacted ones, so keep the public demo's data synthetic.

Alongside it, the **counter-check** (`src/ingest/counterCheck.ts`): an independent raw-log
recount of a function's errors over 24h, plus a few redacted recent samples. Nothing calls it
in a run yet; the triage stage below consumes what it produces.

The first stage of the half that acts exists as a **tested contract** and nothing more: triage
(`src/agent/triage.ts`) decides act / notify / decline for one incident. It skips an incident
that isn't open, defers when the counter-check is missing (missing is not zero), declines a
counter-check of zero without asking the model, validates the model's answer locally and
fails closed, and redacts and bounds both what the model is shown and what it returns. It is
tested with a stubbed model; the agent job (`pnpm agent`, deployable with `DEPLOY_AGENT=1`, never run) runs it and takes the counter-check itself,
and it is not on Google's Agent Development Kit yet.

The **verify gate** (`src/agent/verifyGate.ts`) is also built as a function and tested for real
(real `git apply`, real child processes), and run by the verify job in the isolated deployment (never run). Given a checkout and a
patch it applies the patch in a scratch copy without `.git` or `node_modules`, compares the
trees to see what *actually* changed, and refuses a change to CI or secrets or any path the
deployment excluded (the files that define the verify command and the tests), a symbolic link,
a changed file mode, or too many files, all before running anything. Only then does it run the
configured command with a scrubbed environment and a timeout, and reports bounded, redacted
output tied to the SHA-256 of the exact patch. **It is not a sandbox:** the command runs as this
process's user with the machine's network and filesystem, so it belongs on a disposable runner
that holds no credentials, which is infrastructure that does not exist yet (#8).

The **fixer** (`src/agent/fixer.ts`) is the third stage as a contract, run by the agent job (never run): given an
incident and the source files the caller chose to show it, it returns a unified diff with its
root cause, risk and rejected alternatives, or honestly declines (an empty patch means "I lack
the context", an outcome and not an error). It fails closed on a malformed answer, a patch
that isn't a unified diff, one over the size limit, or one that *adds* credential-shaped text,
and redacts what it shows and what it returns. It applies and runs nothing; the verify gate
judges. Tested with a stubbed model; whether Gemini actually writes patches a human would is
still the spike's open question, not something these tests can say.

The **adversarial reviewer** (`src/agent/reviewer.ts`) is the fourth, same status. It refuses to
review a patch unless the verify gate's result says `passed` *and* carries the hash of that
exact patch. The model lists the attacks it tried, each `held`, `flagged` or `broken`; **the
verdict is computed in code from those outcomes**, never taken from the model (any broken attack
blocks, any flag approves with flags), and a review with no attacks is an error rather than
"found nothing".

The state those stages need in order to run more than once safely exists too, and is also
run by the agent job, never run (`src/agent/cycle.ts`, tested on the emulator): one **cycle** per incident and
recurrence (so a regression gets a fresh fix and a retry cannot open a second PR for the same
one), a **lease** taken in a transaction (one worker at a time; a crashed worker's lease runs
out and another resumes, up to a configured number of starts; the lease can never be extended
past the cycle's deadline), and an append-only list of **run events** (each stage also writes its part of a **run record** on
the cycle itself, `summary.<stage>`, plus which way the cycle went, `path`: decline, notify, draft,
pr, human or failed, so a reader can tell a declined cycle from a notified one, a draft or an
opened PR, and a timeout, from that document alone; a stage that did not run has no entry) that only the current
lease holder can write (fenced inside the same transaction, so a worker that lost its lease can
record and finish nothing). Events are redacted and bounded, and `firestore.rules` let operators
and guests (for the demo environment) read them and nobody write them.

The **loop** that drives them (`src/agent/loop.ts`, tested on the emulator with the real cycle,
lease and verify gate and a scripted model) orders the stages for one cycle and wraps them in
what makes unattended running safe: it stops at the next step if an operator resolves or ignores
the incident or automation is switched off (asked before every stage and again just before
anything is opened); it allows **one revision**, shared between a failed verify and a blocking
review, then hands the cycle to a person; it stops at a **model-call budget**; it releases the
lease to retry when the evidence is missing or the model failed (bounded by the attempts cap); a
worker that loses its lease stops and opens nothing; and it is a **dry run by default**
(`STARFISH_DRY_RUN`): a verified, reviewed patch ends the cycle waiting for a person. Opening a
pull request is an interface keyed by the cycle id, so a retry after a timeout cannot open a
second one. Its implementation (`src/integrations/githubPr.ts`, #17) is built and tested with real
git against a bare repository and a fake GitHub API, and **has never run against GitHub**: it checks
that the API names the configured repository, returns the pull request that already exists for the
cycle's branch `starfish/<cycle id>`, reuses a branch an earlier call pushed only if it holds exactly
this change, pushes only to `refs/heads/starfish/<id>` (never forced, never the base branch), never
merges, passes the token to git in the environment and not on a command line, and refuses a patch whose
SHA-256 is not the one that was verified. The engine's check is a convention: that Starfish can write
only its own branches has to be enforced by branch protection or a ruleset on the repository, because
a GitHub App's permission cannot be scoped to a branch prefix. **Slack (#17), built, tested over local HTTP against a fake webhook, never run against real Slack:** a cycle that ends waiting for a person (triage said notify, the fixer declined, the verify gate or the review would not pass a second time) posts one message to one channel through an incoming webhook (`src/integrations/slack.ts`): what failed, why a person is needed, links to the incident and its run. Incident text is redacted, bounded and set as plain text, so it cannot add a mention or a link; a failed delivery is recorded on the cycle and never silent; retries are bounded and a refusal repeating cannot fix is not repeated; a dry run sends nothing and says so. Delivery is at-least-once (a crash between the post and its record posts again on resume). **The incident's GitHub issue (#17), built, tested against a fake GitHub API, never run against real GitHub:** for every incident the agent acts on or escalates (a declined one gets none) it files one issue (what is failing, the evidence, what Starfish will do, links to the incident and the run), found again after a crash by a marker in its body so a retry files no second; the pull request says `Closes #N` and the Slack message links it; a failure to file is recorded and the cycle goes on; a dry run files nothing. **Not built:** the `#ops-alerts` and `#ops-log` messages, phone escalation (#37), reconciling a later merge or CI result. The pieces of one *pass* over the store exist as plain functions (`src/agent/pass.ts`, #74): choosing open incidents with no settled cycle for their current recurrence, mapping a stack trace to files that really are in the repository (never a path read from the log, never `node_modules` or an excluded path, no guessing when a match is ambiguous), and a bounded driver that runs one cycle at a time and stops when cycles keep throwing. **Also built, not deployed:** `src/agent/assemble.ts` (a shallow clone of the base branch whose tip is the pinned revision, the log counter-check and samples, the files the trace names) and the entrypoint `pnpm agent` (`src/agentCli.ts`): dry run by default, and it **refuses to start** unless `STARFISH_VERIFY_ISOLATION=in-process` is set on purpose (`none` is the default), which means the target repo's tests run on that machine as that identity, not in a sandbox. **Isolation of the verify step (#74), decided and written, never run.** The verify step runs target-repository code, so the agent, which holds the store, Logging and Gemini credentials, never runs it. **The demo's choice, `STARFISH_VERIFY_ISOLATION=github-actions`:** the deterministic half of the gate (the patch applies, touches no excluded path such as `.github/`, adds no link) runs in the agent without executing anything; the patch is then pushed as one commit on `starfish/<cycle>` and the **target repository's own CI**, on GitHub's disposable runners, judges it: the named check runs (`STARFISH_VERIFY_CHECKS`) on that exact commit must all succeed, and a failed or cancelled one is a result the fixer sees once. This needs no new GCP resource, but the target's CI is now the judge *and* the sandbox: its workflow must run on pushes to `starfish/**` and reference no secret, and no other workflow may run on them. A branch is pushed even in a dry run (no pull request is). Tested against real git, a fake GitHub API and a fake CI; **never run against real GitHub or a real workflow**. **The heavier alternative, `cloud-run-job`:** the agent never runs the command; it packs the source and the patch into a bucket, hands a **separate Cloud Run job whose service account holds no roles** two per-run signed URLs, and waits for a result it then validates (typed, tied to the SHA-256 of the exact patch, a pass only on exit 0). It packs the source and the patch into a bucket, hands a **separate Cloud Run job whose service account holds no roles** two per-run signed URLs, and waits for a result it then validates (typed, tied to the SHA-256 of the exact patch, a pass only on exit 0). The job runs the command as an unprivileged user so the command cannot read the URL its result is written to. `scripts/deploy-gcp.sh` deploys the agent job and its Scheduler job with `DEPLOY_AGENT=1` (and, for `cloud-run-job`, the verify job and the bucket); the protocol is tested end to end against a local stand-in for the bucket with the real verify gate, but **Cloud Storage signing, the Cloud Run call, the image's privilege drop and the claim that the verifier can reach nothing have never been exercised on a real project**. The command can still use the network, so candidate code can send out the source it was given. Nothing has opened a pull request: the agent is a dry run and has never run against real GitHub, Cloud Logging or Gemini from a job. It is plain code, not on Google's Agent Development Kit: in `@google/adk` 2.2.0
`SequentialAgent`, the class #8 names, is deprecated in favour of `Workflow`, which is marked
experimental, so wrapping the loop in ADK is a decision still open.

**Missing-index heal (#11): only the deterministic front end exists.** `src/indexheal/createIndexUrl.ts`
finds the create-index URL in an error message, decodes it strictly into a spec (project, database,
collection group, scope, plain ascending or descending fields; array, vector and anything unknown are
refused and left to a person), checks the target against `STARFISH_INDEX_ALLOWED_TARGETS` (empty by
default, so nothing is allowed; Starfish's own database is refused even if listed), and compares the spec
with the repository's `firestore.indexes.json` (an unreadable file is "unknown", never "absent"). It is
tested on URLs **built here from the documented `Index` message, not captured from a real error**, which is
the first thing to check before wiring it to anything. **Nothing creates an index**: the Admin API call,
live-inventory dedup, operation tracking, quotas, the READY and recovery checks and the evidence PR are not
built. Ingest does classify a missing index as its own class, `MissingIndexError`: a failed precondition
whose text carries Google's create-index URL (the code and the URL, never the words alone); nothing acts on
that class yet.

What does **not** exist yet is the code that assembles an incident's inputs (the counter-check,
samples and a checkout of the target repo at a pinned revision), the incident's GitHub issue, the
reconsideration of a declined incident, and the disposable runner the verify gate needs. That is the work, and it is gated on one question the
[spike](docs/spike.md) exists to answer — does Gemini actually produce the patch a human
wrote?

```
src/
  config.ts          every deployment-specific value lives here, and only here
  vertex.ts          Vertex AI client
  spike.ts           the fix-quality spike
  scoreboard/        the results format and aggregation behind `pnpm scoreboard` (no run recorded yet: see scoreboard/FORMAT.md)
  ingest/            logs -> classified, deduped incidents + counter-check
  agent/             triage, fixer, verify gate, reviewer, cycle state and the loop: run by the agent job (`pnpm agent`), deployable and never run
web/                 operator UI: sign-in, incidents, settings
firestore.rules      what the UI may read and change (tested on the emulator)
fixtures/incidents/   spike fixtures (synthetic; see docs/spike.md)
docs/
  design/            the auto-merge policy, UI mockups (mockups.md, screens/, html/), the demo app proposal
  research/          self-healing systems: the literature, and where Starfish sits
  spike.md           what the spike measures and how to read it
```

## Development

```bash
pnpm install            # also points git at .githooks/
cp .env.example .env    # set GOOGLE_CLOUD_PROJECT
pnpm run verify         # the gate: lint · typecheck · test · build
pnpm test:emulator      # firestore.rules + store concurrency on the emulator (needs Java)
pnpm -C web dev         # operator UI on :5177 (copy web/.env.example to web/.env)
pnpm dev:emulated       # the UI against seeded local emulators, no GCP project needed
pnpm spike              # fix-quality spike (needs Vertex AI access)
pnpm scoreboard         # scoreboard/RESULTS.md from scoreboard/results/*.json; says so and writes nothing with no runs
```

To deploy to a project, follow [`docs/setup.md`](docs/setup.md): a read-only preflight
(`scripts/preflight-gcp.sh`), the ingest job and its schedule (`scripts/deploy-gcp.sh`), the first
admin (`pnpm grant-operator`), an end-to-end smoke test (`scripts/smoke-gcp.sh`), and the UI on its
own Hosting site (`scripts/deploy-web.sh`). Each script takes `DRY_RUN=1`. All of it is written and
tested against stubs and the emulators. On 2026-10-05 the preflight, the ingest deploy, `grant-operator`, the web deploy and the smoke test (a planted error read into the store by the deployed ingest, then retired) ran once against the demo project and worked, after two fixes (#103, #104); **the agent job has not run**. What the deploy
creates and the identities: [`docs/deploy.md`](docs/deploy.md).

Requires Node 22+ and a GCP project with the Vertex AI API enabled. Starfish keeps its
incident store in its own Firestore database, `starfish`, so its rules and indexes never
touch your app's database. Create it once (`gcloud firestore databases create
--database=starfish --location=<region>`), then `firebase deploy --only firestore` deploys
`firestore.rules` and `firestore.indexes.json` to that database alone.

Starfish is built with AI-assisted development (Claude Code); the git hooks, verify gate,
Claude Code hooks and skills live in the repo, with `CLAUDE.md` as the entry point. The
product itself runs on Gemini.
