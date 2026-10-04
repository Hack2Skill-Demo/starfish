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
 *      to an excluded path (CI, secrets, whatever defines the verify command or the tests), a new
 *      or changed symlink, a changed file mode, and a patch that touches too many files;
 *   4. only then runs the configured command, with a scrubbed environment, a timeout and bounded,
 *      redacted output. Exit 0 is the only pass.
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
import type { StarfishConfig } from "../config.js";
import { redactPii } from "../ingest/redact.js";

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
  /** A checkout of the target repo at the pinned revision. Never modified. */
  sourceDir: string;
  /** A unified diff against that checkout. */
  patch: string;
  baseRevision?: string;
  config: VerifyConfig;
  /** Names of environment variables to pass to the command (everything else is dropped). */
  passEnv?: string[];
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
function scrubbedEnv(home: string, passEnv: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    CI: "1",
    HOME: home,
    TMPDIR: join(home, "tmp"),
  };
  for (const name of passEnv) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function run(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number }
): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    // Own process group, so a timeout kills everything the command started, not only the shell.
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT_CHARS * 2);
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
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, output: `${output}\n${err.name}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output });
    });
  });
}

const tail = (text: string) => redactPii(text.slice(-MAX_OUTPUT_CHARS));

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
    const tree = join(scratch, "tree");
    const home = join(scratch, "home");
    try {
      await mkdir(join(home, "tmp"), { recursive: true });
      await cp(req.sourceDir, tree, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => !COPY_SKIP.has(src.split("/").pop() ?? ""),
      });
    } catch {
      return done("rejected", "setup-failed", "The checkout could not be copied to a scratch directory.");
    }

    let before: Map<string, Entry>;
    try {
      before = await snapshot(tree);
    } catch (err) {
      if (err instanceof TreeTooLarge) return done("rejected", "tree-too-large", `The checkout has more than ${MAX_TREE_FILES} files.`);
      return done("rejected", "setup-failed", "The scratch copy could not be read.");
    }

    const env = scrubbedEnv(home, req.passEnv ?? []);
    const applied = await run("git", ["apply", "--whitespace=nowarn", "-"], { cwd: tree, env, stdin: req.patch, timeoutMs: 30_000 });
    if (applied.code !== 0) {
      return done("rejected", "patch-does-not-apply", "The patch does not apply to the checkout.", { output: tail(applied.output) });
    }

    let after: Map<string, Entry>;
    try {
      after = await snapshot(tree);
    } catch {
      return done("rejected", "tree-too-large", "The patched tree is too large to inspect.");
    }
    const changedFiles = changedBetween(before, after);
    const refuse = (rule: VerifyRule, reason: string) => done("rejected", rule, reason, { changedFiles });

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

    const ran = await run("sh", ["-c", req.config.verifyCommand], {
      cwd: tree,
      env,
      timeoutMs: req.config.verifyTimeoutSeconds * 1000,
    });
    const output = tail(ran.output);
    if (ran.timedOut) {
      return done("timeout", "command-timeout", `The verify command did not finish in ${req.config.verifyTimeoutSeconds} seconds.`, { changedFiles, output });
    }
    if (ran.code === 0) return done("passed", "command-passed", "The verify command passed.", { changedFiles, output, exitCode: 0 });
    return done("failed", "command-failed", `The verify command failed (exit ${ran.code ?? "none"}).`, { changedFiles, output, exitCode: ran.code });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
