# Development

> Moved from the README (#391): the commands, the synthetic demo history, and the layout of the repository.

## Commands

```bash
pnpm install            # also points git at .githooks/
cp .env.example .env    # set GOOGLE_CLOUD_PROJECT
pnpm run verify         # the gate: lint · typecheck · test · build
pnpm test:emulator      # firestore.rules + store concurrency on the emulator (needs Java)
pnpm -C web dev         # operator UI on :5177 (copy web/.env.example to web/.env)
pnpm dev:emulated       # the UI against seeded local emulators, no GCP project needed
pnpm seed-demo          # dry run: the synthetic demo history it would write (--apply / --remove; demo environment only)
pnpm public-view        # dry run: the guests' trimmed copies (#18) to write or remove (-- --apply --project=<id>)
pnpm spike              # fix-quality spike (needs Vertex AI access)
pnpm scoreboard         # scoreboard/RESULTS.md from scoreboard/results/*.json; says so and writes nothing with no runs
pnpm replay --check-corpus  # is the replay corpus fit to run (no model); `pnpm replay` scores one run (needs Vertex AI access)
pnpm feedback-corpus -- --out=<new dir>  # operators' noise/log corrections -> a replay corpus (reads the store, writes local files)
```

## Synthetic demo history

`pnpm seed-demo` (`src/seedDemo.ts`) writes a small, **made-up** history into the configured Starfish database so the
public demo shows what each path of the loop records even with no live incident: five incidents and, for each, a
finished cycle with its run events and run record in the shapes the agent writes, one per path (declined by triage, a
person told, a dry-run draft that passed verify and review, a pull request after one failed verify, and a patch the
review broke twice), timestamped over the last few days. **None of it happened: no model was called, no test ran, and
the issue and pull-request numbers it shows exist nowhere** (they carry no link).

- Every document it writes has `synthetic: true`; each incident's message starts `[Synthetic demo data, not a real
  incident]`, and each run's first event says no agent ran it. The Incidents table, the incident page and the Runs page
  show a "Synthetic" badge on them. The Overview's counts do include them.
- It refuses unless `STARFISH_ENV=demo`. Without flags it is a dry run that prints what it would write. `--apply
  --project=<id>` writes it; ids are fixed, so a re-run replaces (with fresh timestamps) and never duplicates.
  `--remove --project=<id>` deletes exactly those documents. Neither touches a document at one of its ids that is not
  marked synthetic.
- Guests read it, like everything, through the trimmed copies (#18), which it writes in the same batches; `--remove`
  removes them with it. A guest therefore sees its decisions, rules and counts, not its made-up reasoning.
- It writes no incident key and its fingerprints are not hashes, so a real occurrence never lands on a synthetic
  incident, and each incident's cycle is already finished, so the agent never picks one up. The agent's scans also skip
  every record marked synthetic (the pass, reading pull requests back, auto-merge, fast-revert, phone escalation), so
  nothing is ever read from GitHub or dialled for one.

To deploy to a project, follow [`docs/setup.md`](setup.md): a read-only preflight
(`scripts/preflight-gcp.sh`), the ingest job and its schedule (`scripts/deploy-gcp.sh`), the first
admin (`pnpm grant-operator`), an end-to-end smoke test (`scripts/smoke-gcp.sh`), and the UI on its
own Hosting site (`scripts/deploy-web.sh`). Each script takes `DRY_RUN=1`. All of it is written and
tested against stubs and the emulators. On 2026-10-05 the preflight, the ingest deploy, `grant-operator`, the web deploy and the smoke test (a planted error read into the store by the deployed ingest, then retired) ran once against the demo project and worked, after two fixes (#103, #104). The agent job was deployed there on 2026-10-07 and has run hourly since (dry run off since 2026-10-10); see [Google Cloud stack](implementation-notes.md#google-cloud-stack) for how far it has got. What the deploy
creates and the identities: [`docs/deploy.md`](deploy.md).

Requires Node 22.19+ and a GCP project with the Vertex AI API enabled. Starfish keeps its
incident store in its own Firestore database, `starfish`, so its rules and indexes never
touch your app's database. Create it once (`gcloud firestore databases create
--database=starfish --location=<region>`), then `firebase deploy --only firestore` deploys
`firestore.rules` and `firestore.indexes.json` to that database alone.

Starfish is built with AI-assisted development (Claude Code); the git hooks, verify gate,
Claude Code hooks and skills live in the repo, with `CLAUDE.md` as the entry point. The
product itself runs on Gemini.

## Layout

```
src/
  config.ts          every deployment-specific value lives here, and only here
  vertex.ts          Vertex AI client
  spike.ts           the fix-quality spike
  scoreboard/        the results format and aggregation behind `pnpm scoreboard`, and the replay harness behind `pnpm replay`
                     (tested with a stub model only; no run recorded yet: see scoreboard/FORMAT.md)
  ingest/            logs -> classified, deduped incidents + counter-check
  agent/             triage, fixer, verify gate, reviewer, cycle state and the loop: run by the agent job (`pnpm agent`), deployed to the demo project
web/                 operator UI: sign-in, incidents, settings
firestore.rules      what the UI may read and change (tested on the emulator)
fixtures/incidents/   spike fixtures (synthetic; see docs/spike.md)
fixtures/replay-synthetic/  a SYNTHETIC replay corpus the harness's tests run over (not results)
docs/
  status.md          what is implemented, tested, validated and observed, with dates and evidence (#391)
  implementation-notes.md  the long, dated narrative the README used to carry
  genericity.md, trust-ladder.md, ui.md, blind-spots.md, development.md  the README's other long sections, moved
  setup.md, deploy.md  deploying to a project
  design/            the auto-merge policy, UI mockups (mockups.md, screens/, html/), the demo app proposal
  research/          self-healing systems: the literature, and where Starfish sits
  spike.md           what the spike measures and how to read it
```
