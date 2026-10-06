# UI mockups

> **Status: designed, not built.** These are design mockups of the operator UI Starfish is
> heading toward, and of the demo. Of everything shown here, only the incidents table
> (`web/src/pages/Incidents.tsx`), sign-in and the descriptive settings page exist today. The
> data on every screen is illustrative, not real.

The mockups follow the decisions already tracked in the issues:

- **Code fixes** auto-merge on green only on the demo project; its CI/CD deploys them, with fast-revert armed (#9).
- **Missing indexes:** Starfish creates the index; the evidence PR is human-merged (#11).
- **The four MVP demo cases** are a code fix, a missing index, notify-only and decline (#5).
- **The public demo needs no sign-in:** visitors are view-only guests (#12).
- **The demo app shares Starfish's GCP project** (#32).
- **The screens are tracked as issues:** Live runs (#33), Overview (#38), incident detail (#39), phone escalation (#37), and Settings as part of runtime configuration (#7).

Every screen is also saved as a static HTML page in [`html/`](html/), 31 pages including each
Live runs case and each incident-story step. Open [`html/index.html`](html/index.html) in a browser
after cloning; the links between screens work. GitHub shows HTML files as source, not as pages. The pages
need nothing but a browser: no build and no runtime. Their only external request is Google Fonts, and
without it they fall back to system fonts.

The screenshots below are rendered at 1× from the same designs.

## The demo flow

| Screen | What it shows |
|---|---|
| **Overview** | One PR waiting for a human, runs in progress, errors per hour, what Starfish did with today's incidents, engine health. |
| **Live runs** | A real-time waterfall of one fault cycle: each step's status, timestamp, duration and bar on the run's time axis. One run per MVP case. |
| **Incident story** | One incident step by step: detected, counter-check, triage, fix diff, verify gate, adversarial review, PR. |
| **Slack and GitHub** | The messages Starfish posts (`#ops-alerts`, `#on-call`, `#ops-log`) and the issue and evidence-PR bodies it writes. |
| **Phone escalation** | When Slack goes unanswered: a pre-recorded call to the on-call person with keypad options. |
| **The demo app** | The shop with each feature's broken and working states, and the Scenario lab (a thin client page inside the shop): access code, the four core buttons, the active cycle with its deadline, the health strip and the catalog. |
| **Settings** | Connections, the engine's rules table, and on-call. View-only for the public. |

![Overview](screens/overview.png)

### The demo app

The shop with each feature's broken and working states, then the Scenario lab.

![The demo shop](screens/demo-shop.png)

![The Scenario lab](screens/scenario-lab.png)

> The notify case now disables the Cloud Translation API, not Cloud Storage (disabling Cloud Storage would break deploys; it is the recommended choice in [#68](https://github.com/Hack2Skill-Demo/starfish/issues/68), not yet decided), and the Engine screen lists dependencies and CI config among the never-auto-merged classes. The screenshots below were re-rendered from the HTML pages after those edits (2026-10-06).

### Live runs, one per MVP case

Missing index: Starfish creates the index; the evidence PR waits for a human.

![Live runs: missing index](screens/live-runs-index.png)

Code fix: Gemini's patch, verify gate, CI guards, merge on green, CI deploys, fast-revert armed.

![Live runs: code fix](screens/live-runs-code-fix.png)

Notify-only: a patch can't fix it. Escalated in Slack; with no reply, Starfish phones the on-call person.

![Live runs: notify and call](screens/live-runs-notify-and-call.png)

Decline: a one-off transient, with the reason recorded.

![Live runs: decline](screens/live-runs-decline.png)

### Incident story and the incidents table

![Incident story: the fix](screens/incident-story-fix.png)

The incidents table exists today. In this mockup it carries demo data, and its menu shows the planned Overview, Live runs and Settings pages.

![Incidents](screens/incidents.png)

### What Starfish writes elsewhere

![Slack messages](screens/slack-messages.png)

![GitHub issue and PR](screens/github-issue-and-pr.png)

### Phone escalation

There is no AI on the call. Google Cloud has no outbound phone line of its own, so a
telephony provider (Twilio in the design) places the call, and a Cloud Run service plays one
pre-recorded message and reads the keypad: 1 take it, 2 text me the link, 3 pass it on. The
message says nothing about the incident, so nothing can leak by voice and nothing in a log
can steer it. Tracked in #37; it needs a paid telephony account, so it waits on a go-ahead.

![Phone call record](screens/phone-call-record.png)

![Incoming call](screens/incoming-call.png)

### Settings

![Settings: connections](screens/settings-connections.png)

![Settings: engine rules](screens/settings-engine.png)

![Settings: on-call and calls](screens/settings-on-call.png)

### How it works

![How it works and the trust ladder](screens/how-it-works.png)
