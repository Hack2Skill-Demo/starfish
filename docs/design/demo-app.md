# Demo app proposal: the Scenario lab

> **Status: proposed, not built.** The demo app repositories hold no code yet, and most of what the
> scenarios check is designed but not built in Starfish (see the status column in
> [`demo-app-scenarios.md`](demo-app-scenarios.md)). Written 2026-10-04 for #5 and #32.

## Summary

The demo app is a small shop whose code and cloud setup carry **84 planted scenarios**. Every setting and rule on Starfish's Engine, On-call and Connections screens has at least one ([`demo-app-scenarios.md`](demo-app-scenarios.md)). A **Scenario lab** page, in a separate control app, has one button per scenario. Pressing it changes what the shop's synthetic customers do, or what the cloud project allows. It never switches the code to a buggy path. A **scenario runner** then checks what Starfish did against that scenario's expected outcome, so the same buttons serve as an end-to-end test suite for Starfish.

Four of them are the core of the live 3-minute demo, taken straight from the mockup's Live runs screen:

- `orders-createOrder`: a Firestore `undefined` field (fix by PR)
- `orders-listRecentOrders`: a missing composite index (heal)
- `invoices-renderPdf`: an API that is not enabled (notify only)
- `reports-nightlyExport`: a one-off timeout (decline)

The storyboard's on-camera step, "0:20 Switch on the missing-index fault in the demo app", is one press of the first button.

