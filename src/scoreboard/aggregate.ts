/**
 * The scoreboard's numbers (#10), computed from a parsed run and nothing else. Every ratio keeps its numerator and
 * denominator, a case that errored or timed out is in the denominator and counts against the agent, and each path is
 * reported on its own: deterministic index healing must not inflate Gemini's patch accuracy.
 */
import type { CaseResult, ScoreboardRun, Split } from "./results.js";

export interface Ratio {
  passed: number;
  of: number;
}

/** Only completed cases that recorded the value: a missing measurement is not a zero. */
export interface Measure {
  n: number;
  mean?: number;
  median?: number;
}

export interface SplitMetrics {
  split: Split;
  cases: number;
  errors: number;
  timeouts: number;
  /** Triage matched the expected act / notify / decline, over every case that has an expectation. */
  triageAccuracy: Ratio;
  /** Noise was declined and no pull request opened, over the cases that should be declined. */
  correctDeclines: Ratio;
  /** The proposed fix passes the private evaluator test, over the code-fix cases. */
  patchPassRate: Ratio;
  /** The deterministic index heal, over the index cases. Never mixed into the patch rate. */
  indexHeal: Ratio;
  /** The planted bad patch was blocked by the reviewer, over the bad-patch cases. */
  reviewerCatchRate: Ratio;
  costUsd: Measure;
  latencyMs: Measure;
  detectionToPrMs: Measure;
}

const ratio = (cases: readonly CaseResult[], passes: (c: CaseResult) => boolean): Ratio => ({
  passed: cases.filter(passes).length,
  of: cases.length,
});

function measure(values: readonly number[]): Measure {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { n: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, median };
}

const completed = (c: CaseResult): boolean => c.outcome.status === "completed";

export function metricsFor(run: ScoreboardRun, split: Split): SplitMetrics {
  const cases = run.cases.filter((c) => c.split === split);
  const done = cases.filter(completed);
  const values = (pick: (c: CaseResult) => number | undefined): number[] =>
    done.map(pick).filter((v): v is number => v !== undefined);
  return {
    split,
    cases: cases.length,
    errors: cases.filter((c) => c.outcome.status === "error").length,
    timeouts: cases.filter((c) => c.outcome.status === "timeout").length,
    triageAccuracy: ratio(
      cases.filter((c) => c.expectedTriage !== undefined),
      (c) => completed(c) && c.outcome.triage === c.expectedTriage,
    ),
    correctDeclines: ratio(
      cases.filter((c) => c.expectedTriage === "decline"),
      (c) => completed(c) && c.outcome.triage === "decline" && !c.outcome.openedPr,
    ),
    patchPassRate: ratio(
      cases.filter((c) => c.path === "code-fix"),
      (c) => completed(c) && c.outcome.fixPassed === true,
    ),
    indexHeal: ratio(
      cases.filter((c) => c.path === "index"),
      (c) => completed(c) && c.outcome.fixPassed === true,
    ),
    reviewerCatchRate: ratio(
      cases.filter((c) => c.path === "bad-patch"),
      (c) => completed(c) && c.outcome.reviewerBlocked === true,
    ),
    costUsd: measure(values((c) => c.outcome.costUsd)),
    latencyMs: measure(values((c) => c.outcome.latencyMs)),
    detectionToPrMs: measure(values((c) => c.outcome.detectionToPrMs)),
  };
}
