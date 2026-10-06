/**
 * A replay corpus (#10): `manifest.json` in a directory, naming each case's incident, repository snapshot, private
 * evaluator and (for a planted bad patch) the patch. Parsed strictly, like the results format: anything not exactly as
 * specified is refused with a reason, so a run is never scored over a corpus that silently means something else.
 *
 * {
 *   "corpusVersion": "demo-corpus-1",
 *   "appRevision": "<revision of the app the snapshots were taken at>",
 *   "synthetic": true,                       // recorded with every run: synthetic results are never real results
 *   "cases": [{
 *     "caseId": "code-fix-1", "split": "held-out", "path": "code-fix", "expectedTriage": "act",
 *     "caseHash": "<frozen before tuning; `pnpm replay --hash` prints it>",
 *     "incident": "cases/code-fix-1/incident.json",     // an Incident, with its log counter-check
 *     "repo": "snapshots/app",                         // the pre-fix source
 *     "files": ["src/orders.ts"],                      // what the fixer and reviewer are shown, from `repo`
 *     "verifyCommand": "node test/run.mjs",            // the target's own gate, as the agent would run it
 *     "evaluator": { "dir": "evaluators/code-fix-1", "command": "node .evaluator/check.mjs" },
 *     "plantedPatch": "...", "claimed": { "rootCause": "...", "risk": "..." }   // bad-patch only
 *   }]
 * }
 *
 * Every path is relative to the corpus directory and must stay inside it. The evaluator directory must lie outside the
 * snapshot, and none of its files may exist in the snapshot: the fixer and the reviewer are shown only `files`, which
 * come from the snapshot, so the private tests can never be among them. `index` cases are refused: the deterministic
 * index heal is not run by this harness.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import type { Incident, LogCounterCheck } from "../types.js";
import { CASE_PATHS, SPLITS, type CasePath, type Split, type TriageCall } from "./results.js";
import { listFiles, treeDigest, type Evaluator } from "./evaluate.js";

export interface CorpusCase {
  caseId: string;
  split: Split;
  path: Exclude<CasePath, "index">;
  expectedTriage?: TriageCall;
  /** The hash the case was frozen with. Required for held-out; checked against the case as it is now. */
  caseHash?: string;
  /** Absolute paths from here on, resolved inside the corpus directory. */
  incidentFile: string;
  repoDir?: string;
  files: string[];
  verifyCommand?: string;
  evaluator?: Evaluator;
  plantedPatchFile?: string;
  claimed?: { rootCause: string; risk: string };
  /** The manifest entry as written, for the hash. */
  entry: Record<string, unknown>;
}

export interface Corpus {
  dir: string;
  corpusVersion: string;
  appRevision: string;
  synthetic: boolean;
  cases: CorpusCase[];
}

export class CorpusError extends Error {}

const fail = (where: string, why: string): never => {
  throw new CorpusError(`${where}: ${why}`);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TRIAGE: readonly string[] = ["act", "notify", "decline"];
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;

function text(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") fail(where, `"${key}" must be a non-empty string`);
  return v as string;
}

/** A relative path that stays inside `root`, resolved. `..`, absolute paths and odd characters are refused. */
function inside(root: string, rel: string, where: string, key: string): string {
  if (isAbsolute(rel) || !SAFE_PATH.test(rel)) fail(where, `"${key}" must be a relative path of letters, digits, ".", "_", "-" and "/"`);
  const full = normalize(join(root, rel));
  const r = relative(root, full);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) fail(where, `"${key}" must stay inside the corpus directory`);
  return full;
}

const within = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(outer + sep);

function exists(full: string, kind: "file" | "dir", where: string, key: string): void {
  const st = existsSync(full) ? lstatSync(full) : undefined;
  if (!st || (kind === "file" ? !st.isFile() : !st.isDirectory())) fail(where, `"${key}" must name an existing ${kind === "file" ? "file" : "directory"}`);
}

