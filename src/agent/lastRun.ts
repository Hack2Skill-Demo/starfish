/**
 * Writes the agent pass's last-run record (#274), `{runCollection}/agent_last_run`, the way the ingest writes its
 * `last_run` (src/ingest/run.ts): once per pass, at the end, whatever the outcome, so the UI can say whether the agent
 * is alive and when it runs next. The record's shape and its reader are in src/agentRunRecord.ts.
 *
 * Best effort: the record is for people to look at, and nothing in a pass depends on it. A write that fails is
 * reported to the caller and never thrown, so it can neither lose nor mask the pass's own error. Counts, booleans and
 * enumerated labels only, because guests may read it.
 */
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { AGENT_LAST_RUN_DOC, type AgentPassStep } from "../agentRunRecord.js";
import { cronIntervalMinutes } from "../ingest/cadence.js";
import type { PassSummary } from "./pass.js";

export { AGENT_LAST_RUN_DOC };

/** What a pass learns about itself as it goes; turned into the record at the end. */
export interface AgentPassReport {
  startedAt: Date;
  /** The environment the pass runs for: the env default's until the runtime settings are resolved. */
  environment: string;
  dryRun?: boolean;
  /** The daily reopen limit this pass applies (#456), once its configuration is resolved. */
  reconsiderMaxPerDay?: number;
  problems: string[];
  /** The driver's summary, once the pass got that far. */
  pass?: Pick<PassSummary, "considered" | "ran" | "errors" | "aborted" | "gaveUp" | "skipped" | "daily" | "sweepError">;
  scanCapped: boolean;
  failedSteps: AgentPassStep[];
  /** A code or error name for a pass that did not start or threw; never a message. */
  error?: string;
}

/**
 * Marks a pass as started (`runningSince`), so the UI can say a pass is running rather than only when the last one ended.
 * The previous pass's fields are kept: the end-of-pass write (`recordAgentLastRun`, a whole-document set) replaces them
 * and drops the mark. On a first pass there is no document to update, so one is created holding the environment (the
 * guests' rule reads it) and the mark. Best effort, like the end-of-pass record: never throws.
 */
export async function recordAgentPassStarted(
  db: Firestore,
  config: Pick<StarfishConfig, "runCollection">,
  environment: string,
  startedAt: Date
): Promise<boolean> {
  const ref = db.collection(config.runCollection).doc(AGENT_LAST_RUN_DOC);
  const runningSince = Timestamp.fromDate(startedAt);
  try {
    await ref.update({ runningSince });
    return true;
  } catch (err) {
    // 5 = NOT_FOUND: no pass has been recorded yet. Anything else is a failed write, reported like the end-of-pass one.
    if ((err as { code?: unknown } | null)?.code !== 5) return false;
  }
  try {
    await ref.create({ environment, runningSince });
    return true;
  } catch {
    return false;
  }
}

export function newAgentPassReport(startedAt: Date, environment: string): AgentPassReport {
  return { startedAt, environment, problems: [], scanCapped: false, failedSteps: [] };
}

export function noteFailedStep(report: AgentPassReport, step: AgentPassStep): void {
  if (!report.failedSteps.includes(step)) report.failedSteps.push(step);
}

/** Keeps the driver's summary, and marks its failures: a cycle that threw or an early stop, and a failed sweep. */
export function notePassSummary(report: AgentPassReport, summary: NonNullable<AgentPassReport["pass"]>): void {
  report.pass = summary;
  if (summary.errors.length > 0 || summary.aborted) noteFailedStep(report, "cycles");
  if (summary.sweepError !== undefined) noteFailedStep(report, "sweep");
}

/** A pass failed when it did not start, threw, or one of its steps failed. The CLI exits 1 on exactly this. */
export function agentPassFailed(report: AgentPassReport): boolean {
  return report.error !== undefined || report.failedSteps.length > 0;
}

/** The stored fields. Pure; optional fields are left out rather than written as undefined (Firestore rejects it). */
export function agentLastRunFields(
  report: AgentPassReport,
  schedule: string | undefined,
  finishedAt: Date
): Record<string, unknown> {
  const p = report.pass;
  const interval = cronIntervalMinutes(schedule);
  return {
    environment: report.environment,
    outcome: agentPassFailed(report) ? "failed" : "ok",
    startedAt: Timestamp.fromDate(report.startedAt),
    finishedAt: Timestamp.fromDate(finishedAt),
    considered: p?.considered ?? 0,
    ran: p?.ran ?? 0,
    cycleErrors: p?.errors.length ?? 0,
    aborted: p?.aborted ?? false,
    gaveUp: p?.gaveUp?.length ?? 0,
    scanCapped: report.scanCapped,
    failedSteps: [...report.failedSteps],
    problems: report.problems.slice(0, 20),
    ...(report.dryRun !== undefined && { dryRun: report.dryRun }),
    ...(report.reconsiderMaxPerDay !== undefined && { reconsiderMaxPerDay: report.reconsiderMaxPerDay }),
    ...(p?.skipped !== undefined && { skipped: p.skipped }),
    ...(p?.daily && { daily: { cap: p.daily.cap, startedBefore: p.daily.startedBefore } }),
    ...(report.error !== undefined && { error: report.error }),
    // How often a pass is started, so the UI can say when the next is expected. Absent when not known.
    ...(interval !== null && { intervalMinutes: interval }),
  };
}

/** Best effort: returns whether the record was written, and never throws. */
export async function recordAgentLastRun(
  db: Firestore,
  config: Pick<StarfishConfig, "runCollection" | "agentSchedule">,
  report: AgentPassReport,
  finishedAt: Date = new Date()
): Promise<boolean> {
  try {
    await db.collection(config.runCollection).doc(AGENT_LAST_RUN_DOC).set(agentLastRunFields(report, config.agentSchedule, finishedAt));
    return true;
  } catch {
    return false;
  }
}
