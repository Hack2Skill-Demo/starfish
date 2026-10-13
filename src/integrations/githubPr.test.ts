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
import { GithubError, ISSUE_LABEL, branchFor, createGithubClient, createPullRequestOpener, gitAuthEnv, indexRootCause, inert, issueText, pullRequestText, pushRefspec, titleLine, type GithubPrConfig, type IssueRequest, type RunGit } from "./githubPr.js";

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
  /** One page of a commit's check runs; `filter` is the query's (GitHub's default, `latest`, when absent). */
  checks?: (commit: string, page: number, filter: string | null) => Reply;
  annotations?: (id: string) => Reply;
  issues?: () => Reply;
  issueCreate?: () => Reply;
  pull?: (n: string) => Reply;
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
      else if (req.method === "GET" && url.pathname.startsWith(`/repos/${REPO}/pulls/`) && api.pull) out = api.pull(url.pathname.split("/")[4]!);
      else if (req.method === "GET" && url.pathname === `/repos/${REPO}/issues` && api.issues) out = api.issues();
      else if (req.method === "POST" && url.pathname === `/repos/${REPO}/issues` && api.issueCreate) out = api.issueCreate();
      else if (req.method === "GET" && url.pathname.startsWith(`/repos/${REPO}/commits/`) && url.pathname.endsWith("/check-runs") && api.checks) out = api.checks(url.pathname.split("/")[4]!, Number(url.searchParams.get("page") ?? "1"), url.searchParams.get("filter"));
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
    expect(result).toEqual({ number: 7, url: PR.html_url, headSha: git(bare, "rev-parse", "refs/heads/starfish/inc1_r0") });

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

    expect(await open(request())).toEqual({ number: 7, url: PR.html_url, headSha: tip });
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

  // #141: a misconfigured remote elsewhere must not receive the token.
  it("sends the credential only to github.com or the configured API's host", () => {
    const basics = { PATH: "/bin", HOME: "/h" };
    const hasAuth = (remote: string, api?: string) => gitAuthEnv(remote, TOKEN, basics, api).GIT_CONFIG_VALUE_0 !== undefined;
    expect(hasAuth("https://github.com/acme/shop.git")).toBe(true);
    expect(hasAuth("https://GitHub.com/acme/shop.git")).toBe(true);
    expect(hasAuth("https://gitlab.example/acme/shop.git")).toBe(false);
    expect(hasAuth("https://github.com.evil.example/acme/shop.git")).toBe(false);
    expect(hasAuth("https://evil.example/github.com/acme/shop.git")).toBe(false);
    expect(hasAuth("http://github.com/acme/shop.git")).toBe(false);
    expect(hasAuth("not a url")).toBe(false);
    // GitHub Enterprise Server: one host for git and the API. GHE.com: api.<x>.ghe.com serves <x>.ghe.com.
    expect(hasAuth("https://ghe.example/acme/shop.git", "https://ghe.example/api/v3")).toBe(true);
    expect(hasAuth("https://acme.ghe.com/acme/shop.git", "https://api.acme.ghe.com")).toBe(true);
    expect(hasAuth("https://ghe.example/acme/shop.git")).toBe(false);
    expect(hasAuth("https://ghe.example/acme/shop.git", "not a url")).toBe(false);
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

  it("finds the pull request a cycle already opened, read-only, and says null when there is none (#134)", async () => {
    const c = client();
    expect(await c.findPullRequest("inc1_r0")).toBeNull();
    api.list = () => ({ status: 200, json: [PR] });
    expect(await c.findPullRequest("inc1_r0")).toEqual({ number: 7, url: PR.html_url });
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    await expect(c.findPullRequest("../main")).rejects.toMatchObject({ rule: "invalid-request" });
  });

  it("lets the pull request be opened later from the branch it pushed: the commit is reused, and one pull request is created", async () => {
    const c = client();
    const { commit } = await c.pushPatchBranch(patchReq());
    const pr = await c.openPullRequest(patchReq());
    expect(pr).toEqual({ number: 7, url: PR.html_url, headSha: commit });
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
          { id: 11, name: "verify", status: "completed", conclusion: "success", html_url: "https://github.com/acme/shop/runs/11", app: { slug: "github-actions" }, output: { title: "ok", summary: `token ${TOKEN} ${"s".repeat(2000)}` } },
          { id: 12, name: "lint", status: "in_progress", conclusion: null, html_url: "https://github.com/acme/shop/runs/12", output: null },
          { id: "nope", name: "bad" },
          "junk",
        ],
        sha,
      },
    });
    const runs = await client().listCheckRuns(commit);
    expect(runs.map((r) => [r.id, r.name, r.status, r.conclusion, r.app])).toEqual([[11, "verify", "completed", "success", "github-actions"], [12, "lint", "in_progress", null, ""]]);
    expect(runs[0]!.summary.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(runs)).not.toContain(TOKEN);
    expect(requests.at(-1)!.path).toBe(`/repos/${REPO}/commits/${commit}/check-runs?filter=all&per_page=100&page=1`);
  });

  it("lists EVERY run, not only the latest of each check: a failure re-run to green is still seen (#205)", async () => {
    const commit = "d".repeat(40);
    const run = (id: number, conclusion: string) => ({ id, name: "verify", status: "completed", conclusion, html_url: "", app: { slug: "github-actions" }, output: null });
    // Like GitHub: the default filter (`latest`) hides the earlier, failed run of the same check.
    api.checks = (_sha, _page, filter) => ({ status: 200, json: filter === "all" ? { total_count: 2, check_runs: [run(2, "success"), run(1, "failure")] } : { total_count: 1, check_runs: [run(2, "success")] } });
    expect((await client().listCheckRuns(commit)).map((r) => r.conclusion)).toEqual(["success", "failure"]);
  });

  it("reads every page, and fails closed when the runs cannot all be read (#205)", async () => {
    const commit = "d".repeat(40);
    const page = (from: number, n: number) => Array.from({ length: n }, (_, k) => ({ id: from + k, name: `c${from + k}`, status: "completed", conclusion: "success", html_url: "", app: { slug: "github-actions" }, output: null }));
    api.checks = (_sha, p) => ({ status: 200, json: { total_count: 230, check_runs: p === 1 ? page(1, 100) : p === 2 ? page(101, 100) : p === 3 ? page(201, 30) : [] } });
    const before = requests.length;
    expect(await client().listCheckRuns(commit)).toHaveLength(230);
    expect(requests.slice(before).map((r) => r.path.replace(/^.*check-runs/, ""))).toEqual(["?filter=all&per_page=100&page=1", "?filter=all&per_page=100&page=2", "?filter=all&per_page=100&page=3"]);
    // Exactly a full page, and GitHub's count says that is all: no needless extra read.
    api.checks = () => ({ status: 200, json: { total_count: 100, check_runs: page(1, 100) } });
    expect(await client().listCheckRuns(commit)).toHaveLength(100);
    // More pages than the bound: never judged on the part read.
    api.checks = (_sha, p) => ({ status: 200, json: { total_count: 900, check_runs: page(p * 100, 100) } });
    await expect(client().listCheckRuns(commit)).rejects.toMatchObject({ rule: "too-many-check-runs" });
    // Fewer runs than GitHub's own count (a page that came back short): not judged either.
    api.checks = () => ({ status: 200, json: { total_count: 7, check_runs: page(1, 3) } });
    await expect(client().listCheckRuns(commit)).rejects.toMatchObject({ rule: "too-many-check-runs" });
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

  it("keeps no part of a secret its bound cuts through (#18)", async () => {
    // The bound of 400 falls 11 characters into each token: cut first and redacted after, what was left was too short
    // for its pattern, and was kept.
    for (const secret of [SEEDED_SECRETS.github!, SEEDED_SECRETS.awsId!, SEEDED_SECRETS.stripe!]) {
      const message = `${"word ".repeat(77)}abc ${secret} after`;
      expect(message.indexOf(secret)).toBe(389);
      api.annotations = () => ({ status: 200, json: [{ path: "src/a.ts", start_line: 4, annotation_level: "failure", message }] });
      const a = await client().annotations(11);
      expect(a[0]!.message).not.toContain(secret.slice(0, 11));
      expect(a[0]!.message).toMatch(/^word word/);
    }
  });
});

