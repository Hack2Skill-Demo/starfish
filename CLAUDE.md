# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What Starfish is

An AI ops engineer for teams that don't have one: it watches a Firebase/GCP project's logs,
judges which incidents are urgent, drafts a fix with Gemini, verifies it deterministically,
adversarially reviews it, and **stops at a pull request**. It never merges and never deploys.

Two constraints shape everything: the model it uses is **Gemini on Vertex AI**, and it must
be **generic** (below).

The ingest half is adapted from an incident pipeline the authors run in production. Nothing
about that product (names, project IDs, code) belongs in this repo.

## The rule everything else serves: configured, never forked

> **Nobody should have to edit `src/` to run Starfish against their own project.**

Every deployment-specific value lives in `src/config.ts` and nowhere else. `src/config.ts`
is the only file in `src/` allowed to read `process.env` — enforced at edit time by
`.claude/hooks/config-boundary-guard.sh`. New setting → a `StarfishConfig` field, its env
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
# scripts/smoke-gcp.sh → scripts/deploy-web.sh. pnpm status: is the deployed engine alive? All unrun against a real project.
pnpm scrub            # dry-run: how many stored incidents still hold a credential/email (--apply to rewrite)
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
`docs/design/auto-merge-policy.md`: decided, not built, demo project first); spending that isn't free (new paid GCP services);
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
    retire         admin closes an incident for good and frees its fingerprint (key removed, audited);
                   store.ts treats a retired incident as absent, so the next occurrence is a new one
    counterCheck   independent raw-log recount + redacted samples
    aggregate      reads one window of logs and folds it into the store (each upsert carries
                   the window id, so a replayed window counts once)
    window         (start, end] windows: pure planning; ids come from the boundaries
    run            one scheduled run: resolve runtime settings, replay the pending window or plan
                   the next, advance the checkpoint only after it all commits, write last_run
  agent/triage.ts  stage 1 of the agent loop (#8): act/notify/decline for one incident; deterministic
                   gates before the model, local validation after it; run by the agent job (never deployed)
  agent/fixer.ts   stage 2: minimal patch or honest decline from a stubbed-testable model call;
                   fails closed, redacts both ways. Run by the agent job (never deployed)
  agent/cycle.ts   cycle per (incident, recurrence), transactional lease with fencing, append-only run events
                   (redacted) and the cycle's run record (summary.<stage>, path); infrastructure errors throw, logical refusals are returned
  agent/loop.ts    one cycle: lease -> triage -> fix -> verify -> review -> PR (interface); rechecks status +
                   kill switch, one shared revision, call budget, dry run by default. No gate configured → straight to a person
  agent/pass.ts    one pass over the store: candidate selection, stack trace → repo files, bounded driver
  agent/checkout.ts  the target repo at one pinned revision: shallow clone, `.git` removed, token only in git's env
  agent/subject.ts stored incident → LoopSubject: takes the counter-check + samples now (the ingest stores none),
                   reads only plain files with no link on the way
  agent/job.ts     one run of the agent job (`pnpm agent`, src/agentCli.ts): REFUSES to start with a verify command
                   unless STARFISH_AGENT_ALLOW_LOCAL_VERIFY (the job holds credentials; the gate is not a sandbox).
                   Deployed by `DEPLOY_AGENT=1` as a 2nd Cloud Run job, own service account, dry run. Never deployed;
                   no safe runner for the verify step exists (#74), so it can open no PR
  agent/automationSwitch.ts  the kill switch: reads the runtime settings fresh each time the loop asks; fails closed.
                   Used by the agent job (never deployed)
  agent/reviewer.ts  stage 4: attacks the verified patch; verdict computed from outcomes in code, bound
                   to the patch hash the gate tested. Run by the agent job (never deployed)
  agent/verifyGate.ts  stage 3: apply a patch in a scratch copy, judge the tree that results, run the
                   configured command with a scrubbed env. Not a sandbox; the deployed agent job never runs it
  operators.ts     grant a person an operator record (the first admin; `pnpm grant-operator`); the closed collection can't be written from the UI
  status.ts        judges the engine's last_run record (`pnpm status`): the same verdicts as the UI's engine line
  (repo root)      Dockerfile = the engine image the Cloud Run job runs; scripts/deploy-gcp.sh deploys it
                   (job, Scheduler, Secret Manager, IAM, Firestore rules). Written and tested by a dry run; not yet run against a real project
  indexheal/createIndexUrl.ts  create-index URL → strict spec, default-deny target guard, index-file dedup (#11).
                   Parser and guard only: nothing creates an index; tested on URLs built from the documented proto
  integrations/githubPr.ts  the pull-request opener (#17): idempotent by cycle id, pushes only
                   starfish/<id>, never merges, token only in git's environment. Never run against real
                   GitHub; its only caller is the agent job, which cannot reach it without a verify command
  runtimeSettings.ts  the settings document an admin edits: validated, applied over the
                   env defaults, last-good fallback, a frozen snapshot per run
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
page (the landing page; counts of stored records only, `lib/overviewModel.ts`), the
**Incidents** page, a **Runs** page (live subscription to `{cycleCollection}` and its events,
`web/src/lib/runs.ts`; the waterfall logic is pure in `runsModel.ts`: a step with no event is "not
reached", a cycle whose lease ran out is not "in progress"), an **incident evidence** page (`/incidents/:id`, `lib/evidence.ts`: only stored records, never a placeholder result), and a **Settings** page: the Gemini, GitHub and Slack connections, and an
admin editor for the runtime settings (`src/runtimeSettings.ts` reads what it saves).
React 19, Vite, Tailwind 4, react-router, TanStack Query; Starfish's own theme in
`web/src/styles/theme.css` and components in `web/src/components/ui/`.

- **Access:** Firebase Auth email/password. Roles (`admin`, `operator`) live on the operator
  record `starfish_users/{uid}.roles` and are read fresh on every token event, never cached
  in a claim, so a revoked role takes effect on the next request. Grant access by writing that record from the Admin
  SDK or the console.
- **Guests (rules and UI built):** an anonymous Firebase Auth session may *read* incidents whose
  `environment` is `demo` and the operator copy of the settings, and nothing else; it never writes.
  A signed-in email account with no role is not a guest. A visitor with no session is signed in
  anonymously on arrival (`RequireRole`/`enterAsGuest`) and sees Incidents and a view-only Settings
  with no triage buttons; signing out does not re-enter guest, and if Anonymous sign-in is refused
  they land on /signin. The public demo (#12) uses this so a judge needs no account; a private
  deployment just leaves Anonymous sign-in disabled. App Check is not built. Anonymous sign-in
  is project-wide, so see #32 before enabling it in a project shared with another app.
- **Data:** the UI reads and triages incidents straight from Firestore, filtered to its own
  environment. `firestore.rules` is the security boundary and enforces the status
  transitions; `pnpm test:emulator` runs it against the emulator (Java needed).
- **Database:** Starfish keeps its store in its own named database, `starfish` by default
  (`STARFISH_DATABASE_ID` / `VITE_STARFISH_DATABASE_ID`), which `firebase.json` targets for
  rules and indexes. Never deploy `firestore.rules` to the watched app's database: a rules
  file governs a whole database and would replace the app's own rules.
- **Engine status:** the Incidents page shows a line from `{runCollection}/last_run` (`web/src/lib/engineStatus.ts`):
  failed, stopped (older than `VITE_STARFISH_STALE_MINUTES`), capped, or never recorded. Read errors say nothing.
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
