# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What Starfish is

An AI ops engineer for teams that don't have one: it watches a Firebase/GCP project's logs,
judges which incidents are urgent, drafts a fix with Gemini, verifies it deterministically,
adversarially reviews it, and **stops at a pull request** unless Gemini decides the incident is one
of the admin's merge cases. It runs no deploy itself, but a merge is a release: the target's CI/CD
ships what is merged. How far it goes (log, log + fix, log + fix + merge) is
Gemini's decision; it merges only where an admin turned auto-merge on for that target (the demo,
listed in `STARFISH_AUTO_MERGE_TARGETS`), listed the case, and the safety floor and every required
check pass (built behind default-off switches, never run against real GitHub); every other target is
PR-only.

Two constraints shape everything: the model it uses is **Gemini on Vertex AI**, and it must
be **generic** (below).

The ingest half is adapted from an incident pipeline the authors run in production. Nothing
about that product (names, project IDs, code) belongs in this repo.

## The rule everything else serves: configured, never forked

> **Nobody should have to edit `src/` to run Starfish against their own project.**

Every deployment-specific value lives in `src/config.ts` and nowhere else. `src/config.ts`
is the only file in `src/` allowed to read `process.env` — enforced at edit time by
`.claude/hooks/config-boundary-guard.sh` and on every file by lint (`eslint.config.js`; tests exempt). New setting → a `StarfishConfig` field, its env
var and default in `loadConfig()`, and a line in `.env.example`. The README's genericity
table tracks what still isn't configurable; keep it honest.

## Honesty is the product's main asset

Docs, README, comments and PR text must never claim what the code doesn't do yet.
"Designed", "planned" and "built" mean different things — use them precisely.

## Commands

```bash
pnpm install          # pnpm only — never npm/npx/yarn (pnpm-guard.sh enforces it)
pnpm run verify       # THE gate: lint → typecheck → test → build, near-silent when green
pnpm run verify -- --only=coverage   # coverage percentages without the table
pnpm test             # engine + web unit tests
pnpm test:emulator    # firestore.rules + store concurrency against the emulator (Java required)
pnpm -C web dev       # the operator UI on :5177
pnpm audit:contrast   # WCAG AA audit of the rendered UI (needs `pnpm dev:emulated` + a Chromium)
pnpm spike            # the Gemini fix-quality spike (needs .env + Vertex access)
pnpm ingest           # one ingest run: next window(s) of the watched project's logs → the store
PROJECT_ID=<p> scripts/deploy-gcp.sh   # Cloud Run job + Scheduler + Secret Manager; DRY_RUN=1 prints the plan (docs/deploy.md)
# The whole setup, in order (docs/setup.md): scripts/preflight-gcp.sh → deploy-gcp.sh → pnpm grant-operator →
# scripts/smoke-gcp.sh → scripts/deploy-web.sh. pnpm status: is the deployed engine alive? Run once on the demo project (2026-10-05), the smoke test included; the agent job was deployed there on 2026-10-07 and, since the Deploy engine workflow's first run (2026-10-10), runs hourly with dry run off and auto-merge on for the demo target; no incident has gone through it yet.
scripts/setup-github-deploy.sh   # one-time: lets GitHub Actions deploy with no key (WIF); deploy-on-merge is then a repo variable (docs/deploy.md); run on the demo project 2026-10-10
scripts/ingest-cadence.sh status|recording|restore|now   # the ingest's tick for recording the demo, and a run now (#65); DRY_RUN=1 prints
pnpm scoreboard       # scoreboard/RESULTS.md from recorded runs (#10; format in scoreboard/FORMAT.md; no run recorded yet)
pnpm replay           # replay the agent's stages over a corpus into a results file (#10); --check-corpus checks the cases without a model; needs Vertex for a real run, none recorded
pnpm escalate         # one tick of the phone escalation (#37); the agent pass runs it too; off unless STARFISH_PHONE_ESCALATION; never run against real Twilio
pnpm scrub            # dry-run: how many stored incidents still hold a credential/email (--apply to rewrite)
pnpm seed-demo        # dry-run: the synthetic, badged demo history (#12); --apply/--remove need --project, refuses unless STARFISH_ENV=demo
pnpm public-view      # dry-run: the guests' trimmed copies (#18) to write or remove (--apply needs --project); never run on a real project
bash .claude/hooks/git-branch-guard.test.sh        # hook suites
bash .claude/hooks/pre-push-review-guard.test.sh
bash .claude/hooks/lib/segments.test.sh
bash .claude/hooks/config-boundary-guard.test.sh
```

