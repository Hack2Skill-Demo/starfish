/**
 * The pull-request step against a real git remote (a bare repository on disk) and a fake GitHub REST
 * API (a real HTTP server on localhost). Nothing is mocked inside the code under test: the commit is
 * built by real git, pushed by real git, and the API calls are real HTTP.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadChildProcessBasics } from "../config.js";
import { SEEDED_SECRETS } from "../ingest/testSecrets.js";
import type { PullRequestRequest } from "../agent/loop.js";
import { GithubError, branchFor, createGithubClient, createPullRequestOpener, gitAuthEnv, pullRequestText, pushRefspec, type GithubPrConfig, type RunGit } from "./githubPr.js";

const TOKEN = SEEDED_SECRETS.github!;
const REPO = "acme/shop";
const GIT_ENV = { ...loadChildProcessBasics(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

interface Recorded {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

interface Reply {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

let root: string;
let bare: string;
let baseRev: string;
let server: Server;
let apiUrl: string;
let requests: Recorded[];
/** What the fake API does, per test. */
let api: {
  repo: () => Reply;
  list: (n: number) => Reply;
  create: (n: number) => Reply;
  checks?: (commit: string) => Reply;
  annotations?: (id: string) => Reply;
};
let listCalls: number;
let createCalls: number;

const PATCH = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-hello old\n+hello new\n";
const request = (over: Partial<PullRequestRequest> = {}): PullRequestRequest => ({
  cycleId: "inc1_r0",
  incidentId: "inc1",
  baseRevision: baseRev,
  patch: PATCH,
  patchSha256: createHash("sha256").update(over.patch ?? PATCH).digest("hex"),
  rootCause: "couponCode is written as undefined.",
  risk: "Orders without a coupon.",
  verify: { status: "passed", rule: "command-passed", changedFiles: ["greeting.txt"], output: "ok" },
  review: { verdict: "approve", attacks: [{ attack: "Empty order", outcome: "held", detail: "Handled." }] },
  ...over,
});
const cfg = (): GithubPrConfig => ({
  githubRepo: REPO,
  githubBaseBranch: "main",
  githubApiUrl: apiUrl,
  githubRemoteUrl: bare,
  githubCommitName: "Starfish",
  githubCommitEmail: "starfish@example.test",
});
const opener = (over: { fetch?: typeof fetch; runGit?: RunGit; token?: string } = {}) =>
  createPullRequestOpener(cfg(), { token: TOKEN, env: loadChildProcessBasics(), tmpDir: join(root, "scratch"), ...over });

