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
 * The same client also serves the CI-backed verify step (#74, `STARFISH_VERIFY_ISOLATION=github-actions`): it pushes
 * the patch to that same branch BEFORE any pull request, so the target's own CI can judge it on a disposable runner,
 * lists the check runs on the pushed commit, and deletes the branch again when the patch did not pass. A pull request
 * opened later reuses the branch (it is exactly this change, so it is reconciled, not repeated). The branch is the only
 * thing written, and only under `starfish/`; that is still a push to the target repository, in a dry run too.
 *
 * The patch must be the one that was verified: its SHA-256 is recomputed and compared. Everything
 * written into the pull request text is redacted and bounded; the patch itself is a diff of the
 * repository's own files and goes only to a pull request in it.
 *
 * Secrets: the token is passed to git in the environment, never in a command line (argv shows in `ps`)
 * and never written into .git/config; every error is scrubbed of it before it leaves this file. A
 * child git gets only PATH and HOME besides that.
 *
 * It also files the incident's GITHUB ISSUE (#17), one per cycle Starfish acts on or escalates, found again by a marker in
 * its body so a retry after a crash or timeout reuses it instead of filing a second (`openIssue`, below).
 *
 * Not built here: reconciling a later merge or CI result. Its only caller is the agent job (`pnpm agent`), a dry run by default.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StarfishConfig } from "../config.js";
import type { PullRequestRequest } from "../agent/loop.js";
import { redactPii } from "../ingest/redact.js";
import { incidentUrl, runUrl } from "./links.js";

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

/** What the issue says about one incident. Built by the loop from stored, already-bounded fields. */
export interface IssueRequest {
  cycleId: string;
  incidentId: string;
  functionName: string;
  service: string;
  errorType: string;
  /** null when the stored incident has no count: the issue then says nothing about how often. */
  occurrenceCount: number | null;
  fingerprint: string | null;
  counterCheck: { window: string; count: number; capped: boolean } | null;
  /** `act`: Starfish will draft a fix. `notify`: no code change helps and a person is told. */
  path: "act" | "notify";
  /** Triage's one-line reason, and what it suspects. Redacted and cut here. */
  reason: string;
  suspectedCause: string | null;
  /** The operator UI's origin for links, or "". */
  uiBaseUrl: string;
}

/** The label every Starfish issue carries, so they can be listed together and reconciled by cycle. */
export const ISSUE_LABEL = "starfish";
const ISSUE_MARKER_PREFIX = "starfish-cycle:";
const MAX_ISSUE_SCAN = 100;

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

/**
 * The hosts the token may be sent to over git: github.com, and the host of the configured API (with its `api.` prefix
 * dropped, so `api.<x>.ghe.com` also allows `<x>.ghe.com`; a GitHub Enterprise Server serves both from one host).
 */
function gitHostsFor(apiUrl: string): Set<string> {
  const hosts = new Set(["github.com"]);
  try {
    const host = new URL(apiUrl).hostname.toLowerCase();
    hosts.add(host);
    if (host.startsWith("api.")) hosts.add(host.slice("api.".length));
  } catch {
    // An unparseable API URL adds nothing: github.com only.
  }
  return hosts;
}

/**
 * The environment that gives git its credential: an extra header for an https remote on GitHub (github.com, or the
 * configured API's host), nothing for any other. A remote elsewhere is a misconfiguration, and the token must not go
 * to it (#141). `apiUrl` defaults to github.com's API.
 */
