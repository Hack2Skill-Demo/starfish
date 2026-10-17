/**
 * The bundle that carries a source snapshot and a patch from the agent to the verify runner (#74): a gzipped tar
 * with `tree/` (the checkout, minus `.git` and `node_modules`) and `patch.diff`. Made with the system `tar`, which
 * the engine image has; nothing here is parsed by hand. The agent builds it from its own checkout, so unpacking it
 * trusts the maker, but it is unpacked in a scratch directory under a byte budget (#389) and the tree is checked
 * for what it must hold.
 */
import { execFile, spawn } from "node:child_process";
import { cp, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { BUNDLE_PATCH_FILE, BUNDLE_TREE_DIR, MAX_BUNDLE_BYTES, MAX_UNPACKED_BYTES, VerifyRunnerError } from "./verifyProtocol.js";

const SKIP = new Set([".git", "node_modules"]);
const TAR_TIMEOUT_MS = 120_000;

function tar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", args, { cwd, timeout: TAR_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new VerifyRunnerError(`tar failed: ${String(stderr || err.message).slice(0, 200)}`));
      else resolve();
    });
  });
}

/** The snapshot and the patch as one gzipped tar. Throws a VerifyRunnerError over the size cap. */
export async function packBundle(sourceDir: string, patch: string, tmp = tmpdir()): Promise<Buffer> {
  const work = await mkdtemp(join(tmp, "starfish-bundle-"));
  try {
    const staging = join(work, "staging");
    await cp(sourceDir, join(staging, BUNDLE_TREE_DIR), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !SKIP.has(src.split("/").pop() ?? ""),
    });
    await writeFile(join(staging, BUNDLE_PATCH_FILE), patch);
    const out = join(work, "bundle.tgz");
    await tar(["-czf", out, "-C", staging, BUNDLE_PATCH_FILE, BUNDLE_TREE_DIR], work);
    const bytes = await readFile(out);
    if (bytes.length > MAX_BUNDLE_BYTES) throw new VerifyRunnerError("the bundle is larger than the limit");
    return bytes;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Passes bytes through and fails the stream the moment more than `max` have gone by. */
function byteBudget(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > max) cb(new VerifyRunnerError("the bundle expands beyond the limit"));
      else cb(null, chunk);
    },
  });
}

/** `tar -x` reading the (already decompressed) archive on stdin; resolves when it exits 0, kills it past its timeout. */
function extract(dest: string, source: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", "-", "-C", dest, "--no-same-owner"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 200) stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), TAR_TIMEOUT_MS);
    let failure: Error | undefined;
    const fail = (e: Error) => {
      failure ??= e;
      child.kill("SIGKILL");
    };
    // A tar that exits early closes its stdin: the pipe's EPIPE is that exit, which `close` reports.
    child.stdin.on("error", () => undefined);
    pipeline(source, child.stdin).catch(fail);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new VerifyRunnerError(`tar failed: ${e.message.slice(0, 200)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure instanceof VerifyRunnerError ? failure : new VerifyRunnerError("the bundle could not be unpacked"));
      else if (code === 0) resolve();
      else reject(new VerifyRunnerError(`tar failed: ${stderr.slice(0, 200) || `exit ${String(code)}`}`));
    });
  });
}

/** Empty `dir` without removing it: the caller made it and removes it. */
async function empty(dir: string): Promise<void> {
  for (const name of await readdir(dir).catch(() => [])) await rm(join(dir, name), { recursive: true, force: true });
}

/**
 * Unpack into `dest` (which must exist and be empty) and return the paths of the tree and the patch. The
 * decompressed stream is counted and cut off past MAX_UNPACKED_BYTES (#389); on any failure `dest` is emptied again.
 */
export async function unpackBundle(bytes: Buffer, dest: string): Promise<{ tree: string; patch: string }> {
  if (bytes.length > MAX_BUNDLE_BYTES) throw new VerifyRunnerError("the bundle is larger than the limit");
  const tree = join(dest, BUNDLE_TREE_DIR);
  const patch = join(dest, BUNDLE_PATCH_FILE);
  try {
    const gunzip = createGunzip();
    const archive = Readable.from([bytes]).pipe(gunzip).pipe(byteBudget(MAX_UNPACKED_BYTES));
    // Each stage's failure must reach the one consumer, or a bad gzip would only hang tar's stdin.
    gunzip.on("error", (e) => archive.destroy(e));
    await extract(dest, archive);
    try {
      if (!(await lstat(tree)).isDirectory() || !(await lstat(patch)).isFile()) throw new Error("shape");
    } catch {
      throw new VerifyRunnerError("the bundle does not hold a tree and a patch");
    }
  } catch (err) {
    await empty(dest);
    throw err;
  }
  return { tree, patch };
}
