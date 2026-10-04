// scripts/smoke-gcp.sh writes to a real project, so these pin what a dry run promises: it refuses bad
// input, prints the whole plan in the right order, and neither sleeps nor calls gcloud.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("./smoke-gcp.sh", import.meta.url).pathname;

function smoke(env) {
  const dir = mkdtempSync(join(tmpdir(), "smoke-stub-"));
  const marker = join(dir, "called");
  for (const name of ["gcloud", "pnpm", "sleep"]) {
    writeFileSync(join(dir, name), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(join(dir, name), 0o755);
  }
  const r = spawnSync("bash", [script], { env: { PATH: `${dir}:/usr/bin:/bin`, ...env }, encoding: "utf8" });
  return { ...r, out: `${r.stdout}${r.stderr}`.replace(/\\/g, ""), ran: existsSync(marker) };
}

const dry = { DRY_RUN: "1", PROJECT_ID: "star-proj" };

describe("scripts/smoke-gcp.sh", () => {
  it("needs a project and a sane wait", () => {
    expect(smoke({ DRY_RUN: "1" }).out).toContain("PROJECT_ID is required");
    expect(smoke({ ...dry, SMOKE_WAIT_SECONDS: "soon" }).status).not.toBe(0);
  });

  it("plants the error, waits, runs the job, then checks for the incident, in that order, touching nothing", () => {
    const r = smoke(dry);
    expect(r.status).toBe(0);
    expect(r.ran).toBe(false);
    const at = (s) => r.out.indexOf(s);
    expect(at("gcloud logging write starfish-smoke")).toBeGreaterThan(-1);
    expect(at("sleep 420")).toBeGreaterThan(at("gcloud logging write"));
    expect(at("gcloud run jobs execute starfish-ingest")).toBeGreaterThan(at("sleep 420"));
    expect(at("pnpm status --stale-minutes 15 --min-incidents 1 --min-entries 1")).toBeGreaterThan(at("gcloud run jobs execute"));
  });

  it("writes the entry as a function resource with a name, which is what the ingest reads", () => {
    const r = smoke(dry);
    expect(r.out).toContain("--severity=ERROR");
    expect(r.out).toContain("--monitored-resource-type=cloud_function");
    expect(r.out).toContain("function_name=starfish-smoke");
    expect(r.out).toContain("project_id=star-proj");
  });

  it("writes the error to the watched project but runs the job in Starfish's", () => {
    const r = smoke({ ...dry, WATCHED_PROJECT_ID: "app-proj" });
    expect(r.out).toMatch(/logging write .*--project=app-proj/);
    expect(r.out).toMatch(/run jobs execute .*--project=star-proj/);
    expect(r.out).toContain("GOOGLE_CLOUD_PROJECT=star-proj");
  });
});
