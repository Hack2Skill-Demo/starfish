/**
 * The pull-request step (#17): turn a verified, reviewed patch into ONE pull request in ONE repository,
 * and stop there. It never merges, never deploys, never pushes to the base branch.
 *
 *   check the target -> reconcile (is there already a PR for this cycle?) -> build the commit in a scratch
 *   clone -> push `starfish/<cycleId>` -> create the PR
 *
 * IDEMPOTENT BY CYCLE ID, because the loop (loop.ts) calls this again after a timeout, a crash or a
 * takeover, and a second pull request for one cycle is exactly what must not happen:
 *   - the branch is named for the cycle, and a pull request for that branch (open, closed or merged)
 *     is returned as it is, never replaced;
 *   - a branch left by a call that crashed before opening the PR is reused when its tree and parent are
 *     what this patch produces (the remote success is reconciled, not repeated), and refused when they
 *     are not (somebody else wrote it);
 *   - a "pull request already exists" refusal from the API (a racing worker) is answered with that PR.
 *
 * BOUNDED. The only ref ever pushed to is `refs/heads/starfish/<cycleId>`, checked in code immediately
 * before the push and never forced. That is the engine's half of "Starfish writes only its own
 * branches": a GitHub App's permission cannot be scoped to a branch prefix, so the guarantee that a
 * bug here cannot write elsewhere has to be branch protection or a ruleset on the repository. This
 * file is a convention backed by that, not a substitute for it.
 *
 * The patch must be the one that was verified: its SHA-256 is recomputed and compared. Everything
 * written into the pull request text is redacted and bounded; the patch itself is a diff of the
 * repository's own files and goes only to a pull request in it.
 *
 * Secrets: the token is passed to git in the environment, never in a command line (argv shows in `ps`)
 * and never written into .git/config; every error is scrubbed of it before it leaves this file. A
 * child git gets only PATH and HOME besides that.
 *
 * Not built here: filing an issue for the incident, Slack, reconciling a later merge or CI result, and
 * the link back to the UI. Not run by any job yet.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StarfishConfig } from "../config.js";
import type { PullRequestRequest } from "../agent/loop.js";
import { redactPii } from "../ingest/redact.js";

export type GithubPrConfig = Pick<
  StarfishConfig,
  "githubRepo" | "githubBaseBranch" | "githubApiUrl" | "githubRemoteUrl" | "githubCommitName" | "githubCommitEmail"
>;

/** Why the pull request could not be opened, as a rule a person (or the run record) can read. */
export type GithubRule =
  | "invalid-request"
  | "patch-hash-mismatch"
  | "wrong-repository"
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "not-found"
  | "server-error"
  | "base-revision-unavailable"
  | "patch-does-not-apply"
  | "branch-conflict"
  | "git-failed"
  | "unexpected-response";

/** Thrown for anything that stopped the pull request. Never carries the token. */
export class GithubError extends Error {
  constructor(
    readonly rule: GithubRule,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "GithubError";
  }
}

export interface PullRequestResult {
  number: number;
  url: string;
}

/** Runs one git command. Injected in tests to watch what is run; the default is `execFile`, never a shell. */
export type RunGit = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<string>;

