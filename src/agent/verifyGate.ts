/**
 * The verify gate (#8, stage 3): the deterministic judge between a proposed patch and a pull
 * request. The model proposes; this disposes. Nothing here is an LLM.
 *
 * What it does with a patch and a checkout of the target repo:
 *   1. refuses outright what it can see without applying: no command configured, an empty,
 *      oversized, NUL-bearing or binary patch;
 *   2. copies the checkout to a scratch directory WITHOUT `.git` and `node_modules` (so the run
 *      can read no history and no reference fix) and applies the patch there with `git apply`,
 *      which itself refuses paths outside the directory and writes through symlinks;
 *   3. compares the scratch tree before and after, and judges what actually changed rather than
 *      what the diff claims to change. A path the patch's headers spell one way and git resolves
 *      another is still caught, because the check is on files, not on text. It rejects a change
 *      to an excluded path (`patchExcludedPaths`: CI, secrets, the package manifest and lockfiles and
 *      common test, type-check and lint configs by default, plus what the deployment lists; a file that
 *      defines the tests and is on neither list is NOT protected), a new or changed symlink, a changed
 *      file mode, and a patch that touches too many files;
 *   4. only then runs the configured command, with a scrubbed environment, a timeout and bounded,
 *      redacted output. Exit 0 is the only pass. The wait ends when the command exits or times out, even
 *      if something it started outside its process group still holds the output open; that process is
 *      left running.
 * The result carries the SHA-256 of the exact patch and the revision it was based on, so evidence
 * ("the tests passed") can never be shown for a patch other than the one that was tested.
 *
 * THIS IS NOT A SANDBOX. The command is the deployment's own and runs as this process's OS user,
 * with the machine's network and filesystem. The scrubbed environment keeps this process's
 * credentials out of it; it does nothing about code the patch adds that the command then runs. The
 * issue (#8) asks for a disposable runner with no production credentials, no cloud metadata access
 * and bounded network, CPU and memory. That is infrastructure, it is not built, and until it is this
 * gate must only run on a machine that holds nothing worth stealing. Needs a POSIX shell and git.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVerifyCommandBasics, type StarfishConfig } from "../config.js";
import { redactPii, redactTail } from "../ingest/redact.js";

export type VerifyConfig = Pick<StarfishConfig, "verifyCommand" | "verifyTimeoutSeconds" | "patchExcludedPaths">;

export type VerifyStatus = "passed" | "failed" | "timeout" | "rejected";

export type VerifyRule =
  | "no-verify-command"
  | "empty-patch"
  | "patch-too-large"
  | "patch-not-text"
  | "patch-does-not-apply"
  | "too-many-files"
  | "excluded-path"
  | "symlink"
  | "file-mode"
  | "tree-too-large"
  | "command-passed"
  | "command-failed"
  | "command-timeout"
  | "setup-failed";

export interface VerifyResult {
  status: VerifyStatus;
  rule: VerifyRule;
  /** One sentence for people. Never holds patch or log text. */
  reason: string;
  /** Hash of the exact patch that was judged. Evidence belongs to this patch and no other. */
  patchSha256: string;
  /** The revision of the target the patch was based on, as the caller named it. */
  baseRevision?: string;
  /** Repo-relative paths the patch really changed, found by comparing trees. */
  changedFiles: string[];
  exitCode?: number | null;
  /** The tail of the command's output: redacted and bounded. */
  output: string;
  durationMs: number;
}

export interface VerifyRequest {
  /** The cycle this patch belongs to. Only the CI-backed verifier needs it (it names the branch). */
  cycleId?: string;
  /** A checkout of the target repo at the pinned revision. Never modified. */
  sourceDir: string;
  /** A unified diff against that checkout. */
  patch: string;
  baseRevision?: string;
  config: VerifyConfig;
  /**
   * Extra variables to give the command, by value. The caller reads them through config.ts, the only reader of the
   * environment; nothing else from this process's environment reaches the command but PATH and LANG.
   */
  extraEnv?: Readonly<Record<string, string>>;
  /**
   * Run the verify command as this unprivileged user instead of this process's own. Used by the verify
   * runner (verifyRunner.ts), which starts as root: the command then cannot read the runner's memory or
   * `/proc/<pid>/environ`, where the URL its result is written to is held. The scratch copy is handed to the
   * user after the patch has been judged and applied, and before the command starts.
   */
  runAs?: { uid: number; gid: number };
  /**
   * Called by a verifier that waits (the CI and remote verifiers, on every poll) to keep the cycle's lease alive
   * (#132). It throws when the lease is lost: the verifier must then stop, and must not touch what the cycle's new
   * holder may be using (its branch). Absent: nothing to keep alive.
   */
  heartbeat?: () => Promise<void>;
}

