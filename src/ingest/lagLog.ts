/**
 * The line an alert reads (#387): how far the checkpoint a run left is behind the newest logs it could read, as one
 * structured stdout line. `scripts/setup-ingest-alerts.sh` turns `ingestCheckpointLagSeconds` into a log-based metric
 * and alerts on it, so a run that records "ok" while it falls further behind is seen from outside the job, not only in
 * the UI's engine line. Pure. A run with no lag figure (it failed before it claimed a window) writes no line: missing
 * is not zero, and the missed-run alert is what covers that case.
 */
import type { RunSummary } from "./run.js";

/** The marker the log-based metric's filter selects on: the same string, here and in scripts/setup-ingest-alerts.sh. */
export const INGEST_CHECKPOINT_MESSAGE = "starfish ingest checkpoint";

export function ingestCheckpointLine(summary: Pick<RunSummary, "lagSeconds" | "outcome">): string | undefined {
  const lag = summary.lagSeconds;
  if (lag === undefined || !Number.isFinite(lag) || lag < 0) return undefined;
  return JSON.stringify({
    severity: "INFO",
    message: INGEST_CHECKPOINT_MESSAGE,
    ingestCheckpointLagSeconds: Math.round(lag),
    outcome: summary.outcome,
  });
}
