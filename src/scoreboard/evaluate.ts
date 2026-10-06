/**
 * The deterministic half of an evaluation (#4, #10): a case's private evaluator, run on a disposable copy of the
 * repository snapshot before and after a patch, through the verify gate (src/agent/verifyGate.ts). No model here.
 *
 *   before   the evaluator must FAIL on the unpatched snapshot: the defect reproduces. A case whose evaluator passes
 *            before any patch proves nothing about a fix, so it is refused, not scored.
 *   after    the patch is applied by the gate (`git apply`, nothing repaired by hand) to a copy of the snapshot with the
 *            evaluator's files laid over it, and the evaluator must pass. A patch that touches an evaluator file is
 *            refused by the gate's excluded paths, so a fix cannot pass by rewriting the test that judges it.
 *
 * The evaluator lives outside the snapshot (a separate directory), and only the files a case lists from the snapshot
 * are ever shown to the fixer or the reviewer: the evaluator's tests are never part of what the model reads. They are
 * only laid over the disposable copy this module makes, after the model has answered.
 *
 * THIS IS NOT A SANDBOX, for the same reason the gate is not: the evaluator and the patched code run in this process's
 * user, with its network and filesystem. Run it where nothing worth stealing is held.
 */
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUnpatched, verifyPatch, type VerifyConfig, type VerifyResult } from "../agent/verifyGate.js";

/** A case's private ground truth: files laid over the snapshot, and the command that judges the result. */
export interface Evaluator {
  /** A directory OUTSIDE the snapshot. Its files are copied over the snapshot copy at the same relative paths. */
  dir: string;
  /** Run from the root of the copy. Exit 0 is a pass. */
  command: string;
}

export interface CheckoutUnderTest {
  /** The repository snapshot at the pre-fix revision. Never modified. */
  repoDir: string;
  evaluator: Evaluator;
}

const SKIP = new Set([".git", "node_modules"]);

/** Every regular file under `dir`, as sorted `/`-separated relative paths. A symlink or special file is refused. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of (await readdir(abs)).sort()) {
      if (SKIP.has(name)) continue;
      const full = join(abs, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = await lstat(full);
      if (st.isDirectory()) await walk(full, relPath);
      else if (st.isFile()) out.push(relPath);
      else throw new Error(`${relPath} is not a regular file or directory`);
    }
  };
  await walk(dir, "");
  return out.sort();
}

/** `relPath:sha256` for each file under `dir`, sorted: the content a case is frozen with. */
export async function treeDigest(dir: string): Promise<string[]> {
  const files = await listFiles(dir);
  return Promise.all(files.map(async (f) => `${f}:${createHash("sha256").update(await readFile(join(dir, f))).digest("hex")}`));
}

/** The evaluator's own files, by path relative to its root: the paths a patch may never touch. */
export const evaluatorPaths = (evaluator: Evaluator): Promise<string[]> => listFiles(evaluator.dir);

/** A disposable copy of the snapshot with the evaluator's files laid over it, removed when `fn` settles. */
async function withEvaluationTree<T>(c: CheckoutUnderTest, fn: (tree: string) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "starfish-eval-"));
  try {
    const tree = join(scratch, "tree");
    await cp(c.repoDir, tree, { recursive: true, verbatimSymlinks: true, filter: (src) => !SKIP.has(src.split("/").pop() ?? "") });
    // errorOnExist + force:false: an evaluator file that shadows a snapshot file is a corpus mistake, not something to overwrite.
    await cp(c.evaluator.dir, tree, { recursive: true, force: false, errorOnExist: true });
    return await fn(tree);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

type GateSettings = Pick<VerifyConfig, "verifyTimeoutSeconds" | "patchExcludedPaths">;

/**
 * The "before" check: the evaluator on the unpatched snapshot. `reproduces` only when the command ran and failed; a
 * timeout or a setup failure says nothing about the defect, so it does not count as reproducing it.
 */
export async function checkReproduces(c: CheckoutUnderTest, gate: GateSettings): Promise<{ reproduces: boolean; result: VerifyResult }> {
  const result = await withEvaluationTree(c, (tree) =>
    runUnpatched({ sourceDir: tree, config: { ...gate, verifyCommand: c.evaluator.command } })
  );
  return { reproduces: result.status === "failed", result };
}

/**
 * The "after" check: the patch through the verify gate onto the evaluation copy, then the evaluator. Passes only when
 * the gate reports `passed`: the patch applied as given, touched nothing excluded (the evaluator's files included),
 * and the evaluator exited 0.
 */
export async function evaluatePatch(c: CheckoutUnderTest, patch: string, gate: GateSettings): Promise<{ passed: boolean; result: VerifyResult }> {
  const protectedPaths = await evaluatorPaths(c.evaluator);
  const result = await withEvaluationTree(c, (tree) =>
    verifyPatch({
      sourceDir: tree,
      patch,
      config: { verifyCommand: c.evaluator.command, verifyTimeoutSeconds: gate.verifyTimeoutSeconds, patchExcludedPaths: [...gate.patchExcludedPaths, ...protectedPaths] },
    })
  );
  return { passed: result.status === "passed", result };
}