const issueRequest = (over: Partial<IssueRequest> = {}): IssueRequest => ({
  cycleId: "inc1_r0",
  incidentId: "inc1",
  functionName: "orders-createOrder",
  service: "orders",
  errorType: "DatabaseError",
  occurrenceCount: 42,
  fingerprint: "ab12cd34ef56",
  counterCheck: { window: "24h", count: 42, capped: false },
  path: "act",
  reason: "A defect in the order code.",
  suspectedCause: "createOrder writes undefined",
  uiBaseUrl: "https://starfish.example",
  ...over,
});
const ISSUE = { number: 9, html_url: `https://github.com/${REPO}/issues/9` };
const client = () => createGithubClient(cfg(), { token: TOKEN, env: loadChildProcessBasics(), tmpDir: join(root, "scratch") });

describe("inert: free text from an incident or the model, in markdown GitHub will render", () => {
  const hostile = "ping @everyone and @acme/oncall, see [the fix](https://evil.example/x) <img src=x onerror=1> https://evil.example/y";
  it("cannot notify anyone, make a link, autolink a URL or pass HTML", () => {
    const out = inert(hostile, 500);
    expect(out).not.toMatch(/@[A-Za-z0-9_-]/);
    expect(out).not.toMatch(/(?<!\\)\]\(/); // an escaped bracket is not a link
    expect(out).not.toContain("<img");
    expect(out).not.toContain("https://");
    expect(out).toContain("everyone"); // still readable
  });

  it("is applied to every free-text line of the issue and of the pull request", () => {
    const issue = issueText(issueRequest({ reason: hostile, suspectedCause: hostile })).body;
    const pr = pullRequestText(request({ rootCause: hostile, risk: hostile, review: { verdict: "approve", attacks: [{ attack: hostile, outcome: "held", detail: hostile }] } })).body;
    for (const [name, body] of [["issue", issue], ["pull request", pr]] as const) {
      expect(body, name).not.toMatch(/@[A-Za-z0-9_-]/);
      expect(body, name).not.toMatch(/(?<!\\)\[the fix\]/); // the one link here is the one the issue builds itself
      expect(body, name).not.toContain("<img");
      expect(body, name).not.toContain("https://evil.example");
    }
  });

  it("redacts a credential before it changes any character a pattern needs", () => {
    expect(inert(`token ${SEEDED_SECRETS.github} and ${SEEDED_SECRETS.slackHook}`, 500)).not.toMatch(/ghp_|hooks\.slack/);
  });
});

