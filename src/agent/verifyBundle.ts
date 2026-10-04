/**
 * The bundle that carries a source snapshot and a patch from the agent to the verify runner (#74): a gzipped tar
 * with `tree/` (the checkout, minus `.git` and `node_modules`) and `patch.diff`. Made with the system `tar`, which
 * the engine image has; nothing here is parsed by hand. The agent builds it from its own checkout, so unpacking it
 * trusts the maker, but it is unpacked in a scratch directory and the tree is checked for what it must hold.
 */
import { execFile } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_PATCH_FILE, BUNDLE_TREE_DIR, MAX_BUNDLE_BYTES, VerifyRunnerError } from "./verifyProtocol.js";

const SKIP = new Set([".git", "node_modules"]);

function tar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", args, { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 }, (err, _out, stderr) => {
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

/** Unpack into `dest` (which must exist and be empty) and return the paths of the tree and the patch. */
export async function unpackBundle(bytes: Buffer, dest: string, tmp = tmpdir()): Promise<{ tree: string; patch: string }> {
  if (bytes.length > MAX_BUNDLE_BYTES) throw new VerifyRunnerError("the bundle is larger than the limit");
  const work = await mkdtemp(join(tmp, "starfish-unpack-"));
  try {
    const file = join(work, "bundle.tgz");
    await writeFile(file, bytes);
    await tar(["-xzf", file, "-C", dest], work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const tree = join(dest, BUNDLE_TREE_DIR);
  const patch = join(dest, BUNDLE_PATCH_FILE);
  try {
    if (!(await lstat(tree)).isDirectory() || !(await lstat(patch)).isFile()) throw new Error("shape");
  } catch {
    throw new VerifyRunnerError("the bundle does not hold a tree and a patch");
  }
  return { tree, patch };
}