export const MAX_PATCH_BYTES = 200_000;
export const MAX_CHANGED_FILES = 20;
/** Source files hashed per snapshot: a bound so a huge tree cannot stall the gate. */
export const MAX_TREE_FILES = 20_000;
export const MAX_OUTPUT_CHARS = 20_000;
const COPY_SKIP = new Set([".git", "node_modules"]);

/** Does `path` (repo-relative, `/`-separated) match one of the excluded patterns? Case-insensitive. */
export function isExcludedPath(path: string, patterns: readonly string[]): boolean {
  const p = path.toLowerCase();
  const segments = p.split("/");
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.endsWith("/")) {
      const dir = pattern.slice(0, -1);
      return dir.includes("/") ? p.startsWith(`${dir}/`) : segments.slice(0, -1).includes(dir);
    }
    const re = globToRegExp(pattern);
    // No slash: a name, matched at any depth. With one: a path from the repo root.
    return pattern.includes("/") ? re.test(p) : segments.some((s) => re.test(s));
  });
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
    } else if (c === "*") out += "[^/]*";
    else out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

interface Entry {
  kind: "file" | "symlink";
  mode: number;
  hash: string;
}

/** Every file and symlink under `root`, keyed by `/`-separated relative path. */
async function snapshot(root: string): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = await lstat(full);
      if (st.isDirectory()) {
        await walk(full, relPath);
        continue;
      }
      if (out.size >= MAX_TREE_FILES) throw new TreeTooLarge();
      if (st.isSymbolicLink()) {
        out.set(relPath, { kind: "symlink", mode: st.mode & 0o7777, hash: await readlink(full) });
      } else if (st.isFile()) {
        out.set(relPath, { kind: "file", mode: st.mode & 0o7777, hash: createHash("sha256").update(await readFile(full)).digest("hex") });
      }
    }
  };
  await walk(root, "");
  return out;
}

class TreeTooLarge extends Error {}

function changedBetween(before: Map<string, Entry>, after: Map<string, Entry>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((p) => {
      const a = before.get(p);
      const b = after.get(p);
      return !a || !b || a.kind !== b.kind || a.hash !== b.hash || a.mode !== b.mode;
    })
    .sort();
}

/** A deliberately small environment: nothing from this process's own credentials reaches the command. */
function scrubbedEnv(home: string, extraEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...extraEnv,
    ...loadVerifyCommandBasics(),
    TERM: "dumb",
    CI: "1",
    HOME: home,
    TMPDIR: join(home, "tmp"),
  };
}

function run(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number; runAs?: { uid: number; gid: number } }
): Promise<{ code: number | null; timedOut: boolean; output: string; cut: boolean }> {
  return new Promise((resolve) => {
    // Own process group, so a timeout kills everything the command started, not only the shell.
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.runAs && { uid: opts.runAs.uid, gid: opts.runAs.gid }),
    });
    let output = "";
    // Whether `output` starts at a cut: `tail` must then treat its first line as a possible fragment of a secret (#18).
    let cut = false;
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      const all = output + chunk.toString("utf8");
      if (all.length > MAX_OUTPUT_CHARS * 2) cut = true;
      output = all.slice(-MAX_OUTPUT_CHARS * 2);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.stdin ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);
    // Settle on the child's EXIT, not on `close`: `close` waits for every process holding the output pipes, and one
    // that left the process group (`setsid sleep infinity &`) survives the group kill and holds them for as long as it
    // likes, so the timeout bounded nothing (#135). After exit, the pipes get a short grace to drain what the command
    // already wrote, then are destroyed. A process that escaped the group is NOT killed: this is not a sandbox.
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const settle = (result: { code: number | null; timedOut: boolean; output: string; cut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    child.on("error", (err) => settle({ code: null, timedOut: false, output: `${output}\n${err.name}`, cut }));
    child.on("exit", (code) => {
      // The command finished on its own (or was killed): a timer firing during the grace must not call it a timeout.
      clearTimeout(timer);
      grace = setTimeout(() => settle({ code, timedOut, output, cut }), EXIT_GRACE_MS);
    });
    child.on("close", (code) => settle({ code, timedOut, output, cut }));
  });
}

