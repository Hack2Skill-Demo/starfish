/**
 * The verify gate against a real filesystem, a real `git apply` and real child processes: the
 * issue (#8) asks for the gate to be tested for real, not with a stub.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_CHANGED_FILES, MAX_OUTPUT_CHARS, MAX_PATCH_BYTES, isExcludedPath, runUnpatched, verifyPatch, VerifySetupError, type VerifyConfig } from "./verifyGate.js";
import { parseRunnerResult } from "./verifyProtocol.js";
import { DEFAULT_PATCH_EXCLUDED_PATHS } from "../config.js";
import { SEEDED_SECRETS } from "../ingest/testSecrets.js";

// The gate makes its scratch copies in the OS temp directory, and a test below counts what is left there. Other
// test files run the gate at the same time, so this file gets a temp directory of its own.
const originalTmp = process.env.TMPDIR;
const privateTmp = mkdtempSync(join(tmpdir(), "vg-private-tmp-"));
beforeAll(() => {
  process.env.TMPDIR = privateTmp;
});
afterAll(() => {
  if (originalTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmp;
  rmSync(privateTmp, { recursive: true, force: true });
});

let src: string;
let marker: string;
beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), "vg-src-"));
  marker = join(mkdtempSync(join(tmpdir(), "vg-marker-")), "ran");
  write("greeting.txt", "hello old\n");
  write("src/app.js", "module.exports = () => 'old';\n");
});
afterEach(() => {
  rmSync(src, { recursive: true, force: true });
  rmSync(dirname(marker), { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const full = join(src, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const cfg = (over: Partial<VerifyConfig> = {}): VerifyConfig => ({
  verifyCommand: "grep -q new greeting.txt",
  verifyTimeoutSeconds: 20,
  patchExcludedPaths: [...DEFAULT_PATCH_EXCLUDED_PATHS],
  ...over,
});

/** A real unified diff, produced by git from two small trees. */
function diffOf(files: Record<string, string | null>, tweak?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "vg-diff-"));
  try {
    const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    run("init", "-q");
    run("config", "user.email", "t@t");
    run("config", "user.name", "t");
    for (const f of readdirSync(src)) execFileSync("cp", ["-r", join(src, f), dir]);
    run("add", "-A");
    run("commit", "-qm", "base");
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      if (content === null) rmSync(full, { force: true });
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    tweak?.(dir);
    run("add", "-A");
    return run("diff", "--cached", "--no-color");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Is `pid` a live process? A zombie (killed, not yet reaped) is not. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false; // ps exits non-zero when the process is gone
  }
}

