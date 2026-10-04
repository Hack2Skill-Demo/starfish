// The checkout is tested against a real git remote on disk (file://), with the real `git`: what it must
// guarantee is about git's behaviour (a pinned revision, no .git left behind), which a stub cannot show.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutSource } from "./checkout.js";
import type { RunGit } from "../integrations/githubPr.js";

const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

let remote: string;
let headSha: string;
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "checkout-test-"));
  remote = join(scratch, "remote");
  mkdirSync(join(remote, "src"), { recursive: true });
  git(remote, "init", "-q", "-b", "main");
  writeFileSync(join(remote, "src", "orders.ts"), "export const x = 1;\n");
  writeFileSync(join(remote, "README.md"), "hello\n");
  git(remote, "add", "-A");
  git(remote, "commit", "-q", "-m", "first");
  writeFileSync(join(remote, "README.md"), "hello again\n");
  git(remote, "commit", "-q", "-am", "second");
  headSha = git(remote, "rev-parse", "HEAD");
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const cfg = () => ({ githubRepo: "acme/shop", githubBaseBranch: "main", githubRemoteUrl: `file://${remote}` });

describe("checkoutSource", () => {
  it("gives the base branch's head, named by its full commit id, with the tracked files listed", async () => {
    const c = await checkoutSource(cfg(), { env, tmpDir: scratch });
    try {
      expect(c.revision).toBe(headSha);
      expect(c.files.sort()).toEqual(["README.md", "src/orders.ts"]);
      expect(readFileSync(join(c.dir, "README.md"), "utf8")).toBe("hello again\n");
    } finally {
      await c.cleanup();
    }
  });

  it("leaves no .git behind, so nothing downstream can read history or the credential git was given", async () => {
    const c = await checkoutSource(cfg(), { env, tmpDir: scratch });
    expect(existsSync(join(c.dir, ".git"))).toBe(false);
    await c.cleanup();
    expect(existsSync(c.dir)).toBe(false);
  });

  it("clones one commit deep", async () => {
    const calls: string[][] = [];
    const spy: RunGit = async (args, opts) => {
      calls.push(args);
      return execFileSync("git", args, { cwd: opts.cwd, env: gitEnv, encoding: "utf8" });
    };
    const c = await checkoutSource(cfg(), { env, tmpDir: scratch, runGit: spy });
    await c.cleanup();
    expect(calls[0]).toEqual(expect.arrayContaining(["--depth", "1", "--single-branch", "--branch", "main"]));
  });

  it("hands the token to git only in its environment, never in an argument, and strips it from a failure", async () => {
    const token = "ghp_SEEDED_TOKEN_VALUE_1234567890";
    const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const failing: RunGit = async (args, opts) => {
      seen.push({ args, env: opts.env });
      throw new Error(`git clone failed: fatal: could not read from https://x-access-token:${token}@github.com/acme/shop.git`);
    };
    await expect(
      checkoutSource({ ...cfg(), githubRemoteUrl: "https://github.com/acme/shop.git" }, { env, token, tmpDir: scratch, runGit: failing })
    ).rejects.toThrow(/checkout failed/);
    expect(seen[0]!.args.join(" ")).not.toContain(token);
    expect(JSON.stringify(seen[0]!.env)).toContain("http.extraheader");
    const err = await checkoutSource({ ...cfg(), githubRemoteUrl: "https://github.com/acme/shop.git" }, { env, token, tmpDir: scratch, runGit: failing }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(token);
  });

  it("sends no credential header when there is no token", async () => {
    const seen: NodeJS.ProcessEnv[] = [];
    const stub: RunGit = async (_args, opts) => {
      seen.push(opts.env);
      throw new Error("stop");
    };
    await checkoutSource({ ...cfg(), githubRemoteUrl: "https://github.com/acme/shop.git" }, { env, tmpDir: scratch, runGit: stub }).catch(() => undefined);
    expect(JSON.stringify(seen[0])).not.toContain("extraheader");
  });

  it("refuses a repository or branch name that is not one, before running git", async () => {
    const never: RunGit = async () => {
      throw new Error("git must not run");
    };
    await expect(checkoutSource({ ...cfg(), githubRepo: "not-a-repo" }, { env, runGit: never })).rejects.toThrow("owner/name");
    await expect(checkoutSource({ ...cfg(), githubBaseBranch: "--upload-pack=x" }, { env, runGit: never })).rejects.toThrow("branch");
    await expect(checkoutSource({ ...cfg(), githubBaseBranch: "a..b" }, { env, runGit: never })).rejects.toThrow("branch");
  });

  it("removes its scratch directory when the clone fails", async () => {
    const dirs: string[] = [];
    const stub: RunGit = async (_a, opts) => {
      dirs.push(opts.cwd);
      throw new Error("no network");
    };
    await expect(checkoutSource(cfg(), { env, tmpDir: scratch, runGit: stub })).rejects.toThrow("no network");
    expect(existsSync(dirs[0]!)).toBe(false);
  });

  it("keeps a symbolic link in the repository as a link: it is listed, never followed here", async () => {
    symlinkSync("/etc/hostname", join(remote, "link"));
    git(remote, "add", "-A");
    git(remote, "commit", "-q", "-m", "link");
    const c = await checkoutSource(cfg(), { env, tmpDir: scratch });
    expect(c.files).toContain("link");
    await c.cleanup();
  });
});
