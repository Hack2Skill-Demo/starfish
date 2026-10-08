/**
 * The agent's run for an incident, as the Incidents page shows it: what was decided and a link to the run.
 *
 * A run (cycle) is one per (incident, recurrence), and its id is `{incidentId}_r{recurrence}` (src/agent/cycle.ts), so
 * an incident's current run is found by id, never guessed. What it shows comes only from the stored run record:
 * the run's state (the same words as the Runs page, `runStatus`), and triage's decision and reason when triage
 * recorded them. Pure, so the page logic is testable.
 */
import { PATH_LABELS, runStatus, type CycleRow, type RunStatus } from "./runsModel";

/** The id of the run for this incident's current recurrence. */
export const runIdFor = (incidentId: string, recurrence: number): string => `${incidentId}_r${recurrence}`;

/** The Runs page with this run selected. */
export const runHref = (runId: string): string => `/runs?run=${encodeURIComponent(runId)}`;

const DECISION_LABELS: Record<string, string> = {
  act: "Act: draft a fix",
  notify: "Notify a person",
  decline: "Decline",
  defer: "Wait for evidence",
  skip: "Skip",
  error: "Could not decide",
};

export type IncidentRunView =
  /** A run is recorded for the current recurrence. */
  | {
      kind: "run";
      runId: string;
      href: string;
      status: RunStatus;
      /** Triage's decision in words, when triage recorded one. */
      decision?: string;
      /** Why: triage's reason, else what the run ended in. */
      reason?: string;
      /** The rule that chose it (`model-decline`, `counter-check-zero`...). */
      rule?: string;
    }
  /** Every run of the environment was read and none is this incident's: the agent has not started on it. */
  | { kind: "none" }
  /** Not known (still reading, the read failed, or the run is outside what was read). Says nothing. */
  | { kind: "unknown" };

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/**
 * What the row shows. `cycle` is the run with the incident's current id: the run when found, `null` when it was read
 * by id and does not exist, `undefined` when it was not looked up. `complete` says every run of the environment was
 * read, so one that is not among them does not exist. Missing is never claimed from a partial read.
 */
export function incidentRunView(cycle: CycleRow | null | undefined, complete: boolean, nowMs: number): IncidentRunView {
  if (cycle === null) return { kind: "none" };
  if (cycle === undefined) return complete ? { kind: "none" } : { kind: "unknown" };
  const triage = cycle.summary.triage;
  const decisionKey = text(triage?.decision);
  const reason = text(triage?.reason) ?? (cycle.path ? PATH_LABELS[cycle.path] : undefined);
  const rule = text(triage?.rule);
  return {
    kind: "run",
    runId: cycle.id,
    href: runHref(cycle.id),
    status: runStatus(cycle, nowMs),
    ...(decisionKey && { decision: DECISION_LABELS[decisionKey] ?? decisionKey }),
    ...(reason && { reason }),
    ...(rule && { rule }),
  };
}