describe("issueText", () => {
  it("says what is failing, the evidence, what Starfish will do, and links back, and carries the cycle marker", () => {
    const { title, body } = issueText(issueRequest());
    expect(title).toBe("[Starfish] orders-createOrder: DatabaseError");
    expect(body).toContain("`orders-createOrder` (service `orders`) is failing with `DatabaseError`, 42 times so far.");
    expect(body).toContain("Fingerprint: `ab12cd34ef56`");
    expect(body).toContain("42 error entries for this function over 24h");
    expect(body).toContain("Suspected cause: createOrder writes undefined");
    expect(body).toContain("open a pull request that references this issue");
    expect(body).toContain("does not merge or deploy");
    expect(body).toContain("[The incident in Starfish](https://starfish.example/incidents/inc1)");
    expect(body).toContain("[The run](https://starfish.example/runs?run=inc1_r0)");
    expect(body).toContain("<!-- starfish-cycle:inc1_r0 -->");
  });

  it("says no patch will be drafted for an incident no code change fixes", () => {
    const { body } = issueText(issueRequest({ path: "notify" }));
    expect(body).toContain("no patch will be drafted");
    expect(body).not.toContain("open a pull request");
  });

  it("for a missing index, says no model writes the fix, names the gates, and leaves resolving to a person", () => {
    const { body } = issueText(issueRequest({ path: "index" }));
    expect(body).toContain("No model writes this fix");
    expect(body).toContain("the database's index limit");
    expect(body).toContain("never deletes an index");
    expect(body).toContain("whether the incident is resolved is a person's decision");
    expect(body).not.toContain("Draft a minimal fix");
  });

    it("claims nothing it does not know: no count, no counter-check, no links without a UI origin", () => {
    const { body } = issueText(issueRequest({ occurrenceCount: null, counterCheck: null, fingerprint: null, suspectedCause: null, uiBaseUrl: "" }));
    expect(body).not.toMatch(/times so far/);
    expect(body).toContain("counter-check: not available");
    expect(body).not.toContain("Fingerprint");
    expect(body).not.toContain("## Links");
    expect(issueText(issueRequest({ counterCheck: { window: "24h", count: 200, capped: true } })).body).toContain("at least 200");
  });

  it("shows the newest request's trace and links every line it logged, from checked ids only", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const { body } = issueText(issueRequest({ uiBaseUrl: "", trace: { id, projectId: "app-proj", lastOccurredAt: "2026-10-12T10:00:00.000Z" } }));
    expect(body).toContain(`- Trace: \`${id}\``);
    const query = encodeURIComponent(`trace="projects/app-proj/traces/${id}"`);
    expect(body).toContain(
      `(https://console.cloud.google.com/logs/query;query=${query};cursorTimestamp=2026-10-12T10:00:00.000Z;duration=PT24H?project=app-proj)`
    );

    // No project, or one Google would not allow: the id, no link.
    for (const projectId of [undefined, "x", "App-Proj", "evil.example/x?y=", "a)b"]) {
      const text = issueText(issueRequest({ uiBaseUrl: "", trace: { id, ...(projectId !== undefined && { projectId }) } })).body;
      expect(text).toContain("- Trace:");
      expect(text).not.toContain("console.cloud.google.com");
    }
    // An id that is not one: neither.
    const bad = issueText(issueRequest({ uiBaseUrl: "", trace: { id: "](https://evil.example)", projectId: "app-proj" } })).body;
    expect(bad).not.toContain("Trace");
    expect(bad).not.toContain("evil.example");
  });

  it("redacts and bounds everything from the incident, and cannot add a link of its own", () => {
    const dirty = Object.values(SEEDED_SECRETS).join(" ");
    const { title, body } = issueText(issueRequest({ functionName: dirty, service: dirty, errorType: dirty, reason: dirty + "\n```\n[click](https://evil.example)", suspectedCause: dirty, incidentId: "a/../b" }));
    for (const [name, secret] of Object.entries(SEEDED_SECRETS)) {
      const probe = secret.split("\n")[0]!;
      expect(title, name).not.toContain(probe);
      expect(body, name).not.toContain(probe);
    }
    expect(body.length).toBeLessThanOrEqual(12_000);
    // the incident id is not a plain id, so no link to it is built
    expect(body).not.toContain("/incidents/");
  });
});

