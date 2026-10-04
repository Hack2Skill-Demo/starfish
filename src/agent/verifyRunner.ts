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
import { MAX_BUNDLE_BYTES, VerifyRunnerError, parseRunnerRequest } from "./verifyProtocol.js";
import { verifyPatch, type VerifyResult } from "./verifyGate.js";

export interface RunnerDeps {
  fetch?: typeof fetch;
  tmpDir?: string;
  /** The user the command runs as; absent runs it as this process's own user (a test, a laptop). */
  runAs?: { uid: number; gid: number };
}

export async function runVerifier(rawRequest: string, deps: RunnerDeps = {}): Promise<VerifyResult> {
  const req = parseRunnerRequest(rawRequest);
  const doFetch = deps.fetch ?? fetch;
  const work = await mkdtemp(join(deps.tmpDir ?? tmpdir(), "starfish-runner-"));
  try {
    const got = await doFetch(req.bundleUrl, { method: "GET", redirect: "error" }).catch(() => {
      throw new VerifyRunnerError("the bundle could not be fetched");
    });
    if (!got.ok) throw new VerifyRunnerError(`the bundle could not be fetched (HTTP ${got.status})`);
    const declared = Number(got.headers.get("content-length") ?? 0);
    if (declared > MAX_BUNDLE_BYTES) throw new VerifyRunnerError("the bundle is larger than the limit");
    const bytes = Buffer.from(await got.arrayBuffer());

    const unpacked = await unpackBundle(bytes, work, deps.tmpDir);
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

    const put = await doFetch(req.resultUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
      redirect: "error",
    }).catch(() => {
      throw new VerifyRunnerError("the result could not be written");
    });
    if (!put.ok) throw new VerifyRunnerError(`the result could not be written (HTTP ${put.status})`);
    return result;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
