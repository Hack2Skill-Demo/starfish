# What is built, tested, validated and observed: dated evidence (#391)

**As of 2026-10-17.** This page is the one place that says how far each capability has got, and on what evidence. The README
links here instead of repeating it. Everything else that says "deployed", "ran" or "merged" is a dated narrative and may be
stale: [implementation-notes.md](implementation-notes.md) keeps the old, long version.

## How to read it

Four levels, each stronger than the one before. A capability is only as far along as the **last level it has an entry for**.

| Level | Means | Evidence it needs |
|---|---|---|
| **Implemented** | the code exists in this repository | the code |
| **Tested** | automated tests pass against fakes, stubs or the Firestore emulator | the tests (`pnpm run verify`, `pnpm test:emulator`) |
| **Validated** | it was exercised against the real external service (Google, GitHub, Slack, Twilio), at least once | a dated record someone can look at |
| **Observed** | it has run in the demo deployment, as deployed, on real incidents or real merges | a dated record someone can look at |

Where the evidence comes from is marked on each claim:

- **[G]** checked on GitHub on 2026-10-17 for this page: the Actions run history of this repository (`gh`-less, through the
  Actions API) and the public pages of the demo app's pull requests and runs. Anyone can repeat it from the links.
- **[T]** reported by the team (the facts `CLAUDE.md` records as confirmed, and the dates the docs carry). Not re-checked here.
- **[C]** the code and its tests only.

**What source inspection cannot prove**, and this page does not claim: which repository variables and settings are set in
the deployed project *now* (dry run, auto-merge target, merge cases, public actions), whether a given run is still healthy,
and anything inside Google Cloud. `pnpm status` and the Settings page are the live answers.

## The words for an outcome

"Fixed" can mean four different things. The docs use these four, and nothing else, for what Starfish has done to an error:

