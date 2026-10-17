/**
 * The verify runner (#74): what the credential-less Cloud Run job does. It is given one request (the environment
 * variable `STARFISH_VERIFY_REQUEST`, see verifyProtocol.ts), fetches the bundle from a signed URL, runs the verify
 * gate on it, and writes the result to a second signed URL. Nothing else: it has no Starfish setting, no
 * database, no model, no token, and a service account with no roles.
 *
 * It starts as root only so that it can drop to an unprivileged user for the one thing that runs the target's
 * code: the command. Until then it applies and judges the patch (verifyGate.ts). The result URL lives in this
 * process, so the command must not be able to read this process: it runs as another user, in a scratch copy it
 * owns, with an environment that carries none of this.
 *
 * What stays true even so, and is documented rather than hidden: the command has the network and the metadata
 * server (a token for an account with no roles), so it can send the snapshot it was given somewhere. The snapshot is
 * the target repository's own source.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackBundle } from "./verifyBundle.js";
import { MAX_BUNDLE_BYTES, TRANSFER_TIMEOUT_MS, VerifyRunnerError, parseRunnerRequest } from "./verifyProtocol.js";
import { verifyPatch, type VerifyResult } from "./verifyGate.js";

export interface RunnerDeps {
  fetch?: typeof fetch;
  tmpDir?: string;
  /** The user the command runs as; absent runs it as this process's own user (a test, a laptop). */
  runAs?: { uid: number; gid: number };
  /** One transfer's deadline in ms (the download as a whole, the upload); default TRANSFER_TIMEOUT_MS. */
  transferTimeoutMs?: number;
}

/**
 * Read a response body, counting bytes as they arrive, and stop at once above `max` whatever Content-Length said
 * (or did not say) (#389). Gives up when `signal` aborts, a stalled transfer included: the read is raced against it
 * rather than trusting the fetch implementation to cancel.
 */
async function readBounded(res: Response, max: number, signal: AbortSignal): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new VerifyRunnerError("the bundle could not be fetched (timed out)"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.length;
      if (total > max) throw new VerifyRunnerError("the bundle is larger than the limit");
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err instanceof VerifyRunnerError ? err : new VerifyRunnerError("the bundle could not be fetched");
  }
  return Buffer.concat(chunks, total);
}

/** Run `fn` with a signal that aborts after `ms`; the timer never outlives the call. */
async function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function runVerifier(rawRequest: string, deps: RunnerDeps = {}): Promise<VerifyResult> {
  const req = parseRunnerRequest(rawRequest);
  const doFetch = deps.fetch ?? fetch;
  const work = await mkdtemp(join(deps.tmpDir ?? tmpdir(), "starfish-runner-"));
  try {
    const timeoutMs = deps.transferTimeoutMs ?? TRANSFER_TIMEOUT_MS;
    const bytes = await withDeadline(timeoutMs, async (signal) => {
      const got = await doFetch(req.bundleUrl, { method: "GET", redirect: "error", signal }).catch(() => {
        throw new VerifyRunnerError(signal.aborted ? "the bundle could not be fetched (timed out)" : "the bundle could not be fetched");
      });
      if (!got.ok) throw new VerifyRunnerError(`the bundle could not be fetched (HTTP ${got.status})`);
      // An early refusal only: the count below is what holds when the header is absent or wrong.
      const declared = Number(got.headers.get("content-length") ?? 0);
      if (declared > MAX_BUNDLE_BYTES) {
        await got.body?.cancel().catch(() => undefined);
        throw new VerifyRunnerError("the bundle is larger than the limit");
      }
      return readBounded(got, MAX_BUNDLE_BYTES, signal);
    });

    const unpacked = await unpackBundle(bytes, work);
    const patch = await readFile(unpacked.patch, "utf8");
    // The patch in the bundle must be the one the agent will accept a result for.
    if (createHash("sha256").update(patch).digest("hex") !== req.patchSha256) throw new VerifyRunnerError("the patch in the bundle is not the one named in the request");

    const result = await verifyPatch({
      sourceDir: unpacked.tree,
      patch,
      ...(req.baseRevision !== undefined && { baseRevision: req.baseRevision }),
      config: { verifyCommand: req.command, verifyTimeoutSeconds: req.timeoutSeconds, patchExcludedPaths: req.excludedPaths },
      ...(deps.runAs && { runAs: deps.runAs }),
    });

    const put = await withDeadline(timeoutMs, (signal) =>
      doFetch(req.resultUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
        redirect: "error",
        signal,
      }).catch(() => {
        throw new VerifyRunnerError(signal.aborted ? "the result could not be written (timed out)" : "the result could not be written");
      }),
    );
    if (!put.ok) throw new VerifyRunnerError(`the result could not be written (HTTP ${put.status})`);
    return result;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