export interface GithubPrDeps {
  token: string;
  /** What a child git may inherit: `loadChildProcessBasics()` from config.ts. */
  env: { PATH?: string; HOME?: string };
  fetch?: typeof fetch;
  runGit?: RunGit;
  /** Where scratch clones live. Defaults to the OS temp directory. */
  tmpDir?: string;
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const CYCLE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BRANCH_PREFIX = "starfish/";
const GIT_TIMEOUT_MS = 120_000;
const MAX_BODY = 12_000;
const MAX_OUTPUT_IN_BODY = 3_000;
const MAX_ATTACKS_IN_BODY = 20;
const MAX_FILES_IN_BODY = 50;

export const defaultRunGit: RunGit = (args, { cwd, env }) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).slice(0, 500)}`));
      else resolve(stdout);
    });
  });

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** True for an `https://` API, or plain `http://` to this machine (a test double). Nothing else may carry a token. */
function apiUrlOk(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

/** What a child git gets with no credential: PATH and HOME, and git told never to prompt or read other config. */
export function gitBaseEnv(basics: { PATH?: string; HOME?: string }): NodeJS.ProcessEnv {
  return {
    ...(basics.PATH !== undefined && { PATH: basics.PATH }),
    ...(basics.HOME !== undefined && { HOME: basics.HOME }),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

/** The environment that gives git its credential: an extra header for an https remote, nothing for any other. */
export function gitAuthEnv(remoteUrl: string, token: string, basics: { PATH?: string; HOME?: string }): NodeJS.ProcessEnv {
  const base = gitBaseEnv(basics);
  if (!remoteUrl.startsWith("https://")) return base;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

/** The branch Starfish uses for a cycle, or null if the id is not a plain id (it would become part of a ref). */
export function branchFor(cycleId: string): string | null {
  return CYCLE_RE.test(cycleId) ? `${BRANCH_PREFIX}${cycleId}` : null;
}

/**
 * The one refspec anything is pushed with: `HEAD` to `refs/heads/starfish/<id>`. Never the base branch, never
 * another prefix, never forced (no `+`), never a path out of the prefix. Checked here, at the point of use,
 * so a future change to how the branch is named cannot widen what is written.
 */
export function pushRefspec(branch: string): string {
  const id = branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : null;
  if (id === null || !CYCLE_RE.test(id)) throw new GithubError("invalid-request", "Refused to push to a ref outside starfish/*.");
  return `HEAD:refs/heads/${BRANCH_PREFIX}${id}`;
}

const fence = (text: string) => text.replace(/`{3,}/g, "``");
const clip = (text: string, max: number) => redactPii(String(text ?? "")).slice(0, max);
const oneLine = (text: string, max: number) => clip(text, max).replace(/\s+/g, " ").trim();
const code = (text: string, max: number) => oneLine(text, max).replace(/`/g, "");

/** The pull request's title and body. Redacted and bounded; fenced text cannot close its own fence. */
export function pullRequestText(req: PullRequestRequest): { title: string; body: string } {
  const title = `Starfish: ${oneLine(req.rootCause, 70) || "proposed fix"}`;
  const lines: string[] = [
    "## What",
    "",
    clip(req.rootCause, 1500),
    "",
    "## Risk",
    "",
    clip(req.risk, 1000) || "None stated.",
    "",
    "## Verify gate",
    "",
    `Result: **${oneLine(req.verify.status, 40)}** (${oneLine(req.verify.rule, 80)}).`,
  ];
  if (req.verify.changedFiles.length > 0) {
    lines.push("", "Files changed:", "");
    for (const f of req.verify.changedFiles.slice(0, MAX_FILES_IN_BODY)) lines.push(`- \`${code(f, 200)}\``);
    if (req.verify.changedFiles.length > MAX_FILES_IN_BODY) lines.push(`- … and ${req.verify.changedFiles.length - MAX_FILES_IN_BODY} more`);
  }
  if (req.verify.output.trim() !== "") {
    lines.push("", "Output (tail):", "", "```", fence(clip(req.verify.output.slice(-MAX_OUTPUT_IN_BODY), MAX_OUTPUT_IN_BODY)), "```");
  }
  lines.push("", "## Adversarial review", "");
  if (req.review) {
    lines.push(`Verdict: **${oneLine(req.review.verdict, 40)}**.`, "");
    for (const a of req.review.attacks.slice(0, MAX_ATTACKS_IN_BODY)) {
      lines.push(`- **${oneLine(a.outcome, 20)}**: ${oneLine(a.attack, 200)}: ${oneLine(a.detail, 300)}`);
    }
    if (req.review.attacks.length > MAX_ATTACKS_IN_BODY) lines.push(`- … and ${req.review.attacks.length - MAX_ATTACKS_IN_BODY} more`);
  } else {
    lines.push("No review was required for this change.");
  }
  lines.push(
    "",
    "## Evidence",
    "",
    `- Incident: \`${code(req.incidentId, 128)}\``,
    `- Run: \`${code(req.cycleId, 128)}\``,
    `- Base revision: \`${code(req.baseRevision, 40)}\``,
    `- Patch SHA-256: \`${code(req.patchSha256, 64)}\``,
    "",
    "Opened by Starfish. It does not merge or deploy: a person decides.",
    ""
  );
  return { title, body: lines.join("\n").slice(0, MAX_BODY) };
}

/** Build the opener the agent loop is given. Throws at once for a configuration that could act on the wrong target. */
export function createPullRequestOpener(cfg: GithubPrConfig, deps: GithubPrDeps): (req: PullRequestRequest) => Promise<PullRequestResult> {
  if (!REPO_RE.test(cfg.githubRepo)) throw new GithubError("invalid-request", "githubRepo must be owner/name");
  if (!BRANCH_RE.test(cfg.githubBaseBranch) || cfg.githubBaseBranch.startsWith(BRANCH_PREFIX) || cfg.githubBaseBranch.includes("..")) {
    throw new GithubError("invalid-request", "githubBaseBranch is not a usable base branch");
  }
  if (!apiUrlOk(cfg.githubApiUrl)) throw new GithubError("invalid-request", "githubApiUrl must be https (or http to localhost)");
  if (deps.token.trim() === "") throw new GithubError("invalid-request", "a GitHub token is required");

  const doFetch = deps.fetch ?? fetch;
  const runGit = deps.runGit ?? defaultRunGit;
  const owner = cfg.githubRepo.split("/")[0]!;
  const api = cfg.githubApiUrl.replace(/\/+$/, "");
  const remote = cfg.githubRemoteUrl !== "" ? cfg.githubRemoteUrl : `https://github.com/${cfg.githubRepo}.git`;
  const basic = Buffer.from(`x-access-token:${deps.token}`).toString("base64");

  /** Anything about to leave this file: the token and its encodings removed, then the usual redaction. */
  const scrub = (text: string) => redactPii(text.split(deps.token).join("[token]").split(basic).join("[token]"));

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown; headers: Headers }> {
    let res: Response;
    try {
      res = await doFetch(`${api}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${deps.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "starfish",
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        redirect: "error",
      });
    } catch (err) {
      throw new GithubError("server-error", scrub(`GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}`));
    }
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json, headers: res.headers };
  }

  function failure(status: number, headers: Headers, json: unknown): GithubError {
    const message = scrub(String((json as { message?: unknown } | null)?.message ?? "no message").slice(0, 300));
    if (status === 401) return new GithubError("unauthorized", `GitHub refused the token (it may have expired): ${message}`, status);
    if (status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after") !== null))) {
      return new GithubError("rate-limited", `GitHub rate limit reached: ${message}`, status);
    }
    if (status === 403) return new GithubError("forbidden", `The token may not do this: ${message}`, status);
    if (status === 404) return new GithubError("not-found", `GitHub could not find the repository or the token cannot see it: ${message}`, status);
    if (status >= 500) return new GithubError("server-error", `GitHub failed (${status}): ${message}`, status);
    return new GithubError("unexpected-response", `GitHub answered ${status}: ${message}`, status);
  }

  const asPr = (json: unknown): PullRequestResult | null => {
    const j = json as { number?: unknown; html_url?: unknown } | null;
    return j && typeof j.number === "number" && typeof j.html_url === "string" ? { number: j.number, url: j.html_url } : null;
  };

  /** The pull request for this branch, in any state, or null. */
  async function findExisting(branch: string): Promise<PullRequestResult | null> {
    const q = `head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=5`;
    const r = await call("GET", `/repos/${cfg.githubRepo}/pulls?${q}`);
    if (r.status !== 200) throw failure(r.status, r.headers, r.json);
    if (!Array.isArray(r.json)) throw new GithubError("unexpected-response", "GitHub's list of pull requests was not a list");
    for (const item of r.json) {
      const pr = asPr(item);
      if (pr) return pr;
    }
    return null;
  }

  async function checkTarget(): Promise<void> {
    const r = await call("GET", `/repos/${cfg.githubRepo}`);
    if (r.status !== 200) throw failure(r.status, r.headers, r.json);
    const j = r.json as { full_name?: unknown; archived?: unknown } | null;
    if (typeof j?.full_name !== "string" || j.full_name.toLowerCase() !== cfg.githubRepo.toLowerCase()) {
      throw new GithubError("wrong-repository", "The API names a different repository than the one configured; nothing was done.");
    }
    if (j.archived === true) throw new GithubError("wrong-repository", "The configured repository is archived; nothing was done.");
  }

  async function buildAndPush(req: PullRequestRequest, branch: string): Promise<void> {
    const dir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), "starfish-pr-"));
    const env = {
      ...gitAuthEnv(remote, deps.token, deps.env),
      GIT_AUTHOR_NAME: cfg.githubCommitName,
      GIT_AUTHOR_EMAIL: cfg.githubCommitEmail,
      GIT_COMMITTER_NAME: cfg.githubCommitName,
      GIT_COMMITTER_EMAIL: cfg.githubCommitEmail,
    };
    const git = async (args: string[]) => {
      try {
        return await runGit(args, { cwd: dir, env });
      } catch (err) {
        throw new GithubError("git-failed", scrub(err instanceof Error ? err.message : String(err)));
      }
    };
    try {
      await git(["init", "--quiet"]);
      await git(["remote", "add", "origin", remote]);
      try {
        await git(["fetch", "--quiet", "--depth=1", "origin", req.baseRevision]);
      } catch {
        // A server that won't serve an arbitrary commit by id: fall back to the base branch's recent history.
        await git(["fetch", "--quiet", "--depth=200", "origin", `refs/heads/${cfg.githubBaseBranch}`]);
      }
      try {
        await git(["cat-file", "-e", `${req.baseRevision}^{commit}`]);
      } catch {
        throw new GithubError("base-revision-unavailable", "The base revision the patch was verified against could not be fetched from the repository.");
      }
      await git(["checkout", "--quiet", "--detach", req.baseRevision]);
      const baseCommit = (await git(["rev-parse", "HEAD"])).trim();

      // The patch lives outside the work tree, so it can never be part of the commit.
      const patchDir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), "starfish-patch-"));
      try {
        const patchFile = join(patchDir, "change.patch");
        await writeFile(patchFile, req.patch, "utf8");
        try {
          await git(["apply", "--index", "--whitespace=nowarn", patchFile]);
        } catch {
          throw new GithubError("patch-does-not-apply", "The verified patch does not apply to the base revision in the repository.");
        }
      } finally {
        await rm(patchDir, { recursive: true, force: true });
      }
      const tree = (await git(["write-tree"])).trim();

      // Reconcile a branch an earlier call left behind: reuse it only if it is exactly this change.
      const listing = (await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`])).trim();
      if (listing !== "") {
        await git(["fetch", "--quiet", "--depth=2", "origin", `refs/heads/${branch}`]);
        const remoteTree = (await git(["rev-parse", "FETCH_HEAD^{tree}"])).trim();
        const remoteParent = (await git(["rev-parse", "FETCH_HEAD^"]).catch(() => "")).trim();
        if (remoteTree === tree && remoteParent === baseCommit) return;
        throw new GithubError("branch-conflict", `The branch ${branch} already exists with different content; nothing was changed.`);
      }

      await git(["commit", "--quiet", "--no-gpg-sign", "-m", `Starfish: ${oneLine(req.rootCause, 70) || "proposed fix"}\n\nRun: ${code(req.cycleId, 128)}\nPatch SHA-256: ${req.patchSha256}`]);
      await git(["push", "--quiet", "origin", pushRefspec(branch)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return async function openPullRequest(req) {
    const branch = branchFor(req.cycleId);
    if (branch === null) throw new GithubError("invalid-request", "The cycle id is not a plain id, so it cannot name a branch.");
    if (!SHA_RE.test(req.baseRevision)) throw new GithubError("invalid-request", "The base revision is not a commit id.");
    if (!SHA256_RE.test(req.patchSha256) || sha256(req.patch) !== req.patchSha256) {
      throw new GithubError("patch-hash-mismatch", "The patch is not the one that was verified and reviewed; nothing was opened.");
    }

    await checkTarget();
    const existing = await findExisting(branch);
    if (existing) return existing;

    await buildAndPush(req, branch);

    const { title, body } = pullRequestText(req);
    const created = await call("POST", `/repos/${cfg.githubRepo}/pulls`, { title, head: branch, base: cfg.githubBaseBranch, body, maintainer_can_modify: false });
    if (created.status === 201) {
      const pr = asPr(created.json);
      if (!pr) throw new GithubError("unexpected-response", "GitHub created a pull request but did not say which.");
      return pr;
    }
    if (created.status === 422) {
      // Most likely a worker racing this one opened it first: the branch's pull request is the answer.
      const raced = await findExisting(branch);
      if (raced) return raced;
    }
    throw failure(created.status, created.headers, created.json);
  };
}
