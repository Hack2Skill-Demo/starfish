// scripts/ingest-cadence.sh changes a live Scheduler job, so these pin what a dry run promises: it refuses bad input,
// prints exactly the commands each mode needs, and touches neither gcloud nor the lag unless asked to.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("./ingest-cadence.sh", import.meta.url).pathname;

function cadence(args, env) {
  const dir = mkdtempSync(join(tmpdir(), "cadence-stub-"));
  const marker = join(dir, "called");
  writeFileSync(join(dir, "gcloud"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  chmodSync(join(dir, "gcloud"), 0o755);
  const r = spawnSync("bash", [script, ...args], { env: { PATH: `${dir}:/usr/bin:/bin`, ...env }, encoding: "utf8" });
  return { ...r, out: `${r.stdout}${r.stderr}`.replace(/\\/g, ""), ran: existsSync(marker) };
}

const dry = { DRY_RUN: "1", PROJECT_ID: "star-proj" };

describe("scripts/ingest-cadence.sh", () => {
  it("needs a project and a known mode", () => {
    expect(cadence(["now"], { DRY_RUN: "1" }).out).toContain("PROJECT_ID is required");
    expect(cadence([], dry).out).toContain("usage:");
    expect(cadence(["fast"], dry).status).not.toBe(0);
  });

  it("refuses a schedule or a lag that is not what it says, before any command", () => {
    for (const bad of ["every minute", "* * * *", "* * * * * *", "*; rm -rf /", "$(id) * * * *"]) {
      const r = cadence(["recording"], { ...dry, RECORDING_SCHEDULE: bad });
      expect(r.status, bad).not.toBe(0);
      expect(r.out).toContain("RECORDING_SCHEDULE must be a five-field cron");
    }
    expect(cadence(["restore"], { ...dry, NORMAL_SCHEDULE: "soon" }).status).not.toBe(0);
    for (const lag of ["0", "-1", "a", "1.2.3", ".5", "1;x"]) {
      expect(cadence(["recording"], { ...dry, RECORDING_LAG_MINUTES: lag }).status, lag).not.toBe(0);
    }
  });

  it("recording ticks every minute by default and leaves the lag alone", () => {
    const r = cadence(["recording"], dry);
    expect(r.status).toBe(0);
    expect(r.ran).toBe(false);
    expect(r.out).toMatch(/gcloud scheduler jobs update http starfish-ingest-tick .*--schedule=\* \* \* \* \*/);
    expect(r.out).not.toContain("STARFISH_INGEST_LAG_MINUTES=");
    // The job is told its new schedule, so the UI's "next run expected" follows it (#38).
    expect(r.out).toMatch(/gcloud run jobs update starfish-ingest .*--update-env-vars=.*STARFISH_INGEST_SCHEDULE=/);
    // It says how to put things back, with the schedule that would be restored.
    expect(r.out).toContain("scripts/ingest-cadence.sh restore");
    expect(r.out).toContain("NORMAL_SCHEDULE='0 * * * *'");
  });

  it("changes the lag only when asked, and says to restore it too", () => {
    const r = cadence(["recording"], { ...dry, RECORDING_LAG_MINUTES: "2" });
    expect(r.out).toMatch(/--update-env-vars=.*STARFISH_INGEST_SCHEDULE=.*@STARFISH_INGEST_LAG_MINUTES=2/);
    expect(r.out).toContain("NORMAL_LAG_MINUTES=");
  });

  it("restore puts the schedule back, and the lag only when given one", () => {
    const plain = cadence(["restore"], { ...dry, NORMAL_SCHEDULE: "*/15 * * * *" });
    expect(plain.out).toMatch(/--schedule=\*\/15 \* \* \* \*/);
    expect(plain.out).not.toContain("STARFISH_INGEST_LAG_MINUTES=");
    expect(plain.out).toMatch(/--update-env-vars=.*STARFISH_INGEST_SCHEDULE=\S*15/);
    const lagged = cadence(["restore"], { ...dry, NORMAL_LAG_MINUTES: "5" });
    expect(lagged.out).toMatch(/--update-env-vars=.*@STARFISH_INGEST_LAG_MINUTES=5/);
  });

  it("targets the job and scheduler names of the deploy, and honours the deploy's overrides", () => {
    expect(cadence(["now"], dry).out).toMatch(/gcloud run jobs execute starfish-ingest .*--project=star-proj .*--region=us-central1 .*--wait/);
    const r = cadence(["recording"], { ...dry, JOB_NAME: "my-ingest", REGION: "europe-west1" });
    expect(r.out).toContain("jobs update http my-ingest-tick");
    expect(r.out).toContain("--location=europe-west1");
    expect(cadence(["recording"], { ...dry, SCHEDULER_JOB_NAME: "custom-tick" }).out).toContain("http custom-tick");
  });

  it("status only reads", () => {
    const r = cadence(["status"], dry);
    expect(r.out).toContain("gcloud scheduler jobs describe");
    expect(r.out).toContain("gcloud run jobs describe");
    expect(r.out).not.toMatch(/jobs (update|execute)/);
  });
});