export function gitAuthEnv(
  remoteUrl: string,
  token: string,
  basics: { PATH?: string; HOME?: string },
  apiUrl = "https://api.github.com"
): NodeJS.ProcessEnv {
  const base = gitBaseEnv(basics);
  let host: string;
  try {
    const u = new URL(remoteUrl);
    if (u.protocol !== "https:") return base;
    host = u.hostname.toLowerCase();
  } catch {
    return base;
  }
  if (!gitHostsFor(apiUrl).has(host)) return base;
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
/**
 * Break every issue reference GitHub would act on (#140): `#123`, `owner/repo#123` and `GH-123` each get a zero-width
 * space, so model text saying "fixes #1" can neither close issue 1 when the pull request (or its squashed commit)
 * lands, nor cross-reference it. A full issue URL is broken by `inert`'s `:` + zero-width space + `//`, and by `noUrl`
 * in plain text. Applied to model and incident text only: the `Closes #N` Starfish writes itself is left whole.
 */
const noRefs = (text: string) =>
  text
    .replace(/#(?=\d)/g, "#\u200b")
    .replace(/\b(GH)-(?=\d)/gi, "$1\u200b-");
const noUrl = (text: string) => text.replace(/:\/\//g, ":\u200b//");
/** One line of free text for a title or a commit message: plain text, so no markdown escaping, but no references. */
const plainLine = (text: string, max: number) => noUrl(noRefs(oneLine(text, max)));
const code = (text: string, max: number) => oneLine(text, max).replace(/`/g, "");
/**
 * Free text from an incident or the model, made inert in markdown: GitHub would otherwise notify whoever an `@name` or
 * `@org/team` names, render `[text](url)` as a link, autolink a bare URL and pass HTML through. The characters stay readable;
 * a zero-width space or a backslash is all that changes. An issue reference (`#1`, `o/r#1`, `GH-1`) is broken too, so it
 * cannot close or cross-reference an issue (#140). Used on every free-text line that is not inside a code span or fence.
 */
export const inert = (text: string, max: number): string =>
  noUrl(
    noRefs(
      clip(text, max)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/[[\]]/g, "\\$&")
        .replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b")
    )
  );
/** `inert`, on one line. */
const inertLine = (text: string, max: number): string => inert(text, max).replace(/\s+/g, " ").trim();

const CUT_NOTE = "_\u2026 cut to fit; the full record is in Starfish._";

/**
 * `head` then `footer`, at most MAX_BODY characters, cutting only the head (#141): the footer carries what must never be
 * lost (the evidence, the "does not merge" line, `Closes #N`, the cycle marker). The head is cut at a line, and a code
 * fence it leaves open is closed, so the footer is never swallowed into a code block.
 */
function fitBody(head: string[], footer: string[]): string {
  const tail = footer.join("\n");
  const whole = [...head, ...footer].join("\n");
  if (whole.length <= MAX_BODY) return whole;
  // Room for the head, the closing fence, the note and their newlines.
  const budget = MAX_BODY - tail.length - CUT_NOTE.length - "\n```\n\n\n".length;
  const kept: string[] = [];
  let used = 0;
  let inFence = false;
  for (const line of head) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
    if (line === "```") inFence = !inFence;
  }
  if (inFence) kept.push("```");
  return [...kept, "", CUT_NOTE, ...footer].join("\n").slice(0, MAX_BODY);
}

/** The pull request's title and body. Redacted and bounded; fenced text cannot close its own fence. */
export function pullRequestText(req: PullRequestRequest): { title: string; body: string } {
  const title = `Starfish: ${plainLine(req.rootCause, 70) || "proposed fix"}`;
  const lines: string[] = [
    "## What",
    "",
    inert(req.rootCause, 1500),
    "",
    "## Risk",
    "",
    inert(req.risk, 1000) || "None stated.",
    "",
    "## Verify gate",
    "",
    `Result: **${inertLine(req.verify.status, 40)}** (${inertLine(req.verify.rule, 80)}).`,
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
    lines.push(`Verdict: **${inertLine(req.review.verdict, 40)}**.`, "");
    for (const a of req.review.attacks.slice(0, MAX_ATTACKS_IN_BODY)) {
      lines.push(`- **${inertLine(a.outcome, 20)}**: ${inertLine(a.attack, 200)}: ${inertLine(a.detail, 300)}`);
    }
    if (req.review.attacks.length > MAX_ATTACKS_IN_BODY) lines.push(`- … and ${req.review.attacks.length - MAX_ATTACKS_IN_BODY} more`);
  } else {
    lines.push("No review was required for this change.");
  }
  const footer = [
    "",
    "## Evidence",
    "",
    ...(req.issueNumber !== undefined && Number.isInteger(req.issueNumber) && req.issueNumber > 0 ? [`- Issue: #${req.issueNumber}`] : []),
    `- Incident: \`${code(req.incidentId, 128)}\``,
    `- Run: \`${code(req.cycleId, 128)}\``,
    `- Base revision: \`${code(req.baseRevision, 40)}\``,
    `- Patch SHA-256: \`${code(req.patchSha256, 64)}\``,
    "",
    "Opened by Starfish. It does not merge or deploy: a person decides.",
    ...(req.issueNumber !== undefined && Number.isInteger(req.issueNumber) && req.issueNumber > 0 ? ["", `Closes #${req.issueNumber}`] : []),
    "",
  ];
  return { title, body: fitBody(lines, footer) };
}

/** The marker that finds an issue again by cycle. HTML comment: invisible on GitHub, not part of any text we redact. */
const issueMarker = (cycleId: string) => `<!-- ${ISSUE_MARKER_PREFIX}${cycleId} -->`;

/** The issue's title and body. Redacted and bounded; incident text cannot close a fence or add a link. */
export function issueText(req: IssueRequest): { title: string; body: string } {
  const title = `[Starfish] ${plainLine(req.functionName, 60) || "unknown function"}: ${plainLine(req.errorType, 40) || "error"}`;
  const lines: string[] = [
    "## What is failing",
    "",
    `\`${code(req.functionName, 120)}\` (service \`${code(req.service, 60)}\`) is failing with \`${code(req.errorType, 60)}\`${
      req.occurrenceCount === null ? "" : `, ${req.occurrenceCount} times so far`
    }.`,
    "",
    inert(req.reason, 1000) || "No reason recorded.",
    "",
    "## Evidence",
    "",
    ...(req.fingerprint ? [`- Fingerprint: \`${code(req.fingerprint, 64)}\``] : []),
    req.counterCheck
      ? `- Independent log counter-check: ${req.counterCheck.capped ? "at least " : ""}${req.counterCheck.count} error entries for this function over ${inertLine(req.counterCheck.window, 20)}.`
      : "- Independent log counter-check: not available.",
    ...(req.suspectedCause ? [`- Suspected cause: ${inertLine(req.suspectedCause, 400)}`] : []),
    "",
    "## What Starfish will do",
    "",
    req.path === "act"
      ? "Draft a minimal fix, check it with this repository's own tests, have it adversarially reviewed, and open a pull request that references this issue. Starfish does not merge or deploy: a person decides."
      : "Nothing in the code can fix this, so no patch will be drafted. A person is told, here and in Slack; the step they need to take is above.",
  ];
  const incident = incidentUrl(req.uiBaseUrl, req.incidentId);
  const run = runUrl(req.uiBaseUrl, req.cycleId);
  if (incident || run) {
    lines.push("", "## Links", "");
    if (incident) lines.push(`- [The incident in Starfish](${incident})`);
    if (run) lines.push(`- [The run](${run})`);
  }
  return { title, body: fitBody(lines, ["", `Run: \`${code(req.cycleId, 128)}\``, "", issueMarker(req.cycleId), ""]) };
}

/** Build the opener the agent loop is given. Throws at once for a configuration that could act on the wrong target. */
export function createPullRequestOpener(cfg: GithubPrConfig, deps: GithubPrDeps): (req: PullRequestRequest) => Promise<PullRequestResult> {
  return createGithubClient(cfg, deps).openPullRequest;
}

/** What the CI-backed verify step needs of a patch: enough to build the commit, nothing about review. */
export type PatchBranchRequest = Pick<PullRequestRequest, "cycleId" | "baseRevision" | "patch" | "patchSha256" | "rootCause">;

/** One check run on a commit, reduced to what a verdict needs. Text is redacted and bounded. */
export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  /** The run's own one-line title and summary, when it has any. */
  title: string;
  summary: string;
}

export interface CheckAnnotation {
  path: string;
  line: number;
  level: string;
  message: string;
}

export interface GithubClient {
  openPullRequest: (req: PullRequestRequest) => Promise<PullRequestResult>;
  /**
   * File the incident's issue, or return the one this cycle already filed (found by the marker in its body among the
   * newest issues carrying the `starfish` label, so a retry after a crash or a timeout does not file a second).
   * Writes only an issue and its label; it never touches a branch, a pull request or any file.
   */
  openIssue: (req: IssueRequest) => Promise<PullRequestResult>;
  /**
   * Push the patch as one commit on `starfish/<cycleId>` on top of the base revision and return that commit. A branch
   * this cycle left that is exactly this change is reused; one that differs is DELETED and rebuilt (the verify step
   * revises a patch within a cycle); a branch that already has a pull request is never touched.
   */
  pushPatchBranch: (req: PatchBranchRequest) => Promise<{ branch: string; commit: string }>;
  /** Delete the cycle's branch. Already gone is fine. Refuses anything outside `starfish/`. */
  deleteBranch: (cycleId: string) => Promise<void>;
  listCheckRuns: (commit: string) => Promise<CheckRun[]>;
  annotations: (checkRunId: number) => Promise<CheckAnnotation[]>;
}

export function createGithubClient(cfg: GithubPrConfig, deps: GithubPrDeps): GithubClient {
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

  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ status: number; json: unknown; headers: Headers }> {
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

  async function removeBranch(branch: string): Promise<void> {
    pushRefspec(branch); // refuses anything but starfish/<id>
    const r = await call("DELETE", `/repos/${cfg.githubRepo}/git/refs/heads/${branch}`);
    if (r.status === 204 || r.status === 404 || r.status === 422) return;
    throw failure(r.status, r.headers, r.json);
  }

  async function buildAndPush(req: PatchBranchRequest, branch: string, replace = false): Promise<string> {
    const dir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), "starfish-pr-"));
    const env = {
      ...gitAuthEnv(remote, deps.token, deps.env, cfg.githubApiUrl),
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
        if (remoteTree === tree && remoteParent === baseCommit) return (await git(["rev-parse", "FETCH_HEAD"])).trim();
        if (!replace) throw new GithubError("branch-conflict", `The branch ${branch} already exists with different content; nothing was changed.`);
        await removeBranch(branch);
      }

      await git(["commit", "--quiet", "--no-gpg-sign", "-m", `Starfish: ${plainLine(req.rootCause, 70) || "proposed fix"}\n\nRun: ${code(req.cycleId, 128)}\nPatch SHA-256: ${req.patchSha256}`]);
      await git(["push", "--quiet", "origin", pushRefspec(branch)]);
      return (await git(["rev-parse", "HEAD"])).trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The branch for the cycle, after the checks every write needs. */
  function checked(req: PatchBranchRequest): string {
    const branch = branchFor(req.cycleId);
    if (branch === null) throw new GithubError("invalid-request", "The cycle id is not a plain id, so it cannot name a branch.");
    if (!SHA_RE.test(req.baseRevision)) throw new GithubError("invalid-request", "The base revision is not a commit id.");
    if (!SHA256_RE.test(req.patchSha256) || sha256(req.patch) !== req.patchSha256) {
      throw new GithubError("patch-hash-mismatch", "The patch is not the one that was verified and reviewed; nothing was opened.");
    }
    return branch;
  }

  const MAX_CHECKS = 100;
  const MAX_ANNOTATIONS = 20;
  const bounded = (v: unknown, max: number) => scrub(typeof v === "string" ? v.slice(0, max) : "");

  async function pushPatchBranch(req: PatchBranchRequest): Promise<{ branch: string; commit: string }> {
    const branch = checked(req);
    await checkTarget();
    if (await findExisting(branch)) throw new GithubError("branch-conflict", `A pull request already exists for ${branch}; its branch is not rebuilt.`);
    return { branch, commit: await buildAndPush(req, branch, true) };
  }

  async function deleteBranch(cycleId: string): Promise<void> {
    const branch = branchFor(cycleId);
    if (branch === null) throw new GithubError("invalid-request", "The cycle id is not a plain id, so it cannot name a branch.");
    await removeBranch(branch);
  }

  async function listCheckRuns(commit: string): Promise<CheckRun[]> {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new GithubError("invalid-request", "A check run is looked up by a full commit id.");
    const r = await call("GET", `/repos/${cfg.githubRepo}/commits/${commit}/check-runs?per_page=${MAX_CHECKS}`);
    if (r.status !== 200) throw failure(r.status, r.headers, r.json);
    const runs = (r.json as { check_runs?: unknown } | null)?.check_runs;
    if (!Array.isArray(runs)) throw new GithubError("unexpected-response", "GitHub's list of check runs was not a list");
    const out: CheckRun[] = [];
    for (const item of runs.slice(0, MAX_CHECKS)) {
      const c = item as { id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown; output?: { title?: unknown; summary?: unknown } | null };
      if (typeof c.id !== "number" || typeof c.name !== "string" || typeof c.status !== "string") continue;
      out.push({
        id: c.id,
        name: bounded(c.name, 200),
        status: c.status,
        conclusion: typeof c.conclusion === "string" ? c.conclusion : null,
        url: typeof c.html_url === "string" ? c.html_url.slice(0, 300) : "",
        title: bounded(c.output?.title, 200),
        summary: bounded(c.output?.summary, 400),
      });
    }
    return out;
  }

  async function annotations(checkRunId: number): Promise<CheckAnnotation[]> {
    if (!Number.isInteger(checkRunId) || checkRunId < 1) throw new GithubError("invalid-request", "A check run id is a positive integer.");
    const r = await call("GET", `/repos/${cfg.githubRepo}/check-runs/${checkRunId}/annotations?per_page=${MAX_ANNOTATIONS}`);
    if (r.status !== 200) throw failure(r.status, r.headers, r.json);
    if (!Array.isArray(r.json)) return [];
    return r.json.slice(0, MAX_ANNOTATIONS).map((a: { path?: unknown; start_line?: unknown; annotation_level?: unknown; message?: unknown }) => ({
      path: bounded(a.path, 200),
      line: typeof a.start_line === "number" ? a.start_line : 0,
      level: bounded(a.annotation_level, 20),
      message: bounded(a.message, 400),
    }));
  }

  async function openPullRequest(req: PullRequestRequest): Promise<PullRequestResult> {
    const branch = checked(req);

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
  }

  async function openIssue(req: IssueRequest): Promise<PullRequestResult> {
    if (!CYCLE_RE.test(req.cycleId)) throw new GithubError("invalid-request", "The cycle id is not a plain id, so it cannot name an issue.");
    await checkTarget();
    const marker = issueMarker(req.cycleId);

    // Reconcile first: the repository's own issue list (not the search index, which lags) holds what an earlier call filed.
    const found = await call("GET", `/repos/${cfg.githubRepo}/issues?labels=${ISSUE_LABEL}&state=all&sort=created&direction=desc&per_page=${MAX_ISSUE_SCAN}`);
    if (found.status !== 200) throw failure(found.status, found.headers, found.json);
    if (!Array.isArray(found.json)) throw new GithubError("unexpected-response", "GitHub's list of issues was not a list");
    for (const item of found.json) {
      const i = item as { body?: unknown; pull_request?: unknown };
      if (i.pull_request === undefined && typeof i.body === "string" && i.body.includes(marker)) {
        const existing = asPr(item);
        if (existing) return existing;
      }
    }

    const { title, body } = issueText(req);
    const created = await call("POST", `/repos/${cfg.githubRepo}/issues`, { title, body, labels: [ISSUE_LABEL] });
    if (created.status !== 201) throw failure(created.status, created.headers, created.json);
    const issue = asPr(created.json);
    if (!issue) throw new GithubError("unexpected-response", "GitHub created an issue but did not say which.");
    return issue;
  }

  return { openPullRequest, openIssue, pushPatchBranch, deleteBranch, listCheckRuns, annotations };
}