It deploys into the same Firebase project as Starfish. It uses its own functions codebase, its own Hosting site and the `(default)` Firestore database, so the two never overwrite each other ([#32](https://github.com/Hack2Skill-Demo/starfish/issues/32)).

## The rule: the button changes the world, never the code

The obvious way to build a fault button is a flag in the code: `if (faults.couponBug) write undefined`. We should not do that. Starfish reads the code to fix it, so it would find the flag. Its "fix" would just delete the flag branch, and any judge reading that PR would see a staged bug, not a real one.

Instead, each fault is real code (or a real missing resource) sitting on `main`. It stays hidden until something in the outside world exposes it. The button changes that outside world:

- **Traffic:** synthetic customers start doing something they weren't doing before, such as checking out without a coupon.
- **Data or infrastructure:** the project loses something the code depends on, such as an enabled API.

This is how real production incidents happen. A latent bug meets a new usage pattern. It also means Starfish's PR fixes a real line in a real file, and after the fix the same traffic succeeds. That is the "healed" moment the demo needs.

The one exception is the stubs that stand in for vendors (mail, payments, a slow upstream). They hold deliberate switches, but they sit in the control repo, which Starfish never reads, and nothing in them is Starfish's to patch.

## The app

A small storefront: browse products, check out (with an optional coupon field), see "My recent orders", download an invoice. The Scenario lab is not part of it (see "Two repos" below). It uses the same stack as Starfish's own UI so one team can work on both: TypeScript, pnpm, React 19 + Vite, Firebase gen2 Functions on Node 22, and Firestore.

| Function (as logged) | Kind | Scenarios it hosts |
| --- | --- | --- |
| `orders-createOrder` | Callable | CODE-01, FR-01, ING-02, ING-03, ING-12, G2-03 |
| `orders-listRecentOrders` | Callable | IDX-01, IDX-03, BUD-03, CON-01 |
| `orders-searchOrders` | Callable | IDX-02 |
| `orders-getOrder` | Callable | CODE-02, G1-04, G2-04 |
| `orders-cancelOrder` | Callable | CODE-03, G2-02 |
| `orders-applyGiftCard` | Callable | G2-01 |
| `billing-createCheckoutSession` | Callable | G1-01, G1-03, TRI-03, NOISE-02 |
| `payments-webhook` | HTTP | G1-05 |
| `accounts-onUserCreate` | Auth trigger | G1-02, FB-02 |
| `invoices-renderPdf` | Callable | CFG-01, CFG-02, ESC-01 to ESC-08 |
| `notifications-sendReceiptEmail` | Firestore trigger | ING-04, CFG-03, CFG-04 |
| `reports-nightlyExport` | Scheduled | NOISE-01 |
| `reports-weeklyDigest` | Scheduled, gen1 | ING-08 |
| `reports-importCsv` | Callable | TRI-05, BUD-01 |
| `reports-dailyRollup` | Scheduled | IDX-04 (queries the `analytics` database) |
| `support-submitTicket` | Callable | ING-10, TRI-04 |
| `admin-backfillTotals` | Scheduled | TRI-02, FB-01 |
| `misc-warmCache` | Scheduled | ING-07 |
| `pdf-renderer` | Cloud Run service | ING-09 |
| `traffic-tick`, `control-*`, `stub-mail`, `stub-payments`, `stub-upstream` | Infrastructure | ING-15; never a fault themselves |

The stubs stand in for the outside world: a mail provider, a payment provider and a slow data upstream. The controller can make each one rate-limit, fail once or hang. That gives repeatable vendor failures without depending on a real vendor's bad day.

Functions are grouped exports (`export const orders = { createOrder, listRecentOrders }`), which gives the `orders-createOrder` names from the mockup. Starfish already treats the gen2 spelling `orders-createorder` as the same function.

Separation from Starfish, set up from the first commit:

- `firebase.json`: `functions[].codebase: "demo"`, so a demo deploy never deletes Starfish's functions.
- A Hosting site of its own (for example `starfish-demo-shop`), named in `firebase.json`.
- Firestore `(default)` only. Starfish's store stays in the named database `starfish`.
- No `ignoreUndefinedProperties`, so the coupon fault behaves exactly as in the mockup.
- A real `pnpm run verify` (lint, typecheck, test, build). Starfish's verify gate will run it against every fix. Its tests must not cover the faulty paths, or `main` would never be green with the bug in it. The evaluator tests from [#5](https://github.com/Hack2Skill-Demo/starfish/issues/5) live outside this repo.

**Two repos, so Starfish can't read the answers.** Starfish reads the repo it fixes, and [#10](https://github.com/Hack2Skill-Demo/starfish/issues/10) requires the ground truth to stay hidden from the fixer and the reviewer. So everything that knows where the faults are lives apart from the shop:

- **`demo-app`**, which Starfish watches and fixes: the shop, its functions, its tests, `firestore.indexes.json` and its CI/CD. Starfish's GitHub App is installed here only.
- **`demo-control`**, private, and never visible to Starfish: the Scenario lab, the controller, `traffic-tick`, the stubs, the scenario files, the runner, the reset workflow and the evaluator tests.

Both deploy into the same project as separate functions codebases (`demo`, `demo-control`) and separate Hosting sites. The shop reaches the stubs through configured URLs, just as it would a real vendor.

## The live-demo core: four faults

These four are the storyboard's runs, and the rest of the catalog follows the same pattern. Each button exposes a fault that is already there. Every error message below is the one the mockup shows, apart from the API name in the notify case (explained under the table).

| Button | What the press changes | Error in the logs | Starfish's path (mockup) | Reset |
| --- | --- | --- | --- | --- |
| **Missing index** | Synthetic customers start opening "My recent orders". Baseline traffic never calls it. | `9 FAILED_PRECONDITION: The query requires an index. You can create it here: …` | Create the index, then an evidence PR waits for a human | Controller deletes the index and removes its entry from `firestore.indexes.json`; recent-orders traffic stops |
| **Checkout without coupon** | Synthetic customers start checking out without a coupon. Baseline orders always carry one. | `Cannot use "undefined" as a Firestore value (found in field "couponCode")` | Fix PR, merge on green, the app's CI/CD deploys, fast-revert armed (#9) | A reset workflow restores the baseline line on `main` and deploys it; coupon-less traffic stops |
| **API disabled** | Controller disables the one API `invoices-renderPdf` uses | `7 PERMISSION_DENIED: Cloud Translation API has not been used in project … or it is disabled` | Notify on-call with the console step; no patch | Nothing if the human re-enabled it; otherwise the controller re-enables it |
| **Slow upstream** | Sets a one-shot slow marker on the upstream stub and starts an export run now | `4 DEADLINE_EXCEEDED: Deadline exceeded` (once) | Decline and record why | None; the marker is used up and the next run succeeds |

**Use a different API than the mockup's Cloud Storage.** Cloud Functions deploys upload their source to Cloud Storage. Disabling it in a shared project would break deploys for Starfish and the demo app alike. The disabled API must be one nothing else in the project uses. Cloud Translation (`translate.googleapis.com`) is one example: invoices get their line items translated into the customer's language. Disabling an API can also take a few minutes to take effect, so press this button before its segment, not on camera.

**The decline case uses a stub's switch.** The slow-upstream marker lives in `stub-upstream` in the control repo, not in `reports-nightlyExport`. There is nothing to patch, and Starfish never sees the switch. The correct outcome is to leave it alone.

## Traffic

`traffic-tick` runs every minute on Cloud Scheduler and acts as a handful of synthetic customers. They are real Firebase Auth users on a reserved domain. The tick signs each one in with a custom token and calls the deployed callable functions over HTTPS. Errors are therefore logged by `orders-createOrder` itself, exactly as real customer traffic would be.

- **Baseline:** a few healthy orders a minute, always with a coupon, plus invoice downloads. No errors.
- **Scenarios:** the button flips a field in `demo_control/traffic` (`couponless`, `recentOrders`). The tick reads it on every run. Rates are set so failures arrive at 1 to 2 a minute, close to the mockup's counts: 11 in 6 min for the index, 31 in 20 min for the API.
- **Real visitors** to the shop exercise the same functions. A visitor who checks out without a coupon during a cycle hits the same bug.

The app itself costs close to nothing. There are 6 Scheduler jobs: traffic, the nightly export, the weekly digest, the daily rollup, the backfill and the cache warmer. 3 are free per billing account, and the other 3 cost $0.10 each a month. That is also roughly 7,000 function calls a day, against 2 million free a month. The paid extras are the optional ones in the decisions table (Twilio, the `analytics` database). Starfish's Gemini spend is separate, with the daily incident cap from #5.

## The button

The Scenario lab is a page in the control app, not the shop. It lists all 84 scenarios, grouped as in the catalog, each with a Run button, its expected outcome, its status (Today, Designed, Gap) and its last result. Four large buttons at the top are the live-demo core. Anyone can view the lab, but only signed-in team members can press. This matches the mockup's rule that visitors are view-only guests. It also stops a stranger from burning the Gemini budget or starting a scenario on top of one Starfish is still handling.

Only one scenario runs at a time. Each run is a **cycle** with its own id and a deadline (the `maxCycleDurationMinutes` setting from [#5](https://github.com/Hack2Skill-Demo/starfish/issues/5)). While a cycle is active, the other buttons are disabled. #5's 30-minute default fits the index, notify and decline paths. A code fix runs CI, merges, deploys through the app's CI/CD and then waits out a 30-minute watch, so code-fix scenarios get 90 minutes.

What one press does:

1. `control-triggerFault({ caseId })` checks that the caller is on the team list.
2. In one Firestore transaction it checks that `demo_control/cycle` is idle. It then writes `{ caseId, cycleId, startedAt, deadline, state: "active" }`.
3. It applies that case's change to the world (the table below).
4. It sends one burst of traffic straight away, so the first errors land within seconds rather than at the next minute.
5. `traffic-tick` keeps the new behaviour going every minute.
6. The lab shows the cycle live: which fault, time elapsed, errors in the last minute, and a link to Starfish's Live runs.

The cycle ends in one of three ways:

- Starfish's run reaches a final outcome: healed, merged, notified or declined. For the MVP a team member confirms this with Reset. Later the lab can read Starfish's run state itself.
- The deadline passes. The cycle is recorded as `timed_out`.
- A team member presses Reset.

Reset undoes the world change. For the code fault it also restores the baseline code. It never erases the incident, issue or PR history.

**Timing on camera.** Errors appear in Cloud Logging within seconds of the press. Starfish only sees them on its next ingest run, and the mockup shows a 5-minute schedule. For the live video, either run ingest every minute during the demo, or add a "run ingest now" to Starfish. That is a Starfish-side change.

## When it's fixed, the app works again

Every fault sits on a real shop feature, and that feature's screen is built with both states from day one. While the fault is live, a visitor sees the failure. Once the fix takes effect, the same screen shows the working feature, with no flag and no UI redeploy. The heal shows up on its own, whether it comes from Starfish's index, its merged fix, or a human's console step.

| Scenario | While broken, a visitor sees | Once fixed, a visitor sees | What fixes it |
| --- | --- | --- | --- |
| IDX-01 | "My recent orders": "Couldn't load your recent orders" | Their last 10 orders, newest first | Starfish's index reaches READY |
| CODE-01 | Checkout without a coupon: "Something went wrong placing your order" | Order confirmation with an order number; the order shows in "My recent orders" | Starfish's fix, merged on green and deployed by the app's CI/CD |
| CFG-01 | "Download invoice": "Invoice unavailable" | The PDF downloads, line items translated | A human enables the API |
| NOISE-01 | Reports page: last night's export "failed" | The next run shows "ready" | Nothing: the next run is healthy |
| FR-01 | Gift-wrapped orders fail after the coupon fix | Gift-wrapped and coupon-less orders both confirm | Starfish reverts its first fix (#9), then a fix that covers both writes |

**A health strip shows it live.** `traffic-tick` records the outcome of every synthetic call per feature: Checkout, Recent orders, Invoices, Exports and so on. The Scenario lab shows each feature as a dot, using its success rate over the last 5 minutes. A press turns one dot red, and the fix turns it green again. The strip comes from the app's own calls, not from Starfish, so it is an independent witness that the heal is real. On camera, Live runs sits on one side and the strip turns green on the other.

**Each scenario declares its healthy behaviour.** Next to its expected Starfish outcome, every scenario file carries a `healthy` check: the deterministic flow probe #9 asks for. It uses the feature the way a customer would and checks the right result, not merely the absence of an error. For CODE-01 that means a coupon-less order returns an order id and the stored order has no `couponCode` key. For IDX-01, the list comes back sorted newest first. A run passes only when all three hold:

1. Starfish did the expected thing.
2. The `healthy` check passes after the fix.
3. The feature's dot stays green under traffic for Starfish's 30-minute watch.

A reset puts the fault back but leaves it latent. The dot stays green until the next press, because baseline traffic never touches the faulty path.

## Reset: the same bugs, again and again

The starting state of every fault lives in git as a tag, `baseline-v1`. A reset copies only the files that scenario owns back from that tag, in a normal commit on `main`. History is never rewritten, so it reads fault, fix, reset, fix. That is the public evidence trail #5 asks for.

1. **The baseline tag.** `baseline-v1` marks a commit where every latent fault is present and `pnpm run verify` is green. Each scenario file lists the paths it owns. CODE-01 owns `functions/src/orders/createOrder.ts`; IDX-01 owns `firestore.indexes.json`.
2. **The reset workflow.** `control-reset` starts a GitHub Actions workflow, `reset-scenario.yml`, with the scenario and cycle ids. It closes Starfish's open PRs and issues for that cycle with a comment. It then branches from `main` and runs `git restore --source=baseline-v1 -- <owned paths>`.
3. **Nothing changed?** The fix was never merged, so the bug is still there. Skip straight to the non-git state.
4. **Otherwise a reset PR,** `chore(demo): reset CODE-01 to baseline (cycle …)`. CI runs the verify gate, plus the scenario's private evaluator test, which must **fail**. A failing test proves the fault is back. The controller's own GitHub App merges it, never Starfish's, and the app's normal CI/CD deploys it. A reset never runs while Starfish is verifying a fix or inside its revert window. #9 forbids it, and it would look like an unrelated change landing on top of the fix.
5. **Non-git state.** The controller deletes the healed index, re-enables the API, restores the IAM grant and the secret version, and clears traffic flags and stub markers. The button stays disabled until a deleted index is really gone and a re-enabled API really answers; both take minutes.
6. **A fresh start in Starfish.** See the first trap below.

A **Full reset** button does this for every scenario at once. Use it before recording.

**Why not `git reset --hard baseline` and a force-push.** It would erase Starfish's merged fixes from public history and break every PR link. It would also invalidate everyone's checkout and need force-push rights on `main`, which branch protection should forbid.

**Trap 1: Starfish would see a regression.** Last cycle's incident is resolved. When the same bug fires again, Starfish correctly reopens it as `recurred`. If that lands inside the fast-revert window, it would open a revert PR. So Starfish needs a **cycle boundary** action. It closes the old incident for good and frees its fingerprint, so the next occurrence starts a new incident and fast-revert stays quiet. This is a Starfish-side change. The controller calls it and never writes to Starfish's database. ING-05 and FR-03 skip this step on purpose, to test recurrence.

**Trap 2: the baseline drifts.** When app code changes for other reasons, an old baseline copy of a file may no longer fit. The reset PR's verify gate catches that, and the reset stops with "baseline needs a refresh" in the lab. The fix is a new tag, `baseline-v2`, cut with the fault still in place, and a manifest update.

## Testing the scenarios

Each scenario is one file in demo-control, `scenarios/<ID>.ts`. It declares a setup, a trigger, an expected outcome, a reset and a timeout. The runner works the same from the lab's Run button or from the command line (`pnpm scenario run ING-02`, `pnpm scenario suite ingest`):

1. **Setup:** put Starfish and the app in the scenario's starting state, for example dry run on, or an incident already resolved by an operator.
2. **Trigger:** call `control-triggerFault`, as a press does.
3. **Wait:** poll for Starfish's response until the scenario's timeout.
4. **Assert:** compare what Starfish did with the expected outcome.
5. **Reset and record:** undo the change and store the result. The lab shows it as pass, fail, timed out or waiting on a stage.

What a run can assert grows with Starfish:

| Evidence | What is checked | Available |
| --- | --- | --- |
| Incident store | Exists or not, count equals the raw recount, error type, service, status (`recurred`, `ignored`), redacted text, distinct fingerprints | Today |
| Starfish's run record | Triage verdict, class, chosen path, each gate's result | When Starfish stores runs (the Live runs screen implies it) |
| Outside effects | GitHub issue or PR and its labels, the Slack message and channel, index state, the call log | As each connection is built |

Suites:

- **ingest:** the 18 "Today" scenarios, run with triage off so they make no Gemini calls. Run nightly in demo-control's CI and before each Starfish release.
- **rules, gates, escalation and budgets:** on demand. They count against the daily Gemini cap and use dry run wherever the scenario allows.
- **demo:** the four core scenarios, as the rehearsal before recording.

**Results feed the scoreboard** ([#10](https://github.com/Hack2Skill-Demo/starfish/issues/10)). Each run is stored in #10's format: corpus version, app and Starfish revisions, model, configuration, and the outcome. A timeout counts as a failure, never as a skipped run. `pnpm scoreboard` reads these records, so the numbers in the video come from real runs.

**Held-out cases.** Everyone tuning Starfish can read the catalog, so it is the tuning and regression set. #10's held-out cases are written by someone who doesn't tune prompts. They live only in `demo-control` and are never listed in these docs.

**What the runner may touch in Starfish.** It reads the `starfish` database through a read-only identity and never writes to it. Anything a person would do, it does through Starfish's own rules as a test account. As an operator it resolves or ignores incidents (ING-05, ING-06, FB-01, FB-02). As an admin it changes runtime settings (SET-01 to SET-04), and each save leaves an audit entry. Settings that aren't runtime settings yet wait on #7 and #9: dry run, triage on/off, caps and auto-merge. ING-13 also needs Starfish's ingest to be callable on demand.

## Guardrails and what Starfish needs

**What a press shows today.** Ingest, fingerprinting, dedup, the counter-check, redaction and runtime settings are built. Nothing runs ingest on a schedule yet, because the Cloud Run job and Scheduler are [#6](https://github.com/Hack2Skill-Demo/starfish/issues/6). Until #6 lands, the runner calls the engine's ingest directly, so the built scenarios can be checked. Triage, the fix draft, the verify gate, review, Slack, auto-merge and the index heal are designed, not built. The demo shows each one only once it exists.

The demo side:

- **A controller identity of its own.** The control functions run as their own service account. That account can delete and create indexes on `(default)`, disable and re-enable the one allowlisted API, change IAM on the one invoices bucket, disable and enable versions of the one mail secret, and run the reset workflow. Every target is hard-coded; nothing is chosen at run time. Starfish's account gets none of these, and per #5 the healer never deletes an index.
- **IAM can't limit API disabling to one API,** so `control-triggerFault` hard-codes the single service name it may touch.
- **Deploys go through the app's own CI/CD** ([#9](https://github.com/Hack2Skill-Demo/starfish/issues/9)). Merging to `main` deploys the changed functions. The pipeline records the commit, the deployed revision and the completion time, because Starfish's fast-revert window starts at completion. It never deploys `firestore.indexes.json` with `--force`, so a lagging index file can't delete an index Starfish created.

Starfish's side:

- An ingest exclusion list covering `traffic-*`, `control-*`, the stubs and Starfish's own functions ([#32](https://github.com/Hack2Skill-Demo/starfish/issues/32)). It fits as a new runtime setting next to the noise list.
- The index-heal allowlist names `(default)`, never `starfish` (#32, #11).
- Service patterns, set on Starfish's Settings page (runtime settings are built): `orders` to orders, `invoices` and `payments` to billing, `sendreceipt` to notifications, `reports` to reports. `misc-*` stays unmatched for ING-07.
- Ingest on a schedule (#6), and quick enough for the video: about a minute after a press, from a short schedule or a "run now".
- A stored run record per incident (triage verdict, chosen path, gate results), so runs can be checked beyond the incident store.
- A cycle-boundary action that archives an incident and frees its fingerprint (see Reset).

## Changes to the mockup

The mockups now exist in two places: the Starfish Screens canvas and `docs/design/html` in the Starfish repo ([#42](https://github.com/Hack2Skill-Demo/starfish/pull/42)). Each change below goes into both.

- **Add two screens.** First, the shop, showing each feature's broken and working states. Second, the Scenario lab: the four core buttons, the catalog with last results, the health strip, the active cycle with its deadline, and Reset.
- **Notify run:** wherever it appears (Live runs, the Incidents row, Overview activity, the Slack card), change "Cloud Storage JSON API" to the API we actually disable.
- **Engine screen, hard-exclude list:** it shows shared packages and "more than one function", while #9 lists dependencies and CI config. Show the union, which is what G1-03, G1-06 and G1-07 test.
- **Story chart caption:** "the moment a deploy went out" becomes "the moment checkout without a coupon opened up", because no deploy causes this fault.
- **Storyboard note:** "0:20 Switch on the missing-index fault" becomes "press Missing index". Add that the notify and decline cycles are run before recording, because disabling an API takes minutes to take effect.

## Build phases

Phase 1 is your starting point: the button for IDX-01 with its reset, plus the runner and the 18 scenarios that exercise built Starfish code. Phase 2 completes the storyboard. Phases 3 and 4 work through the rest of the catalog, one engine area at a time. Scenarios whose Starfish stage isn't built yet can still be triggered, and they report "waiting on stage" until it lands.

| Phase | What it builds | Gate to the next phase |
| --- | --- | --- |
| 1. The button and the ingest suite | Two repos, verify gate, own codebases, Hosting sites, `(default)` database; shop orders, `traffic-tick`, Scenario lab with IDX-01 and Reset; the runner and the 18 scenarios on built Starfish code | The ingest suite passes against live Starfish, and IDX-01 makes an incident |
| 2. The live-demo core | CODE-01, CFG-01 and NOISE-01 with their resets; the reset workflow, and fixes deployed by the app's CI/CD; the cycle deadline and the frozen manifest | All four core cycles reach a recorded outcome |
| 3. Rules, gates and feedback | The remaining IDX, CODE, CFG and NOISE variants; Gate 1 and Gate 2 cases, fast-revert, feedback, triage settings; the payment, mail and upstream stubs | Every scenario triggers on demand and resets cleanly |
| 4. Escalation, budgets and connections | The on-call ladder with test phone numbers (needs Twilio); caps, token budget, `demo-infra` repo, auto-merge switch; gap scenarios become tests as their designs land | Every row passes, or waits on a named Starfish stage |

Each phase starts only after the gate of the one before it is passed.

## Decisions needed

| Decision | Recommended | Alternative |
| --- | --- | --- |
| Repos | Two: `demo-app` (Starfish fixes it) and a private `demo-control` (lab, controller, scenarios, evaluator tests) | One repo with scenario files kept outside Starfish's read path. Weaker: the fixer could still find them |
| Who can press the buttons | Signed-in team only; the public sees the lab's state and results | Anyone, with a queue and a daily cap |
| What exposes the code fault | Traffic changes (checkout without coupon): instant, no deploy | Deploy a breaking commit. It matches "a deploy went out", but takes 2 to 4 minutes before the first error |
| API for the notify case | Cloud Translation, which nothing else in the project uses | A misconfigured Secret Manager secret, which is also CFG-03 |
| Ingest speed for the video | Schedule ingest every minute while recording (#6) | A "run ingest now" control in Starfish |
| Twilio for the escalation scenarios | Yes, one number, Phase 4 only. It is paid per number and per minute | Leave ESC-02 to ESC-07 untested and say so |
| A second named database, `analytics` | Yes, for IDX-04. Small paid usage | Test the allowlist in Starfish's unit tests only |
| A second repo, `demo-infra` | Yes, for CON-01 | Keep indexes in `demo-app` and leave CON-01 untested |
| Where scenario results live | In `demo-control`, in #10's results format, read by the lab and by `pnpm scoreboard` | In Starfish, as part of its run records |

Once these are settled, demo-control gets created and Phase 1 starts in `Hack2Skill-Demo/demo-app` on `claude/kind-johnson-3pf3w3`.
