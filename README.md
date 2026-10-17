# Starfish

**An AI ops engineer for teams that don't have one.**

Starfish watches a production Firebase/GCP project, judges which incidents are actually
urgent, drafts a fix, adversarially reviews its own work, and opens a verified pull request
— then stops and waits for a human. Only where an admin has switched it on, for the kinds of incident they listed, and with
every check green, may it merge (built for the demo target; never run against real GitHub).

Named for the animal that regrows what it loses.

## Try the live demo

The demo has two sites: Starfish itself, and the shop it watches.

| | Live site | Source |
|---|---|---|
| **Starfish**, the operator UI: incidents, runs, settings | **[ocean-starfish.web.app](https://ocean-starfish.web.app)** | [Hack2Skill-Demo/starfish](https://github.com/Hack2Skill-Demo/starfish) (this repo) |
| **Demo Shop**, the app Starfish watches: synthetic customers order from it around the clock, and its **Lab** page breaks one part of it on purpose so you can watch Starfish respond | **[hack2skill-demo.web.app](https://hack2skill-demo.web.app)** | [Hack2Skill-Demo/demo-app](https://github.com/Hack2Skill-Demo/demo-app) |

The shop sits behind an access code, which the team issues. Starfish needs none to look:

- **No account needed to look.** Opening the link puts you in a read-only view of a live
  deployment that watches a demo project.
- **Judges: sign in for the full records.** The email and password are in our presentation
  slides (deliberately not here). Signed in, you see what the view-only demo leaves out: error
  detail, stack traces, Gemini's reasoning and the patches.
- **A three-step guide opens on your first visit.** The **?** button in the header reopens it.

What happens to an incident:

1. **Ingest:** reads the watched project's new error logs on a schedule and folds repeats of one
   error into one incident (one that comes back after a fix is reopened as a regression).
2. **Triage:** Gemini judges whether it needs action and how far to go: noise, log it, or attempt a fix. It reads
   the error's logs and the source files the stack trace (or the function's name) points at, the same files the fixer gets (#371).
3. **Fix:** Gemini drafts a minimal patch, or declines when there is no confident one-step fix.
4. **Verify:** deterministic, not a model: in the demo, the watched project's own CI checks judge the patch.
5. **Review:** a second Gemini pass attacks the verified patch before anything is opened.
6. **Pull request:** opened with its evidence; then Starfish stops and a person decides. It merges
   only where an admin turned that on, for the cases they listed, with every check green.

Where to look: **Overview** (is the engine alive, what is waiting on a person), **Incidents** (each
error and what the agent decided; open one for its evidence), **Runs** (every agent run, step by
step), **Settings** (the switches and rules an admin controls). Every number is a record the
deployment wrote; one marked **Synthetic** is an illustration, not a run that happened. How far
each stage has got on real incidents is in [`docs/status.md`](docs/status.md).


---

## What it has done so far

Precisely, as of 2026-10-17 (the evidence for every line is in [`docs/status.md`](docs/status.md)):

- **Proposed:** three verified, reviewed pull requests on the demo app (demo-app #41, #42, #49), from real incidents (#41, #42 and #49 are one bug, found again after the first fix attempt).
- **Merged:** two of them, by a person (#49 on 2026-10-13, #41 on 2026-10-15). **Starfish has merged nothing itself.**
- **Deployed:** the target's own pipeline deployed both merges. Starfish does not observe deployment.
- **Verified recovery:** none. Starfish does not yet check that a merged fix stopped its error; it has that check only for the
  missing-index path and a watch for a merge of its own, neither of which has run. See
  [what recovery covers](docs/status.md#what-recovery-covers-today-and-what-it-does-not-390).

"Built", "tested", "validated against the real service" and "observed in the deployment" are four different claims; the
[matrix](docs/status.md) keeps them apart, capability by capability, with dates.

## Why

## Why

Sentry's Seer needs Sentry and a team around it. Google's Gemini Cloud Assist is built for
enterprises that already employ SREs. Both assume an engineering organisation exists.

Nobody builds for the two-person company running real production for real users — which is
the long tail of most software that actually matters to the people using it.

That's the gap Starfish is for.

## Quick start

Requires Node 22.19+, pnpm, and a GCP project with the Vertex AI API enabled. Starfish keeps its store in its own Firestore
database, `starfish`, so its rules and indexes never touch your app's database.

```bash
pnpm install            # also points git at .githooks/
cp .env.example .env    # set GOOGLE_CLOUD_PROJECT
pnpm run verify         # the gate: lint · typecheck · test · build
pnpm -C web dev         # operator UI on :5177 (copy web/.env.example to web/.env)
pnpm dev:emulated       # the UI against seeded local emulators, no GCP project needed
```

To run it against your own project, follow [`docs/setup.md`](docs/setup.md): a read-only preflight, the ingest job and its
schedule, the first admin, an end-to-end smoke test, and the UI on its own Hosting site. Each script takes `DRY_RUN=1`. What
the deploy creates and the identities it uses: [`docs/deploy.md`](docs/deploy.md).

## How it works

![Architecture: the watched app's errors flow through Cloud Logging into Starfish's ingest, then Firestore; the agent pass calls Gemini on Vertex AI and files GitHub issues and pull requests and Slack messages outside the Google Cloud project; a merge is released by the target's own CI/CD](docs/diagrams/architecture.png)

Everything inside the dashed box runs in the watched Google Cloud project. Starfish runs no deploy of its own: what ships is
whatever the target's CI/CD ships after a merge. The two chips on the diagram mark what has not run: **Merge ready**
(built and switched on for the demo target, never completed a merge) and **Phone off** (built, off by default).

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
                                         pull request       ← stops here unless Gemini named an admin's
                                                              merge case: then auto-merge on green checks
                                                              (demo target only, off by default; built, never run)
```

The verify gate is deliberately *not* an LLM. The model proposes; the test suite disposes.

## How far it may go: the trust ladder

How far Starfish goes with an incident is Gemini's decision, inside limits an admin sets. A merge is a release (the target's
CI/CD ships it), so the last rung is the narrowest:

| Level | What Starfish does | Who decides |
|-------|--------------------|-------------|
| noise | records it, files nothing | Gemini's triage: *decline* |
| **log** | a GitHub issue and an alert; a person fixes it | Gemini's triage: *notify* |
| **log + fix** | the issue and a verified, reviewed pull request; a person merges | Gemini's triage: *act* |
| **log + fix + merge** | merges the fix itself, then watches for the error coming back and reverts | *act* **and** one of the admin's merge cases, inside the safety floor, on green checks. Built for the demo target only, off by default, never run against real GitHub |

People can always hold Starfish back, never push it further: class rules and operator corrections cap how far it goes, and the
lowest cap wins. Details, the safety floor, and the rungs not built: [`docs/trust-ladder.md`](docs/trust-ladder.md) and
[`docs/design/auto-merge-policy.md`](docs/design/auto-merge-policy.md).

## Design goal: configured, never forked

> **Nobody should have to edit `src/` to run Starfish against their own project.**

Everything deployment-specific lives in `src/config.ts` and nowhere else; if adopting Starfish somewhere new needs engine
code touched, that is a bug in the design. What is and is not configurable today, row by row: [`docs/genericity.md`](docs/genericity.md).
Starfish assumes Firestore for its incident store, and reads Cloud Functions and Cloud Run logs.

## Where to read more

| | |
|---|---|
| What is built, tested, validated and observed, with dates and evidence | [`docs/status.md`](docs/status.md) |
| Set it up on a project, step by step | [`docs/setup.md`](docs/setup.md) |
| What the deploy creates, identities, GitHub Actions deploys, the admin API, alerts, the public demo's open actions | [`docs/deploy.md`](docs/deploy.md) |
| The trust ladder and the merge policy | [`docs/trust-ladder.md`](docs/trust-ladder.md), [`docs/design/auto-merge-policy.md`](docs/design/auto-merge-policy.md) |
| The UI, its pages and captures | [`docs/ui.md`](docs/ui.md), [`docs/design/mockups.md`](docs/design/mockups.md) |
| Logs are not the only signal (the Monitoring source) | [`docs/blind-spots.md`](docs/blind-spots.md) |
| The long, dated narrative of how each part was built | [`docs/implementation-notes.md`](docs/implementation-notes.md) |
| Commands, the synthetic demo history, the layout of the repository | [`docs/development.md`](docs/development.md) |
| Does Gemini write the patch a human wrote? | [`docs/spike.md`](docs/spike.md) |
| Self-healing systems: the literature, and where Starfish sits | [`docs/research/self-healing-systems.md`](docs/research/self-healing-systems.md) |

Starfish is built with AI-assisted development (Claude Code); the git hooks, verify gate, Claude Code hooks and skills live in
the repo, with `CLAUDE.md` as the entry point. The product itself runs on Gemini.
