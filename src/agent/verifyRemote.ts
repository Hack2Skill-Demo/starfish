/**
 * The agent's side of the isolated verify step (#74): `createRemoteVerifier` is a drop-in for `verifyPatch` that
 * runs the verify command in a SEPARATE Cloud Run job instead of in this process. This process holds the
 * store, Logging and Gemini credentials; the job runs the target repository's own tests under a service account
 * with no roles, so the code that runs there reaches none of them.
 *
 * One call: pack the source snapshot and the patch into a bundle, put it in the bucket, mint two per-run signed
 * URLs (read the bundle, write the result), start the job with them, and wait for the result object. Everything
 * the job says is validated (verifyProtocol.ts) and bound to the SHA-256 of the patch sent.
 *
 * Failures that are the infrastructure's, not the patch's (the bundle could not be stored, the job could not be
 * started, no result by the deadline, a result that is not a result) THROW, as the rest of the engine does: the
 * cycle's lease then expires and the cycle is resumed, counted against its attempts. A command that failed or timed
 * out is a RESULT, and the loop sends it back to the fixer once. Signed URLs are secrets for their lifetime and are
 * never put in a message or an error.
 *
 * The storage, the job starter and the clock are injected: the production versions are at the foot of this file
 * and in cloudRunJob.ts, and they are the part never run against a real project.
 */
import { createHash, randomUUID } from "node:crypto";
import type { StarfishConfig } from "../config.js";
import { packBundle } from "./verifyBundle.js";
import { MAX_BUNDLE_BYTES, VerifyRunnerError, parseRunnerResult, type RunnerRequest } from "./verifyProtocol.js";
import type { VerifyRequest, VerifyResult } from "./verifyGate.js";

/** The slice of a bucket the verifier uses. */
export interface ObjectStore {
  put(path: string, data: Buffer, contentType: string): Promise<void>;
  /** A URL that allows exactly one method on exactly this object until `expiresMs` from now. */
  signedUrl(path: string, method: "GET" | "PUT", expiresMs: number, contentType?: string): Promise<string>;
  /** The object's bytes, or null while it does not exist. */
  read(path: string): Promise<Buffer | null>;
  remove(paths: string[]): Promise<void>;
}

/** Starts the verify job with this request. Resolves once the job is accepted, not when it has finished. */
export type JobStarter = (request: RunnerRequest) => Promise<void>;

export interface RemoteVerifyDeps {
  store: ObjectStore;
  startJob: JobStarter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  pollMs?: number;
  tmpDir?: string;
}

export type RemoteVerifyConfig = Pick<StarfishConfig, "verifyTimeoutSeconds">;

/** Time for the job to start, fetch, unpack and apply the patch, on top of the command's own limit. */
export const RUNNER_SLACK_SECONDS = 300;
const URL_LIFETIME_MS = 60 * 60 * 1000;

export function createRemoteVerifier(cfg: RemoteVerifyConfig, deps: RemoteVerifyDeps): (req: VerifyRequest) => Promise<VerifyResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const newId = deps.newId ?? randomUUID;
  const pollMs = deps.pollMs ?? 3000;

  return async (req) => {
    const patchSha256 = createHash("sha256").update(req.patch).digest("hex");
    const runId = newId();
    if (!/^[A-Za-z0-9-]{8,64}$/.test(runId)) throw new VerifyRunnerError("the run id is not usable");
    const bundlePath = `verify/${runId}/bundle.tgz`;
    const resultPath = `verify/${runId}/result.json`;

    const bundle = await packBundle(req.sourceDir, req.patch, deps.tmpDir);
    if (bundle.length > MAX_BUNDLE_BYTES) throw new VerifyRunnerError("the bundle is larger than the limit");

    try {
      await deps.store.put(bundlePath, bundle, "application/gzip");
      const request: RunnerRequest = {
        v: 1,
        bundleUrl: await deps.store.signedUrl(bundlePath, "GET", URL_LIFETIME_MS),
        resultUrl: await deps.store.signedUrl(resultPath, "PUT", URL_LIFETIME_MS, "application/json"),
        patchSha256,
        command: req.config.verifyCommand,
        timeoutSeconds: req.config.verifyTimeoutSeconds,
        excludedPaths: req.config.patchExcludedPaths,
        ...(req.baseRevision !== undefined && { baseRevision: req.baseRevision }),
      };
      await deps.startJob(request);

      const deadline = now() + (cfg.verifyTimeoutSeconds + RUNNER_SLACK_SECONDS) * 1000;
      for (;;) {
        const found = await deps.store.read(resultPath);
        if (found !== null) return parseRunnerResult(found.toString("utf8"), patchSha256, req.baseRevision);
        if (now() >= deadline) throw new VerifyRunnerError("the verify job wrote no result before the deadline");
        // Keeps the cycle's lease alive through the wait, and stops it once the lease is lost (#132).
        await req.heartbeat?.();
        await sleep(pollMs);
      }
    } finally {
      // Best effort: the bucket's lifecycle rule removes what this cannot.
      await deps.store.remove([bundlePath, resultPath]).catch(() => undefined);
    }
  };
}