// #140: model text saying "fixes #1" must not close issue 1 when a person merges the pull request.
const CLOSER = "fixes #1, closes acme/shop#2 and resolves GH-3; see https://github.com/acme/shop/issues/4";
const CLOSING_RE = /\b(close|fix|resolve)[sd]?\s*:?\s+(#\d|[\w.-]+\/[\w.-]+#\d|gh-\d|https?:\/\/)/gi;
const ANY_REF_RE = /#\d|[\w.-]+\/[\w.-]+#\d|\bgh-\d/gi;

describe("issue references in model text (#140)", () => {
  it("leave no closing keyword in the pull request but the one Starfish writes, and no reference in its title", () => {
    const { title, body } = pullRequestText(
      request({
        issueNumber: 9,
        rootCause: CLOSER,
        risk: CLOSER,
        verify: { status: CLOSER as never, rule: CLOSER as never, changedFiles: [], output: "" },
        review: { verdict: CLOSER as never, attacks: [{ attack: CLOSER, outcome: CLOSER as never, detail: CLOSER }] },
      })
    );
    expect(body.match(CLOSING_RE)).toEqual(["Closes #9"]);
    expect(body.match(ANY_REF_RE)).toEqual(["#9", "#9"]); // "- Issue: #9" and "Closes #9"
    expect(body.trimEnd().endsWith("Closes #9")).toBe(true);
    expect(title.match(ANY_REF_RE)).toBeNull();
    expect(title).not.toContain("://");
    expect(body).toContain("fixes #\u200b1"); // still readable
  });

  it("leave none in the commit message a squash merge keeps", async () => {
    await opener()(request({ rootCause: CLOSER }));
    const message = git(bare, "log", "-1", "--format=%B", "refs/heads/starfish/inc1_r0");
    expect(message.match(ANY_REF_RE)).toBeNull();
    expect(message.match(CLOSING_RE)).toBeNull();
    expect(message).toMatch(/^Starfish: fixes #\u200b1/);
  });

  it("leave none in the issue's title or body", () => {
    const { title, body } = issueText(issueRequest({ functionName: CLOSER, errorType: "GH-5", reason: CLOSER, suspectedCause: CLOSER }));
    expect(title.match(ANY_REF_RE)).toBeNull();
    // Code spans are not parsed for references; everything outside them is checked.
    expect(body.replace(/`[^`]*`/g, "").match(ANY_REF_RE)).toBeNull();
    expect(body.replace(/`[^`]*`/g, "").match(CLOSING_RE)).toBeNull();
  });
});

// #327: a real title read "Starfish: The `address` object can be undefined for pickup orders, causing a Typ".
describe("titles cut at a word, not mid-word (#327)", () => {
  const LONG = "The `address` object can be undefined for pickup orders, causing a TypeError when the courier view renders";

  it("cuts a root cause over 70 characters at the last word boundary and ends it with an ellipsis", () => {
    const { title } = pullRequestText(request({ rootCause: LONG }));
    expect(title).toBe("Starfish: The `address` object can be undefined for pickup orders, causing a…");
    expect(title.length - "Starfish: ".length).toBeLessThanOrEqual(70);
  });

  it("keeps a title that fits exactly, with no ellipsis", () => {
    const exact = "x".repeat(40) + " " + "y".repeat(29); // 70 characters
    expect(titleLine(exact, 70)).toBe(exact);
    expect(titleLine(exact + "z", 70)).toBe("x".repeat(40) + "…");
  });

  it("falls back to a hard cut plus an ellipsis when there is no word boundary to cut at", () => {
    const token = "a".repeat(200);
    expect(titleLine(token, 70)).toBe("a".repeat(69) + "…");
    // A space only near the start is no boundary worth keeping a stub for.
    expect(titleLine("ab " + token, 70)).toBe(("ab " + token).slice(0, 69) + "…");
  });

  it("drops a separator left dangling before the ellipsis", () => {
    expect(titleLine("one two three, four five", 16)).toBe("one two three…");
  });

  it("never leaves a live reference near the cut, and stays within the budget", () => {
    for (let pad = 50; pad <= 75; pad++) {
      for (const ref of ["#1234", "acme/shop#99", "GH-77", "https://x.example/a"]) {
        const text = `${"w ".repeat(pad / 2)}${"v".repeat(pad % 2)} fixes ${ref} and more words after it`;
        const cut = titleLine(text, 70);
        expect(cut.length, text).toBeLessThanOrEqual(70);
        expect(cut.match(ANY_REF_RE), cut).toBeNull();
        expect(cut, cut).not.toContain("://");
      }
    }
    // Hard cut through a token holding a reference: still broken.
    for (let n = 60; n <= 70; n++) {
      const cut = titleLine(`${"a".repeat(n)}#123456789${"b".repeat(50)}`, 70);
      expect(cut.length).toBeLessThanOrEqual(70);
      expect(cut.match(ANY_REF_RE), cut).toBeNull();
    }
  });

  it("cuts the issue title's parts the same way", () => {
    const { title } = issueText(issueRequest({ functionName: "orders " + "createOrderWithAVeryLongName ".repeat(4), errorType: "Database Error From Somewhere Deep Inside" }));
    expect(title).toMatch(/^\[Starfish\] orders createOrderWithAVeryLongName( createOrderWithAVeryLongName)*…: Database Error From Somewhere Deep…$/);
  });
});

describe("pullRequestText: a body over the cap (#141)", () => {
  it("cuts the variable sections, never the evidence, the no-merge line or Closes, and leaves no fence open", () => {
    const { body } = pullRequestText(
      request({
        issueNumber: 9,
        rootCause: "&".repeat(1500),
        risk: "<".repeat(1000),
        verify: { status: "passed", rule: "command-passed", changedFiles: Array.from({ length: 60 }, (_, i) => `src/${"f".repeat(150)}${i}.ts`), output: "o\n".repeat(5000) },
        review: { verdict: "approve", attacks: Array.from({ length: 30 }, () => ({ attack: "&".repeat(200), outcome: "held", detail: "&".repeat(300) })) },
      })
    );
    expect(body.length).toBeLessThanOrEqual(12_000);
    expect(body).toContain("cut to fit");
    expect(body).toContain(`- Patch SHA-256: \`${request().patchSha256}\``);
    expect(body).toContain(`- Base revision: \``);
    expect(body).toContain("It does not merge or deploy: a person decides.");
    expect(body.trimEnd().endsWith("Closes #9")).toBe(true);
    expect(body.split("\n").filter((l) => l === "```").length % 2).toBe(0);
  });

  it("closes a fence the cut leaves open, so the footer is not swallowed into a code block", () => {
    const { body } = pullRequestText(
      // About 10.5k of head before the output's fence opens; the output (3000) does not fit after it.
      request({ issueNumber: 9, rootCause: "&".repeat(1500), risk: "&".repeat(600), verify: { status: "passed", rule: "command-passed", changedFiles: [], output: "o".repeat(3000) } })
    );
    expect(body.length).toBeLessThanOrEqual(12_000);
    const lines = body.split("\n");
    const fences = lines.map((l, i) => (l === "```" ? i : -1)).filter((i) => i >= 0);
    expect(fences).toHaveLength(2);
    expect(fences[1]!).toBe(fences[0]! + 1); // nothing of the output fitted: an empty, closed block
    expect(lines[fences[1]! + 2]).toContain("cut to fit"); // the fence we closed sits right before the note
    expect(lines.indexOf("## Evidence")).toBeGreaterThan(fences[1]!);
    expect(body.trimEnd().endsWith("Closes #9")).toBe(true);
  });

  it("is unchanged when it fits", () => {
    expect(pullRequestText(request({ issueNumber: 9 })).body).not.toContain("cut to fit");
  });
});

describe("pullRequestText: the issue", () => {
  it("references the issue and closes it when there is one, and says nothing when there is not", () => {
    expect(pullRequestText(request({ issueNumber: 9 })).body).toMatch(/- Issue: #9[\s\S]*Closes #9/);
    expect(pullRequestText(request()).body).not.toMatch(/Closes|Issue: #/);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(pullRequestText(request({ issueNumber: bad })).body, String(bad)).not.toContain("Closes");
  });
});

describe("createGithubClient: the incident's issue", () => {
  it("files one issue, with the starfish label, and touches nothing else", async () => {
    api.issues = () => ({ status: 200, json: [] });
    api.issueCreate = () => ({ status: 201, json: ISSUE });
    const before = branches();
    const r = await client().openIssue(issueRequest());
    expect(r).toEqual({ number: 9, url: ISSUE.html_url });
    expect(requests.map((q) => `${q.method} ${q.path.split("?")[0]}`)).toEqual([`GET /repos/${REPO}`, `GET /repos/${REPO}/issues`, `POST /repos/${REPO}/issues`]);
    const create = requests.at(-1)!.body as { title: string; body: string; labels: string[] };
    expect(create.labels).toEqual([ISSUE_LABEL]);
    expect(create.body).toContain("<!-- starfish-cycle:inc1_r0 -->");
    expect(branches()).toEqual(before); // no branch, no commit
  });

  it("lists the repository's issues, newest first, bounded, by label (not the lagging search index)", async () => {
    api.issues = () => ({ status: 200, json: [] });
    api.issueCreate = () => ({ status: 201, json: ISSUE });
    await client().openIssue(issueRequest());
    const list = requests.find((q) => q.method === "GET" && q.path.startsWith(`/repos/${REPO}/issues`))!;
    expect(list.path).toContain("labels=starfish");
    expect(list.path).toContain("state=all");
    expect(list.path).toContain("per_page=100");
    expect(requests.some((q) => q.path.startsWith("/search"))).toBe(false);
  });

  it("returns the issue this cycle already filed instead of filing another (a retry after a crash or a timeout)", async () => {
    api.issues = () => ({ status: 200, json: [{ number: 3, html_url: `https://github.com/${REPO}/issues/3`, body: `earlier text\n\n${issueText(issueRequest()).body}` }] });
    api.issueCreate = () => ({ status: 201, json: ISSUE });
    const r = await client().openIssue(issueRequest());
    expect(r).toEqual({ number: 3, url: `https://github.com/${REPO}/issues/3` });
    expect(requests.some((q) => q.method === "POST")).toBe(false);
  });

  it("does not mistake another cycle's issue, or a pull request carrying the marker, for this one's", async () => {
    api.issues = () => ({
      status: 200,
      json: [
        { number: 4, html_url: "https://github.com/acme/shop/issues/4", body: "<!-- starfish-cycle:inc1_r1 -->" },
        { number: 5, html_url: "https://github.com/acme/shop/pull/5", body: "<!-- starfish-cycle:inc1_r0 -->", pull_request: {} },
        { number: 6, html_url: "https://github.com/acme/shop/issues/6", body: null },
      ],
    });
    api.issueCreate = () => ({ status: 201, json: ISSUE });
    expect((await client().openIssue(issueRequest())).number).toBe(9);
    expect(requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("refuses a cycle id that is not a plain id, and a different or archived repository, before writing", async () => {
    api.issues = () => ({ status: 200, json: [] });
    api.issueCreate = () => ({ status: 201, json: ISSUE });
    await expect(client().openIssue(issueRequest({ cycleId: "a b" }))).rejects.toMatchObject({ rule: "invalid-request" });
    api.repo = () => ({ status: 200, json: { full_name: "evil/other", archived: false } });
    await expect(client().openIssue(issueRequest())).rejects.toMatchObject({ rule: "wrong-repository" });
    api.repo = () => ({ status: 200, json: { full_name: REPO, archived: true } });
    await expect(client().openIssue(issueRequest())).rejects.toMatchObject({ rule: "wrong-repository" });
    expect(requests.some((q) => q.method === "POST")).toBe(false);
  });

  it("reports what GitHub says as a rule, with the token scrubbed out of anything it echoes", async () => {
    api.issues = () => ({ status: 200, json: [] });
    api.issueCreate = () => ({ status: 403, json: { message: `Resource not accessible by personal access token ${TOKEN}` } });
    const err = await client().openIssue(issueRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect((err as GithubError).rule).toBe("forbidden");
    expect((err as GithubError).message).not.toContain(TOKEN);
    api.issues = () => ({ status: 200, json: { not: "a list" } });
    await expect(client().openIssue(issueRequest())).rejects.toMatchObject({ rule: "unexpected-response" });
    api.issues = () => ({ status: 200, json: [] });
    api.issueCreate = () => ({ status: 201, json: { nothing: "useful" } });
    await expect(client().openIssue(issueRequest())).rejects.toMatchObject({ rule: "unexpected-response" });
  });
});

describe("createGithubClient: reading a pull request back (#17)", () => {
  const SHA = "a".repeat(40);
  const pull = (over: Record<string, unknown> = {}) => ({
    number: 7,
    state: "open",
    merged: false,
    merged_at: null,
    closed_at: null,
    head: { ref: "starfish/inc1_r0", sha: SHA, repo: { full_name: REPO } },
    base: { ref: "main", repo: { full_name: REPO } },
    ...over,
  });

  it("reads open, closed and merged, with the head commit, using GETs only", async () => {
    api.pull = () => ({ status: 200, json: pull() });
    expect(await client().readPullRequest("inc1_r0", 7)).toEqual({ number: 7, state: "open", mergedAt: null, closedAt: null, headSha: SHA });
    api.pull = () => ({ status: 200, json: pull({ state: "closed", closed_at: "2026-10-06T10:00:00Z" }) });
    expect(await client().readPullRequest("inc1_r0", 7)).toMatchObject({ state: "closed", closedAt: "2026-10-06T10:00:00.000Z", mergedAt: null });
    api.pull = () => ({ status: 200, json: pull({ state: "closed", merged: true, merged_at: "2026-10-06T11:00:00Z", closed_at: "2026-10-06T11:00:00Z" }) });
    expect(await client().readPullRequest("inc1_r0", 7)).toMatchObject({ state: "merged", mergedAt: "2026-10-06T11:00:00.000Z" });
    expect(requests.every((r) => r.method === "GET" && r.path === `/repos/${REPO}/pulls/7`)).toBe(true);
  });

  it("refuses a pull request that is not this cycle's: another branch, a fork's branch, another repository", async () => {
    for (const bad of [
      pull({ head: { ref: "starfish/other_r0", sha: SHA, repo: { full_name: REPO } } }),
      pull({ head: { ref: "starfish/inc1_r0", sha: SHA, repo: { full_name: "evil/shop" } } }),
      pull({ base: { ref: "main", repo: { full_name: "evil/shop" } } }),
      pull({ number: 8 }),
      null,
    ]) {
      api.pull = () => ({ status: 200, json: bad });
      await expect(client().readPullRequest("inc1_r0", 7), JSON.stringify(bad)).rejects.toBeInstanceOf(GithubError);
    }
  });

  it("refuses a pull request retargeted to another base branch, or one that names none (#186)", async () => {
    for (const base of [{ ref: "production", repo: { full_name: REPO } }, { repo: { full_name: REPO } }]) {
      api.pull = () => ({ status: 200, json: pull({ base }) });
      await expect(client().readPullRequest("inc1_r0", 7)).rejects.toMatchObject({ rule: "wrong-base" });
    }
  });

  it("refuses an answer it cannot read, and a bad id or number before asking", async () => {
    for (const bad of [pull({ head: { ref: "starfish/inc1_r0", sha: "nope", repo: { full_name: REPO } } }), pull({ state: "weird" })]) {
      api.pull = () => ({ status: 200, json: bad });
      await expect(client().readPullRequest("inc1_r0", 7)).rejects.toMatchObject({ rule: "unexpected-response" });
    }
    requests = [];
    await expect(client().readPullRequest("../main", 7)).rejects.toMatchObject({ rule: "invalid-request" });
    await expect(client().readPullRequest("inc1_r0", 0)).rejects.toMatchObject({ rule: "invalid-request" });
    expect(requests).toHaveLength(0);
  });

  it("says what the API said: an expired token, a rate limit, a PR that is gone; never the token", async () => {
    const cases: Array<[Reply, string]> = [
      [{ status: 401, json: { message: `Bad credentials ${TOKEN}` } }, "unauthorized"],
      [{ status: 403, json: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } }, "rate-limited"],
      [{ status: 404, json: { message: "Not Found" } }, "not-found"],
    ];
    for (const [reply, rule] of cases) {
      api.pull = () => reply;
      const err = (await client().readPullRequest("inc1_r0", 7).catch((e: unknown) => e)) as GithubError;
      expect(err.rule).toBe(rule);
      expect(err.message).not.toContain(TOKEN);
    }
  });
});

describe("pullRequestText: the missing-index evidence pull request (#11)", () => {
  const index = {
    project: "demo-app-1",
    database: "(default)",
    collectionGroup: "orders",
    queryScope: "COLLECTION",
    fields: [
      { fieldPath: "status", order: "ASCENDING" },
      { fieldPath: "createdAt", order: "DESCENDING" },
    ],
    created: true,
    operation: "projects/demo-app-1/databases/(default)/operations/op1",
    indexFile: "firestore.indexes.json",
    fileCreated: false,
    readyAt: "2026-10-06T12:00:00.000Z",
  };

  it("is a fixed template: what is already true, the index, what a deploy does, and no verify or review section", () => {
    const { title, body } = pullRequestText(request({ index, verify: undefined, review: undefined, rootCause: indexRootCause(index) }));
    expect(title).toBe("Starfish: add the missing Firestore index on orders (status asc, createdAt desc)");
    expect(body).toContain("Starfish created that one index in `demo-app-1` / `(default)` with a single Admin API call");
    expect(body).toContain("- Fields: `status` ASCENDING, `createdAt` DESCENDING");
    expect(body).toContain("adds the same entry to `firestore.indexes.json`");
    expect(body).toContain("Starfish does not estimate the amount");
    expect(body).toContain("reverting this pull request does not remove the index");
    expect(body).toContain("- Create operation: `projects/demo-app-1/databases/(default)/operations/op1`");
    expect(body).toContain("It does not merge or deploy: a person decides.");
    expect(body).not.toContain("## Verify gate");
    expect(body).not.toContain("## Adversarial review");
  });

  it("says when the index was found rather than created, and when the file is new", () => {
    const { body } = pullRequestText(request({ index: { ...index, created: false, fileCreated: true }, verify: undefined }));
    expect(body).toContain("this cycle has no recorded create operation for it");
    expect(body).toContain("This pull request creates `firestore.indexes.json`");
  });

  it("links the incident's issue but never closes it: whether the heal held is a person's call", () => {
    const { body } = pullRequestText(request({ index, issueNumber: 12, verify: undefined, review: undefined }));
    expect(body).toContain("- Issue: #12");
    expect(body).not.toMatch(/(close[sd]?|fix(e[sd])?|resolve[sd]?) #12/i);
  });

    it("a code fix without a verify result says so instead of inventing one", () => {
    expect(pullRequestText(request({ verify: undefined })).body).toContain("## Verify gate\n\nNot run.");
  });
});
