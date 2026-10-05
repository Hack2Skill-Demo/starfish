/**
 * The results format of one scoreboard run (#10) and its strict parser. A results file is the only source of the
 * numbers the README, the deck and the video quote, so it is checked the way a record of evidence should be:
 * anything not exactly as specified is rejected with a reason, never defaulted, and a case that errored or timed out
 * is a case, not a gap.
 *
 * Nothing here runs the agent. A runner (the demo's scenario runner, or a replay harness) writes these files; this
 * module and `aggregate.ts` only judge them.
 */

/** The path a case exercises. Reported separately: deterministic index healing must not inflate patch accuracy. */
export type CasePath = "code-fix" | "index" | "notify" | "decline" | "bad-patch";
export const CASE_PATHS: readonly CasePath[] = ["code-fix", "index", "notify", "decline", "bad-patch"];

/** A case used to tune the agent, or one frozen before tuning and never inspected for it. */
export type Split = "tuning" | "held-out";
export const SPLITS: readonly Split[] = ["tuning", "held-out"];

export type TriageCall = "act" | "notify" | "decline";
const TRIAGE_CALLS: readonly string[] = ["act", "notify", "decline"];

/** How the run of one case ended. A timeout and an error count against the agent: neither is "skipped". */
export type CaseStatus = "completed" | "error" | "timeout";
const CASE_STATUSES: readonly string[] = ["completed", "error", "timeout"];

export interface CaseOutcome {
  status: CaseStatus;
  /** What triage decided. Absent when the run never got that far (an error or timeout before triage). */
  triage?: TriageCall;
  /** A pull request was opened for the incident. */
  openedPr?: boolean;
  /** The proposed fix passes the private evaluator test (code-fix) or the probe (index). Absent: no fix was proposed. */
  fixPassed?: boolean;
  /** For a planted bad patch: the reviewer blocked it. */
  reviewerBlocked?: boolean;
  costUsd?: number;
  latencyMs?: number;
  /** Detection to pull request, when the run measured it. */
  detectionToPrMs?: number;
}

export interface CaseResult {
  caseId: string;
  split: Split;
  path: CasePath;
  /** What triage should decide. A planted bad patch has none: it exercises the reviewer. */
  expectedTriage?: TriageCall;
  /** sha256 hex of the frozen case manifest entry. Required for a held-out case: it is what freezing it means. */
  caseHash?: string;
  outcome: CaseOutcome;
}

export interface ScoreboardRun {
  version: 1;
  runId: string;
  corpusVersion: string;
  /** The revision of the app under test and of Starfish. */
  appRevision: string;
  starfishRevision: string;
  model: string;
  /** ISO 8601, UTC. */
  ranAt: string;
  /** The settings the run used (dry run, retry budget...): recorded, not interpreted. */
  configuration: Record<string, string | number | boolean>;
  cases: CaseResult[];
}

export class ResultsError extends Error {}

const fail = (where: string, why: string): never => {
  throw new ResultsError(`${where}: ${why}`);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function text(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") fail(where, `"${key}" must be a non-empty string`);
  return v as string;
}

function oneOf<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly string[], where: string): T {
  const v = o[key];
  if (typeof v !== "string" || !allowed.includes(v)) fail(where, `"${key}" must be one of ${allowed.join(", ")}`);
  return v as T;
}

function optionalNumber(o: Record<string, unknown>, key: string, where: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(where, `"${key}" must be a finite number, zero or more`);
  return v as number;
}

function optionalBoolean(o: Record<string, unknown>, key: string, where: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") fail(where, `"${key}" must be true or false`);
  return v as boolean;
}

function parseOutcome(v: unknown, where: string): CaseOutcome {
  if (!isObject(v)) return fail(where, "outcome must be an object");
  const triage = v.triage === undefined ? undefined : oneOf<TriageCall>(v, "triage", TRIAGE_CALLS, where);
  const out: CaseOutcome = { status: oneOf<CaseStatus>(v, "status", CASE_STATUSES, where) };
  if (triage) out.triage = triage;
  for (const k of ["openedPr", "fixPassed", "reviewerBlocked"] as const) {
    const b = optionalBoolean(v, k, where);
    if (b !== undefined) out[k] = b;
  }
  for (const k of ["costUsd", "latencyMs", "detectionToPrMs"] as const) {
    const n = optionalNumber(v, k, where);
    if (n !== undefined) out[k] = n;
  }
  // A run that did not complete cannot also claim a result: the numbers would count something that did not happen.
  if (out.status !== "completed" && (out.fixPassed !== undefined || out.reviewerBlocked !== undefined || out.openedPr)) {
    fail(where, `an outcome with status "${out.status}" cannot claim a result (fixPassed, reviewerBlocked, openedPr)`);
  }
  return out;
}

function parseCase(v: unknown, index: number, seen: Set<string>): CaseResult {
  const where = `cases[${index}]`;
  if (!isObject(v)) return fail(where, "must be an object");
  const caseId = text(v, "caseId", where);
  if (seen.has(caseId)) fail(where, `duplicate caseId "${caseId}": a case counts once`);
  seen.add(caseId);
  const here = `case "${caseId}"`;
  const split = oneOf<Split>(v, "split", SPLITS, here);
  const path = oneOf<CasePath>(v, "path", CASE_PATHS, here);
  const expectedTriage = v.expectedTriage === undefined ? undefined : oneOf<TriageCall>(v, "expectedTriage", TRIAGE_CALLS, here);
  if (path !== "bad-patch" && !expectedTriage) fail(here, `"expectedTriage" is required for a "${path}" case`);
  const caseHash = v.caseHash === undefined ? undefined : text(v, "caseHash", here);
  if (caseHash !== undefined && !/^[0-9a-f]{64}$/.test(caseHash)) fail(here, `"caseHash" must be a lowercase sha256 hex digest`);
  if (split === "held-out" && !caseHash) fail(here, `a held-out case needs "caseHash": the hash it was frozen with before tuning`);
  return {
    caseId,
    split,
    path,
    ...(expectedTriage && { expectedTriage }),
    ...(caseHash && { caseHash }),
    outcome: parseOutcome(v.outcome, here),
  };
}

/** A results file, or a ResultsError saying exactly what is wrong. Never defaults a missing field. */
export function parseRun(raw: unknown): ScoreboardRun {
  if (!isObject(raw)) return fail("results", "must be a JSON object");
  if (raw.version !== 1) fail("results", `"version" must be 1`);
  const ranAt = text(raw, "ranAt", "results");
  if (Number.isNaN(Date.parse(ranAt)) || !/Z$/.test(ranAt)) fail("results", `"ranAt" must be an ISO 8601 UTC time, like 2026-10-11T09:00:00Z`);
  const configuration: Record<string, string | number | boolean> = {};
  if (!isObject(raw.configuration)) fail("results", `"configuration" must be an object`);
  for (const [k, v] of Object.entries(raw.configuration as Record<string, unknown>)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") fail("results", `configuration "${k}" must be a string, number or boolean`);
    configuration[k] = v as string | number | boolean;
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) fail("results", `"cases" must be a non-empty array`);
  const seen = new Set<string>();
  return {
    version: 1,
    runId: text(raw, "runId", "results"),
    corpusVersion: text(raw, "corpusVersion", "results"),
    appRevision: text(raw, "appRevision", "results"),
    starfishRevision: text(raw, "starfishRevision", "results"),
    model: text(raw, "model", "results"),
    ranAt,
    configuration,
    cases: (raw.cases as unknown[]).map((c, i) => parseCase(c, i, seen)),
  };
}
