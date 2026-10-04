/**
 * A checkout of the target repository at one pinned revision, for the agent job (#74).
 *
 * The fixer, the reviewer and the verify gate all work from this one directory, and the pull-request opener
 * fetches the same revision itself (githubPr.ts), so the evidence a cycle records is about exactly the tree
 * the patch was written against. What is returned is a SNAPSHOT: a shallow clone of the base branch whose
 * `.git` is then deleted, so nothing downstream can read history, a reference fix or the credential git was
 * given (#8, "Evaluator boundary"). The revision and the file list are read before that happens.
 *
 * The token reaches git only in its environment (`gitAuthEnv`), never in a command line or in `.git/config`,
 * and a child git inherits nothing else. It is optional: a public repository needs none. Errors are scrubbed
 * of it before they leave this file. Needs a `git` on the PATH (the engine image installs one).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StarfishConfig } from "../config.js";
import { BRANCH_RE, REPO_RE, defaultRunGit, gitAuthEnv, type RunGit } from "../integrations/githubPr.js";
import { redactPii } from "../ingest/redact.js";

export type CheckoutConfig = Pick<StarfishConfig, "githubRepo" | "githubBaseBranch" | "githubRemoteUrl">;

export interface CheckoutDeps {
  /** Only for a private repository. */
  token?: string;
  /** What a child git may inherit: `loadChildProcessBasics()` from config.ts. */
  env: { PATH?: string; HOME?: string };
  runGit?: RunGit;
  /** Where the snapshot lives. Defaults to the OS temp directory. */
  tmpDir?: string;
}

export interface Checkout {
  /** The snapshot, without `.git`. Never modified by the agent: the verify gate copies it. */
  dir: string;
  /** The full commit id the snapshot is, the one every piece of evidence is tied to. */
  revision: string;
  /** Repo-relative paths of the tracked files, as git lists them. */
  files: string[];
  cleanup: () => Promise<void>;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_FILES = 50_000;

/** Throws a plain Error naming what failed, with the token and any credential-shaped text removed. */
export async function checkoutSource(cfg: CheckoutConfig, deps: CheckoutDeps): Promise<Checkout> {
  if (!REPO_RE.test(cfg.githubRepo)) throw new Error("checkout: githubRepo must be owner/name");
  if (!BRANCH_RE.test(cfg.githubBaseBranch) || cfg.githubBaseBranch.includes("..")) {
    throw new Error("checkout: githubBaseBranch is not a usable branch name");
  }
  const remote = cfg.githubRemoteUrl !== "" ? cfg.githubRemoteUrl : `https://github.com/${cfg.githubRepo}.git`;
  const token = deps.token?.trim() ?? "";
  // An empty remote is not https, so with no token git gets its plain environment and no credential header.
  const env = gitAuthEnv(token === "" ? "" : remote, token, deps.env);
  const runGit = deps.runGit ?? defaultRunGit;
  const scrub = (text: string) => {
    const hidden = token === "" ? text : text.split(token).join("[token]").split(Buffer.from(`x-access-token:${token}`).toString("base64")).join("[token]");
    return redactPii(hidden);
  };

  const root = await mkdtemp(join(deps.tmpDir ?? tmpdir(), "starfish-source-"));
  const dir = join(root, "src");
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    await runGit(["clone", "--quiet", "--depth", "1", "--single-branch", "--no-tags", "--branch", cfg.githubBaseBranch, "--", remote, dir], { cwd: root, env });
    const revision = (await runGit(["rev-parse", "HEAD"], { cwd: dir, env })).trim();
    if (!SHA_RE.test(revision)) throw new Error("git did not report a commit id");
    const listed = (await runGit(["ls-files", "-z"], { cwd: dir, env })).split("\0").filter((f) => f !== "");
    if (listed.length > MAX_FILES) throw new Error(`the repository has more than ${MAX_FILES} files`);
    await rm(join(dir, ".git"), { recursive: true, force: true });
    return { dir, revision, files: listed, cleanup };
  } catch (err) {
    await cleanup();
    // The original error is deliberately not attached as `cause`: its message can carry the token, and a cause is
    // printed by anything that logs the error.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(scrub(`checkout failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}
