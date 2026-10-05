import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const cli = new URL("./grantOperatorCli.ts", import.meta.url).pathname;
const cwd = new URL("..", import.meta.url).pathname;
// No credentials and no emulator: a run that gets past the project check would fail slowly or loudly, so each of
// these asserts it stopped at the check.
const run = (args: string[], env: Record<string, string>) => {
  const r = spawnSync("pnpm", ["exec", "tsx", cli, ...args], { encoding: "utf8", cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

describe("pnpm grant-operator names its project", () => {
  it("needs --project as well as --email", () => {
    const r = run(["--email", "a@example.com"], { GOOGLE_CLOUD_PROJECT: "star-proj" });
    expect(r.status).toBe(2);
    expect(r.out).toContain("usage: pnpm grant-operator --project <id> --email");
  });

  it("refuses when the shell's project is not the one named, before touching anything", () => {
    const r = run(["--project", "star-proj", "--email", "a@example.com", "--create"], { GOOGLE_CLOUD_PROJECT: "someone-elses-proj" });
    expect(r.status).toBe(2);
    expect(r.out).toContain("--project is star-proj but GOOGLE_CLOUD_PROJECT is someone-elses-proj");
    expect(r.out).toContain("export GOOGLE_CLOUD_PROJECT=star-proj");
    expect(r.out).not.toContain("now admin");
  });
});
