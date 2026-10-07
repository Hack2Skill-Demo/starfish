/**
 * The GitHub writes auto-merge and fast-revert make (#9), against a real git remote (a bare repository on disk) and a
 * fake GitHub REST API (a real HTTP server on localhost): the squash merge bound to the exact head, the evidence
 * comment, and the revert of Starfish's own merge commit, which refuses to overwrite a later change. Never real GitHub.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadChildProcessBasics } from "../config.js";
import { SEEDED_SECRETS } from "../ingest/testSecrets.js";
import { createGithubClient, type GithubPrConfig } from "./githubPr.js";

const TOKEN = SEEDED_SECRETS.github!;
const REPO = "acme/demo-shop";
const GIT_ENV = { ...loadChildProcessBasics(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const HEAD = "b".repeat(40);
const MERGE_SHA = "e".repeat(40);

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}
interface Reply {
  status: number;
  json: unknown;
}

let root: string;
let bare: string;
let seed: string;
let server: Server;
let apiUrl: string;
let requests: Recorded[];
let pulls: Record<string, () => Reply>;
let mergeReply: () => Reply;
let listReply: () => Reply;
let compareReply: () => Reply;

const pr = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  html_url: `https://github.com/${REPO}/pull/${number}`,
  state: "open",
  merged: false,
  merged_at: null,
  closed_at: null,
  head: { ref: "starfish/inc1_r0", sha: HEAD, repo: { full_name: REPO } },
  base: { ref: "main", repo: { full_name: REPO } },
  ...over,
});

const cfg = (): GithubPrConfig => ({ githubRepo: REPO, githubBaseBranch: "main", githubApiUrl: apiUrl, githubRemoteUrl: bare, githubCommitName: "Starfish", githubCommitEmail: "starfish@example.test" });
const client = () => createGithubClient(cfg(), { token: TOKEN, env: loadChildProcessBasics(), tmpDir: join(root, "scratch") });

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      requests.push({ method: req.method ?? "", path: url.pathname + url.search, body: raw ? JSON.parse(raw) : undefined });
      let out: Reply = { status: 404, json: { message: "not found" } };
      const m = /^\/repos\/acme\/demo-shop\/pulls\/(\d+)(\/merge)?$/.exec(url.pathname);
      if (req.method === "GET" && url.pathname === `/repos/${REPO}`) out = { status: 200, json: { full_name: REPO, archived: false } };
      else if (req.method === "GET" && url.pathname === `/repos/${REPO}/pulls`) out = listReply();
      else if (req.method === "POST" && url.pathname === `/repos/${REPO}/pulls`) out = { status: 201, json: pr(8, { head: { ref: "starfish/revert-inc1_r0", sha: "f".repeat(40), repo: { full_name: REPO } } }) };
      else if (req.method === "GET" && m && !m[2] && pulls[m[1]!]) out = pulls[m[1]!]!();
      else if (req.method === "PUT" && m && m[2]) out = mergeReply();
      else if (req.method === "GET" && url.pathname.startsWith(`/repos/${REPO}/compare/`)) out = compareReply();
      else if (req.method === "POST" && /^\/repos\/acme\/demo-shop\/issues\/\d+\/comments$/.test(url.pathname)) out = { status: 201, json: { id: 1 } };
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gh-merge-test-"));
  mkdirSync(join(root, "scratch"));
  bare = join(root, "remote.git");
  seed = join(root, "seed");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { env: GIT_ENV });
  mkdirSync(seed);
  git(seed, "init", "--quiet", "-b", "main");
  writeFileSync(join(seed, "order.js"), "function get(o) {\n  return o.total;\n}\n");
  writeFileSync(join(seed, "other.js"), "module.exports = 1;\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "base");
  git(seed, "push", "--quiet", bare, "main");
  requests = [];
  pulls = { "7": () => ({ status: 200, json: pr(7) }) };
  mergeReply = () => ({ status: 200, json: { merged: true, sha: MERGE_SHA } });
  listReply = () => ({ status: 200, json: [] });
  compareReply = () => ({ status: 200, json: { ahead_by: 0, files: [] } });
  return () => rmSync(root, { recursive: true, force: true });
});

/** A commit on main, as Starfish's squash merge would leave it. */
function commitOnMain(file: string, content: string, message: string): string {
  writeFileSync(join(seed, file), content);
  git(seed, "commit", "--quiet", "-am", message);
  git(seed, "push", "--quiet", bare, "main");
  return git(seed, "rev-parse", "HEAD");
}
const branches = () => git(bare, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort();

describe("mergePullRequest", () => {
  it("squash-merges with the exact head named, and returns the merge commit", async () => {
    expect(await client().mergePullRequest("inc1_r0", 7, HEAD, { title: "Starfish: merge #7", body: "Run: inc1_r0" })).toEqual({ sha: MERGE_SHA });
    const put = requests.find((r) => r.method === "PUT")!;
    expect(put.path).toBe(`/repos/${REPO}/pulls/7/merge`);
    expect(put.body).toMatchObject({ merge_method: "squash", sha: HEAD });
    expect((put.body as { commit_title: string }).commit_title).toMatch(/^Starfish: merge #/);
  });

  it("refuses before asking GitHub when the head moved, the PR is not open, or it is not this cycle's", async () => {
    await expect(client().mergePullRequest("inc1_r0", 7, "c".repeat(40), { title: "t", body: "b" })).rejects.toMatchObject({ rule: "head-changed" });
    pulls["7"] = () => ({ status: 200, json: pr(7, { state: "closed", closed_at: "2026-10-06T12:00:00Z" }) });
    await expect(client().mergePullRequest("inc1_r0", 7, HEAD, { title: "t", body: "b" })).rejects.toMatchObject({ rule: "not-mergeable" });
    pulls["7"] = () => ({ status: 200, json: pr(7, { head: { ref: "feature/x", sha: HEAD, repo: { full_name: REPO } } }) });
    await expect(client().mergePullRequest("inc1_r0", 7, HEAD, { title: "t", body: "b" })).rejects.toMatchObject({ rule: "unexpected-response" });
    pulls["7"] = () => ({ status: 200, json: pr(7, { head: { ref: "starfish/inc1_r0", sha: HEAD, repo: { full_name: "evil/fork" } } }) });
    await expect(client().mergePullRequest("inc1_r0", 7, HEAD, { title: "t", body: "b" })).rejects.toMatchObject({ rule: "wrong-repository" });
    pulls["7"] = () => ({ status: 200, json: pr(7, { base: { ref: "production", repo: { full_name: REPO } } }) });
    await expect(client().mergePullRequest("inc1_r0", 7, HEAD, { title: "t", body: "b" })).rejects.toMatchObject({ rule: "wrong-base" }); // retargeted (#186)
    await expect(client().mergePullRequest("inc1_r0", 7, "short", { title: "t", body: "b" })).rejects.toMatchObject({ rule: "invalid-request" });
    expect(requests.filter((r) => r.method === "PUT")).toEqual([]);
  });

  it("reads GitHub's refusals as refusals, and an unconfirmed merge as not merged", async () => {
    mergeReply = () => ({ status: 409, json: { message: "Head branch was modified" } });
    await expect(client().mergePullRequest("inc1_r0", 7, HEAD, { title: "t", body: "b" })).rejects.toMatchObject({ rule: "head-changed" });
    mergeReply = () => ({ status: 405, json: { message: "Required status check is expected" } });
    await expect(client().mergePullRequest("inc1_r0", 7, HEAD, { title: "t", body: "b" })).rejects.toMatchObject({ rule: "not-mergeable" });
    mergeReply = () => ({ status: 200, json: { merged: false } });
    await expect(client().mergePullRequest("inc1_r0", 7, HEAD, { title: "t", body: "b" })).rejects.toMatchObject({ rule: "unexpected-response" });
  });

  it("keeps issue references and links in the commit message inert", async () => {
    await client().mergePullRequest("inc1_r0", 7, HEAD, { title: "fixes #1", body: "closes #2 https://evil.example" });
    const body = requests.find((r) => r.method === "PUT")!.body as { commit_title: string; commit_message: string };
    expect(body.commit_title).not.toContain("#1");
    expect(body.commit_message).not.toContain("#2");
    expect(body.commit_message).not.toContain("https://");
  });
});

describe("commentOnPullRequest", () => {
  it("posts one comment on this cycle's pull request", async () => {
    await client().commentOnPullRequest("inc1_r0", 7, "evidence");
    expect(requests.filter((r) => r.method === "POST")).toEqual([{ method: "POST", path: `/repos/${REPO}/issues/7/comments`, body: { body: "evidence" } }]);
  });
  it("refuses a pull request that is not this cycle's", async () => {
    await expect(client().commentOnPullRequest("other_r0", 7, "evidence")).rejects.toBeDefined();
    expect(requests.filter((r) => r.method === "POST")).toEqual([]);
  });
});

describe("filesChangedSince", () => {
  const BASE = "1".repeat(40);
  it("lists what changed on the base branch since the verified revision, renames included", async () => {
    compareReply = () => ({ status: 200, json: { ahead_by: 2, files: [{ filename: "a.ts" }, { filename: "b.ts", previous_filename: "old.ts" }] } });
    expect(await client().filesChangedSince(BASE)).toEqual(["a.ts", "b.ts", "old.ts"]);
    expect(requests.at(-1)!.path).toBe(`/repos/${REPO}/compare/${BASE}...main?per_page=300`);
  });
  it("is empty when nothing landed since, and refuses a list GitHub may have cut", async () => {
    expect(await client().filesChangedSince(BASE)).toEqual([]);
    compareReply = () => ({ status: 200, json: { ahead_by: 900, files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) } });
    await expect(client().filesChangedSince(BASE)).rejects.toMatchObject({ rule: "unexpected-response" });
    await expect(client().filesChangedSince("main")).rejects.toMatchObject({ rule: "invalid-request" });
  });
});

describe("readPullRequest: the merge commit", () => {
  it("gives the merge commit of a merged pull request", async () => {
    pulls["7"] = () => ({ status: 200, json: pr(7, { state: "closed", merged: true, merged_at: "2026-10-06T12:00:00Z", merge_commit_sha: MERGE_SHA }) });
    expect(await client().readPullRequest("inc1_r0", 7)).toMatchObject({ state: "merged", mergeCommitSha: MERGE_SHA });
  });
});

describe("openRevertPullRequest", () => {
  const revertReq = (mergeSha: string) => ({ cycleId: "inc1_r0", mergeSha, mergedPr: 7, reason: "It came back." });

  it("reverts Starfish's merge commit on starfish/revert-<cycle> and opens one pull request", async () => {
    const before = git(seed, "rev-parse", "HEAD:order.js");
    const merged = commitOnMain("order.js", "function get(o) {\n  if (!o) return null;\n  return o.total;\n}\n", "Starfish: merge #7");
    commitOnMain("other.js", "module.exports = 2;\n", "unrelated change"); // another file: not in the way
    const r = await client().openRevertPullRequest(revertReq(merged));
    expect(r).toMatchObject({ number: 8, url: `https://github.com/${REPO}/pull/8` });
    expect(branches()).toEqual(["refs/heads/main", "refs/heads/starfish/revert-inc1_r0"]);
    expect(git(bare, "rev-parse", "refs/heads/starfish/revert-inc1_r0:order.js")).toBe(before);
    expect(git(bare, "show", "refs/heads/starfish/revert-inc1_r0:other.js")).toBe("module.exports = 2;");
    expect(r.headSha).toBe(git(bare, "rev-parse", "refs/heads/starfish/revert-inc1_r0"));
    const post = requests.find((q) => q.method === "POST")!.body as { head: string; base: string; body: string };
    expect(post).toMatchObject({ head: "starfish/revert-inc1_r0", base: "main" });
    expect(post.body).toContain("never reverts a revert");
    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(git(seed, "rev-parse", "HEAD")); // main untouched
  });

  it("escalates instead of overwriting a later change to a file the merge touched", async () => {
    const merged = commitOnMain("order.js", "function get(o) {\n  if (!o) return null;\n  return o.total;\n}\n", "Starfish: merge #7");
    commitOnMain("order.js", "function get(o) {\n  if (!o) return null;\n  return o.total + 0;\n}\n", "a person's later change");
    await expect(client().openRevertPullRequest(revertReq(merged))).rejects.toMatchObject({ rule: "intervening-changes" });
    expect(branches()).toEqual(["refs/heads/main"]);
    expect(requests.filter((q) => q.method === "POST")).toEqual([]);
  });

  it("refuses a commit that is not on the base branch", async () => {
    await expect(client().openRevertPullRequest(revertReq("1".repeat(40)))).rejects.toMatchObject({ rule: "revert-not-possible" });
    expect(branches()).toEqual(["refs/heads/main"]);
  });

  it("returns the revert already opened for this cycle instead of a second", async () => {
    listReply = () => ({ status: 200, json: [pr(8, { head: { ref: "starfish/revert-inc1_r0", sha: "f".repeat(40), repo: { full_name: REPO } } })] });
    pulls["8"] = () => ({ status: 200, json: pr(8, { head: { ref: "starfish/revert-inc1_r0", sha: "f".repeat(40), repo: { full_name: REPO } } }) });
    expect(await client().openRevertPullRequest(revertReq("1".repeat(40)))).toEqual({ number: 8, url: `https://github.com/${REPO}/pull/8`, headSha: "f".repeat(40) });
    expect(requests.filter((q) => q.method === "POST")).toEqual([]);
  });

  it("refuses ids it cannot turn into a branch", async () => {
    await expect(client().openRevertPullRequest({ ...revertReq("1".repeat(40)), cycleId: "../main" })).rejects.toMatchObject({ rule: "invalid-request" });
    await expect(client().openRevertPullRequest({ ...revertReq("1".repeat(40)), cycleId: "x".repeat(125) })).rejects.toMatchObject({ rule: "invalid-request" });
    await expect(client().openRevertPullRequest(revertReq("short"))).rejects.toMatchObject({ rule: "invalid-request" });
  });
});
