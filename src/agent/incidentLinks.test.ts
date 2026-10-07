import { describe, expect, it } from "vitest";
import { linkFromEvent } from "./incidentLinks.js";

describe("linkFromEvent", () => {
  it("reads an issue filed and a pull request opened", () => {
    expect(linkFromEvent({ stage: "issue", type: "opened", summary: "", record: { state: "opened", number: 5, url: "https://github.com/a/b/issues/5" } })).toEqual({
      kind: "issue",
      number: 5,
      url: "https://github.com/a/b/issues/5",
    });
    expect(linkFromEvent({ stage: "pr", type: "opened", summary: "", record: { opened: true, number: 7, url: "https://github.com/a/b/pull/7" } })).toEqual({
      kind: "pr",
      number: 7,
      url: "https://github.com/a/b/pull/7",
    });
  });

  it("is null for anything that did not open one, or does not say which", () => {
    expect(linkFromEvent({ stage: "pr", type: "dry-run", summary: "", record: { opened: false, reason: "dry-run" } })).toBeNull();
    expect(linkFromEvent({ stage: "issue", type: "failed", summary: "", record: { state: "failed", reason: "error" } })).toBeNull();
    expect(linkFromEvent({ stage: "pr", type: "opened", summary: "", record: { opened: false, number: 7, url: "https://x/7" } })).toBeNull();
    expect(linkFromEvent({ stage: "pr", type: "opened", summary: "", record: { opened: true, number: 0, url: "https://x/7" } })).toBeNull();
    expect(linkFromEvent({ stage: "pr", type: "opened", summary: "", record: { opened: true, number: 7, url: "javascript:alert(1)" } })).toBeNull();
    expect(linkFromEvent({ stage: "merge", type: "opened", summary: "", record: { number: 7, url: "https://x/7" } })).toBeNull();
    expect(linkFromEvent({ stage: "pr", type: "opened", summary: "" })).toBeNull();
  });
});