/** How long the output pipes may stay open after the command itself has exited. */
const EXIT_GRACE_MS = 1000;

/** The output's redacted tail. Redacted before it is cut, so a secret across the cut is not half kept (#18). */
const tail = (ran: { output: string; cut: boolean }) => redactTail(ran.output, MAX_OUTPUT_CHARS, ran.cut);

export async function verifyPatch(req: VerifyRequest): Promise<VerifyResult> {
  const started = Date.now();
  const patchSha256 = createHash("sha256").update(req.patch).digest("hex");
  const base = { patchSha256, ...(req.baseRevision !== undefined && { baseRevision: req.baseRevision }) };
  const done = (
    status: VerifyStatus,
    rule: VerifyRule,
    reason: string,
    extra: Partial<VerifyResult> = {}
  ): VerifyResult => ({ ...base, status, rule, reason, changedFiles: [], output: "", durationMs: Date.now() - started, ...extra });

  if (!req.config.verifyCommand.trim()) {
    return done("rejected", "no-verify-command", "No verify command is configured, so nothing could prove this patch.");
  }
  if (req.patch.trim() === "") return done("rejected", "empty-patch", "The patch is empty.");
  if (Buffer.byteLength(req.patch) > MAX_PATCH_BYTES) {
    return done("rejected", "patch-too-large", `The patch is larger than ${MAX_PATCH_BYTES} bytes.`);
  }
  if (req.patch.includes("\0") || /^GIT binary patch$/m.test(req.patch) || /^Binary files .* differ$/m.test(req.patch)) {
    return done("rejected", "patch-not-text", "The patch contains binary content.");
  }

  const scratch = await mkdtemp(join(tmpdir(), "starfish-verify-"));
  try {
    const { tree, home } = scratchPaths(scratch);
    if (!(await copyToScratch(req.sourceDir, scratch))) {
      return done("rejected", "setup-failed", "The checkout could not be copied to a scratch directory.");
    }

    let before: Map<string, Entry>;
    try {
      before = await snapshot(tree);
    } catch (err) {
      if (err instanceof TreeTooLarge) return done("rejected", "tree-too-large", `The checkout has more than ${MAX_TREE_FILES} files.`);
      return done("rejected", "setup-failed", "The scratch copy could not be read.");
    }

    const env = scrubbedEnv(home, req.extraEnv ?? {});
    const applied = await run("git", ["apply", "--whitespace=nowarn", "-"], { cwd: tree, env, stdin: req.patch, timeoutMs: 30_000 });
    if (applied.code !== 0) {
      return done("rejected", "patch-does-not-apply", "The patch does not apply to the checkout.", { output: tail(applied) });
    }

    let after: Map<string, Entry>;
    try {
      after = await snapshot(tree);
    } catch {
      return done("rejected", "tree-too-large", "The patched tree is too large to inspect.");
    }
    const changedFiles = changedBetween(before, after);
    // A refusal lists at most MAX_CHANGED_FILES + 1 paths: enough to show "too many", and no more than
    // `parseRunnerResult` accepts. Listing all of them made a too-many-files refusal from the verify job a
    // protocol error, so the fixer never heard why its patch was refused (#135).
    const refuse = (rule: VerifyRule, reason: string) => done("rejected", rule, reason, { changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES + 1) });

    if (changedFiles.length === 0) return refuse("empty-patch", "The patch changes nothing.");
    if (changedFiles.length > MAX_CHANGED_FILES) return refuse("too-many-files", `The patch changes more than ${MAX_CHANGED_FILES} files.`);
    for (const path of changedFiles) {
      if (isExcludedPath(path, req.config.patchExcludedPaths)) {
        return refuse("excluded-path", `The patch changes a path that proposed patches may never touch (${redactPii(path)}).`);
      }
      const a = before.get(path);
      const b = after.get(path);
      if (b?.kind === "symlink" || a?.kind === "symlink") return refuse("symlink", `The patch adds or changes a symbolic link (${redactPii(path)}).`);
      if (a && b && a.mode !== b.mode) return refuse("file-mode", `The patch changes a file's permissions (${redactPii(path)}).`);
      if (!a && b && (b.mode & 0o111) !== 0) return refuse("file-mode", `The patch adds an executable file (${redactPii(path)}).`);
    }

    if (req.runAs) {
      const handed = await run("chown", ["-R", `${req.runAs.uid}:${req.runAs.gid}`, scratch], { cwd: scratch, env, timeoutMs: 60_000 });
      if (handed.code !== 0) return done("rejected", "setup-failed", "The scratch copy could not be handed to the unprivileged user.", { changedFiles });
    }
    return await runCommand(tree, env, req, (status, rule, reason, extra) => done(status, rule, reason, { changedFiles, ...extra }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

type Done = (status: VerifyStatus, rule: VerifyRule, reason: string, extra?: Partial<VerifyResult>) => VerifyResult;

const scratchPaths = (scratch: string) => ({ tree: join(scratch, "tree"), home: join(scratch, "home") });

/** Copies the checkout to `<scratch>/tree` without `.git` and `node_modules`, and makes a scratch home. False on failure. */
async function copyToScratch(sourceDir: string, scratch: string): Promise<boolean> {
  const { tree, home } = scratchPaths(scratch);
  try {
    await mkdir(join(home, "tmp"), { recursive: true });
    await cp(sourceDir, tree, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !COPY_SKIP.has(src.split("/").pop() ?? ""),
    });
    return true;
  } catch {
    return false;
  }
}

/** Runs the configured command in `tree`. Exit 0 is the only pass. */
async function runCommand(tree: string, env: NodeJS.ProcessEnv, req: Pick<VerifyRequest, "config" | "runAs">, done: Done): Promise<VerifyResult> {
  const ran = await run("sh", ["-c", req.config.verifyCommand], {
    cwd: tree,
    env,
    timeoutMs: req.config.verifyTimeoutSeconds * 1000,
    ...(req.runAs && { runAs: req.runAs }),
  });
  const output = tail(ran);
  if (ran.timedOut) {
    return done("timeout", "command-timeout", `The verify command did not finish in ${req.config.verifyTimeoutSeconds} seconds.`, { output });
  }
  if (ran.code === 0) return done("passed", "command-passed", "The verify command passed.", { output, exitCode: 0 });
  return done("failed", "command-failed", `The verify command failed (exit ${ran.code ?? "none"}).`, { output, exitCode: ran.code });
}

/**
 * The configured command on the checkout exactly as it is, with no patch: the "before" half of a before/after check
 * (#4, #10). The same scratch copy, scrubbed environment, timeout and bounded output as `verifyPatch`; only the patch
 * is missing, so `patchSha256` is the hash of the empty patch. The replay harness (src/scoreboard/evaluate.ts) uses it
 * to prove a case's defect reproduces before any patch, so a fix is never credited for a test that never failed. Not a
 * sandbox, as above.
 */
export async function runUnpatched(req: Pick<VerifyRequest, "sourceDir" | "baseRevision" | "config" | "extraEnv">): Promise<VerifyResult> {
  const started = Date.now();
  const base = { patchSha256: createHash("sha256").update("").digest("hex"), ...(req.baseRevision !== undefined && { baseRevision: req.baseRevision }) };
  const done: Done = (status, rule, reason, extra = {}) => ({ ...base, status, rule, reason, changedFiles: [], output: "", durationMs: Date.now() - started, ...extra });
  if (!req.config.verifyCommand.trim()) return done("rejected", "no-verify-command", "No command is configured, so nothing was checked.");
  const scratch = await mkdtemp(join(tmpdir(), "starfish-verify-"));
  try {
    if (!(await copyToScratch(req.sourceDir, scratch))) {
      return done("rejected", "setup-failed", "The checkout could not be copied to a scratch directory.");
    }
    const { tree, home } = scratchPaths(scratch);
    return await runCommand(tree, scrubbedEnv(home, req.extraEnv ?? {}), req, done);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
