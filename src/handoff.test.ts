import { describe, expect, it } from "vitest";
import { handoffSteps } from "./handoff.js";

describe("handoffSteps", () => {
  it("lists the same five steps, in order, for either path", () => {
    for (const path of ["notify", "human"] as const) {
      expect(handoffSteps(path, true).map((s) => s.id)).toEqual(["acknowledge", "fix", "retry", "correct", "ignore"]);
    }
  });

  it("says a tried fix is the person's to finish, and a notify one has a cause outside the code", () => {
    expect(handoffSteps("human", true)[1]!.title).toBe("Fix it yourself");
    expect(handoffSteps("notify", true)[1]!.text).toContain("no code change");
  });

  it("points at the issue only when one was filed", () => {
    expect(handoffSteps("human", true)[1]!.text).toContain("the GitHub issue");
    expect(handoffSteps("human", false)[1]!.text).not.toContain("issue");
    expect(handoffSteps("human", false)[1]!.text).toContain("evidence page");
  });
});
