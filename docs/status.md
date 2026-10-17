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
| **Deployed fix** | the merge commit is serving | **no.** Starfish cannot observe a target's deployment (`fastRevert.ts` starts at the merge for that reason) [C] | the target's own pipeline deployed both merges: demo-app Deploy run #25 (for #49) and #26 (for #41) succeeded [G]. That workflow records a GitHub Deployment on `production` and `deployments/<commit>` in the shop's database; Starfish reads neither (#390) |
| **Verified recovery** | the error stopped, with evidence that it would have shown if it had not | missing-index path: built, **never run** [C]. Merge recurrence watch: built, **never run** [C]. **General code fixes: not built** (#390) | **none.** No fix has been verified to have cured its error. demo-app #56 (2026-10-15) deliberately put `getOrder.ts` back to its baseline so the demo's fault exists again [G], so the merged fix is not in effect either |

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

Recovery has three separate pieces. Two exist for narrow cases and one is missing.

1. **Index recovery (built, never run).** After a missing-index heal creates an index, `src/indexheal/observe.ts` calls the heal
   **healed** only when no occurrence was recorded from the index being READY through a quiet window, ingest's checkpoint
   shows it read the logs through that window (a stalled ingest records no occurrences either, so until it has, the heal keeps
   observing, and a day later it is **unverified**), and the failing query, replayed read-only, passes at the end. Otherwise it is
   **recurred** or query-failing. It never resolves the incident itself. This is the one place Starfish makes a positive check.
2. **Merge recurrence watch and revert (built, never run).** A merge **Starfish made** starts `src/agent/fastRevert.ts`: the
   same incident seen again after a grace and within a window of the **merge** opens a revert pull request of Starfish's own
   merge commit. A watch that saw nothing clears only once ingest has read through the window. **A clear watch is not proof
   of a deployed, healthy revision:** the window starts at the merge, not the deploy, and silence is not recovery.
3. **General code fixes (missing, #390).** A fix a **person** merged (the only kind there has been) gets neither of the above.
   Starfish records that the PR merged (`reconcile.ts`), never that the fix reached production, never that the error stopped,
   and never marks the incident healed. There is no acknowledgement tied to the merged revision, no observation that starts at
   a confirmed deployment, and no way to tell recovered, recurred and unverified apart.

## How this page was checked, and how to repeat it

On 2026-10-17: the Actions run history of `Hack2Skill-Demo/starfish` (Deploy engine runs #67 to #78, Deploy web UI runs #75 to #82,
and the failing job's log of run #82), the public pull-request pages of `Hack2Skill-Demo/demo-app` #41, #42 and #49 (state,
merged-by, verify and review text, "no reviews"), that repository's merge commits and its Deploy runs #25 and #26, and a local
clone of it for the merge dates and the deploy workflow. The rows marked [T] were not re-checked: they rest on what the team
confirmed. A row's "Observed" cell is blank of a claim unless a source is named, and a new claim here needs one.
