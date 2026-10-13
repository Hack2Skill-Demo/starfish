/**
 * Assemble what one cycle needs about one incident (#74): the incident as the stages see it, the log
 * counter-check and recent samples, a checkout of the target repository at a PINNED revision, and the
 * source files its stack trace names. This is the `load` the loop is given (`LoopDeps.load`).
 *
 * Every read degrades the way the rest of the engine does: the counter-check is `null` and there are no samples
 * when Cloud Logging fails (missing is not zero: triage is told the check is missing). The samples are only entries
 * that hash to the incident's fingerprint, and never choose files (#304). A checkout that
 * fails THROWS: with no source there is nothing to fix, and the cycle's lease will expire and be resumed.
 *
 * Files come only from the repository's own file list (`pathsFromStack` over the incident's own stack trace; when no frame names a repository file, the one
 * file that exports the failing function, `findSourceByFunctionName`, #259), are read as plain regular files
 * (never a symlink, never binary, bounded), and carry whatever the repository holds: the loop's stages
 * redact them before a model sees them.
 *
 * The checkout is a shallow clone of the base branch; its tip is the pinned revision the patch is verified
 * against and the pull request is opened on, so the two cannot disagree.
 */
import { readCorrection } from "../triageRules.js";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { fetchRecentErrorSamples, runLogCounterCheck, type EntryReader } from "../ingest/counterCheck.js";
import type { LogSource } from "../ingest/parseLogEntry.js";
import { defaultRunGit, gitAuthEnv, gitBaseEnv, type RunGit } from "../integrations/githubPr.js";
import type { Incident, IncidentStatus } from "../types.js";
import { INCIDENT_STATUSES } from "../types.js";
import type { LoopSubject } from "./loop.js";
import { pathsFromStack } from "./pass.js";
import type { SourceFile } from "./fixer.js";
import { findSourceByFunctionName, type SourceProvenance } from "./sourceByName.js";

export interface Checkout {
  /** The working tree (no `.git` content is ever shown to a model). */
  dir: string;
  /** The commit the tree is at: the pinned base revision. */
  revision: string;
  /** Repo-relative, `/`-separated tracked files. */
  files: string[];
  dispose(): Promise<void>;
}

export type CheckoutFn = () => Promise<Checkout>;

export type CheckoutConfig = Pick<StarfishConfig, "githubRepo" | "githubBaseBranch" | "githubRemoteUrl" | "githubApiUrl">;

export interface CheckoutDeps {
  /** Absent for a public or local remote: no credential is sent. */
  token?: string;
  /** What a child git may inherit: `loadChildProcessBasics()` from config.ts. */
  env: { PATH?: string; HOME?: string };
  runGit?: RunGit;
  tmpDir?: string;
}

/** A shallow clone of the configured repository's base branch, at its current tip. */
export function createGitCheckout(cfg: CheckoutConfig, deps: CheckoutDeps): CheckoutFn {
  const remote = cfg.githubRemoteUrl !== "" ? cfg.githubRemoteUrl : `https://github.com/${cfg.githubRepo}.git`;
  const env = deps.token ? gitAuthEnv(remote, deps.token, deps.env, cfg.githubApiUrl) : gitBaseEnv(deps.env);
  const runGit = deps.runGit ?? defaultRunGit;
  return async () => {
    const dir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), "starfish-src-"));
    const dispose = () => rm(dir, { recursive: true, force: true });
    const git = (args: string[]) => runGit(args, { cwd: dir, env });
    try {
      await git(["init", "--quiet"]);
      await git(["remote", "add", "origin", remote]);
      await git(["fetch", "--quiet", "--depth=1", "origin", `refs/heads/${cfg.githubBaseBranch}`]);
      await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
      const revision = (await git(["rev-parse", "HEAD"])).trim();
      const files = (await git(["ls-files", "-z"])).split("\0").filter((f) => f !== "");
      return { dir, revision, files, dispose };
    } catch (err) {
      await dispose();
      // The message may carry a remote URL: it never carries the token (it is in the environment, not argv).
      throw err;
    }
  };
}

export type AssembleConfig = Pick<StarfishConfig, "environment" | "incidentCollection" | "patchExcludedPaths" | "functionsSourceRoots" | "logResourceTypes" | "ignoredMessages" | "excludedServices">;

