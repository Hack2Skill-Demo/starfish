import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cli = new URL("./scoreboardCli.ts", import.meta.url).pathname;
const run = (...args: string[]) => {
  const r = spawnSync("pnpm", ["exec", "tsx", cli, ...args], { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const file = {
  version: 1,
  runId: "r1",
  corpusVersion: "c1",
  appRevision: "a",
  starfishRevision: "s",
  model: "m",
  ranAt: "2026-10-11T09:00:00Z",
  configuration: {},
  cases: [{ caseId: "c", split: "tuning", path: "decline", expectedTriage: "decline", outcome: { status: "completed", triage: "decline" } }],
};

// Each case starts the CLI as its own process (pnpm, then tsx): a few seconds apiece, more on a busy machine. The
// default 5 s timeout made the slowest case fail under load, so these cases get room, not a skip.
const CLI_TIMEOUT_MS = 30_000;

describe("pnpm scoreboard", { timeout: CLI_TIMEOUT_MS }, () => {
  it("writes nothing when there are no runs, and says so", () => {
    const d = mkdtempSync(join(tmpdir(), "sbcli-"));
    const r = run("--dir", join(d, "results"), "--out", join(d, "RESULTS.md"));
    expect(r.status).toBe(0);
    expect(r.out).toContain("no runs recorded");
    expect(existsSync(join(d, "RESULTS.md"))).toBe(false);
  });

  it("writes the table from the files, and --check notices when it is stale", () => {
    const d = mkdtempSync(join(tmpdir(), "sbcli-"));
    mkdirSync(join(d, "results"));
    writeFileSync(join(d, "results", "r1.json"), JSON.stringify(file));
    const args = ["--dir", join(d, "results"), "--out", join(d, "RESULTS.md")];
    expect(run(...args).status).toBe(0);
    expect(readFileSync(join(d, "RESULTS.md"), "utf8")).toContain("Correct declines | 1/1 (100%)");
    expect(run(...args, "--check").status).toBe(0);
    writeFileSync(join(d, "RESULTS.md"), "edited by hand");
    const stale = run(...args, "--check");
    expect(stale.status).toBe(1);
    expect(stale.out).toContain("is not what");
  });

  it("fails on a bad results file, naming it", () => {
    const d = mkdtempSync(join(tmpdir(), "sbcli-"));
    mkdirSync(join(d, "results"));
    writeFileSync(join(d, "results", "bad.json"), JSON.stringify({ ...file, model: "" }));
    const r = run("--dir", join(d, "results"), "--out", join(d, "RESULTS.md"));
    expect(r.status).toBe(1);
    expect(r.out).toContain("bad.json");
  });
});
