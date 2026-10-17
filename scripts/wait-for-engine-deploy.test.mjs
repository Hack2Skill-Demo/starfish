// scripts/wait-for-engine-deploy.sh orders the web deploy after the engine deploy of the same push (#373). It is run here
// against a stub `gh` that answers from a list of states, one per call; nothing reaches GitHub.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./wait-for-engine-deploy.sh", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wait-engine-"));
  const stub = join(dir, "gh");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
f="$STUB_DIR/states"; n="$STUB_DIR/n"
i=$(cat "$n" 2>/dev/null || echo 0); echo $((i+1)) > "$n"
echo "$*" >> "$STUB_DIR/calls"
line=$(sed -n "$((i+1))p" "$f"); [ -n "$line" ] || line=$(tail -n1 "$f")
case "$line" in FAIL) exit 1 ;; NONE) exit 0 ;; *) echo "$line" ;; esac
`,
  );
  chmodSync(stub, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run the script with `gh` answering `states` in order (the last one repeats). */
function run(states, env = {}) {
  writeFileSync(join(dir, "states"), states.join("\n") + "\n");
  const r = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, STUB_DIR: dir, REPO: "acme/starfish", SHA, POLL_SECONDS: "0", ...env },
  });
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").length;
  return { code: r.status, out: r.stdout + r.stderr, calls };
}

describe("scripts/wait-for-engine-deploy.sh", () => {
  it("waits for a running engine deploy to finish, then lets the web deploy go", () => {
    const r = run(["queued none", "in_progress none", "in_progress none", "completed success"], { APPEAR_SECONDS: "60", WAIT_SECONDS: "60" });
    expect(r.code).toBe(0);
    expect(r.calls).toBe(4);
    expect(r.out).toContain("Deploy engine is running");
    expect(r.out).toContain("rules and indexes are published");
  });

  it("finds a run that appears a moment after the push", () => {
    const r = run(["NONE", "NONE", "queued none", "completed success"], { APPEAR_SECONDS: "60", WAIT_SECONDS: "60" });
    expect(r.code).toBe(0);
    expect(r.calls).toBe(4);
  });

  it("does not wait when the push starts no engine run", () => {
    const r = run(["NONE"], { APPEAR_SECONDS: "0" });
    expect(r.code).toBe(0);
    expect(r.calls).toBe(1);
    expect(r.out).toContain("this push does not start one");
  });

  it("goes on, with a warning, when the engine run failed: the rules check below is the gate", () => {
    const r = run(["completed failure"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("::warning::Deploy engine ended 'failure'");
  });

  it("goes on when the engine run was skipped or cancelled", () => {
    expect(run(["completed skipped"]).out).toContain("was skipped");
    expect(run(["completed cancelled"]).out).toContain("ended 'cancelled'");
  });

  it("goes on, with a warning, when the engine run is still unfinished after the wait", () => {
    const r = run(["in_progress none"], { WAIT_SECONDS: "0" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("had not finished");
  });

  it("goes on, with a warning, when the runs cannot be read at all", () => {
    const r = run(["FAIL"], { APPEAR_SECONDS: "0" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("could not read the Deploy engine runs");
  });

  it("keeps waiting through one failed read once it has seen the run", () => {
    const r = run(["in_progress none", "FAIL", "completed success"], { WAIT_SECONDS: "60", APPEAR_SECONDS: "0" });
    expect(r.code).toBe(0);
    expect(r.calls).toBe(3);
  });

  it("asks for this commit's push runs of the engine workflow, nothing else", () => {
    run(["completed success"]);
    const asked = readFileSync(join(dir, "calls"), "utf8");
    expect(asked).toContain("repos/acme/starfish/actions/workflows/deploy.yml/runs?head_sha=" + SHA + "&event=push");
  });

  it("refuses a missing or malformed setting, before calling anything", () => {
    for (const env of [{ REPO: "" }, { SHA: "" }, { REPO: "nope" }, { SHA: "main; rm -rf /" }, { ENGINE_WORKFLOW: "../x" }, { WAIT_SECONDS: "soon" }]) {
      writeFileSync(join(dir, "states"), "completed success\n");
      const r = spawnSync("bash", [script], {
        encoding: "utf8",
        env: { PATH: `${dir}:${process.env.PATH}`, STUB_DIR: dir, REPO: "acme/starfish", SHA, ...env },
      });
      expect(r.status, JSON.stringify(env)).toBe(1);
    }
  });
});
