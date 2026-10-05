# Scoreboard results format (#10)

`pnpm scoreboard` reads every `scoreboard/results/*.json` and writes `scoreboard/RESULTS.md`. **No run has been
recorded yet, so there is no results table and Starfish quotes no accuracy number anywhere.** The numbers in the README,
the deck and the video must come from `RESULTS.md` only.

A runner (the demo's scenario runner, or a replay harness) writes one file per run. Nothing in this repository runs the
agent over a corpus yet; this is the format and the aggregation that will judge it.

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
| Cost, latency, detection to pull request | completed cases that recorded it | (median and mean, with the number behind them) |

Every ratio is shown as passed/of. Below 30 cases a ratio is called a small sample.

## Not here yet

The private evaluator tests and reference fixes stay out of this repository (the evaluator boundary of #8), so a
public file holds only outcomes. Per-class eligibility criteria for auto-merge (#9), BugsJS and the optional corpus
expansion, and the replay harness that produces these files are not built.
