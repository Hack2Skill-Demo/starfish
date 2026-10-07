import { describe, expect, it } from "vitest";
import type { CheckRun } from "../integrations/githubPr.js";
import { requiredRuns, summarizeChecks } from "./reconcile.js";

const APP = "github-actions";
const run = (id: number, name: string, status: string, conclusion: string | null, app = APP): CheckRun => ({ id, name, status, conclusion, url: "", app, title: "", summary: "" });

describe("summarizeChecks: the named required checks on a PR's head", () => {
  it("passes only when every named check succeeded, and ignores checks nobody named", () => {
    const runs = [run(1, "verify", "completed", "success"), run(2, "lint", "completed", "success"), run(3, "deploy-preview", "completed", "failure")];
    expect(summarizeChecks(runs, ["verify", "lint"], APP)).toEqual({ checks: "passed", checksPassed: 2, checksRequired: 2 });
  });

  it("says failed, with the names, when one finished any other way than success", () => {
    const runs = [run(1, "verify", "completed", "failure"), run(2, "lint", "completed", "neutral"), run(3, "e2e", "in_progress", null)];
    expect(summarizeChecks(runs, ["verify", "lint", "e2e"], APP)).toEqual({ checks: "failed", checksPassed: 0, checksRequired: 3, failedChecks: "verify, lint" });
  });

  it("says pending while one still runs, and missing when one never reported: neither is passed", () => {
    expect(summarizeChecks([run(1, "verify", "completed", "success"), run(2, "lint", "queued", null)], ["verify", "lint"], APP)).toMatchObject({ checks: "pending", checksPassed: 1 });
    expect(summarizeChecks([run(1, "verify", "completed", "success")], ["verify", "lint"], APP)).toMatchObject({ checks: "missing", checksPassed: 1, checksRequired: 2 });
    expect(summarizeChecks([], ["verify"], APP)).toMatchObject({ checks: "missing", checksPassed: 0 });
  });

  it("requires EVERY run of a name to succeed: a newer success does not hide a failure, whatever the order (#205)", () => {
    expect(summarizeChecks([run(9, "verify", "completed", "success"), run(4, "verify", "completed", "failure")], ["verify"], APP)).toMatchObject({ checks: "failed", checksPassed: 0, failedChecks: "verify" });
    expect(summarizeChecks([run(4, "verify", "completed", "success"), run(9, "verify", "in_progress", null)], ["verify"], APP).checks).toBe("pending");
    expect(summarizeChecks([run(4, "verify", "completed", "success"), run(9, "verify", "completed", "success")], ["verify"], APP).checks).toBe("passed");
  });

  it("counts only the configured app's runs: another app's run of the same name neither passes nor hides a failure (#205)", () => {
    expect(summarizeChecks([run(1, "verify", "completed", "success", "some-bot")], ["verify"], APP).checks).toBe("missing");
    expect(summarizeChecks([run(1, "verify", "completed", "failure"), run(2, "verify", "completed", "success", "some-bot")], ["verify"], APP).checks).toBe("failed");
    expect(summarizeChecks([run(1, "verify", "completed", "success", "")], ["verify"], APP).checks).toBe("missing"); // no app said: not counted
    expect(summarizeChecks([run(1, "verify", "completed", "success", "our-ci")], ["verify"], "our-ci").checks).toBe("passed");
    expect(requiredRuns([run(1, "verify", "completed", "success", "some-bot"), run(2, "verify", "completed", "success"), run(3, "lint", "completed", "success")], ["verify"], APP).map((r) => r.id)).toEqual([2]);
  });

  it("says not-configured when no check is named, never passed", () => {
    expect(summarizeChecks([run(1, "verify", "completed", "success")], [], APP)).toEqual({ checks: "not-configured", checksPassed: 0, checksRequired: 0 });
  });
});
