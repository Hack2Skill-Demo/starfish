// scripts/deploy-web.sh deploys to a real project, so these pin what a dry run promises: it refuses the
// unsafe inputs, prints the whole plan, runs nothing, and keeps Starfish off the project's default site.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("./deploy-web.sh", import.meta.url).pathname;

// A pnpm that records being called and fails, first on PATH: a dry run must never reach it.
function deploy(env) {
  const dir = mkdtempSync(join(tmpdir(), "pnpm-stub-"));
  const marker = join(dir, "called");
  writeFileSync(join(dir, "pnpm"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  chmodSync(join(dir, "pnpm"), 0o755);
  const r = spawnSync("bash", [script], { env: { PATH: `${dir}:/usr/bin:/bin`, ...env }, encoding: "utf8" });
  return { ...r, out: `${r.stdout}${r.stderr}`.replace(/\\/g, ""), ran: existsSync(marker) };
}

const dry = { DRY_RUN: "1", PROJECT_ID: "star-proj" };

describe("scripts/deploy-web.sh", () => {
  it("needs a project", () => {
    const r = deploy({ DRY_RUN: "1" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("PROJECT_ID is required");
  });

  it("refuses the default database and an invalid site name", () => {
    expect(deploy({ ...dry, STARFISH_DATABASE_ID: "(default)" }).status).not.toBe(0);
    const r = deploy({ ...dry, HOSTING_SITE: "Bad_Site" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("HOSTING_SITE must be");
  });

  it("prints the whole plan and runs nothing", () => {
    const r = deploy(dry);
    expect(r.status).toBe(0);
    expect(r.ran).toBe(false);
    for (const part of [
      "VITE_STARFISH_ENV=dev",
      "VITE_STARFISH_DATABASE_ID=starfish",
      "pnpm run build",
      "apps:list WEB",
      "hosting:sites:create star-proj-starfish --app <web-app-id>",
      "target:apply hosting starfish star-proj-starfish",
      "deploy --only hosting:starfish --project star-proj",
    ]) {
      expect(r.out).toContain(part);
    }
    expect(r.out).toContain("Dry run: nothing was changed.");
  });

  it("deploys to its own site by default, never the project's default one", () => {
    const r = deploy(dry);
    expect(r.out).toContain("star-proj-starfish");
    expect(r.out).not.toMatch(/target:apply hosting starfish star-proj( |$)/m);
  });

  it("takes the site and the environment label it is given", () => {
    const r = deploy({ ...dry, HOSTING_SITE: "judges", STARFISH_ENV: "demo" });
    expect(r.out).toContain("target:apply hosting starfish judges");
    expect(r.out).toContain("VITE_STARFISH_ENV=demo");
  });
});