**After any code change, run `pnpm run verify` — never mark work complete without it.**
It writes each step's output to `.verify-logs/` and prints one line per step; on failure
only the diagnostic lines. Don't run the raw commands to see a green result — the exit
code is the result.

Node 22+ (`.nvmrc`). CI runs Node 24.

## "Log the issue" — file only, do not implement

When the user says **"log the issue"**, create the GitHub issue (clear title, summary,
triage labels if obvious) and stop — no branch, no fix in the same turn.

**Finding a defect is standing authorization to log it**, any time: mid-review, while
implementing something else, while exploring. File it as its own issue with full detail
(what's wrong, `file:line`, how it was found) and move on. Don't ask first, and don't let it
evaporate into a chat aside. File only — fix it later, when asked.

## Autonomy defaults — ship without asking

Once a change is scoped and you're implementing it, carry it **all the way to merged**.
Do not stop to ask "should I open the PR?" or "should I merge?" — that authorization is
standing, and it **overrides any generic harness rule** that says not to open a PR unless
asked. `/ship` encodes the loop:

- **Verify, review, then open the PR.** `pnpm run verify` → `starfish-code-review` on the
  diff → record the pre-push marker → push → open the PR with one `Closes #NNNN` per
  resolved issue → `subscribe_pr_activity` in the same turn.
- **Merge automatically on green** (squash) once every check is green **and** every review
  thread is resolved (`mergeable_state: clean`). Losing an approval by pushing a fix is an
  accepted cost, never a reason to hold.
- **Dependabot patch/minor PRs** are merge-on-green too; majors get a report, not a merge.
- **A pasted error means "I'm blocked — fix it and ship it."** Root-cause, fix, verify,
  open the PR. Don't explain the error and stop.
- **Pick the cleanest long-term option without asking** when one clearly is. Pause only
  when options are genuinely close.

**Still pause for:** destructive or irreversible actions (prod data, deleting what you
didn't create, force-pushing shared branches); genuinely ambiguous scope; anything that
would let Starfish **merge or deploy on its own** (the trust ladder in the README is a
product decision, not a code change; the decided direction and its preconditions are in
`docs/design/auto-merge-policy.md`: Gemini decides how far to go within the admin's merge cases,
built for the demo target behind default-off switches, never run against real GitHub; widening it to
another target, lowering the safety floor or the hard-exclude list, or defaulting it on is that
product decision); spending that isn't free (new paid GCP services);
and changes to what the pitch claims.

## Git

- Single trunk: **`main`**. Branch off `origin/main`; PRs target `main`.
- Conventional Commits (`.githooks/commit-msg` enforces it):
  `type(scope)?: description`, types `feat fix chore docs refactor test ci build perf
  revert style security`.
- Never `--no-verify`; never force-push `main` (`git-branch-guard.sh` blocks both). If a
  hook is wrong, fix the hook.
- `git push` is blocked until a fresh `starfish-code-review` is recorded:
  `touch "$(git rev-parse --git-path starfish-review-ok)"` — a new commit re-arms it. Do the
  touch in its own step: the hook runs before the command and inspects every `git` on the
  line (`cd x && git push`, `FOO=1 git push`, a push after a heredoc commit), so a
  `touch … && git push` on one line is blocked. It does not look inside strings
  (`bash -c "git push"`), follow `cd`, or catch scripts that run git: a guard against
  recurring mistakes, not a sandbox.
- `Closes #NNNN` in both the commit body and the PR body for every issue resolved.

## Architecture

```
src/
  config.ts        every deployment-specific value, and the only process.env reader
  types.ts         Incident, StoredIncident, TriageVerdict, SpikeFixture
  vertex.ts        Gemini on Vertex AI — structured JSON output, untrusted-data notice
  spike.ts         fix-quality spike over fixtures/incidents/*.json
  ingest/          Cloud Logging → classified, fingerprinted, deduped incidents
    parseLogEntry  parse + noise suppression + the shared log filter
    classify       error type (source class > code > HTTP status > keywords), service
    fingerprint    sha256(canonical functionName : first 100 chars of the normalized message);
                   volatile ids/paths/timestamps/counts are collapsed first
    store          the single write path: dedup by fingerprint; a resolved one that fires
                   again is re-opened as `recurred` (a regression). One transaction per
                   upsert, through a per-(environment, fingerprint) key document
    trigger        admin-only "run ingest now": the same runIngest, audited before it runs
    retire         admin closes an incident for good and frees its fingerprint (audited); the key stays as a
                   tombstone (applied windows kept): a later occurrence opens a new incident, an earlier one
                   (ingest lag) accrues onto the retired one without reopening it
    counterCheck   independent raw-log recount + redacted samples
    monitoring     Cloud Monitoring failure counts per function (#19): injectable reader, REST adapter, bounded,
                   null when unavailable (never zero); aggregate annotates a function's log incidents in the window
                   or opens a Monitoring-only one (fingerprint `mon-…`). Off by default, never run against real Monitoring
    aggregate      reads one window of logs and folds it into the store (each upsert carries
                   the window id, so a replayed window counts once)
    window         (start, end] windows: pure planning; ids come from the boundaries
    run            one scheduled run: resolve runtime settings (refuses on an unusable document with no
                   last-good), replay the pending window or plan the next, advance the checkpoint only
                   after it all commits, write last_run. State per (watched project, environment). Bounded by a
                   run budget (`STARFISH_INGEST_RUN_BUDGET_SECONDS`) the deploy's timeouts are derived from (#221)
  agent/triage.ts  stage 1 of the agent loop (#8): act/notify/decline for one incident, and how far to go
                   (`triageLevel`: noise, log, fix, merge): on act the model may name one of the admin's merge cases
                   (`mergeCases`; `missing-index` never offered), kept only if listed. Deterministic gates before the
                   model, local validation after it; run by `pnpm agent` (deployed to the demo project, dry run: ran on real incidents 2026-10-08)
  agent/fixer.ts   stage 2: minimal patch or honest decline from a stubbed-testable model call;
                   fails closed, redacts both ways. Run by `pnpm agent` (deployed, dry run: ran 2026-10-08 and declined, #259)
  agent/cycle.ts   cycle per (incident, recurrence), transactional lease with fencing, append-only run events
                   (redacted), the cycle's run record (summary.<stage>, path) and its model-call and revision counts (#182); infrastructure errors throw, logical refusals are returned. Run by `pnpm agent` (deployed to the demo project, dry run)
  agent/loop.ts    one cycle: lease -> triage -> fix -> verify -> review -> PR (interface); rechecks status +
                   kill switch, one shared revision, call budget, dry run by default. Run by `pnpm agent`. Where
                   triage named a merge case auto-merge may apply to, it also runs the safety floor and the "fails
                   before" run (`summary.before`, reported) and records the candidate (`summary.merge` pending, with the
                   case); it never merges itself. The floor holds only if its files are exactly the files the verify
                   gate saw change
  agent/blastRadius.ts  the safety floor every merge needs (`assessMergeFloor`: gate 1's parsing, hard-exclude list and
                   whole-function check, tests only as new files, one production file, any number of hunks; no fix
                   class or size rule). And #9's original gate 1 (`assessBlastRadius`, no longer used to merge), pure:
                   a conservative diff classifier (null guard on an explicit null/undefined
                   check, never `!x`, that leaves with nothing or throws, ended by `;` or a block, after a line that ends
                   a statement; `?.` (never before a call) and only `?? null`/`?? undefined`, never on a line that
                   compares or does arithmetic; missing await; Firestore undefined field; literals and comments
                   unchanged; one file, one hunk with 3 lines of context, one function; paths in git's a/ b/ form, no rename;
                   no control characters; a `\ No newline` marker only at a file's end; tests only as new files) and the hard-exclude list (auth, rules, money, secrets, schema,
                   dependencies/imports, CI/config, shared code; access control, money and secrets also on every deciding
                   statement of the whole enclosing function in the base file, which the loop passes in, and for a null
                   guard on every statement naming one, a check written as a call included). Unsure is never
                   allowed
  agent/autoMerge.ts  the switches (`mergeBlockedBy`, with the candidate's merge case still listed), gate 2 (`certaintyGate`,
                   pure over the run record, now reported in the evidence, not required) and the merge step after the
                   pass: a merge case recorded, fresh switches + incident status, the floor, no earlier merge of the
                   incident still watched or reverted (#240), the index path's evidence PR (`kind: index`, no revert
                   watch),
                   PR into the configured base with the head Starfish built, every
                   run of the named checks from `STARFISH_VERIFY_CHECK_APP` green on it, daily cap (transactional),
                   evidence comment, squash merge with `sha`. Any failure: PR stays open + notify. Fakes + emulator
                   tested, never run against real GitHub
  agent/fastRevert.ts  the watch every merge starts: the incident seen again after a grace and within N minutes of the
                   MERGE (deploy completion is not observable; counted by the hour, so an error that keeps firing past
                   the window is still seen) -> revert PR of Starfish's own merge commit, merged on
                   green checks; a later change to the same files escalates; a revert is never reverted. Cleared only
                   once the ingest checkpoint has read through the window, else a person is told after a day (#241).
                   Runs before the merge step in the pass
  agent/pass.ts    one pass over the store: candidate selection (paged past closed/settled incidents, bounded, a cap
                   reported, #226), stack trace → repo files, bounded driver; the daily cycle cap
                   (`STARFISH_MAX_CYCLES_PER_DAY`, a count of cycles started that UTC day); a sweep that gives up and
                   announces `running` cycles nobody holds whose deadline passed or attempts ran out
  agent/reconcile.ts  after the pass (#17): polls a bounded number of opened PRs (state + named checks on the head), records
                   `summary.prState` via cycle.ts `recordPrState` (no lease; never changes the cycle's state; newest read wins;
                   merged is final; never marks an incident healed; copies the state to the incident's `githubPrState`).
                   Fake GitHub + emulator tested, never run against real GitHub
  agent/incidentLinks.ts  copies the issue and PR (number, URL, state) from the cycle onto the incident for the UI's links (#194):
                   only those fields, only while the incident is in the cycle's recurrence; never its status
  agent/reconsider.ts  when a DECLINED cycle is triaged again (#8): an operator's `retriageRequestedAt`, a burst, or a new
                   structural cause since the recorded decision, or an incident closed mid-cycle and reopened (#227);
                   cooldown + cap per 24 h; never over ignored/resolved.
                   cycle.ts reopens the same cycle in the lease transaction, so still one issue and one PR per recurrence
  agent/assemble.ts  one incident's inputs: shallow clone at a pinned revision, counter-check, samples, files the trace names
  scoreboard/      the results format (strict parser), the metrics (ratios keep numerator and denominator; an error or timeout counts
                   against the agent; each path apart) and the Markdown table: `pnpm scoreboard`. `replay.ts`/`corpus.ts` (`pnpm replay`) run
                   the loop's own stages over a frozen corpus with hidden evaluators and write a results file; no real run recorded
  agentCli.ts      `pnpm agent`: one pass. Dry run by default; refuses to start until STARFISH_VERIFY_ISOLATION is set
                   (`in-process` is not a sandbox; `github-actions` = the target's own CI judges a pushed starfish/<cycle>
                   branch, the demo's choice; `cloud-run-job` hands the source + patch to a separate job whose service
                   account holds NO roles). The agent never runs the target's code. Deployed by `DEPLOY_AGENT=1`; never run
  agent/verifyCi.ts  `github-actions` isolation: local gate checks (nothing executed) → push branch → wait for the NAMED check
                   runs on that exact commit (heartbeat each poll) → delete the branch IT pushed unless it passed (in a dry run, always).
                   No check / only queued throws (cycle resumes)
  agent/verifyRemote.ts  the agent's side of the isolated verify: bundle → signed URLs → start the job → validated result.
                   Infra failures throw (the cycle resumes); a failed command is a result
  agent/verifyRunner.ts  the verify job's side (`src/verifyRunnerCli.ts`): fetch the bundle, run the gate, write the result.
                   Starts as root only to run the command as uid 65534 (docker-entrypoint.sh)
  agent/verifyProtocol.ts  the request/result contract and its strict checks (bounded BEFORE redactPii: #96)
  agent/cloudRunJob.ts  production adapters (GCS signed URLs, Cloud Run `jobs.run`): the part never run on a real project
  agent/integrations.ts  at the start of each `pnpm agent` pass: which credentials the agent job holds (GitHub token, the two Slack
                   webhooks, Twilio) as booleans in `{runCollection}/integrations`, for the Settings page; never a value, best effort,
                   and "set" is not "works" (nothing calls the service). The browser can't read the secrets, so this is the only way it knows
  agent/automationSwitch.ts  the kill switch: reads the runtime settings fresh each time the loop asks; fails closed
  agent/reviewer.ts  stage 4: attacks the verified patch; verdict computed from outcomes in code, bound
                   to the patch hash the gate tested. Run by `pnpm agent` (deployed; not yet reached on a real incident)
  agent/verifyGate.ts  stage 3: apply a patch in a scratch copy, judge the tree that results, run the
                   configured command with a scrubbed env. Not a sandbox; run by `pnpm agent` (deployed; not yet reached on a real incident)
  adminApi.ts      the admin API's rules (#63, #65): a Firebase ID token -> uid, admin from the operator record on every call, `POST /api/ingest/run`
                   and `POST /api/incidents/<id>/retire` (with Twilio, the on-call opt-in `send-code`/`confirm`, every admin's attempt audited
                   without the number or the code, #172), one 401, bounded body, CORS allowlist, one ingest at a time. `adminApiServer.ts` is its HTTP
                   shell, `adminApiCli.ts` the Cloud Run service (`DEPLOY_ADMIN_API=1`): deployed once to the demo project (2026-10-07), "Run ingest now" run from the UI; Retire and the Twilio routes not yet tried
  operators.ts     grant a person an operator record (the first admin; `pnpm grant-operator --project <id>`, which refuses if the shell's project differs and reads the store before creating an account); the closed collection can't be written from the UI
  status.ts        judges the engine's last_run record (`pnpm status`): the same verdicts as the UI's engine line
  (repo root)      Dockerfile = the engine image the Cloud Run job runs; scripts/deploy-gcp.sh deploys it
                   (job, Scheduler, Secret Manager, IAM, Firestore rules). Written and tested by a dry run; ingest part run once on the demo project (2026-10-05), agent part not
  indexheal/createIndexUrl.ts  create-index URL → strict spec, default-deny target guard, index-file dedup (#11).
                   Tested on URLs built from the documented proto
  indexheal/heal.ts  the gated executor (#11): target guard, `indexAutoApply` + dry run + kill switch (rechecked before the one
                   create), live-inventory reconcile (a building index is waited on, never duplicated), a persisted operation
                   polled not repeated, daily cap, the database's index count (`STARFISH_INDEX_MAX_PER_DATABASE`, default 100),
                   the probe confirming the failing query, bounded wait; infra failures throw.
                   `firestoreAdmin.ts` is its REST adapter; `probe.ts` replays the CONFIGURED failing query (STARFISH_INDEX_PROBES,
                   read-only, limit 1); `indexFilePatch.ts` the evidence PR's diff (self-checked, entries only added);
                   `observe.ts` decides healed / recurred after the quiet window (writes the run record only, never the incident)
  agent/indexPath.ts  the loop's index path: a MissingIndexError skips triage and the model when an index target is allowed;
                   attempt recorded (fenced) before the create, operation after; the incident's issue via the loop's openIssue
                   (linked, never closed, by the evidence PR); evidence PR via the PR opener, recorded as an auto-merge
                   candidate when the admin lists the reserved `missing-index` merge case. Run by
                   `pnpm agent`; tested against fakes and the emulator, never run against Google
  integrations/slack.ts  Slack delivery (#17): one "needs a human" message through an incoming webhook, from redacted plain-text
                   fields; bounded retries, a failed delivery is a recorded result (`summary.notify`), a dry run sends nothing; the webhook
                   (a secret, `loadSlackOnCallWebhook`) never appears in a result. Also the optional #ops-alerts "new incident"
                   message (`loadSlackAlertsWebhook`, `summary.alert`). Run by `pnpm agent`; never run against real Slack
  integrations/githubPr.ts  the pull-request opener (#17): idempotent by cycle id, pushes only
                   starfish/<id>, does not merge itself, token only in git's environment. Also files the incident's issue
                   (`openIssue`: idempotent by a marker, label `starfish`, a failure recorded on the cycle), and reads one of its PRs
                   back (`readPullRequest`: refuses one not from starfish/<cycle> in the repo, or not into the configured base). For #9 only: squash-merges
                   one of its PRs at an exact head (`mergePullRequest`), comments on it, and opens the revert of its own
                   merge commit on starfish/revert-<cycle> (`openRevertPullRequest`). Never run against real
                   GitHub; run by `pnpm agent` (deployed; in dry run it files and opens nothing)
  oncall/escalation.ts  phone escalation (#37): an urgent cycle (triage notify/act, waiting for a person) whose Slack message
                   went unacknowledged for the policy's wait -> primary, primary again after 2 min, secondary, support lead.
                   One sequence per cycle, each call claimed in a transaction (claimer, per-person daily cap) before it is
                   placed; ack = incident acknowledged/resolved/ignored in the UI, or keypress 1; quiet hours unless critical
                   (recurred, or >= criticalOccurrences); run events stage `escalation`, numbers masked, people by role.
                   Ticked by `pnpm agent` and `pnpm escalate`. Off by default (env switch + admin's switch); dry run places nothing
  oncall/twilio.ts the Twilio REST client (place a call, send a text; never retries, never throws), X-Twilio-Signature
                   check, and the fixed TwiML (one recording, one key; no incident text is ever spoken)
  oncall/webhooks.ts  Twilio's webhooks on the admin API (`/twilio/voice|gather|status`): signature-checked against the
                   configured origin, 1 takes it, 2 texts the incident link (to the number called, still confirmed), 3 passes, voicemail/no input moves on
  oncall/optIn.ts  a number is called only once confirmed: an admin asks for a texted code, the person reads it back
                   (admin API `POST /api/oncall/people/<id>/send-code|confirm`); hash bound to person + number
  oncallSchema.ts  the on-call policy and person schema, `maskPhone`, quiet hours: pure, shared with the UI's Settings -> On-call.
                   People (phone numbers) live in an admin-only collection, never the runtime settings.
                   All of #37: tested against a fake Twilio and the emulator, never run against real Twilio
  integrations/links.ts  links from Slack and issues back to the UI, built from the configured origin and a plain id
  runtimeSettings.ts  the settings document an admin edits: validated, applied over the
                   env defaults, last-good fallback, a frozen snapshot per run
  publicView.ts    the guests' TRIMMED COPIES (#18), pure: one allowlist per kind (`toPublicIncident`, `toPublicCycle`,
                   `toPublicEvent`), every field named and its value's shape checked; only for `STARFISH_PUBLIC_ENVIRONMENTS`
                   (default `demo`). Never detail, traces, tenant ids, the log filter, model words, patches or event data;
                   an event's one-line summary only for the engine-worded stages. `publicView: 1` marks a copy
  publicViewStore.ts  writes them (Admin SDK only): an event's copy in the event's own transaction (cycle.ts); an
                   incident's or cycle's refreshed after each engine write from what was committed (store.ts, cycle.ts,
                   incidentLinks.ts, observe.ts, escalation.ts, webhooks.ts; never throws), a retired incident's deleted
                   in the retire's transaction; `syncRecentPublicView` (the newest 50 of each, after every ingest and
                   agent run) for writes the engine does not make; `backfillPublicView` = `pnpm public-view`
                   (`publicViewCli.ts`). Unit- and emulator-tested; never run on a real project
```

Conventions that carry real weight (the `starfish-dev` skill has the reasoning):

- **Text reaching the model is redacted and bounded** (`sanitize`), and every system
  prompt treats incident text as untrusted data (`vertex.ts`).
- **"Never throws" contracts are load-bearing.** Log reads and checks that fail degrade to
  `null`/`[]`; they never lose the incident. Missing is not zero.
- **Firestore rejects `undefined`** — optional fields are spread conditionally.
- **The verify gate is deterministic, not an LLM.** The model proposes; the tests dispose.

## UI (`web/`)

The operator UI: sign-in, an auth provider with race guards, a two-level layout, an **Overview**
page (the landing page; counts of stored records only, `lib/overviewModel.ts`; "healed on its own" is only an index run
the engine recorded healed, `isHealedRun`; its activity feed is a
collection-group query over `events`, with its own rule and index; a guest's reads `starfish_public_events`), the
**Incidents** page (under each error, the incident's current run: its state, triage's reason and a link to it, `lib/useIncidentRuns.ts`), a **Runs** page (live subscription to `{cycleCollection}` and its events,
`web/src/lib/runs.ts`; the waterfall logic is pure in `runsModel.ts`: a step with no event is "not
reached", a cycle whose lease ran out is not "in progress"), an **incident evidence** page (`/incidents/:id`, `lib/evidence.ts`: only stored records, never a placeholder result), and a **Settings** page: the Gemini, GitHub and Slack connections (GitHub and Slack read `{runCollection}/integrations`, the agent's own report of what it holds: "configured", never "connected", and "not connected yet" until the agent has run and reported), an
admin editor for the runtime settings (`src/runtimeSettings.ts` reads what it saves), and, for admins only, **On-call** (#37,
`pages/OnCallEditor.tsx`, `lib/onCallWrite.ts`): the people (numbers shown masked, typed in but never read back), the
opt-in code, and the call policy.
React 19, Vite, Tailwind 4, react-router, TanStack Query; Starfish's own theme in
`web/src/styles/theme.css` and components in `web/src/components/ui/`.

- **Access:** Firebase Auth email/password. Roles (`admin`, `operator`) live on the operator
  record `starfish_users/{uid}.roles` and are read fresh on every token event, never cached
  in a claim, so a revoked role takes effect on the next request. Grant access by writing that record from the Admin
  SDK or the console.
- **Guests (rules and UI built):** an anonymous Firebase Auth session never reads a stored incident, cycle or event
  (#18). It may *read* their trimmed copies (`starfish_public_incidents`, `starfish_public_cycles`,
  `starfish_public_events`, written by the engine only, `src/publicView.ts`), `last_run` and
  `starfish_runs/integrations` (which credentials the agent job holds: booleans and a time, never a value), each only
  whose `environment` is `demo` (a get of a missing one reads as missing), and the operator copy of the settings, and
  nothing else; it never writes. The UI switches in ONE place, `web/src/lib/dataSource.ts` (an anonymous session reads
  the copies, everyone else the stored documents); a copy keeps the stored field names, so the same parsers read it, and
  a field it leaves out shows as nothing (the evidence and Runs pages say the view is a trimmed copy).
  A signed-in email account with no role is not a guest. A visitor with no session is signed in
  anonymously on arrival (`RequireRole`/`enterAsGuest`) and sees Overview, Incidents, incident evidence,
  Runs and a view-only Settings with no triage or admin buttons; signing out does not re-enter guest, and if Anonymous sign-in is refused
  they land on /signin. A build for the `demo` environment offers "See the demo view" on /signin, which starts a guest
  session even after a sign-out (`offersGuestView`, `enterAsGuest({ requested: true })`). The public demo (#12) uses this so a judge needs no account; a private
  deployment just leaves Anonymous sign-in disabled. App Check: the UI initialises it only when built with
  `VITE_STARFISH_APPCHECK_SITE_KEY` (`lib/appCheck.ts`; absent = off, the UI and guests unchanged), and the admin API
  requires its token only with `STARFISH_ADMIN_API_APPCHECK` (default off); Firestore enforcement is a console step,
  not scripted (docs/deploy.md). Unit-tested; never run on a real project. Anonymous sign-in
  is project-wide, so see #32 before enabling it in a project shared with another app.
- **Data:** the UI reads and triages incidents straight from Firestore, filtered to its own
  environment. `firestore.rules` is the security boundary and enforces the status
  transitions; `pnpm test:emulator` runs it against the emulator (Java needed).
- **Database:** Starfish keeps its store in its own named database, `starfish` by default
  (`STARFISH_DATABASE_ID` / `VITE_STARFISH_DATABASE_ID`), which `firebase.json` targets for
  rules and indexes. Never deploy `firestore.rules` to the watched app's database: a rules
  file governs a whole database and would replace the app's own rules.
- **Admin controls:** an admin sees "Run ingest now" (Incidents) and "Retire" (an incident) when the build has `VITE_STARFISH_ADMIN_API_URL`; they call the admin API with the ID token (`web/src/lib/adminApi.ts`, `components/AdminActions.tsx`). Hiding them is not the gate: the API re-checks the role. Built and unit-tested; "Run ingest now" has run once against the deployed service (2026-10-07), Retire has not.
- **Engine status:** Overview, Incidents and Runs show a line from `{runCollection}/last_run` (`web/src/lib/engineStatus.ts`):
  failed, stopped (older than `VITE_STARFISH_STALE_MINUTES`), capped, or never recorded. Read errors say nothing. When the
  job knows its schedule (`STARFISH_INGEST_SCHEDULE`, set by the deploy and cadence scripts) it records the interval, and the
  line says when the next run is expected.
- **Config:** `web/src/lib/config.ts` is the only reader of `import.meta.env`. The Firebase
  project comes from Hosting's `/__/firebase/init.json` at startup (`VITE_FIREBASE_*` only for
  local dev); the rest from `web/.env` (`web/.env.example`).
- **Runtime settings:** one admin save is one batch of three documents (settings, audit entry,
  operator copy) that `firestore.rules` ties together. The UI imports `src/settingsSchema.ts`,
  so it and the engine can't disagree on what is valid. Change that schema and the rules'
  key list together. Verify command, timeout and excluded paths are deliberately not editable
  here (an editable command is code execution on the engine host).
- **Run:** `pnpm -C web dev` (port 5177).

## Sessions

- Poll GitHub through the MCP tools, never `gh`.
- A subagent inherits none of your skills — tell it to call `Skill(starfish-dev)` and
  `Skill(starfish-code-review)` itself.