function parseCase(root: string, raw: unknown, index: number, seen: Set<string>): CorpusCase {
  if (!isObject(raw)) return fail(`cases[${index}]`, "must be an object");
  const caseId = text(raw, "caseId", `cases[${index}]`);
  if (!SAFE_PATH.test(caseId) || caseId.includes("/")) fail(`cases[${index}]`, `"caseId" may hold letters, digits, ".", "_" and "-" only`);
  if (seen.has(caseId)) fail(`cases[${index}]`, `duplicate caseId "${caseId}"`);
  seen.add(caseId);
  const where = `case "${caseId}"`;
  const split = raw.split as Split;
  if (!SPLITS.includes(split)) fail(where, `"split" must be one of ${SPLITS.join(", ")}`);
  const path = raw.path as CasePath;
  if (!CASE_PATHS.includes(path)) fail(where, `"path" must be one of ${CASE_PATHS.join(", ")}`);
  if (path === "index") fail(where, `"index" cases are not run by the replay harness: the deterministic index heal is not part of it`);
  const expectedTriage = raw.expectedTriage as TriageCall | undefined;
  if (path === "bad-patch") {
    if (expectedTriage !== undefined) fail(where, `a "bad-patch" case has no "expectedTriage": it exercises the reviewer`);
  } else if (!TRIAGE.includes(expectedTriage as string)) fail(where, `"expectedTriage" must be one of ${TRIAGE.join(", ")}`);
  const caseHash = raw.caseHash === undefined ? undefined : text(raw, "caseHash", where);
  if (caseHash !== undefined && !/^[0-9a-f]{64}$/.test(caseHash)) fail(where, `"caseHash" must be a lowercase sha256 hex digest`);
  if (split === "held-out" && caseHash === undefined) fail(where, `a held-out case needs the "caseHash" it was frozen with (pnpm replay --hash)`);

  const incidentFile = inside(root, text(raw, "incident", where), where, "incident");
  exists(incidentFile, "file", where, "incident");

  const repoDir = raw.repo === undefined ? undefined : inside(root, text(raw, "repo", where), where, "repo");
  if (repoDir) exists(repoDir, "dir", where, "repo");
  const files = raw.files === undefined ? [] : raw.files;
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) return fail(where, `"files" must be a list of paths`);
  if (files.length > 0 && !repoDir) fail(where, `"files" needs a "repo" to come from`);
  for (const f of files as string[]) exists(inside(repoDir!, f, where, "files"), "file", where, `files: ${f}`);

  const verifyCommand = raw.verifyCommand === undefined ? undefined : text(raw, "verifyCommand", where);
  if (verifyCommand !== undefined && !repoDir) fail(where, `"verifyCommand" needs a "repo" to run in`);

  let evaluator: Evaluator | undefined;
  if (raw.evaluator !== undefined) {
    if (!isObject(raw.evaluator)) return fail(where, `"evaluator" must be an object`);
    if (!repoDir) fail(where, `"evaluator" needs a "repo" to judge`);
    const dir = inside(root, text(raw.evaluator, "dir", where), where, "evaluator.dir");
    exists(dir, "dir", where, "evaluator.dir");
    if (within(repoDir!, dir) || within(dir, repoDir!)) fail(where, `"evaluator.dir" must lie outside the snapshot: the fixer must never be able to read it`);
    evaluator = { dir, command: text(raw.evaluator, "command", where) };
  }

  const plantedPatchFile = raw.plantedPatch === undefined ? undefined : inside(root, text(raw, "plantedPatch", where), where, "plantedPatch");
  if (plantedPatchFile) exists(plantedPatchFile, "file", where, "plantedPatch");
  let claimed: CorpusCase["claimed"];
  if (raw.claimed !== undefined) {
    if (!isObject(raw.claimed)) return fail(where, `"claimed" must be an object`);
    claimed = { rootCause: text(raw.claimed, "rootCause", where), risk: text(raw.claimed, "risk", where) };
  }

  if (path === "code-fix" && (!repoDir || !verifyCommand || !evaluator)) {
    fail(where, `a "code-fix" case needs "repo", "verifyCommand" and "evaluator": a patch is only scored by running it`);
  }
  if (path === "bad-patch" && (!repoDir || !verifyCommand || !evaluator || !plantedPatchFile || !claimed)) {
    fail(where, `a "bad-patch" case needs "repo", "verifyCommand", "evaluator", "plantedPatch" and "claimed"`);
  }
  if (path !== "bad-patch" && (plantedPatchFile || claimed)) fail(where, `"plantedPatch" and "claimed" belong to a "bad-patch" case only`);

  return {
    caseId,
    split,
    path: path as CorpusCase["path"],
    ...(expectedTriage !== undefined && { expectedTriage }),
    ...(caseHash !== undefined && { caseHash }),
    incidentFile,
    ...(repoDir && { repoDir }),
    files: files as string[],
    ...(verifyCommand !== undefined && { verifyCommand }),
    ...(evaluator && { evaluator }),
    ...(plantedPatchFile && { plantedPatchFile }),
    ...(claimed && { claimed }),
    entry: raw,
  };
}