const hasSetsid = (() => {
  try {
    execFileSync("sh", ["-c", "command -v setsid"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Kill the process whose pid the command wrote to `marker`: the gate deliberately leaves an escaped one running. */
function killMarked() {
  try {
    process.kill(Number(readFileSync(marker, "utf8").trim()), "SIGKILL");
  } catch {
    // already gone, or never written
  }
}

const verify = (patch: string, config = cfg(), extra: object = {}) => verifyPatch({ sourceDir: src, patch, config, ...extra });
const goodPatch = () => diffOf({ "greeting.txt": "hello new\n" });
const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith("starfish-verify-"));

describe("verifyPatch: a patch that works", () => {
  it("passes when the command passes on the patched copy, and says what changed", async () => {
    const r = await verify(goodPatch());
    expect(r).toMatchObject({ status: "passed", rule: "command-passed", exitCode: 0, changedFiles: ["greeting.txt"] });
  });

  it("never touches the checkout it was given", async () => {
    await verify(goodPatch());
    expect(readFileSync(join(src, "greeting.txt"), "utf8")).toBe("hello old\n");
  });

  it("ties the result to the exact patch and revision it judged", async () => {
    const patch = goodPatch();
    const r = await verify(patch, cfg(), { baseRevision: "abc123" });
    expect(r.patchSha256).toBe(createHash("sha256").update(patch).digest("hex"));
    expect(r.baseRevision).toBe("abc123");
    const other = await verify(diffOf({ "greeting.txt": "hello newer\n" }));
    expect(other.patchSha256).not.toBe(r.patchSha256);
  });

  it("leaves nothing behind in the temp directory", async () => {
    const before = leftovers().length;
    await verify(goodPatch());
    await verify("not a patch");
    expect(leftovers().length).toBe(before);
  });
});

describe("verifyPatch: a patch that does not work", () => {
  it("fails when the command fails, with its output and exit code", async () => {
    const r = await verify(diffOf({ "greeting.txt": "hello still old\n" }), cfg({ verifyCommand: "echo checking; grep -q new greeting.txt" }));
    expect(r).toMatchObject({ status: "failed", rule: "command-failed", exitCode: 1 });
    expect(r.output).toContain("checking");
  });

  // git ran and exited non-zero: git's own word on the patch, a verdict, and not the gate failing (#428).
  it("rejects, without running anything, a patch that does not apply", async () => {
    const r = await verify("--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-something else entirely\n+x\n", cfg({ verifyCommand: `touch ${marker}` }));
    expect(r).toMatchObject({ status: "rejected", rule: "patch-does-not-apply" });
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects a patch that applies but changes nothing, rather than passing the unmodified code", async () => {
    const noop = "--- a/greeting.txt\n+++ b/greeting.txt\n@@ -1 +1 @@\n-hello old\n+hello old\n";
    const r = await verify(noop, cfg({ verifyCommand: "true" }));
    expect(r).toMatchObject({ status: "rejected", rule: "empty-patch", changedFiles: [] });
  });
});

describe("verifyPatch: what it refuses before running anything", () => {
  const refused = async (patch: string, rule: string) => {
    const r = await verify(patch, cfg({ verifyCommand: `touch ${marker}` }));
    expect(r).toMatchObject({ status: "rejected", rule });
    expect(existsSync(marker)).toBe(false);
    return r;
  };

  it("with no verify command configured, nothing could prove the patch", async () => {
    const r = await verify(goodPatch(), cfg({ verifyCommand: "  " }));
    expect(r).toMatchObject({ status: "rejected", rule: "no-verify-command" });
  });

  it("an empty patch", async () => {
    await refused("   \n", "empty-patch");
  });

  it("an oversized patch", async () => {
    await refused(`${"x".repeat(MAX_PATCH_BYTES + 1)}`, "patch-too-large");
  });

  it("a patch with a NUL byte, or binary content", async () => {
    await refused("--- a/x\0\n", "patch-not-text");
    await refused("diff --git a/b.bin b/b.bin\nGIT binary patch\nliteral 1\nIcmZPo\n", "patch-not-text");
    await refused("Binary files a/b.bin and b/b.bin differ\n", "patch-not-text");
  });

  it.each([
    [".github/workflows/ci.yml", "name: ci\n"],
    ["app/.env", "TOKEN=x\n"],
    [".env.production", "TOKEN=x\n"],
    ["deploy/server.pem", "key\n"],
    [".GitHub/workflows/ci.yml", "name: ci\n"],
    [".npmrc", "//registry:_authToken=x\n"],
  ])("a patch that adds %s", async (path, content) => {
    const r = await refused(diffOf({ [path]: content }), "excluded-path");
    expect(r.changedFiles).toEqual([path]);
  });

  it("a patch that edits a file the deployment excluded (what defines the verify command)", async () => {
    write("package.json", '{"scripts":{"test":"jest"}}\n');
    const patch = diffOf({ "package.json": '{"scripts":{"test":"true"}}\n' });
    const r = await verify(patch, cfg({ patchExcludedPaths: ["package.json"], verifyCommand: `touch ${marker}` }));
    expect(r).toMatchObject({ status: "rejected", rule: "excluded-path" });
    expect(existsSync(marker)).toBe(false);
    // The same patch is acceptable where nobody excluded the file.
    expect((await verify(patch, cfg({ patchExcludedPaths: [], verifyCommand: "true" }))).status).toBe("passed");
  });

  it("a patch that adds a symbolic link", async () => {
    const patch = diffOf({}, (dir) => symlinkSync("/etc/passwd", join(dir, "link")));
    const r = await refused(patch, "symlink");
    expect(r.changedFiles).toEqual(["link"]);
  });

  it("a patch that replaces a file with a symbolic link", async () => {
    const patch = diffOf({ "greeting.txt": null }, (dir) => symlinkSync("src/app.js", join(dir, "greeting.txt")));
    await refused(patch, "symlink");
  });

  it("a patch that changes a file's permissions, or adds an executable", async () => {
    await refused(diffOf({}, (dir) => execFileSync("chmod", ["+x", join(dir, "greeting.txt")])), "file-mode");
    await refused(diffOf({ "run.sh": "echo hi\n" }, (dir) => execFileSync("chmod", ["+x", join(dir, "run.sh")])), "file-mode");
  });

  it("a patch that changes too many files", async () => {
    const files = Object.fromEntries(Array.from({ length: MAX_CHANGED_FILES + 1 }, (_, i) => [`gen/f${i}.txt`, "x\n"]));
    await refused(diffOf(files), "too-many-files");
  });

  it("a too-many-files refusal survives the verify job's protocol, however many files it changed (#135)", async () => {
    const files = Object.fromEntries(Array.from({ length: MAX_CHANGED_FILES + 5 }, (_, i) => [`gen/f${i}.txt`, "x\n"]));
    const r = await verify(diffOf(files));
    expect(r).toMatchObject({ status: "rejected", rule: "too-many-files" });
    expect(r.changedFiles).toHaveLength(MAX_CHANGED_FILES + 1);
    // What the runner writes is what the agent parses: the refusal must reach the fixer, not throw.
    expect(parseRunnerResult(JSON.stringify(r), r.patchSha256)).toMatchObject({ status: "rejected", rule: "too-many-files" });
  });
});

describe("verifyPatch: paths that leave the checkout", () => {
  // The checkout is made in the temp directory, so one level up is the temp directory itself.
  const abs = join(tmpdir(), `vg-escape-abs-${process.pid}.txt`);
  const rel = join(tmpdir(), "vg-escape.txt");
  afterEach(() => {
    rmSync(abs, { force: true });
    rmSync(rel, { force: true });
  });

  it.each([
    ["a parent-directory path", () => "--- /dev/null\n+++ b/../vg-escape.txt\n@@ -0,0 +1 @@\n+pwned\n"],
    ["a deeper parent-directory path", () => "--- /dev/null\n+++ b/a/../../vg-escape.txt\n@@ -0,0 +1 @@\n+pwned\n"],
    ["an absolute path", () => `diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ ${abs}\n@@ -0,0 +1 @@\n+pwned\n`],
  ])("rejects %s, and nothing is written outside", async (_name, patchOf) => {
    const r = await verify(patchOf(), cfg({ verifyCommand: `touch ${marker}` }));
    expect(r.status).toBe("rejected");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(abs)).toBe(false);
    expect(existsSync(rel)).toBe(false);
  });

  it("rejects writing through a symlink the checkout already contains", async () => {
    const target = mkdtempSync(join(tmpdir(), "vg-target-"));
    symlinkSync(target, join(src, "linked"));
    try {
      const patch = "--- /dev/null\n+++ b/linked/escaped.txt\n@@ -0,0 +1 @@\n+pwned\n";
      const r = await verify(patch, cfg({ verifyCommand: `touch ${marker}` }));
      expect(r.status).toBe("rejected");
      expect(existsSync(join(target, "escaped.txt"))).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("verifyPatch: the command's world", () => {
  it("cannot see .git or node_modules of the checkout: no history, no reference fix", async () => {
    mkdirSync(join(src, ".git"));
    write(".git/HEAD", "ref: refs/heads/main\n");
    mkdirSync(join(src, "node_modules/dep"), { recursive: true });
    write("node_modules/dep/index.js", "x");
    const r = await verify(goodPatch(), cfg({ verifyCommand: "test ! -e .git && test ! -e node_modules && grep -q new greeting.txt" }));
    expect(r.status).toBe("passed");
  });

  it("runs with a scrubbed environment: this process's credentials do not reach it", async () => {
    process.env.STARFISH_TEST_SECRET = "super-secret-value";
    process.env.GITHUB_TOKEN = "gh-token-value";
    try {
      const r = await verify(goodPatch(), cfg({ verifyCommand: "env; grep -q new greeting.txt" }));
      expect(r.status).toBe("passed");
      expect(r.output).not.toContain("super-secret-value");
      expect(r.output).not.toContain("gh-token-value");
      expect(r.output).toContain("CI=1");
    } finally {
      delete process.env.STARFISH_TEST_SECRET;
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("passes the extra variables it was given by value, and cannot have its basics overridden by them", async () => {
    const r = await verify(goodPatch(), cfg({ verifyCommand: 'echo "x=$STARFISH_TEST_ALLOWED"; echo "ci=$CI"; grep -q new greeting.txt' }), {
      extraEnv: { STARFISH_TEST_ALLOWED: "allowed-value", CI: "0" },
    });
    expect(r.output).toContain("x=allowed-value");
    expect(r.output).toContain("ci=1");
  });

  it("does not wait on a process that left the process group: the timeout still bounds the wait (#135)", async () => {
    if (!hasSetsid) return; // setsid is util-linux; without it this escape cannot be staged
    try {
      const started = Date.now();
      const r = await verify(goodPatch(), cfg({ verifyCommand: `setsid sleep 15 & echo $! > ${marker}; sleep 30`, verifyTimeoutSeconds: 2 }));
      expect(r).toMatchObject({ status: "timeout", rule: "command-timeout" });
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      killMarked();
    }
  });

  it("returns when the command exits, even if an escaped child still holds its output (#135)", async () => {
    if (!hasSetsid) return;
    try {
      const started = Date.now();
      const r = await verify(goodPatch(), cfg({ verifyCommand: `setsid sleep 15 & echo $! > ${marker}; exit 0`, verifyTimeoutSeconds: 2 }));
      expect(r).toMatchObject({ status: "passed", exitCode: 0 });
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      killMarked();
    }
  });

  it("kills a command that runs too long, and what it started", async () => {
    const started = Date.now();
    const r = await verify(goodPatch(), cfg({ verifyCommand: `sh -c 'sleep 30' & echo $! > ${marker}; sleep 30`, verifyTimeoutSeconds: 1 }));
    expect(r).toMatchObject({ status: "timeout", rule: "command-timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(marker, "utf8").trim());
    // Killed is not the same as reaped: a killed grandchild whose parent is gone stays a zombie until
    // init collects it, and `kill(pid, 0)` still succeeds for a zombie. A zombie is not running.
    const deadline = Date.now() + 5000;
    while (isRunning(pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    expect(isRunning(pid)).toBe(false);
  });

  it("redacts and bounds the output, which can echo whatever the code under test printed", async () => {
    const r = await verify(
      goodPatch(),
      cfg({ verifyCommand: `echo ${SEEDED_SECRETS.github}; head -c 200000 /dev/zero | tr '\\0' 'y'; echo; grep -q new greeting.txt` })
    );
    expect(r.output).not.toContain(SEEDED_SECRETS.github);
    expect(r.output.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  });

  it("keeps no part of a secret the tail's cut runs through (#18)", async () => {
    // A private key whose BEGIN line falls 12 characters before the kept tail, and a token the cut enters 10 characters in.
    // Cut first and redacted after, the key's body and the token's remainder survived with nothing left to match them.
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCSECRETBODY"; // 41 characters
    const pem = `printf '%s\\n' '-----BEGIN PRIVATE KEY-----' '${body}' '-----END PRIVATE KEY-----'`;
    const token = SEEDED_SECRETS.github!; // 44 characters
    for (const [print, after, fragment] of [
      [pem, MAX_OUTPUT_CHARS - (28 - 12) - (body.length + 1) - 26 - 1, body.slice(-12)],
      [`echo ${token}`, MAX_OUTPUT_CHARS - (token.length + 1 - 10) - 1, token.slice(10)],
    ] as const) {
      const r = await verify(goodPatch(), cfg({ verifyCommand: `${print}; head -c ${after} /dev/zero | tr '\\0' 'y'; echo; grep -q new greeting.txt` }));
      expect(r.status).toBe("passed");
      expect(r.output).not.toContain(fragment);
    }
  });

  it("keeps the reason free of patch text", async () => {
    const r = await verify(diffOf({ [`.github/${SEEDED_SECRETS.github}.yml`]: "x\n" }));
    expect(r.reason).not.toContain(SEEDED_SECRETS.github);
  });
});

describe("isExcludedPath", () => {
  const p = [...DEFAULT_PATCH_EXCLUDED_PATHS];
  it("directories, at any depth for a bare name and from the root for a path", () => {
    expect(isExcludedPath(".github/workflows/ci.yml", p)).toBe(true);
    expect(isExcludedPath("sub/.github/x.yml", p)).toBe(true);
    expect(isExcludedPath("src/secrets/key.txt", ["src/secrets/"])).toBe(true);
    expect(isExcludedPath("lib/src/secrets/key.txt", ["src/secrets/"])).toBe(false);
  });
  it("names and globs, ignoring case", () => {
    expect(isExcludedPath("a/b/.env", p)).toBe(true);
    expect(isExcludedPath("a/.env.local", p)).toBe(true);
    expect(isExcludedPath("keys/server.PEM", p)).toBe(true);
    expect(isExcludedPath("id_rsa.pub", p)).toBe(true);
    expect(isExcludedPath("firebase-adminsdk-abc.json", p)).toBe(true);
  });
  it("does not match what merely contains the text", () => {
    expect(isExcludedPath("src/environment.ts", p)).toBe(false);
    expect(isExcludedPath("src/github.ts", p)).toBe(false);
    expect(isExcludedPath("docs/.envelope.md", [".env"])).toBe(false);
    expect(isExcludedPath("src/app.js", p)).toBe(false);
  });
  it("** crosses directories and * does not", () => {
    expect(isExcludedPath("a/b/c/x.snap", ["a/**/*.snap"])).toBe(true);
    expect(isExcludedPath("a/b/c/x.snap", ["a/*.snap"])).toBe(false);
  });
  it("ignores empty patterns", () => {
    expect(isExcludedPath("anything", ["", "  "])).toBe(false);
  });
});

describe("verifyPatch: its own failures throw, and are never the patch's verdict (#428)", () => {
  it("throws when the checkout cannot be copied, and leaves no scratch copy behind", async () => {
    const before = leftovers().length;
    await expect(verifyPatch({ sourceDir: join(src, "no-such-dir"), patch: goodPatch(), config: cfg() })).rejects.toThrow(VerifySetupError);
    expect(leftovers().length).toBe(before);
  });

  it("throws when git apply cannot be run at all (no exit code), and runs nothing", async () => {
    const patch = goodPatch();
    const path = process.env.PATH;
    // The command's PATH is this process's (config.ts `loadVerifyCommandBasics`): with no git on it, spawn fails.
    process.env.PATH = join(src, "no-bin");
    try {
      const err = await verify(patch, cfg({ verifyCommand: `touch ${marker}` })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VerifySetupError);
      expect((err as Error).message).toBe("git apply could not be run");
    } finally {
      process.env.PATH = path;
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("names itself, so a pass's error list says what failed", () => {
    expect(new VerifySetupError("x").name).toBe("VerifySetupError");
  });
});

describe("verifyPatch: runAs", () => {
  // Dropping privileges needs root, which a test is not. Handing the scratch copy to this process's own user
  // exercises every step except the one that needs root: the copy is chowned, and the command still runs and
  // still sees only its scrubbed environment.
  it("runs the command as the named user, in a scratch copy handed to that user", async () => {
    const me = { uid: process.getuid!(), gid: process.getgid!() };
    const patch = diffOf({ "greeting.txt": "hello new\n" });
    const r = await verifyPatch({ sourceDir: src, patch, config: cfg({ verifyCommand: `test "$(id -u)" = "${me.uid}" && grep -q new greeting.txt` }), runAs: me });
    expect(r).toMatchObject({ status: "passed", rule: "command-passed" });
  });

  it("throws, as its own failure and not the patch's, when the scratch copy cannot be handed over (#428)", async () => {
    // A uid this user cannot chown to (unless root, where it is a real user and the command runs as it).
    if (process.getuid!() === 0) return;
    const patch = diffOf({ "greeting.txt": "hello new\n" });
    await expect(verifyPatch({ sourceDir: src, patch, config: cfg({ verifyCommand: `touch ${marker}` }), runAs: { uid: 1, gid: 1 } })).rejects.toThrow(VerifySetupError);
    expect(existsSync(marker)).toBe(false);
  });

  it("does nothing different when runAs is absent", async () => {
    const patch = diffOf({ "greeting.txt": "hello new\n" });
    expect(await verifyPatch({ sourceDir: src, patch, config: cfg() })).toMatchObject({ status: "passed" });
  });
});

describe("runUnpatched (the before half of a before/after check)", () => {
  it("runs the command on a scratch copy of the checkout as it is, and reports its exit", async () => {
    expect(await runUnpatched({ sourceDir: src, config: cfg() })).toMatchObject({ status: "failed", rule: "command-failed", exitCode: 1, changedFiles: [] });
    expect(await runUnpatched({ sourceDir: src, config: cfg({ verifyCommand: "grep -q old greeting.txt" }) })).toMatchObject({ status: "passed", exitCode: 0 });
  });

  it("never touches the checkout it was given", async () => {
    await runUnpatched({ sourceDir: src, config: cfg({ verifyCommand: "echo changed > greeting.txt" }) });
    expect(readFileSync(join(src, "greeting.txt"), "utf8")).toBe("hello old\n");
  });

  it("refuses with no command, and times out like the gate", async () => {
    expect(await runUnpatched({ sourceDir: src, config: cfg({ verifyCommand: " " }) })).toMatchObject({ status: "rejected", rule: "no-verify-command" });
    expect(await runUnpatched({ sourceDir: src, config: cfg({ verifyCommand: "sleep 5", verifyTimeoutSeconds: 0.3 }) })).toMatchObject({ status: "timeout", rule: "command-timeout" });
  });
});
