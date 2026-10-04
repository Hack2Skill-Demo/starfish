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
| Watched project, environment label, log resource types, service patterns, noise list, and the pipeline switches (dry run, review required, model calls per cycle) | ⚠️ an admin edits them on the Settings page; the engine validates the saved document and applies it over the defaults, falling back to the last good one (`src/runtimeSettings.ts`). `firestore.rules` let only admins write it, each save in one batch with an immutable audit entry (before and after) and a separate operator copy; the engine's last-good copy and any secret-shaped key are closed to clients. The editor and the engine run the same validator (`src/settingsSchema.ts`). Rules check each list's shape and size but not each entry (they have no loops); the engine checks entries on read. Tested on the emulator, and the editor's own save is the one the rules suite runs. `pnpm ingest` reads it on each run (`src/ingest/run.ts`), and `scripts/deploy-gcp.sh` defines the scheduled job that runs it, but that script has **not been run against a real project yet** (#6), so until it has, a saved document is read only when someone runs `pnpm ingest`; secrets (Secret Manager and its endpoint). The three pipeline switches are stored and applied the same way, but **nothing runs the agent loop yet**, so today they change nothing; the verify command, its timeout and the excluded paths stay environment-only on purpose (an editable command would be code execution on the engine host, and the excluded paths guard the judge). Single-target: one watched project per deployment |
| Vertex project, model and region | ⚠️ environment only (`STARFISH_VERTEX_PROJECT_ID`, defaulting to `GOOGLE_CLOUD_PROJECT`, so Gemini can run in a different project from the store): `vertex.ts` reads them itself, so a settings document can't change them yet |
| Firebase project the UI connects to | ✅ read at startup from Hosting's `/__/firebase/init.json`, so one build serves any project (`VITE_FIREBASE_*` is the local-dev fallback). Untested against a real Hosting site until the deploy path (#6) exists |
| UI environment label | ✅ follows the runtime settings once signed in (the build-time `VITE_STARFISH_ENV` is the fallback when none is set or the read fails) |
| UI collections and region | ⚠️ still `VITE_*`, baked in at build time |
| Collection names in `firestore.rules` | ⚠️ hardcoded `incidents` / `starfish_users`; rules can't read config, so a renamed collection means editing the rules file |
| Dry run, review required, model-call budget | ⚠️ environment defaults (`STARFISH_DRY_RUN` on by default, `STARFISH_REVIEW_REQUIRED`, `STARFISH_MODEL_CALL_BUDGET`) that an admin can override on the Settings page (first row); the loop reads them, no job runs it |
| Agent cycle collection, lease length, cycle deadline, attempts | ⚠️ environment only (`STARFISH_CYCLE_COLLECTION`, `STARFISH_LEASE_SECONDS`, `STARFISH_CYCLE_DEADLINE_MINUTES`, `STARFISH_MAX_CYCLE_ATTEMPTS`); the rules name `starfish_cycles` too |
| Ingest lag, longest window, run-record collection | ⚠️ environment only (`STARFISH_INGEST_LAG_MINUTES`, `STARFISH_INGEST_MAX_WINDOW_HOURS`, `STARFISH_RUN_COLLECTION`); the rules name `starfish_runs` too |
| Services Starfish never ingests (its own) | ✅ config (`STARFISH_EXCLUDED_SERVICES`, default `starfish`), applied at query time and at parse time; environment-only on purpose, because it guards against a feedback loop and is not an operational preference. Set it to the name Starfish is actually deployed under; nothing is deployed yet (#6, #32) |
| Log source resource types | ⚠️ config, but attribution reads only `function_name` / `service_name`, so only Cloud Functions and Cloud Run work |
| Framework-noise suppression list | ✅ config, callable GET-probe noise by default |
| Deployment: project, region, schedule, the watched and Gemini projects, the environment label | ✅ environment variables of `scripts/deploy-gcp.sh`; no file is edited. Written, **not yet run against a real project** (#6) |
| Incident store | ❌ assumes Firestore |
| Verify-gate command, timeout and excluded paths | ⚠️ environment only (`STARFISH_VERIFY_COMMAND`, `STARFISH_VERIFY_TIMEOUT_SECONDS`, `STARFISH_PATCH_EXCLUDED_PATHS`); `src/agent/verifyGate.ts` reads them, but no job calls it yet |

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

**Mostly designed, not built.** The operator UI today has sign-in, the incidents table, an
editable settings page and a **Runs** page. The mockups below show where it is going and how the
demo runs.

- **Live runs:** a first version is built: the **Runs** page lists the agent's cycles and draws
  each one's steps (triage, fix, verify, review, pull request) from the events the engine records,
  live. A step with no event reads "not reached", and a run with no worker holding it is not shown
  as in progress. **Nothing runs the agent loop as a job yet, so on a real deployment the page is
  empty;** it is exercised against the emulator with seeded data. Not built: the mockup's header
  (path rule, engine health), the Slack, GitHub-issue, index, deploy, phone and recovery steps (the
  loop has no code for them), and the four MVP cases observed end to end (#33 stays open).
- **Overview:** what needs a human, and what was handled.
- **Slack messages and GitHub issue/PR bodies:** what Starfish posts elsewhere.
- **Pre-recorded phone call:** to the on-call person when Slack goes unanswered.
- **Settings:** connections, the engine's rules and on-call.

The Incidents page opens with a line saying whether the engine is running (from the engine's last-run record: failed, stopped past a configurable threshold, read capped, or never recorded), so a quiet list can't pass for good news; nothing writes that record in production until the ingest job is deployed and scheduled: `scripts/deploy-gcp.sh` does both but has not been run against a real project yet (#6).

The public demo needs no sign-in: a visitor is signed in anonymously and sees the incidents and a view-only Settings page, with no triage buttons (#12). That needs Anonymous sign-in enabled in the Firebase project and only `demo`-labelled data; App Check, the seeded evidence history and the uptime check are not built. A private deployment leaves Anonymous sign-in disabled and still requires an operator account.

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
| Cloud Scheduler | starts that job on a cron (`SCHEDULE`, hourly by default) | in the deploy script; not deployed |
| Secret Manager | the GitHub token the pull-request step will need | secret, access grant and mount are in the deploy script; **nothing in the engine reads it yet**, because the step that opens pull requests is not built |
| Cloud Build, Artifact Registry | build the image (`gcloud run jobs deploy --source`) | in the deploy script; not deployed |
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
  `store.emulator.test.ts`). A read that hits the 5,000-entry cap is flagged on the run record,
  not called complete. `pnpm ingest` runs this once; the Cloud Run job and Scheduler that would run it on a schedule are written (`scripts/deploy-gcp.sh`) but not yet deployed anywhere (#6). The checkpoint
  is per (watched project, environment) and is not carried over when settings change either
- an admin can retire an incident (`src/ingest/retire.ts`): it is closed for good with its history
  kept, its incident key is removed, and the same error firing again opens a **new** incident
  instead of coming back as `recurred`. One transaction does it together with an audit entry
  (`starfish_audit`, admin-readable, engine-written), so a retire racing an occurrence loses none
  (`retire.emulator.test.ts`). Admin is checked from the operator record, not from anything the caller
  passes. **Not built:** the endpoint or admin action that calls it (the demo's reset script needs
  one), and the fast-revert watch (#9) it is meant to disarm; `retired` is the flag that watch must
  honour
- ingest can be run on demand by an admin (`src/ingest/trigger.ts`): the **same** `runIngest` as a scheduled
  run (same windows, checkpoint and last-run record, and two together converge), behind an admin check
  made from the operator record and an audit entry written before the run. **Not built:** the endpoint
  or Settings action that calls it, and the short schedule for recording the demo, which is the `SCHEDULE` of
  the deploy script (#6), not yet deployed; a setting nothing reads would be a control that does nothing
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
outside the incident collection, and it finds only what the pattern list finds. There is no
Slack, issue/PR or judge-facing output yet, so the output allowlist for those surfaces is
still to be built with them (issue #18).

Alongside it, the **counter-check** (`src/ingest/counterCheck.ts`): an independent raw-log
recount of a function's errors over 24h, plus a few redacted recent samples. Nothing calls it
in a run yet; the triage stage below consumes what it produces.

The first stage of the half that acts exists as a **tested contract** and nothing more: triage
(`src/agent/triage.ts`) decides act / notify / decline for one incident. It skips an incident
that isn't open, defers when the counter-check is missing (missing is not zero), declines a
counter-check of zero without asking the model, validates the model's answer locally and
fails closed, and redacts and bounds both what the model is shown and what it returns. It is
tested with a stubbed model; **no job runs it**, the counter-check isn't fed to it by any run,
and it is not on Google's Agent Development Kit yet.

The **verify gate** (`src/agent/verifyGate.ts`) is also built as a function and tested for real
(real `git apply`, real child processes), and also run by no job. Given a checkout and a
patch it applies the patch in a scratch copy without `.git` or `node_modules`, compares the
trees to see what *actually* changed, and refuses a change to CI or secrets or any path the
deployment excluded (the files that define the verify command and the tests), a symbolic link,
a changed file mode, or too many files, all before running anything. Only then does it run the
configured command with a scrubbed environment and a timeout, and reports bounded, redacted
output tied to the SHA-256 of the exact patch. **It is not a sandbox:** the command runs as this
process's user with the machine's network and filesystem, so it belongs on a disposable runner
that holds no credentials, which is infrastructure that does not exist yet (#8).

The **fixer** (`src/agent/fixer.ts`) is the third stage as a contract, run by no job: given an
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
run by no job (`src/agent/cycle.ts`, tested on the emulator): one **cycle** per incident and
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
second one; **no implementation of it exists**, because there is no GitHub App yet (#17). No job
runs the loop. It is plain code, not on Google's Agent Development Kit: in `@google/adk` 2.2.0
`SequentialAgent`, the class #8 names, is deprecated in favour of `Workflow`, which is marked
experimental, so wrapping the loop in ADK is a decision still open.

What does **not** exist yet is the code that assembles an incident's inputs (the counter-check,
samples and a checkout of the target repo at a pinned revision), the pull-request opener, the
reconsideration of a declined incident, and the disposable runner the verify gate needs. That is the work, and it is gated on one question the
[spike](docs/spike.md) exists to answer — does Gemini actually produce the patch a human
wrote?

```
src/
  config.ts          every deployment-specific value lives here, and only here
  vertex.ts          Vertex AI client
  spike.ts           the fix-quality spike
  ingest/            logs -> classified, deduped incidents + counter-check
  agent/             triage, fixer, verify gate, reviewer, cycle state and the loop: run by no job yet
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
```

To deploy the ingest job and its schedule to a project (needs `gcloud`; `DRY_RUN=1` prints every
command and changes nothing): `PROJECT_ID=<project> scripts/deploy-gcp.sh`. What it creates, the
identities and what to check after: [`docs/deploy.md`](docs/deploy.md).

Requires Node 22+ and a GCP project with the Vertex AI API enabled. Starfish keeps its
incident store in its own Firestore database, `starfish`, so its rules and indexes never
touch your app's database. Create it once (`gcloud firestore databases create
--database=starfish --location=<region>`), then `firebase deploy --only firestore` deploys
`firestore.rules` and `firestore.indexes.json` to that database alone.

Starfish is built with AI-assisted development (Claude Code); the git hooks, verify gate,
Claude Code hooks and skills live in the repo, with `CLAUDE.md` as the entry point. The
product itself runs on Gemini.