const branches = () => git(bare, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").split("\n").sort();
const scratchLeft = () => readdirSync(join(root, "scratch"));

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "gh-pr-test-"));
  mkdirSync(join(root, "scratch"));
  bare = join(root, "remote.git");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { env: GIT_ENV });
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  mkdirSync(seed);
  git(seed, "init", "--quiet", "-b", "main");
  writeFileSync(join(seed, "greeting.txt"), "hello old\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "base");
  baseRev = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "--quiet", bare, "main");

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      requests.push({ method: req.method ?? "", path: url.pathname + url.search, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      let out: Reply;
      if (req.method === "GET" && url.pathname === `/repos/${REPO}`) out = api.repo();
      else if (req.method === "GET" && url.pathname === `/repos/${REPO}/pulls`) out = api.list(++listCalls);
      else if (req.method === "POST" && url.pathname === `/repos/${REPO}/pulls`) out = api.create(++createCalls);
      else if (req.method === "GET" && url.pathname.startsWith(`/repos/${REPO}/commits/`) && url.pathname.endsWith("/check-runs") && api.checks) out = api.checks(url.pathname.split("/")[4]!);
      else if (req.method === "GET" && url.pathname.startsWith(`/repos/${REPO}/check-runs/`) && api.annotations) out = api.annotations(url.pathname.split("/")[4]!);
      else if (req.method === "DELETE" && url.pathname.startsWith(`/repos/${REPO}/git/refs/heads/`)) {
        // Like GitHub: the branch is really gone afterwards.
        const ref = `refs/heads/${decodeURIComponent(url.pathname.slice(`/repos/${REPO}/git/refs/heads/`.length))}`;
        out = branches().some((b) => b.startsWith(`${ref} `)) ? (git(bare, "update-ref", "-d", ref), { status: 204, json: null }) : { status: 422, json: { message: "Reference does not exist" } };
      } else out = { status: 404, json: { message: "not found" } };
      res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) });
      res.end(out.status === 204 ? undefined : JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

const PR = { number: 7, html_url: `https://github.com/${REPO}/pull/7` };
beforeEach(() => {
  requests = [];
  listCalls = 0;
  createCalls = 0;
  api = {
    repo: () => ({ status: 200, json: { full_name: REPO, archived: false } }),
    list: () => ({ status: 200, json: [] }),
    create: () => ({ status: 201, json: PR }),
  };
});
afterEach(() => {
  // Each test starts from the seeded remote: only main.
  for (const line of branches()) {
    const ref = line.split(" ")[0]!;
    if (ref !== "refs/heads/main") git(bare, "update-ref", "-d", ref);
  }
});

describe("createPullRequestOpener: opening", () => {
  it("pushes one commit on starfish/<cycle> on top of the verified base, and opens one pull request", async () => {
    const mainBefore = git(bare, "rev-parse", "refs/heads/main");
    const result = await opener()(request());
    expect(result).toEqual({ number: 7, url: PR.html_url });

    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(mainBefore);
    expect(branches().map((l) => l.split(" ")[0])).toEqual(["refs/heads/main", "refs/heads/starfish/inc1_r0"]);
    expect(git(bare, "rev-parse", "refs/heads/starfish/inc1_r0^")).toBe(baseRev);
    expect(git(bare, "show", "refs/heads/starfish/inc1_r0:greeting.txt")).toBe("hello new");
    expect(git(bare, "log", "-1", "--format=%an <%ae>", "refs/heads/starfish/inc1_r0")).toBe("Starfish <starfish@example.test>");
    // The patch file is not part of the commit.
    expect(git(bare, "ls-tree", "-r", "--name-only", "refs/heads/starfish/inc1_r0")).toBe("greeting.txt");

    const post = requests.find((r) => r.method === "POST")!;
    const sent = post.body as { head: string; base: string; maintainer_can_modify: boolean; body: string; title: string };
    expect(sent).toMatchObject({ head: "starfish/inc1_r0", base: "main", maintainer_can_modify: false });
    expect(sent.body).toContain(request().patchSha256);
    expect(sent.title).toMatch(/^Starfish: couponCode/);
    expect(scratchLeft()).toEqual([]);
  });

  it("never merges, never touches another ref: the API sees only a repo read, a list and one create", async () => {
    await opener()(request());
    expect(requests.map((r) => `${r.method} ${r.path.split("?")[0]}`)).toEqual([
      `GET /repos/${REPO}`,
      `GET /repos/${REPO}/pulls`,
      `POST /repos/${REPO}/pulls`,
    ]);
  });

  it("sends the token to the API only as a bearer header", async () => {
    await opener()(request());
    for (const r of requests) expect(r.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(requests.map((r) => r.body))).not.toContain(TOKEN);
  });
});

describe("createPullRequestOpener: idempotent by cycle id", () => {
  it("returns the pull request that already exists for the cycle, without pushing or creating another", async () => {
    api.list = () => ({ status: 200, json: [{ number: 3, html_url: `https://github.com/${REPO}/pull/3` }] });
    const result = await opener()(request());
    expect(result.number).toBe(3);
    expect(createCalls).toBe(0);
    expect(branches().map((l) => l.split(" ")[0])).toEqual(["refs/heads/main"]);
  });

  it("a second call after a success is a no-op: same pull request, same branch tip", async () => {
    const open = opener();
    await open(request());
    const tip = git(bare, "rev-parse", "refs/heads/starfish/inc1_r0");
    api.list = () => ({ status: 200, json: [PR] });
    expect((await open(request())).number).toBe(7);
    expect(createCalls).toBe(1);
    expect(git(bare, "rev-parse", "refs/heads/starfish/inc1_r0")).toBe(tip);
  });

  it("after a crash between the push and the pull request, reuses the pushed branch and opens exactly one", async () => {
    let first = true;
    api.create = () => {
      if (first) {
        first = false;
        return { status: 500, json: { message: "boom" } };
      }
      return { status: 201, json: PR };
    };
    const open = opener();
    await expect(open(request())).rejects.toMatchObject({ rule: "server-error" });
    const tip = git(bare, "rev-parse", "refs/heads/starfish/inc1_r0");

    expect(await open(request())).toEqual({ number: 7, url: PR.html_url });
    expect(git(bare, "rev-parse", "refs/heads/starfish/inc1_r0")).toBe(tip); // not pushed again, not rewritten
    expect(createCalls).toBe(2);
  });

  it("answers a 'pull request already exists' refusal (a racing worker) with that pull request", async () => {
    api.create = () => ({ status: 422, json: { message: "A pull request already exists for acme:starfish/inc1_r0." } });
    api.list = (n) => ({ status: 200, json: n === 1 ? [] : [{ number: 9, html_url: `https://github.com/${REPO}/pull/9` }] });
    expect((await opener()(request())).number).toBe(9);
  });

  it("refuses a branch that exists with different content, and changes nothing", async () => {
    const seed = join(root, "other");
    execFileSync("git", ["clone", "--quiet", bare, seed], { env: GIT_ENV });
    git(seed, "checkout", "--quiet", "-b", "starfish/inc1_r0");
    writeFileSync(join(seed, "greeting.txt"), "someone else\n");
    git(seed, "commit", "--quiet", "-am", "theirs");
    git(seed, "push", "--quiet", "origin", "starfish/inc1_r0");
    const theirs = git(bare, "rev-parse", "refs/heads/starfish/inc1_r0");

    await expect(opener()(request())).rejects.toMatchObject({ rule: "branch-conflict" });
    expect(git(bare, "rev-parse", "refs/heads/starfish/inc1_r0")).toBe(theirs);
    expect(createCalls).toBe(0);
    rmSync(seed, { recursive: true, force: true });
  });
});

describe("createPullRequestOpener: refusals before anything is written", () => {
  const untouched = () => {
    expect(branches().map((l) => l.split(" ")[0])).toEqual(["refs/heads/main"]);
    expect(createCalls).toBe(0);
    expect(scratchLeft()).toEqual([]);
  };

  it("refuses a patch that is not the one that was verified", async () => {
    await expect(opener()(request({ patchSha256: "0".repeat(64) }))).rejects.toMatchObject({ rule: "patch-hash-mismatch" });
    expect(requests).toEqual([]);
    untouched();
  });

  it("refuses a cycle id that could become part of another ref", async () => {
    for (const cycleId of ["../main", "a/b", "x y", "", "a".repeat(200), "main:evil"]) {
      await expect(opener()(request({ cycleId }))).rejects.toMatchObject({ rule: "invalid-request" });
    }
    expect(requests).toEqual([]);
    expect(branchFor("../main")).toBeNull();
    expect(branchFor("inc1_r0")).toBe("starfish/inc1_r0");
  });

  it("refuses a base revision that is not a commit id", async () => {
    await expect(opener()(request({ baseRevision: "main" }))).rejects.toMatchObject({ rule: "invalid-request" });
    expect(requests).toEqual([]);
  });

  it("refuses when the API names a different repository, or an archived one", async () => {
    api.repo = () => ({ status: 200, json: { full_name: "acme/other", archived: false } });
    await expect(opener()(request())).rejects.toMatchObject({ rule: "wrong-repository" });
    api.repo = () => ({ status: 200, json: { full_name: REPO, archived: true } });
    await expect(opener()(request())).rejects.toMatchObject({ rule: "wrong-repository" });
    untouched();
  });

  it("refuses a patch that does not apply to the base revision, and leaves nothing behind", async () => {
    const bad = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-not what is there\n+x\n";
    await expect(opener()(request({ patch: bad, patchSha256: createHash("sha256").update(bad).digest("hex") }))).rejects.toMatchObject({ rule: "patch-does-not-apply" });
    untouched();
  });

  it("refuses a base revision the repository does not have", async () => {
    await expect(opener()(request({ baseRevision: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }))).rejects.toBeInstanceOf(GithubError);
    untouched();
  });
});

describe("createPullRequestOpener: what the API can say", () => {
  const cases: [string, Reply, string][] = [
    ["an expired token", { status: 401, json: { message: "Bad credentials" } }, "unauthorized"],
    ["a token that may not act", { status: 403, json: { message: "Resource not accessible by integration" } }, "forbidden"],
    ["a rate limit", { status: 403, json: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } }, "rate-limited"],
    ["a 429", { status: 429, json: { message: "slow down" } }, "rate-limited"],
    ["a repository it cannot see", { status: 404, json: { message: "Not Found" } }, "not-found"],
    ["a server error", { status: 502, json: { message: "bad gateway" } }, "server-error"],
  ];
  it.each(cases)("%s is a named, token-free error and nothing is pushed", async (_n, response, rule) => {
    api.repo = () => response;
    const err = await opener()(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect((err as GithubError).rule).toBe(rule);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(branches().map((l) => l.split(" ")[0])).toEqual(["refs/heads/main"]);
  });

  it("scrubs the token out of an error message the API echoes back", async () => {
    api.repo = () => ({ status: 401, json: { message: `Bad credentials for ${TOKEN}` } });
    const err = (await opener()(request()).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
  });

  it("a network failure is a server-error, not a hang or a crash", async () => {
    const failing = (async () => {
      throw new Error(`connect ECONNREFUSED while using ${TOKEN}`);
    }) as unknown as typeof fetch;
    const err = (await opener({ fetch: failing })(request()).catch((e: unknown) => e)) as GithubError;
    expect(err.rule).toBe("server-error");
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("createPullRequestOpener: secrets and the commands it runs", () => {
  it("never puts the token in a git command line", async () => {
    const seen: string[][] = [];
    const real: RunGit = async (args, o) => {
      seen.push(args);
      return execFileSync("git", args, { cwd: o.cwd, env: o.env, encoding: "utf8" });
    };
    await opener({ runGit: real })(request());
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    expect(seen.length).toBeGreaterThan(5);
  });

  it("only ever pushes to refs/heads/starfish/<cycle>, and never forces", async () => {
    const seen: string[][] = [];
    const real: RunGit = async (args, o) => {
      seen.push(args);
      return execFileSync("git", args, { cwd: o.cwd, env: o.env, encoding: "utf8" });
    };
    await opener({ runGit: real })(request());
    const pushes = seen.filter((a) => a[0] === "push");
    expect(pushes).toEqual([["push", "--quiet", "origin", "HEAD:refs/heads/starfish/inc1_r0"]]);
    expect(seen.flat().some((a) => a === "--force" || a === "-f" || a.startsWith("+"))).toBe(false);
  });

  it("builds a push refspec only for a starfish/<id> branch", () => {
    expect(pushRefspec("starfish/inc1_r0")).toBe("HEAD:refs/heads/starfish/inc1_r0");
    for (const bad of ["main", "starfish/", "starfish/../main", "+starfish/x", "starfish/x:main", "starfish/a/b", "refs/heads/main", "STARFISH/x", ""]) {
      expect(() => pushRefspec(bad)).toThrow(GithubError);
    }
  });

  it("does not follow a redirect with the token", async () => {
    api.repo = () => ({ status: 302, json: {}, headers: { location: `${apiUrl}/elsewhere` } });
    await expect(opener()(request())).rejects.toMatchObject({ rule: "server-error" });
    expect(requests.map((r) => r.path)).toEqual([`/repos/${REPO}`]);
  });

  it("gives git its credential in the environment, as a header, only for an https remote", () => {
    const basics = { PATH: "/bin", HOME: "/h" };
    const https = gitAuthEnv("https://github.com/acme/shop.git", TOKEN, basics);
    expect(https.GIT_CONFIG_KEY_0).toBe("http.extraheader");
    expect(Buffer.from(String(https.GIT_CONFIG_VALUE_0).replace("Authorization: Basic ", ""), "base64").toString()).toBe(`x-access-token:${TOKEN}`);
    expect(gitAuthEnv("/some/local/path.git", TOKEN, basics).GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(JSON.stringify(gitAuthEnv("/p", TOKEN, basics))).not.toContain(TOKEN);
    // Nothing else of the engine's environment is handed down.
    expect(Object.keys(gitAuthEnv("/p", TOKEN, basics)).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "PATH"]);
  });

  it("does not leave the token in the scratch clone's git config", async () => {
    let configText = "";
    const real: RunGit = async (args, o) => {
      const out = execFileSync("git", args, { cwd: o.cwd, env: o.env, encoding: "utf8" });
      if (args[0] === "push") configText = readFileSync(join(o.cwd, ".git", "config"), "utf8");
      return out;
    };
    await opener({ runGit: real })(request());
    expect(configText).not.toContain(TOKEN);
  });
});

describe("pullRequestText", () => {
  it("redacts and bounds everything it writes, and a fenced output cannot close its fence", () => {
    const S = SEEDED_SECRETS;
    const { title, body } = pullRequestText(
      request({
        rootCause: `cause with ${S.stripe}\nsecond line`,
        risk: `risk ${S.jwt}`,
        verify: { status: "passed", rule: "command-passed", changedFiles: [`src/${S.github}.ts`], output: "x".repeat(20_000) + `\nout ${S.awsId}\n\`\`\`\n[evil](https://evil.example)\n` },
        review: { verdict: "approve", attacks: [{ attack: `a ${S.slack}`, outcome: "held", detail: `d ${S.googleOauth}` }] },
      })
    );
    for (const secret of Object.values(S)) {
      expect(title).not.toContain(secret);
      expect(body).not.toContain(secret);
    }
    expect(title).not.toContain("\n");
    expect(body.length).toBeLessThanOrEqual(12_000);
    // The one fence the output sits in is closed by us, not by the output.
    expect(body.split("\n").filter((l) => l === "```")).toHaveLength(2);
    expect(body).toContain("[evil](https://evil.example)"); // present as text inside the fence, which is what was asked
  });

  it("says plainly when no review was required, and never claims a merge", () => {
    const { body } = pullRequestText(request({ review: undefined }));
    expect(body).toContain("No review was required");
    expect(body).toContain("does not merge or deploy");
  });
});

describe("createPullRequestOpener: configuration", () => {
  it("refuses at construction a target or API it should not act on", () => {
    const deps = { token: TOKEN, env: loadChildProcessBasics() };
    const base = { githubRepo: REPO, githubBaseBranch: "main", githubApiUrl: "https://api.github.com", githubRemoteUrl: "", githubCommitName: "S", githubCommitEmail: "s@s" };
    expect(() => createPullRequestOpener(base, deps)).not.toThrow();
    expect(() => createPullRequestOpener({ ...base, githubRepo: "" }, deps)).toThrow(/owner\/name/);
    expect(() => createPullRequestOpener({ ...base, githubRepo: "a/b/c" }, deps)).toThrow(/owner\/name/);
    expect(() => createPullRequestOpener({ ...base, githubRepo: "a/b;rm -rf" }, deps)).toThrow(/owner\/name/);
    expect(() => createPullRequestOpener({ ...base, githubBaseBranch: "starfish/x" }, deps)).toThrow(/base branch/);
    expect(() => createPullRequestOpener({ ...base, githubBaseBranch: "a/../b" }, deps)).toThrow(/base branch/);
    expect(() => createPullRequestOpener({ ...base, githubApiUrl: "http://evil.example" }, deps)).toThrow(/https/);
    expect(() => createPullRequestOpener({ ...base, githubApiUrl: "http://127.0.0.1:9" }, deps)).not.toThrow();
    expect(() => createPullRequestOpener(base, { ...deps, token: "  " })).toThrow(/token/);
  });
});

describe("createGithubClient: the CI-backed verify step", () => {
  const client = (over: { fetch?: typeof fetch; runGit?: RunGit } = {}) =>
    createGithubClient(cfg(), { token: TOKEN, env: loadChildProcessBasics(), tmpDir: join(root, "scratch"), ...over });
  const tip = (branch: string) => git(bare, "rev-parse", `refs/heads/${branch}`);
  const patchReq = (over: Partial<PullRequestRequest> = {}) => request(over);
  const OTHER_PATCH = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-hello old\n+hello other\n";

  it("pushes the patch as one commit on starfish/<cycle> on top of the base, opens NO pull request, and returns the commit", async () => {
    const { branch, commit } = await client().pushPatchBranch(patchReq());
    expect(branch).toBe("starfish/inc1_r0");
    expect(commit).toBe(tip(branch));
    expect(git(bare, "rev-parse", `${commit}^`)).toBe(baseRev);
    expect(git(bare, "show", `${commit}:greeting.txt`)).toBe("hello new");
    expect(requests.some((r) => r.method === "POST")).toBe(false);
    expect(scratchLeft()).toEqual([]);
  });

  it("is idempotent: the same patch again gives the same commit and writes nothing", async () => {
    const c = client();
    const first = await c.pushPatchBranch(patchReq());
    const again = await c.pushPatchBranch(patchReq());
    expect(again.commit).toBe(first.commit);
    expect(branches().filter((b) => b.includes("starfish/"))).toHaveLength(1);
  });

  it("replaces the branch when the cycle's next draft differs: it deletes through the API, then pushes, never forcing", async () => {
    const c = client();
    const first = await c.pushPatchBranch(patchReq());
    const second = await c.pushPatchBranch(patchReq({ patch: OTHER_PATCH }));
    expect(second.commit).not.toBe(first.commit);
    expect(git(bare, "show", `${second.commit}:greeting.txt`)).toBe("hello other");
    expect(requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`/repos/${REPO}/git/refs/heads/starfish/inc1_r0`]);
  });

  it("never touches a branch that already has a pull request", async () => {
    const c = client();
    const first = await c.pushPatchBranch(patchReq());
    api.list = () => ({ status: 200, json: [PR] });
    await expect(c.pushPatchBranch(patchReq({ patch: OTHER_PATCH }))).rejects.toMatchObject({ rule: "branch-conflict" });
    expect(tip("starfish/inc1_r0")).toBe(first.commit);
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("lets the pull request be opened later from the branch it pushed: the commit is reused, and one pull request is created", async () => {
    const c = client();
    const { commit } = await c.pushPatchBranch(patchReq());
    const pr = await c.openPullRequest(patchReq());
    expect(pr).toEqual({ number: 7, url: PR.html_url });
    expect(tip("starfish/inc1_r0")).toBe(commit);
    expect(createCalls).toBe(1);
  });

  it("refuses a patch that is not the one named, before writing anything", async () => {
    await expect(client().pushPatchBranch({ ...patchReq(), patchSha256: "0".repeat(64) })).rejects.toMatchObject({ rule: "patch-hash-mismatch" });
    expect(branches()).toHaveLength(1);
  });

  it("only ever pushes to refs/heads/starfish/<cycle>, and never forces", async () => {
    const pushes: string[][] = [];
    const spy: RunGit = async (args, opts) => {
      if (args[0] === "push") pushes.push(args);
      return execFileSync("git", args, { cwd: opts.cwd, env: { ...opts.env, ...GIT_ENV }, encoding: "utf8" });
    };
    await client({ runGit: spy }).pushPatchBranch(patchReq());
    expect(pushes).toEqual([["push", "--quiet", "origin", "HEAD:refs/heads/starfish/inc1_r0"]]);
  });

  it("deletes the cycle's branch, treats an already-gone one as done, and refuses an id that is not a plain id", async () => {
    const c = client();
    await c.pushPatchBranch(patchReq());
    await c.deleteBranch("inc1_r0");
    expect(branches().filter((b) => b.includes("starfish/"))).toEqual([]);
    await expect(c.deleteBranch("inc1_r0")).resolves.toBeUndefined();
    await expect(c.deleteBranch("../main")).rejects.toMatchObject({ rule: "invalid-request" });
    await expect(c.deleteBranch("a b")).rejects.toMatchObject({ rule: "invalid-request" });
    expect(requests.filter((r) => r.method === "DELETE").every((r) => r.path.includes("/refs/heads/starfish/"))).toBe(true);
  });

  it("lists the check runs on a commit, bounded, and with a token an API echoes back scrubbed", async () => {
    const commit = "d".repeat(40);
    api.checks = (sha) => ({
      status: 200,
      json: {
        total_count: 2,
        check_runs: [
          { id: 11, name: "verify", status: "completed", conclusion: "success", html_url: "https://github.com/acme/shop/runs/11", output: { title: "ok", summary: `token ${TOKEN} ${"s".repeat(2000)}` } },
          { id: 12, name: "lint", status: "in_progress", conclusion: null, html_url: "https://github.com/acme/shop/runs/12", output: null },
          { id: "nope", name: "bad" },
          "junk",
        ],
        sha,
      },
    });
    const runs = await client().listCheckRuns(commit);
    expect(runs.map((r) => [r.id, r.name, r.status, r.conclusion])).toEqual([[11, "verify", "completed", "success"], [12, "lint", "in_progress", null]]);
    expect(runs[0]!.summary.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(runs)).not.toContain(TOKEN);
    expect(requests.at(-1)!.path).toBe(`/repos/${REPO}/commits/${commit}/check-runs?per_page=100`);
  });

  it("refuses a ref that is not a full commit id, and reports what the API cannot give", async () => {
    await expect(client().listCheckRuns("main")).rejects.toMatchObject({ rule: "invalid-request" });
    api.checks = () => ({ status: 403, json: { message: "Resource not accessible by integration" } });
    await expect(client().listCheckRuns("e".repeat(40))).rejects.toMatchObject({ rule: "forbidden" });
    api.checks = () => ({ status: 200, json: { check_runs: "nope" } });
    await expect(client().listCheckRuns("e".repeat(40))).rejects.toMatchObject({ rule: "unexpected-response" });
  });

  it("reads a check run's annotations, bounded", async () => {
    api.annotations = () => ({ status: 200, json: [{ path: "src/a.ts", start_line: 4, annotation_level: "failure", message: "m".repeat(1000) }, ...Array.from({ length: 40 }, () => ({ path: "x", start_line: 1, annotation_level: "notice", message: "n" }))] });
    const a = await client().annotations(11);
    expect(a).toHaveLength(20);
    expect(a[0]).toMatchObject({ path: "src/a.ts", line: 4, level: "failure" });
    expect(a[0]!.message.length).toBeLessThanOrEqual(400);
    await expect(client().annotations(0)).rejects.toMatchObject({ rule: "invalid-request" });
  });
});