/** The corpus in `dir`, or a CorpusError naming exactly what is wrong. Reads the manifest and checks every path it names. */
export function loadCorpus(dir: string): Corpus {
  const manifest = join(dir, "manifest.json");
  if (!existsSync(manifest)) throw new CorpusError(`${manifest}: no manifest`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifest, "utf8"));
  } catch (e) {
    throw new CorpusError(`${manifest}: not JSON (${e instanceof Error ? e.name : "error"})`);
  }
  if (!isObject(raw)) return fail("manifest", "must be a JSON object");
  if (typeof raw.synthetic !== "boolean") fail("manifest", `"synthetic" must be true or false: a synthetic corpus must say so`);
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) fail("manifest", `"cases" must be a non-empty array`);
  const seen = new Set<string>();
  const root = normalize(dir);
  return {
    dir: root,
    corpusVersion: text(raw, "corpusVersion", "manifest"),
    appRevision: text(raw, "appRevision", "manifest"),
    synthetic: raw.synthetic as boolean,
    cases: (raw.cases as unknown[]).map((c, i) => parseCase(root, c, i, seen)),
  };
}

/** JSON with keys sorted at every level, so the same entry always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * The hash a case is frozen with: its manifest entry (without the hash itself) and the content of every file it names:
 * the incident, the snapshot, the evaluator and the planted patch. Changing any of them after freezing is detected.
 */
export async function caseHashOf(c: CorpusCase): Promise<string> {
  const entry = { ...c.entry };
  delete entry.caseHash;
  const h = createHash("sha256").update(`entry:${canonical(entry)}\n`);
  h.update(`incident:${createHash("sha256").update(readFileSync(c.incidentFile)).digest("hex")}\n`);
  if (c.repoDir) for (const line of await treeDigest(c.repoDir)) h.update(`repo:${line}\n`);
  if (c.evaluator) for (const line of await treeDigest(c.evaluator.dir)) h.update(`evaluator:${line}\n`);
  if (c.plantedPatchFile) h.update(`planted:${createHash("sha256").update(readFileSync(c.plantedPatchFile)).digest("hex")}\n`);
  return h.digest("hex");
}

/** Problems with a case's evaluator files that parsing alone cannot see: a shadowed snapshot file, an unsafe name. */
export async function evaluatorProblems(c: CorpusCase): Promise<string[]> {
  if (!c.evaluator || !c.repoDir) return [];
  const problems: string[] = [];
  const snapshot = new Set(await listFiles(c.repoDir));
  for (const f of await listFiles(c.evaluator.dir)) {
    if (!SAFE_PATH.test(f)) problems.push(`case "${c.caseId}": evaluator file "${f}" has characters a path guard cannot match exactly`);
    if (snapshot.has(f)) problems.push(`case "${c.caseId}": evaluator file "${f}" also exists in the snapshot; an evaluator only adds files`);
  }
  return problems;
}

/** The incident a case replays: an Incident with a usable counter-check, so triage's gates do not decide for it. */
export function readIncident(c: CorpusCase): Incident {
  const where = `case "${c.caseId}": incident`;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(c.incidentFile, "utf8"));
  } catch {
    return fail(where, "is not JSON");
  }
  if (!isObject(raw)) return fail(where, "must be an object");
  const check = raw.logCounterCheck;
  if (!isObject(check) || typeof check.window !== "string" || typeof check.count !== "number" || !Number.isFinite(check.count)) {
    fail(where, `needs "logCounterCheck" with a "window" and a finite "count": without it triage defers and the case decides nothing`);
  }
  const str = (k: string) => (typeof raw[k] === "string" && raw[k] !== "" ? { [k]: raw[k] as string } : {});
  const num = (k: string) => (typeof raw[k] === "number" && Number.isFinite(raw[k]) ? { [k]: raw[k] as number } : {});
  return {
    id: text(raw, "id", where),
    environment: text(raw, "environment", where),
    ...str("fingerprint"),
    ...str("functionName"),
    ...str("service"),
    ...str("errorType"),
    ...str("errorCode"),
    ...str("errorName"),
    ...str("errorDetail"),
    ...num("httpStatus"),
    ...num("occurrenceCount"),
    ...str("firstOccurredAt"),
    ...str("lastOccurredAt"),
    ...str("message"),
    ...str("stackTrace"),
    logCounterCheck: { window: (check as Record<string, unknown>).window, count: (check as Record<string, unknown>).count, ...((check as Record<string, unknown>).capped === true && { capped: true }) } as LogCounterCheck,
  };
}