export interface AssembleDeps {
  db: Firestore;
  config: AssembleConfig;
  logging: EntryReader;
  checkout: CheckoutFn;
  now?: () => number;
  /** Source files shown per incident. */
  maxFiles?: number;
  /** A file larger than this is left out rather than cut mid-line. */
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_FILE_BYTES = 100_000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const iso = (v: unknown): string | undefined => {
  const d = (v as { toDate?: () => Date } | null | undefined)?.toDate?.();
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : str(v);
};

/** The stored document as the stages see an incident. Only fields that exist are set. */
export function toIncident(id: string, d: Record<string, unknown>): Incident {
  return {
    id,
    environment: str(d.environment) ?? "",
    ...(str(d.fingerprint) && { fingerprint: str(d.fingerprint) }),
    ...(str(d.functionName) && { functionName: str(d.functionName) }),
    ...(str(d.service) && { service: str(d.service) }),
    ...(str(d.errorType) && { errorType: str(d.errorType) }),
    ...(str(d.errorCode) && { errorCode: str(d.errorCode) }),
    ...(str(d.errorName) && { errorName: str(d.errorName) }),
    ...(str(d.errorDetail) && { errorDetail: str(d.errorDetail) }),
    ...(typeof d.httpStatus === "number" && { httpStatus: d.httpStatus }),
    ...(typeof d.occurrenceCount === "number" && { occurrenceCount: d.occurrenceCount }),
    ...(iso(d.firstOccurredAt) && { firstOccurredAt: iso(d.firstOccurredAt) }),
    ...(iso(d.lastOccurredAt) && { lastOccurredAt: iso(d.lastOccurredAt) }),
    ...(str(d.errorMessage) && { message: str(d.errorMessage) }),
    ...(str(d.stackTrace) && { stackTrace: str(d.stackTrace) }),
    ...(str(d.traceId) && { traceId: str(d.traceId) }),
    ...(str(d.sourceProjectId) && { sourceProjectId: str(d.sourceProjectId) }),
    // Triage's evidence rules read these (#19): a Monitoring-only incident is judged differently.
    ...(d.signalSource === "monitoring" && { signalSource: "monitoring" as const }),
    ...(typeof d.monitoringCount === "number" && Number.isFinite(d.monitoringCount) && { monitoringCount: d.monitoringCount }),
  };
}

/** A regular, text file under `dir`, or null. Never follows a symlink; never reads past the size cap. */
async function readSource(dir: string, rel: string, maxBytes: number): Promise<SourceFile | null> {
  try {
    const full = join(dir, rel);
    const st = await lstat(full);
    if (!st.isFile() || st.size > maxBytes) return null;
    const content = await readFile(full, "utf8");
    return content.includes("\0") ? null : { path: rel, content };
  } catch {
    return null;
  }
}

export interface Loader {
  /** `LoopDeps.load`: null when the incident is gone, retired or another environment's. */
  load: (incidentId: string) => Promise<LoopSubject | null>;
  /** Remove every checkout made. Never throws: call it when the pass is over. */
  disposeAll: () => Promise<void>;
}

export function createLoader(deps: AssembleDeps): Loader {
  const open: Checkout[] = [];
  const maxFiles = deps.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const source: LogSource = {
    logResourceTypes: deps.config.logResourceTypes,
    ignoredMessages: deps.config.ignoredMessages,
    excludedServices: deps.config.excludedServices,
  };

  return {
    async load(incidentId) {
      const snap = await deps.db.collection(deps.config.incidentCollection).doc(incidentId).get();
      const data = snap.data();
      if (!snap.exists || !data) return null;
      if (data.environment !== deps.config.environment || data.retired === true) return null;
      const status = INCIDENT_STATUSES.includes(data.status as IncidentStatus) ? (data.status as IncidentStatus) : "new";
      const incident = toIncident(incidentId, data);
      const correction = readCorrection(data);

      // Both degrade to null / [] rather than throw; a missing check is reported to triage as missing.
      const opts = deps.now ? { nowMs: deps.now() } : {};
      const [counter, fetched] = await Promise.all([
        incident.functionName ? runLogCounterCheck(deps.logging, source, incident.functionName, opts) : Promise.resolve(null),
        incident.functionName && incident.fingerprint
          ? fetchRecentErrorSamples(deps.logging, source, incident.functionName, incident.fingerprint, opts)
          : Promise.resolve(null),
      ]);
      if (counter) incident.logCounterCheck = counter;
      const samples = fetched ?? [];

      const checkout = await deps.checkout();
      open.push(checkout);

      // The incident's own stack only, never the samples' (#304): a sample is a recent log entry, and whoever can make
      // the function log an error could plant frames in it to choose which files the fixer is shown. The samples are
      // shown to the model as untrusted data, nothing more. (The stored stack is log text too, but it is the one record
      // of this incident ingest kept; it was always the source of the files, and still names only repository files.)
      const wanted = pathsFromStack(incident.stackTrace, checkout.files, deps.config.patchExcludedPaths, maxFiles);
      const files: SourceFile[] = [];
      for (const rel of wanted) {
        const file = await readSource(checkout.dir, rel, maxBytes);
        if (file) files.push(file);
      }
      let provenance: SourceProvenance = { rule: "stack" };
      if (wanted.length === 0) {
        // Only framework frames (a callable failing through logger.error / HttpsError), or no stack at all (#259): the
        // function's name still says which export failed. Never a structural cause (autoMerge.ts reads the stack alone).
        const byName = await findSourceByFunctionName(incident.functionName, checkout.files, (rel) => readSource(checkout.dir, rel, maxBytes), {
          roots: deps.config.functionsSourceRoots,
          excluded: deps.config.patchExcludedPaths,
        });
        if (byName.file) files.push(byName.file);
        provenance = { rule: byName.file ? "function-name" : "none", search: byName.outcome };
      }

      return {
        // An operator's correction (src/triageRules.ts): it caps triage, and is never shown to the model.
        subject: { incident, status, ...(correction && { correction }), ...(samples.length > 0 && { samples }) },
        files,
        source: provenance,
        sourceDir: checkout.dir,
        baseRevision: checkout.revision,
        repoFiles: checkout.files,
      };
    },
    async disposeAll() {
      await Promise.all(open.splice(0).map((c) => c.dispose().catch(() => undefined)));
    },
  };
}