| Outcome | Meaning | Does Starfish itself record it? | Evidence so far |
|---|---|---|---|
| **Proposed PR** | a verified, reviewed pull request that fixes the error was opened | yes: the cycle's run record and links | three on the demo app: demo-app #41, #42 and #49 [G]. Each PR page shows the target's verify check passed and the reviewer's verdict "approve with flags" |
| **Merged change** | the pull request was merged | **by Starfish: never run** (built, switched on for the demo target, never run against real GitHub [C][T]). A person's merge is read back by the PR reconcile step, which has not been confirmed against real GitHub [C] | **by a person: two.** demo-app #49 on 2026-10-13 and #41 on 2026-10-15, merged by the maintainer ("merged commit … into main"), with no review on the PR page [G]. #42 was closed unmerged on 2026-10-16 as redundant [G] |
| **Deployed fix** | the merge commit is serving | **built, never run (#390):** the recovery observer reads GitHub's Deployments API for the merge commit, in the environment `STARFISH_DEPLOY_ENVIRONMENT` names (empty by default, so off) [C]. The fast-revert watch still starts at the merge, not at a deployment [C] | the target's own pipeline deployed both merges: demo-app Deploy run #25 (for #49) and #26 (for #41) succeeded [G]. That workflow's deploy job runs in `environment: production`, which GitHub records as a Deployment [C: its workflow file; the Deployments API itself was not read for this page] |
| **Verified recovery** | the error stopped, with evidence that it would have shown if it had not | missing-index path: built, **never run** [C]. Merge recurrence watch: built, **never run** [C]. **General code fixes, whoever merged: built, never run (#390):** `recovered` only after a confirmed deployment, a quiet window long enough for the error's old rate to have shown, and ingest read through it [C] | **none.** No fix has been verified to have cured its error. demo-app #56 (2026-10-15) deliberately put `getOrder.ts` back to its baseline so the demo's fault exists again [G], so the merged fix is not in effect either |

So the precise answer to "has Starfish fixed anything?" is: **it has proposed fixes (three pull requests). A person merged two of
them and the target deployed them. Starfish has merged nothing itself and has not verified that any fix cured its error.**
An earlier phrasing, "nothing merged" or "none merged", was true of Starfish's own merges and false of the pull requests;
it is corrected throughout.

## The capability matrix

`yes` = at that level with the evidence named; `no` = nothing yet. Rows are grouped by the stage of the loop.

### Ingest and the store

| Capability | Implemented | Tested | Validated | Observed in the deployment |
|---|---|---|---|---|
| Log ingest: windows, checkpoint, fingerprint dedup, redaction, counter-check | yes | yes: fake Logging, emulator | yes: real Cloud Logging read, planted error read into the store, 2026-10-05 [T] | yes: scheduled job on the demo project, hourly [T]; no error flood has gone through it [T] |
| Ingest alerts for a missed run and a stalled checkpoint (#387) | yes | yes: stubs | no | no: a person has to run `scripts/setup-ingest-alerts.sh`; it has not been run |
| Cloud Monitoring failure signal (#19) | yes | yes: fakes | no | no: off by default |
| Missing-index heal (#11) | yes | yes: fakes, emulator | no: never met Google | no |
| Recovery of a merged fix, anyone's merge: deployment confirmed, then recovered / recurred / unverified (#390) | yes | yes: fake GitHub and the emulator, the whole sequence from the incident to a person's merge to the deployment to `recovered`, and the recurrence and every "unverified" path | no | no: needs `STARFISH_DEPLOY_ENVIRONMENT` set on the agent job (it is not set [T: the variable is not among those the team lists]) and a token that can read deployments; neither has been done |
| Admin API: "Run ingest now" | yes | yes | yes: once, from the deployed UI, 2026-10-07 [T] | no |
| Admin API: Retire, "Run agent now", Twilio routes | yes | yes | no | no |
| Guests' trimmed copies and the public demo's view | yes | yes: unit, emulator | no | not confirmed here: the docs say the copy writes have never been run on a real project [T], while the README presents the guest view as live; open the demo in a signed-out browser to check (#16) |
| Public demo's open actions for visitors (#377) | yes | yes: stubs, emulator | no | not known: the repository variable was set on 2026-10-16 [T]; no visitor action is on record here |

### The agent loop

| Capability | Implemented | Tested | Validated | Observed in the deployment |
|---|---|---|---|---|
| Triage (Gemini) | yes | yes: stubbed model | yes: real Gemini since 2026-10-08 [T] | yes: the agent job runs hourly on the demo project [T] |
| Fix draft (Gemini) | yes | yes: stubbed model | yes: patches reached pull requests 2026-10-12/13 [G] | yes: three proposed PRs (above) [G]; earlier attempts declined for want of source (2026-10-08) or were refused by the gate as not applying (2026-10-12) [T] |
| Verify, `github-actions` isolation | yes | yes: real git, fake GitHub | yes: the demo app's `verify` check passed on pushed `starfish/<cycle>` branches [G] | yes, on those runs |
| Verify, `cloud-run-job` isolation | yes | yes: local stand-in for the bucket | no | no: never deployed |
| Verify runner limits: streamed byte cap, deadlines, bounded extraction (#389) | yes | yes | no | no: part of `cloud-run-job`, which has never run |
| Adversarial review (Gemini) | yes | yes: stubbed model | yes: reviewed the patch behind demo-app #41, 2026-10-12 [T]; the PR pages carry its verdict [G] | yes |
| One way to show the model a bounded block (cuts marked, a stack-named file windowed at its frame, each file saying how it was found) and one typed model outcome (a cut or filtered answer goes to a person, #416 to #420) | yes | yes: stubbed model, mocked Vertex client, emulator | no: not yet run against Vertex | no: not yet deployed (as of 2026-10-18) |
| GitHub issue, and the pull request | yes | yes: real git, fake GitHub | yes: since 2026-10-12 [G] | yes: pull requests demo-app #41, #42 and #49 [G]; their issues are linked from them [G] |
| One issue per incident across a recurrence, as a comment (#397) | yes | yes: fake GitHub | no | no |
| Slack: "needs a human" and "new incident" | yes | yes: fake webhook | yes: posted to real Slack since 2026-10-11 [T] | yes |
| Reading a pull request back (reconcile) | yes | yes: fake GitHub, emulator | no | no |
| Reopening a declined or handed-off run ("Retry with agent") | yes | yes: emulator | no | no |
| Auto-merge | yes: for the demo target, default-off switches | yes: real git, fake GitHub, emulator | **no: never run against real GitHub** | **no.** The safety floor refused a real patch there (the docs name demo-app #41 and #49), so Starfish did not merge it [T]; a person did |
| Fast revert after a merge | yes | yes | no | no |
| Phone escalation (#37) | yes: off by default | yes: fake Twilio, emulator | no | no |

### Deployment and delivery

| Capability | Implemented | Tested | Validated | Observed in the deployment |
|---|---|---|---|---|
| `Deploy engine` workflow, deploy on merge | yes | yes: the workflow's properties are pinned by a test | yes | yes: runs #67 to #78 (2026-10-14 to 2026-10-17) all succeeded, the latest on the merge of #399 [G]; earlier runs not re-checked |
| `Deploy web UI` workflow | yes | yes | no | **failing:** the eight runs checked (#75 to #82, 2026-10-16 to 17) all failed, and run #82's log stops at the Hosting site read with HTTP 403: the deployer needs `roles/firebasehosting.admin`, which `scripts/setup-github-deploy.sh` grants and has not been re-run on the project to give (#370) [G][T]. The UI is published from the maintainer's Mac script [T] |
| Web deploy waits for the engine deploy of the same push (#373) | yes | yes: stub `gh` | yes: run #82 (2026-10-17) waited about 4 minutes for Deploy engine run #78, then its rules check passed and it built [G] | yes, on that run |
| Operator UI on Hosting | yes | yes | yes: first deployed 2026-10-05 [T] | yes: `ocean-starfish.web.app` |
| Incident list reads by cursor (#388) | yes | yes | no | not known: not published by the GitHub workflow (above); whether the Mac script has published it is not recorded |

## What recovery covers today, and what it does not (#390)

Recovery has three pieces. All three are built; none has run against a real service.

1. **Index recovery (built, never run).** After a missing-index heal creates an index, `src/indexheal/observe.ts` calls the heal
   **healed** only when no occurrence was recorded from the index being READY through a quiet window, ingest's checkpoint
   shows it read the logs through that window (a stalled ingest records no occurrences either, so until it has, the heal keeps
   observing, and a day later it is **unverified**), and the failing query, replayed read-only, passes at the end. Otherwise it is
   **recurred** or query-failing. It never resolves the incident itself. This is the one place with a positive probe.
2. **Merge recurrence watch and revert (built, never run).** A merge **Starfish made** starts `src/agent/fastRevert.ts`: the
   same incident seen again after a grace and within a window of the **merge** opens a revert pull request of Starfish's own
   merge commit. A watch that saw nothing clears only once ingest has read through the window. **A clear watch is not proof
   of a deployed, healthy revision:** the window starts at the merge, not the deploy, and silence is not recovery.
3. **Recovery of a merged fix, whoever merged it (built, never run, #390).** For every pull request Starfish opened that is merged,
   `src/agent/recoveryStep.ts` records one of five answers on the cycle (`summary.recovery`), shown on the Runs and evidence pages:
   - **awaiting-deploy:** merged; no deployment of the merge commit has completed. GitHub's Deployments API is read for the
     configured environment (`STARFISH_DEPLOY_ENVIRONMENT`): a deployment created after the merge whose commit is the merge
     commit, or is ahead of it by GitHub's compare, with a `success` status. The clock starts at that status, not at the merge.
   - **observing:** deployed; the quiet window, or ingest's read of the logs through it, is not done.
   - **recovered:** the window passed with the error not seen, ingest's checkpoint read through it, and the error's rate before the
     merge says it would have shown. The window is `STARFISH_RECOVERY_QUIET_MINUTES` (60), lengthened until at least
     `STARFISH_RECOVERY_MIN_EXPECTED` (5) occurrences were expected at that rate; the expected count is recorded and shown.
   - **recurred:** the incident was seen again after the deployment and `STARFISH_RECOVERY_GRACE_MINUTES` (5) for the old revision to
     drain, from the incident's latest occurrence (which never moves back) or a regression the ingest marked. It does not wait for
     the window to end.
   - **unverified, with a reason, never recovered:** no deployment environment is configured; the deployment failed, was not seen,
     or could not be read within `STARFISH_RECOVERY_GIVE_UP_HOURS` (24) of the merge; the incident was retired or is gone (a
     recurrence would be a new incident); the error was too rare for silence to mean anything (the window it would need is longer
     than the give-up time); ingest did not read through the window within a day of its end.

   It observes only: it never resolves the incident, changes the cycle's outcome, reverts, merges or notifies. A final answer is
   final and is not read again.

**What the recovery check cannot do, and does not claim.**
- It needs the target's pipeline to record a GitHub deployment (a workflow job that runs in an `environment:`; demo-app's does) and
  the agent's token to read deployments; without either the answer is `unverified`, never a guess. Neither is set up in the demo
  deployment yet: the variable `STARFISH_DEPLOY_ENVIRONMENT` is not among the ones the team lists, and the token's scope for
  deployments is unknown.
- "The error did not show in a window where about N occurrences were expected" is evidence (about a `exp(-N)` chance of seeing none
  if it were still firing at its old rate), not proof that the deployed revision exercised the fixed path, nor that the error
  stopped because of the fix: one that was already dying out before the merge would also read as recovered. A positive probe, as the
  index path has, is not built for code fixes. The error's rate comes from the incident's hourly buckets, each ingest window's count
  put in the hour of its latest occurrence, so it is an estimate.
- A slow deployment pipeline that reports success before the new revision serves would start the clock early; the grace is the
  allowance for that.
- It has not been demonstrated end to end on the real demo project. The sequence it must show (a fault, its detection, a verified
  pull request, a merge, a deployment, recovery evidence, and a recurrence) is tested against fakes and the emulator in
  `src/agent/recoveryStep.emulator.test.ts`; running it for real is a step of the demo runbook (#163).

## How this page was checked, and how to repeat it

On 2026-10-17: the Actions run history of `Hack2Skill-Demo/starfish` (Deploy engine runs #67 to #78, Deploy web UI runs #75 to #82,
and the failing job's log of run #82), the public pull-request pages of `Hack2Skill-Demo/demo-app` #41, #42 and #49 (state,
merged-by, verify and review text, "no reviews"), that repository's merge commits and its Deploy runs #25 and #26, and a local
clone of it for the merge dates and the deploy workflow. The rows marked [T] were not re-checked: they rest on what the team
confirmed. A row's "Observed" cell is blank of a claim unless a source is named, and a new claim here needs one.
