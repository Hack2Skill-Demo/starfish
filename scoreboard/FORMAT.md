# Scoreboard results format (#10)

`pnpm scoreboard` reads every `scoreboard/results/*.json` and writes `scoreboard/RESULTS.md`. **No run has been
recorded yet, so there is no results table and Starfish quotes no accuracy number anywhere.** The numbers in the README,
the deck and the video must come from `RESULTS.md` only.

A runner writes one file per run. The replay harness (`pnpm replay`, below) is built and writes this format; it has been
run only by its tests, with a stub model over a synthetic corpus, so **no run has been recorded and no corpus of real
cases exists yet**. The demo's scenario runner is not built.

```json
{
  "version": 1,
  "runId": "2026-10-11-a",
  "corpusVersion": "demo-corpus-1",
  "appRevision": "<git sha of the app under test>",
  "starfishRevision": "<git sha of Starfish>",
  "model": "<the Gemini model id>",
  "ranAt": "2026-10-11T09:00:00Z",
  "configuration": { "dryRun": true, "retryBudget": 1 },
  "cases": [
    {
      "caseId": "code-fix-1",
      "split": "held-out",
      "path": "code-fix",
      "expectedTriage": "act",
      "caseHash": "<sha256 hex of the case manifest entry, frozen before tuning>",
      "outcome": { "status": "completed", "triage": "act", "openedPr": true, "fixPassed": true,
                   "costUsd": 0.03, "latencyMs": 41000, "detectionToPrMs": 190000 }
    }
  ]
}
```

- `path` is `code-fix`, `index`, `notify`, `decline` or `bad-patch` (a planted bad patch: it has no `expectedTriage`; it
  exercises the reviewer, and `outcome.reviewerBlocked` says whether it was blocked).
- `split` is `tuning` or `held-out`. A held-out case must carry `caseHash`: the hash it was frozen with before any
  tuning. A case inspected for tuning moves to `tuning`, and the change is reported.
- `outcome.status` is `completed`, `error` or `timeout`. An errored or timed-out case counts **against** the agent in
  every metric it belongs to, and may not claim a result (`fixPassed`, `reviewerBlocked`, `openedPr`).
- A field a run did not measure is left out, never zero.

## What is counted

| Metric | Over | Counts as a pass when |
| --- | --- | --- |
| Triage accuracy | every case with an `expectedTriage` | the run completed and triage made the expected call |
| Correct declines | cases expected to decline | triage declined and no pull request was opened |
| Patch pass rate | `code-fix` cases | the run completed and the proposed patch passes the private evaluator test |
| Index heal | `index` cases | the run completed and the deterministic heal checks out. Never mixed into the patch rate |
| Reviewer catch rate | `bad-patch` cases | the reviewer blocked the planted patch |
| Cost, latency | every case that recorded it, an errored or timed-out one included (a failed run still costs, and is often the slowest) | (median and mean, with the number behind them) |
| Detection to pull request | completed cases that recorded it | (median and mean, with the number behind them) |

Every ratio is shown as passed/of. Below 30 cases a ratio is called a small sample.

## The replay harness (`pnpm replay`)

`src/scoreboard/replay.ts` runs the agent's own stage functions (triage, fixer, verify gate, reviewer) in the loop's
order, with its one shared revision and its model-call budget, over the corpus in `STARFISH_REPLAY_CORPUS`, and writes
`<STARFISH_REPLAY_RESULTS_DIR>/<runId>.json` after checking it with the same parser `pnpm scoreboard` uses. It never
overwrites a recorded run. It does not run what needs the store (lease, run events, issues, Slack, the pull request): a
replay is always a dry run, so **`openedPr` in a replay means the cycle reached the pull-request step**, where a live run
would open one. Nothing is opened.

A corpus is a directory with a `manifest.json` (the format is in `src/scoreboard/corpus.ts`): per case its id, split,
path, expected triage, the incident (with its counter-check), the repository snapshot, the files the fixer and reviewer
are shown, the target's own verify command, and a **private evaluator** (a directory outside the snapshot plus a
command). The fixer and the reviewer are shown only the listed snapshot files; the evaluator's files are laid over a
disposable copy only after the model has answered, and a patch that touches one is refused. A `bad-patch` case adds a
planted patch and the fixer's claimed cause; the reviewer reviews it whatever `STARFISH_REVIEW_REQUIRED` says.

- `fixPassed` is the private evaluator's verdict on the patch that reached the pull-request step, applied as given by
  the verify gate. A patch the agent would not ship (failed verify or review twice, budget spent, unfit) is `false`; a
  fixer that declined leaves it out.
- Before any model call (`pnpm replay --check-corpus` runs the same checks alone): a held-out case must still hash to
  its frozen `caseHash` (`pnpm replay --hash` prints it; the hash covers the entry and every file it names); every
  code-fix evaluator must **fail** on the unpatched snapshot; every planted patch must pass the target's gate and fail
  its evaluator. A corpus that fails any check is not run.
- A model failure or an unusable review is `error`; a case over `STARFISH_REPLAY_CASE_TIMEOUT_SECONDS` is `timeout`
  (work it started is not killed; the gate's own timeout bounds a command). `latencyMs` is wall time per case. Cost is
  not recorded: the model client reports no usage. `index` cases are refused: the index heal is not run by the harness.
- `configuration.syntheticCorpus` comes from the manifest's required `synthetic` flag. A synthetic run is not a result.
- Not a sandbox: the corpus's commands and the model's patches run in this process, so a scored run requires
  `STARFISH_VERIFY_ISOLATION=in-process`. The evaluator boundary is about what the model is *shown*; code a patch adds
  runs as this user and could read the machine's files, the evaluators included. Replay a private corpus only where that
  is acceptable.

`fixtures/replay-synthetic/` is a tiny **synthetic** corpus (one code fix, one decline, one notify, one planted bad patch)
that the harness's tests run over with a stub model. It exists to test the harness; it is not evidence about Gemini.

## Not here yet

- The corpus: the four frozen MVP cases of #5, the held-out cases, and the planted bad patch over real (public or
  synthetic) incidents, with their evaluators kept out of this repository where they are private (the evaluator boundary
  of #8). Building it, freezing its hashes and running `pnpm replay` against Vertex is work for a person with access.
- A recorded run, and with it any number.
- Per-class eligibility criteria for auto-merge (#9), BugsJS and the optional corpus expansion, cost per case, and
  detection-to-PR measured end to end.
