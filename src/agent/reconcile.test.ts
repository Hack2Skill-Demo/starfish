import { describe, expect, it } from "vitest";
import type { CheckRun } from "../integrations/githubPr.js";
import { summarizeChecks } from "./reconcile.js";

const run = (id: number, name: string, status: string, conclusion: string | null): CheckRun => ({ id, name, status, conclusion, url: "", title: "", summary: "" });

describe("summarizeChecks: the named required checks on a PR's head", () => {
  it("passes only when every named check succeeded, and ignores checks nobody named", () => {
    const runs = [run(1, "verify", "completed", "success"), run(2, "lint", "completed", "success"), run(3, "deploy-preview", "completed", "failure")];
    expect(summarizeChecks(runs, ["verify", "lint"])).toEqual({ checks: "passed", checksPassed: 2, checksRequired: 2 });
  });

  it("says failed, with the names, when one finished any other way than success", () => {
    const runs = [run(1, "verify", "completed", "failure"), run(2, "lint", "completed", "neutral"), run(3, "e2e", "in_progress", null)];
    expect(summarizeChecks(runs, ["verify", "lint", "e2e"])).toEqual({ checks: "failed", checksPassed: 0, checksRequired: 3, failedChecks: "verify, lint" });
  });

  it("says pending while one still runs, and missing when one never reported: neither is passed", () => {
    expect(summarizeChecks([run(1, "verify", "completed", "success"), run(2, "lint", "queued", null)], ["verify", "lint"])).toMatchObject({ checks: "pending", checksPassed: 1 });
    expect(summarizeChecks([run(1, "verify", "completed", "success")], ["verify", "lint"])).toMatchObject({ checks: "missing", checksPassed: 1, checksRequired: 2 });
    expect(summarizeChecks([], ["verify"])).toMatchObject({ checks: "missing", checksPassed: 0 });
  });

  it("judges a re-run by its newest run, whatever order GitHub lists them in", () => {
    expect(summarizeChecks([run(9, "verify", "completed", "success"), run(4, "verify", "completed", "failure")], ["verify"]).checks).toBe("passed");
    expect(summarizeChecks([run(4, "verify", "completed", "success"), run(9, "verify", "in_progress", null)], ["verify"]).checks).toBe("pending");
  });

  it("says not-configured when no check is named, never passed", () => {
    expect(summarizeChecks([run(1, "verify", "completed", "success")], [])).toEqual({ checks: "not-configured", checksPassed: 0, checksRequired: 0 });
  });
});
