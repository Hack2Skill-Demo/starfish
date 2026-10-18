# Implementation notes: the long, dated narrative

> Moved verbatim from the README's "Google Cloud stack" and "Status" sections (#391), so no detail is lost. **Read it as a
> dated narrative, not as the current state:** each sentence was true when written and carries the dates and issue numbers of
> that moment; some are stale, and the README's problem was that it read as if all were current. The dated summary of what
> is implemented, tested, validated against a real service and observed running, with the evidence for each, is
> [status.md](status.md); when the two differ, status.md is the one that was checked.

## Google Cloud stack
What each service does here, and how far it had got when this was written. "Written" means the code or script exists and
is tested; "deployed" means it has run in a real project: the ingest half and the web UI, once, on the demo project
(2026-10-05, #6), the admin API once, on 2026-10-07, and the agent job, on 2026-10-07; on 2026-10-10 the Deploy engine workflow redeployed all three, and the agent has run since with dry run off and auto-merge on for the demo target. Real incidents have gone through it, on 2026-10-12 and 2026-10-13, as far as a pull request on the demo app (demo-app #41, #42 and #49); nothing has been merged.

| Service | Used for | Status |
|---|---|---|
| Vertex AI (Gemini) | triage, fix drafting, adversarial review | built as stages, tested with a stubbed model; the deployed agent has run them on real Gemini on the demo project since 2026-10-08 (triage and fix drafting from then; the review first on 2026-10-12, in the run that opened demo-app #41) |
| Cloud Logging | the errors Starfish watches | built (ingest) |
| Firestore (its own `starfish` database) | incidents, settings, cycles, run records | built; rules and store tested on the emulator |
| Firebase Auth | operator sign-in, guest view | built |
| Cloud Run (a job) | runs one ingest per tick, as its own least-privilege service account | `Dockerfile` and deploy script written; deployed on the demo project from a terminal (2026-10-05), and redeployed by the Deploy engine workflow since 2026-10-10 |
| Cloud Run (a service): the admin API | "Run ingest now", "Run agent now" (#276) and Retire for an admin, from the UI (`DEPLOY_ADMIN_API=1`) | in the deploy script; deployed to the demo project from a terminal (2026-10-07), redeployed by the Deploy engine workflow since 2026-10-10, and "Run ingest now" ran from the UI; Retire, the Twilio routes and "Run agent now" (built later, never run against real Cloud Run) not tried. The public demo's open actions for visitors (off by default, per-address hourly limits) are built and tested with stubs and the emulator, never deployed |
| Cloud Run: agent job and verify job, Cloud Storage bucket | the agent runs triage → fix → review; the target's tests run only in a separate job whose service account holds no roles, fed through the bucket (`DEPLOY_AGENT=1`) | in the deploy script (`docs/deploy.md`); the agent job is deployed on the demo project (2026-10-07) and runs hourly; the verify job and bucket (`cloud-run-job` isolation) have never been deployed, since the demo's verify step runs in the target's own CI (`github-actions`) |
| Cloud Scheduler | starts that job on a cron (`SCHEDULE`, hourly by default) | in the deploy script; deployed on the demo project (the ingest's tick 2026-10-05, the agent's hourly tick 2026-10-07) |
| Secret Manager | the GitHub token the pull-request step uses; the Slack webhooks and Twilio's credentials (#37) the same way, in secrets of their own | secret, access grant and mount are in the deploy script, and `loadGithubToken()` reads it; the opener is tested against a local git remote and a fake API, and has run against real GitHub: the agent job files issues on the demo app and opened a pull request there on 2026-10-12; its only caller is the agent job |
| Firebase Hosting | the operator UI, on its own site (not the project's default one) | `scripts/deploy-web.sh` and the Hosting config written; deployed once, on the demo project (2026-10-05), from a terminal; the Actions workflow (Deploy web UI) ran twice on 2026-10-10 and both runs failed before publishing anything (#265) |
| Cloud Build, Artifact Registry | build the image (`gcloud run jobs deploy --source`; one build per job) | in the deploy script; used by the demo project's deploys (from a terminal on 2026-10-05 and 2026-10-07, by the Deploy engine workflow since 2026-10-10) |
| Cloud Monitoring | a second signal beside logs (see the blind spot above) | built and tested against fakes; off by default (`STARFISH_MONITORING_ENABLED`); never run against real Cloud Monitoring; the deploy script grants its role only with `STARFISH_MONITORING_ENABLED=true` |

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
  `store.emulator.test.ts`). A window is read oldest first, a page at a time, each page reduced to parsed
  entries before the next is read; a read that hits the 5,000-entry cap, or 64 MB of entries
  (`STARFISH_INGEST_READ_BUDGET_MB`, #296: a Cloud Logging entry can be 256 KB, and a burst of large ones ran the
  512Mi job out of memory on every replay), writes nothing and narrows the pending window to the part it read in
  full, and the rest is read by the windows after it (#127). A window with more than that in its first
  millisecond, or one an earlier attempt already began writing (narrowing it would give it a new id and count
  those writes again, #199), is processed as read and flagged capped on the run record. A pending window three
  attempts in a row did not finish (failed, timed out or killed) is split in half before the next attempt, when
  nothing was written under it (#296). A narrowing does not use up one of a run's eight windows; the run budget
  bounds those (#297). The run record says how far the checkpoint is behind the newest logs it could read, and
  `pnpm status` and the UI's engine line call the ingest "behind" past twice the schedule's interval
  (`STARFISH_INGEST_BEHIND_MINUTES` / `VITE_STARFISH_BEHIND_MINUTES` to set it), so a flood that outpaces the runs
  no longer reads as ok (#297). Built and tested against a fake Logging and the emulator; no flood has gone through
  the deployed job. `pnpm ingest` runs this once; the Cloud Run job and Scheduler that run it on a schedule (`scripts/deploy-gcp.sh`) were deployed once, to the demo project (2026-10-05, #6). The checkpoint
  is kept per (watched project, environment) in its own document, so moving the engine to another target
  and back resumes where the first one stopped instead of re-reading its lookback (#198). A run whose
  settings document could not be read or is invalid, with no earlier good one to fall back to, reads
  nothing: it records a failed run (`settings-unusable`) rather than ingest the environment defaults'
  target, which may not be the one the admin chose; the UI's engine line and `pnpm status` both show that
  record as failed, whatever environment it names (#223). With no settings document at all the defaults are the
  configuration, and the run goes ahead
- an admin can retire an incident (`src/ingest/retire.ts`): it is closed for good with its history
  kept, and the same error firing again after the retire opens a **new** incident instead of coming
  back as `recurred`. Its incident key stays as a tombstone, so a window replayed after the retire
  still counts once, and occurrences from before the retire that ingest reads late are counted on the
  retired incident without reopening it (#197). One transaction does it together with an audit entry
  (`starfish_audit`, admin-readable, engine-written), so a retire racing an occurrence loses none
  (`retire.emulator.test.ts`). Admin is checked from the operator record, not from anything the caller
  passes. The admin API (`src/adminApi.ts`, a Cloud Run service, `DEPLOY_ADMIN_API=1`) is the endpoint the demo's reset script
  calls: built, tested with stubs and over local HTTP, deployed once to the demo project (2026-10-07). The UI has the three controls for admins (`Retire` on an incident, `Run ingest now` on Incidents, `Run agent now` on Runs, #276), shown only when the site is built with `VITE_STARFISH_ADMIN_API_URL`; unit-tested with stubs; "Run ingest now" ran once from the deployed UI against the deployed service, Retire and "Run agent now" have not been tried there. The fast-revert watch (#9, `src/agent/fastRevert.ts`, built, never run against real GitHub) honours
  `retired`: a retired incident never triggers a revert
- ingest can be run on demand by an admin (`src/ingest/trigger.ts`): the **same** `runIngest` as a scheduled
  run (same windows, checkpoint and last-run record, and two together converge), behind an admin check
  made from the operator record and an audit entry written before the run. The admin API (see above) is the endpoint that calls it: deployed once to the demo project (2026-10-07); the Incidents page has a "Run ingest now" button for admins when the site knows the admin API's URL, and it ran once from the deployed UI as an admin. Retire has not been tried against the deployed service. The short schedule for recording the demo is the `SCHEDULE` of
  the deploy script (#6; the ingest job is deployed to the demo project, from a terminal on 2026-10-05 and by the Deploy engine workflow since 2026-10-10, and `scripts/ingest-cadence.sh` changes the tick); a setting nothing reads would be a control that does nothing
- an agent pass can be started on demand by an admin (`src/agent/trigger.ts`, #276): the admin API starts the **deployed agent job**
  itself, the one its schedule starts (`POST /api/agent/run`, `src/agent/agentJob.ts`), behind the same admin check and an audit entry
  written before the start. The pass runs as the agent's own account with its own switches, caps and leases, so a click is one
  tick, early; the admin API holds none of the agent's credentials, only the right to start that one job. The Runs page has a
  "Run agent now" button for admins; it reports that the pass started, not what it did. An admin's "Retry with agent" on a
  run starts the same pass right after recording the retry, so it runs without waiting for the schedule (an operator's retry
  waits for the next pass). Built; tested with stubs and the emulator; never run against real Cloud Run
- a fingerprint ignores what varies per occurrence (ids, paths, timestamps, counts) but not
  what makes a bug distinct (status codes, quoted property names), and treats a function's
  first- and second-generation spellings as one
- credentials (bearer tokens, JWTs, API keys, signed-URL parameters) are redacted from
  everything stored and everything sent to the model, not just the counter-check samples
- a log's `error` field is kept apart from its title: the title keys the fingerprint, the
  error is the cause a fixer needs
- a stack trace the logger wrote INSIDE the message (the firebase-functions logger does, #361) is split off at its first
  frame line: the title alone is fingerprinted, classified and shown to guests, and the frames are the incident's stack.
  When the fingerprint code changes, `pnpm rekey` gives stored incidents the new fingerprint and key (#362; a dry run by
  default, `pnpm rekey -- --apply --project=<id>` writes). Built and emulator-tested; never run on a real project

- one redaction policy (`src/ingest/redact.ts`) covers emails, credentials and phone numbers: token
  shapes (JWTs, bearer headers, Google/GitHub/AWS/Slack/Stripe keys), private keys,
  URL credentials, the whole value of an `Authorization` header (scheme and credential, `Basic` included)
  and of a `Cookie`/`Set-Cookie` header (every cookie, to the end of the line), credential-named
  `key=value` pairs (also `session`/`sessionId`, `sid`, `otp`, `pwd`, `pass`, and in escaped JSON such as
  `{\"password\":\"…\"}`), and phone numbers written with a `+` country code (a national number with no `+`
  is not caught, by design: it cannot be told from an id). The store re-applies it on
  every write, so no caller can persist a seeded secret; the model prompt, model error
  messages and the spike's printed output go through it too (`redact.test.ts`)
- what the agent loop records and sends is checked end to end: one emulator test runs a whole
  cycle with every seeded credential planted in the incident's message, detail and stack, the source
  files, the verify command's output and each model answer, and asserts none of them appears in a
  prompt, a stored cycle or event, or the pull request opener's payload (`loop.emulator.test.ts`).
  The patch itself is the exception: it is a diff of the repository's own files, goes only to a pull
  request in that repository, and the fixer refuses a patch that *adds* a credential shape
  (a secret already sitting in a context or removed line is not caught)

<a id="redaction-limits"></a>**Redaction limits.** It is pattern matching: a credential in a format nobody listed will
get through, and free-form PII (names, addresses, record ids) is not detectable at all —
`truncate` bounds how much raw text leaves, it does not clean it. The store redacts new
writes; incidents stored **before** the policy are scrubbed in place by `pnpm scrub` (a dry
run that counts what it would change; `pnpm scrub -- --apply --project=<id>` rewrites, and
refuses unless the project matches `GOOGLE_CLOUD_PROJECT`). It redacts the same eight fields the
store does (message, cause, stack trace, error name, service, error code, tenant id, request id; the last five bounded
as the store bounds them), recomputes each changed record's fingerprint (the store fingerprints the redacted
text, so otherwise the next occurrence would fork a duplicate), removes the stale incident
key, and is safe to re-run (`scrub.test.ts`, `scrub.emulator.test.ts`). Run it before real
data is exposed to anyone. It does not touch Firestore exports or backups, logs, or anything
outside the incident collection, and it finds only what the pattern list finds. Cycles and their run events are
not scrubbed: they were redacted on write from the start, and guests never read them (a verify event's `output` written
before text was redacted ahead of being cut may hold a fragment of a secret, readable by operators only). Neither
`pnpm scrub --apply` nor `pnpm public-view --apply` has been run on the demo project yet.

**Every outbound text is a fixed template over named, redacted, bounded fields (#18).** Both Slack messages (`needs a
human` and the `#ops-alerts` new-incident message), the GitHub issue, the pull request, the merge commit, the evidence
comment and the revert PR are built that way, and a whole-cycle emulator test seeds credentials and an email into the
incident, the source, the verify output and the model's words and asserts none reaches any of them, a prompt, the cycle
or its events. Twilio texts carry only a link built from a plain id, or a code. Text cut to a bound is redacted BEFORE
the cut (`redactTail` / `redactHead` in `src/ingest/redact.ts`): cut first, a secret straddling the cut lost the prefix
its pattern needs and survived.

**What a guest reads is an allowlist (#18).** A guest (an anonymous session on the public demo) never reads a stored
incident, cycle or run event. For each one in a public environment (`STARFISH_PUBLIC_ENVIRONMENTS`, `demo` by default)
the engine writes a **trimmed copy** (`src/publicView.ts`: one function per kind, each naming every field it copies and
checking each value's shape) to `starfish_public_incidents`, `starfish_public_cycles` and `starfish_public_events`, and
`firestore.rules` let a guest read only those; nobody writes them from a client. A copy holds ids, statuses, counts,
times, the function and service names, the error type and code, a bounded one-line title, the issue and pull-request
number, link and state, and from the run record only its enumerated, numeric and hash values. It never holds error
detail, stack traces, tenant or request ids, the counter-check's log filter, the model's words (triage's reason, the
fix's root cause and risk, the review's attacks), patches, or event payloads; an event keeps its one-line summary only
for the stages whose summaries the engine writes in its own words. An event's copy is written in the same transaction
as the event; an incident's or a cycle's is refreshed right after each engine write from what was committed (its
updates are increments and field deletes, so the result is only known then), a retired incident's is deleted in the
retire's transaction, and the ingest and agent jobs sweep the newest 50 of each after every run for changes the engine
did not make (an operator's triage). Records stored before the copies existed get theirs from `pnpm public-view` (a dry
run; `-- --apply --project=<id>` writes, and also removes copies whose record is gone, retired or private);
`pnpm seed-demo --apply` writes its synthetic history's copies in the same batches. Built and tested (unit tests that
plant seeded credentials and personal-looking text in every source field, the emulator for the writes and the rules);
**never run on a real project**. The title, the function and service names and the engine's own event lines are the
free text a copy keeps: redacted again and bounded, but free-form personal data in them still gets through, so keep the
public demo's data synthetic.

Alongside it, the **counter-check** (`src/ingest/counterCheck.ts`): an independent raw-log
recount of a function's errors over 24h, plus up to three redacted recent samples: entries,
among the function's 50 newest errors, whose fingerprint (recomputed the way ingest computes it) is
the incident's, so an error with another fingerprint in the same function is never shown as this one (#304). The
agent's assemble step calls both; the samples are shown to the model as untrusted data and never
choose which source files the fixer sees (only the incident's own stack trace does).

The first stage of the half that acts exists as a **tested contract** and nothing more: triage
(`src/agent/triage.ts`) decides act / notify / decline for one incident. It skips an incident
that isn't open, defers when the counter-check is missing (missing is not zero), declines a
counter-check of zero without asking the model (except a Monitoring-only incident, whose zero is
expected; and that one is turned from act to notify when it carries no cause evidence), sends an overflow or a
consolidated Cloud Run quota incident to a person (notify) without asking the model, validates the model's answer locally and
fails closed, and redacts and bounds both what the model is shown and what it returns. It is
tested with a stubbed model; the agent job (`pnpm agent`, deployed with `DEPLOY_AGENT=1` to the demo project, where it has triaged real incidents with Gemini since 2026-10-08, with dry run off since 2026-10-10) runs it and takes the counter-check itself,
and it is not on Google's Agent Development Kit yet.

The **verify gate** (`src/agent/verifyGate.ts`) is also built as a function and tested for real
(real `git apply`, real child processes). On the demo project the agent job runs its checks that execute nothing, which have
judged real patches since 2026-10-12 (#317), and with `github-actions` isolation the target's own CI runs the command; with
`cloud-run-job` isolation the verify job would run the whole gate (never run). Given a checkout and a
patch it applies the patch in a scratch copy without `.git` or `node_modules`, compares the
trees to see what *actually* changed, and refuses a change to CI, secrets, the package manifest and
lockfiles, common test, type-check and lint configs, or any path the deployment excluded (any other
file that defines the verify command or the tests must be listed there), a symbolic link,
a changed file mode, or too many files, all before running anything. Only then does it run the
configured command with a scrubbed environment and a timeout, and reports bounded, redacted
output tied to the SHA-256 of the exact patch. **It is not a sandbox:** the command runs as this
process's user with the machine's network and filesystem, so it belongs on a disposable runner
that holds no credentials, which is infrastructure that does not exist yet (#8).

The **fixer** (`src/agent/fixer.ts`) is the third stage as a contract, run by the agent job (on the demo project; its first fixes, in dry run on 2026-10-08, declined for want of source, #259;
since 2026-10-12 its patches have reached pull requests there, demo-app #41, #42 and #49; corrected 2026-10-17: Starfish merged none, a person merged #49 and #41, see status.md): given an
incident and the source files the caller chose to show it, it returns a unified diff with its
root cause, risk and rejected alternatives, or honestly declines (an empty patch means "I lack
the context", an outcome and not an error). It fails closed on a malformed answer, a patch
that isn't a unified diff, one over the size limit, or one that *adds* credential-shaped text,
and redacts what it shows and what it returns. It applies and runs nothing; the verify gate
judges. Tested with a stubbed model; whether Gemini actually writes patches a human would is
still the spike's open question, not something these tests can say.

Which source it is shown comes from the stack trace's frames, matched against the repository's own file
list. A callable that fails through `logger.error` or an `HttpsError` logs only firebase-functions' own
frames, so for those the loader falls back to the function's name (#259, `src/agent/sourceByName.ts`):
`orders-createOrder` -> the one file that defines `export const createOrder` (or `export function`, a
local `export { … }`, `exports.createOrder =`), under `STARFISH_FUNCTIONS_SOURCE_ROOTS` (default: the whole
checkout). Several such files that the group does not tell apart, or a repository larger than the search
reads (2,000 code files), show nothing rather than a guess. The run record says which rule found the source
(`summary.fix.source`: `stack`, `function-name` or `none`), and a file found by name never counts as a
structural cause for auto-merge. Built and unit-tested; not yet run on a real incident.

The **adversarial reviewer** (`src/agent/reviewer.ts`) is the fourth, tested with a stubbed model and run by the agent
job on the demo project (first on a real incident on 2026-10-12, in the run that opened demo-app #41). It refuses to
review a patch unless the verify gate's result says `passed` *and* carries the hash of that
exact patch. The model lists the attacks it tried, each `held`, `flagged` or `broken`; **the
verdict is computed in code from those outcomes**, never taken from the model (any broken attack
blocks, any flag approves with flags), and a review with no attacks is an error rather than
"found nothing".

The state those stages need in order to run more than once safely exists too, and is also
run by the agent job on the demo project (`src/agent/cycle.ts`, tested on the emulator): one **cycle** per incident and
recurrence (so a regression gets a fresh fix and a retry cannot open a second PR for the same
one), a **lease** taken in a transaction (one worker at a time; a crashed worker's lease runs
out and another resumes, up to a configured number of starts; the lease can never be extended
past the cycle's deadline), and an append-only list of **run events** (each stage also writes its part of a **run record** on
the cycle itself, `summary.<stage>`, plus which way the cycle went, `path`: decline, notify, draft,
pr, human or failed, so a reader can tell a declined cycle from a notified one, a draft or an
opened PR, and a timeout, from that document alone; a stage that did not run has no entry) that only the current
lease holder can write (fenced inside the same transaction, so a worker that lost its lease can
record and finish nothing). Events are redacted and bounded, and `firestore.rules` let operators
read them and nobody write them; guests read only their trimmed copies (#18).

The **loop** that drives them (`src/agent/loop.ts`, tested on the emulator with the real cycle,
lease and verify gate and a scripted model) orders the stages for one cycle and wraps them in
what makes unattended running safe: it stops at the next step if an operator resolves or ignores
the incident, and pauses the cycle (lease released, the attempt not counted) if automation is
switched off (asked before every stage, before verify, before a person is told, and again just before anything is opened;
a pass with automation off starts no cycle); it renews its lease while it works, a long verify
wait included; it allows **one revision**, shared between a failed verify and a blocking
review, then hands the cycle to a person; it stops at a **model-call budget** and hands the cycle to a person (both counted on the
cycle across its attempts, so a retry does not reset them; a triage decided without the model costs nothing); it releases the
lease to retry when the evidence is missing or the model call failed (bounded by the attempts cap
and the deadline, and a person is told when either gives the cycle up); a
worker that loses its lease stops and opens nothing; and it is a **dry run by default**
(`STARFISH_DRY_RUN`): a verified, reviewed patch ends the cycle waiting for a person. Opening a
pull request is an interface keyed by the cycle id, so a retry after a timeout cannot open a
second one. Its implementation (`src/integrations/githubPr.ts`, #17) is built and tested with real
git against a bare repository and a fake GitHub API, and **has run against real GitHub since 2026-10-12** (it opened
demo-app #41 and #42): it checks
that the API names the configured repository, returns the pull request that already exists for the
cycle's branch `starfish/<cycle id>`, reuses a branch an earlier call pushed only if it holds exactly
this change, pushes only to `refs/heads/starfish/<id>` (never forced, never the base branch), does
not merge (merging is the separate auto-merge step below), passes the token to git in the environment and not on a command line, and refuses a patch whose
SHA-256 is not the one that was verified. The engine's check is a convention: that Starfish can write
only its own branches has to be enforced by branch protection or a ruleset on the repository, because
a GitHub App's permission cannot be scoped to a branch prefix. **Slack (#17), built, tested over local HTTP against a fake webhook, posting to real Slack since 2026-10-11:** a cycle that ends waiting for a person (triage said notify, the fixer declined, the verify gate or the review would not pass a second time) posts one message to one channel through an incoming webhook (`src/integrations/slack.ts`): what failed, why a person is needed, links to the incident and its run. Incident text is redacted, bounded and set as plain text, so it cannot add a mention or a link; a failed delivery is recorded on the cycle and never silent; retries are bounded and a refusal repeating cannot fix is not repeated; a dry run sends nothing and says so. Delivery is at-least-once (a crash between the post and its record posts again on resume). **The incident's GitHub issue (#17), built, tested against a fake GitHub API, filing on real GitHub since 2026-10-12:** for every incident the agent acts on or escalates (a declined one gets none) it files one issue (what is failing, the evidence, what Starfish will do, links to the incident and the run), found again after a crash by a marker in its body so a retry files no second; when a resolved incident fails again while its earlier issue is still open, the recurrence is posted on that issue as a comment instead of a new issue (#397, tested against a fake GitHub API, not yet run on real GitHub); the pull request says `Closes #N` and the Slack message links it; the issue and the pull request are also linked from the incident on the Incidents page (`src/agent/incidentLinks.ts`), and a `new` incident becomes `logged` with that link (any other status is kept; a merged PR never makes one `resolved`); a failure to file is recorded and the cycle goes on; a dry run files nothing. **The `#ops-alerts` "new incident" message (#17), built the same way and tested the same way, posting to real Slack since 2026-10-11:** an optional second webhook (`STARFISH_SLACK_WEBHOOK_ALERTS`, its own secret) gets one message for every cycle the agent acts on or escalates, recorded on the cycle as pending/sent/failed. **Reading a pull request back (#17), built, tested against a fake GitHub API and the Firestore emulator, not yet confirmed against real GitHub:** each agent pass polls a bounded number of the pull requests earlier cycles opened (`src/agent/reconcile.ts`): open, closed or merged, and the named checks (`STARFISH_VERIFY_CHECKS`) on the PR's head, recorded on the cycle and shown on the Runs and evidence pages ("merged 2h ago · checks passed", or "not checked since it was opened"), and the PR's state on the incident's link. Read-only; a later read never moves a merge back; a merged PR never marks the incident healed. **Auto-merge and fast-revert (#9), built for the demo target behind default-off switches, tested against real git with a fake GitHub API and against the Firestore emulator, never run against real GitHub:** only where Gemini's triage named one of the admin's merge cases (`src/agent/triage.ts`), and auto-merge may apply to it, the loop runs the safety floor on the proposed patch (`assessMergeFloor`, `src/agent/blastRadius.ts`) and runs the patch's test files alone on the base revision through the same verifier, recording whether they fail before the fix (reported in the evidence, not required); when it opens the pull request it records a candidate with the case. The missing-index path records its evidence pull request as a candidate when the admin lists the `missing-index` case. Each agent pass then takes candidates to merged or to a person (`src/agent/autoMerge.ts`): the switches, the case still listed and the incident's status read fresh, the floor as recorded, the PR still open with the head Starfish built, every named required check a success on that head, today's merges under `STARFISH_MAX_MERGES_PER_DAY` (3), the evidence posted on the PR as one comment, then a squash merge naming that exact head. A merge starts the fast-revert watch (`src/agent/fastRevert.ts`): the same incident seen again later than a grace (`STARFISH_FAST_REVERT_GRACE_MINUTES`, 10) and within `STARFISH_FAST_REVERT_MINUTES` (60) of the merge opens a revert of Starfish's own merge commit and merges it once its checks pass; a later commit to the same files escalates instead, and a revert is never reverted. A watch that saw nothing closes only once ingest has read the logs through its window (still unread a day later, a person is told and nothing is reverted), and no second fix for the same incident is auto-merged while an earlier merge's watch is open. **What it cannot see:** when the target's deployment finishes, so the window starts at the merge, not at the deploy (#9 keeps that open); and with `github-actions` isolation "fails before" is the target's CI failing on the test-only commit, which cannot tell a failing assertion from a test that does not compile. Nothing marks an incident healed. **Phone escalation (#37), built, tested against a fake Twilio and the Firestore emulator, never run against real Twilio; off by default:** when a cycle that needs a person (triage said notify or act, and it ended waiting for one) has had its "needs a human" Slack message out for the on-call policy's wait (10 minutes) with nobody acknowledging it (an operator moving the incident to acknowledged, resolved or ignored in the UI, or a keypress), the agent pass phones the on-call people through Twilio (`src/oncall/`): the primary, the primary again two minutes after that call ended, the secondary, then the support lead. Each call plays one fixed recording from a configured URL (`STARFISH_ONCALL_AUDIO_URL`) that names no incident, then reads one key: 1 takes it (the sequence ends and a `new`, `logged` or `recurred` incident becomes acknowledged, #410), 2 texts the link to the incident (the link only), 3 passes it on; voicemail gets a short fixed message. The text goes only to the number the call was placed to, and only
while that number is still confirmed. Triage records no severity, so "urgent" is triage's `notify` or `act`; "critical" (which may ring during the admin's quiet hours) is a regression or at least a configured number of occurrences. One call sequence per cycle, claimed call by call in Firestore transactions, so concurrent passes and restarts place each call once; a per-person daily cap; every attempt, answer, keypress and outcome is a run event on the Runs page, the number masked (`+1 ••• ••• ••42`) and the person named only by role. Phone numbers live in an admin-only collection (never the runtime settings, whose copy operators read), shown masked in the UI even to admins, and a number is called only after its owner read back a code Starfish texted it on an admin's request (Settings -> On-call). Twilio's webhooks are served by the admin API and refused without a valid `X-Twilio-Signature`. It needs `STARFISH_PHONE_ESCALATION=true` **and** the admin's switch, Twilio's three secrets, and the dry run off: a dry run places nothing and records what it would have done. The waits are only as precise as how often something ticks: each agent pass, `pnpm escalate` (not scheduled by the deploy script), and Twilio's own report that a call ended. A Twilio number and every call cost money. **Not built:** the `#ops-log` message, deployment state. The pieces of one *pass* over the store exist as plain functions (`src/agent/pass.ts`, #74): choosing open incidents with no settled cycle for their current recurrence, mapping a stack trace to files that really are in the repository (never a path read from the log, never `node_modules` or an excluded path, no guessing when a match is ambiguous), and a bounded driver that runs one cycle at a time and stops when cycles keep throwing. **Also built, and deployed with the agent job:** `src/agent/assemble.ts` (a shallow clone of the base branch whose tip is the pinned revision, the log counter-check and samples, the files the trace names) and the entrypoint `pnpm agent` (`src/agentCli.ts`): dry run by default, and it **refuses to start** until `STARFISH_VERIFY_ISOLATION` is set on purpose (`none` is the default) to `github-actions` or `cloud-run-job` (below), or to `in-process`, which means the target repo's tests run on that machine as that identity, not in a sandbox. **Isolation of the verify step (#74): `github-actions` has run on the demo app (the verify check passed on a pushed `starfish/<cycle>` branch, 2026-10-12 and 2026-10-13); `cloud-run-job` is written and never run.** The verify step runs target-repository code, so the agent, which holds the store, Logging and Gemini credentials, never runs it. **The demo's choice, `STARFISH_VERIFY_ISOLATION=github-actions`:** the deterministic half of the gate (the patch applies, touches no excluded path such as `.github/`, adds no link) runs in the agent without executing anything; the patch is then pushed as one commit on `starfish/<cycle>` and the **target repository's own CI**, on GitHub's disposable runners, judges it: the named check runs (`STARFISH_VERIFY_CHECKS`) on that exact commit must all succeed, and a failed or cancelled one is a result the fixer sees once. This needs no new GCP resource, but the target's CI is now the judge *and* the sandbox: its workflow must run on pushes to `starfish/**` and reference no secret, and no other workflow may run on them. A branch is pushed even in a dry run (no pull request is), and deleted once CI has judged it. Tested against real git, a fake GitHub API and a fake CI, and run against real GitHub and the demo app's own workflow on 2026-10-12 and 2026-10-13. **The heavier alternative, `cloud-run-job`:** the agent never runs the command; it packs the source and the patch into a bucket, hands a **separate Cloud Run job whose service account holds no roles** two per-run signed URLs, and waits for a result it then validates (typed, tied to the SHA-256 of the exact patch, a pass only on exit 0). The job runs the command as an unprivileged user so the command cannot read the URL its result is written to. `scripts/deploy-gcp.sh` deploys the agent job and its Scheduler job with `DEPLOY_AGENT=1` (and, for `cloud-run-job`, the verify job and the bucket); the protocol is tested end to end against a local stand-in for the bucket with the real verify gate, but **Cloud Storage signing, the Cloud Run call, the image's privilege drop and the claim that the verifier can reach nothing have never been exercised on a real project**. The command can still use the network, so candidate code can send out the source it was given. The agent job has run against real Cloud Logging and Gemini on the demo project since 2026-10-08 (triage decided, the fixer declined, #259), has filed incident issues on the demo app, and on 2026-10-12 took one incident all the way to a pull request on the demo app (triage, fix, the target's own CI as the verify gate, review, pull request; PR #41 there). The auto-merge step ran on it and did not merge: the safety floor refused the patch, so the PR stayed open and a person was told. It is plain code, not on Google's Agent Development Kit: in `@google/adk` 2.2.0
`SequentialAgent`, the class #8 names, is deprecated in favour of `Workflow`, which is marked
experimental, so wrapping the loop in ADK is a decision still open.

**Missing-index heal (#11): written end to end and tested against fakes and the emulator; it has never run against Google.** `src/indexheal/createIndexUrl.ts`
finds the create-index URL in an error message, decodes it strictly into a spec (project, database,
collection group, scope, plain ascending or descending fields; array, vector and anything unknown are
refused and left to a person), checks the target against `STARFISH_INDEX_ALLOWED_TARGETS` (empty by
default, so nothing is allowed; Starfish's own database is refused even if listed), and compares the spec
with the repository's `firestore.indexes.json` (an unreadable file is "unknown", never "absent"). It is
tested on URLs **built here from the documented `Index` message, not captured from a real error**, which is
the first thing to check on the demo project. **The executor** (`src/indexheal/heal.ts`, with the
Firestore Admin REST adapter in `src/indexheal/firestoreAdmin.ts`) runs the gates in order (parse, target guard,
`indexAutoApply` on and `dryRun` off and the automation switch on, the live inventory, an operation an earlier attempt
recorded, the daily cap, the deterministic probe, the switches again right before the one create), creates a single
index and waits a bounded time for it. An equal index that already exists or is still building is waited on, never
created twice; a dry run reads the inventory, replays the query and creates nothing. It never deploys a file and never
deletes. **The loop wires it in** (`src/agent/indexPath.ts`) only when `STARFISH_INDEX_ALLOWED_TARGETS` lists a target:
a `MissingIndexError` incident (ingest's class for a failed precondition carrying Google's create-index URL) then skips
triage and the model. The create attempt is recorded under the cycle's lease *before* the call (that record is what the
per-target daily cap counts, so a crash after the create still counts), and the operation's name right after it; a
resumed attempt polls that operation instead of creating again, and one that recorded an attempt but no usable
operation creates nothing and goes to a person. **The failing query is configured, not guessed:** the URL does not
carry the query, so an operator writes it down (`STARFISH_INDEX_PROBES`, empty by default, so nothing can be created),
and `src/indexheal/probe.ts` replays it read-only with a limit of one: before the create it must fail with Google's
error naming exactly this index, and after READY it must pass. Then the run record says `runtime: observing`, and the
evidence pull request adds the same entry to the repository's index file (`STARFISH_INDEX_FILE`) through the same
opener as a code fix: the diff is computed and self-checked in code (`src/indexheal/indexFilePatch.ts`; every existing
entry kept) and the text is a fixed template, no model. Merging it is left to a person. After the pass, the job checks
earlier heals (`src/indexheal/observe.ts`): **healed** only when no occurrence was recorded since READY through
`STARFISH_INDEX_OBSERVE_MINUTES` (plus the ingest lag), ingest's checkpoint shows it read the logs through that window
(a stalled ingest records no occurrences either, so until it has, the heal keeps observing, and a day later it is
unverified), and the query still passes at the end; otherwise recurred, query-failing or unverified. A replay that could
not run at all (UNAVAILABLE, a permission) decides nothing: the heal keeps observing, and a day later it is unverified. Starfish does not measure the traffic in that window (the replayed query stands in for
it), and it never resolves the incident itself. Runs and the incident page show the index stage and its runtime state.
Refusals, the daily cap, a failed build, a query still failing after READY, and an index file it cannot extend go to a
person (Slack when configured). **Never run:** none of the Admin REST calls, the probe's Firestore query or a real
create-index URL has met Google; the response shapes are from the documentation. **Also built, same status:** the
database's index limit (before a create, the Admin API's inventory of every collection group is counted; at or above
`STARFISH_INDEX_MAX_PER_DATABASE`, default 100, nothing is created and a person decides; a count that cannot be read
creates nothing), and the incident's GitHub issue, filed for every index cycle through the same opener as a triaged
incident's (idempotent by cycle, nothing filed in a dry run); the evidence pull request links that issue but does not
close it, since whether the heal held is a person's call. Not built: Gemini writing the PR's explanation (the template does).

Assembling an incident's inputs (`src/agent/assemble.ts`), the incident's GitHub issue and the `github-actions` verify
step (above) have run on the demo project since 2026-10-12, in the run that opened demo-app #41; the `cloud-run-job` verify
step has never run against a real project. (Reconsidering a declined incident is written and tested against the emulator:
the same cycle is triaged again on an operator's retriage request, a burst or a new structural cause, or when an
incident closed while it was worked on is reopened, after a cooldown and under a cap; the rules accept the request, the Runs page's "Retry with agent" sends one, and it has not yet run on a real project.) What is left is running them over many more incidents than the few so far, gated on one question the
[spike](spike.md) exists to answer — does Gemini actually produce the patch a human
wrote?
