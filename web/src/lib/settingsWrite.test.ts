import { afterEach, describe, expect, it, vi } from "vitest";
import { changedSettings, newAuditId, settingsCollections } from "./settingsWrite";

describe("settingsCollections", () => {
  it("hangs the operator copy and the audit trail off the configured name, as firestore.rules expects", () => {
    expect(settingsCollections("starfish_settings")).toEqual({
      settings: "starfish_settings",
      public: "starfish_settings_public",
      audit: "starfish_settings_audit",
    });
  });
});

describe("changedSettings", () => {
  it("names the settings added, removed and altered, and ignores bookkeeping", () => {
    const before = { version: 1, revision: 1, auditId: "a", updatedBy: "u1", environment: "dev", ignoredMessages: ["x"] };
    const after = {
      version: 1,
      revision: 2,
      auditId: "b",
      updatedBy: "u2",
      environment: "prod",
      logResourceTypes: ["cloud_function"],
    };
    expect(changedSettings(before, after)).toEqual(["environment", "ignoredMessages", "logResourceTypes"]);
  });

  it("treats a first save as adding everything, and a save with no difference as no change", () => {
    expect(changedSettings(null, { version: 1, revision: 1, environment: "prod" })).toEqual(["environment"]);
    expect(changedSettings({ environment: "prod", revision: 1 }, { environment: "prod", revision: 2 })).toEqual([]);
  });

  it("compares lists and maps by value", () => {
    expect(changedSettings({ servicePatterns: { a: "b" } }, { servicePatterns: { a: "b" } })).toEqual([]);
    expect(changedSettings({ logResourceTypes: ["a"] }, { logResourceTypes: ["a", "b"] })).toEqual(["logResourceTypes"]);
  });
});

describe("newAuditId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is unique and fits the 8-64 characters firestore.rules requires", () => {
    const a = newAuditId();
    expect(a).not.toBe(newAuditId());
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it("still works where crypto.randomUUID doesn't exist (a page served over plain http)", () => {
    const real = globalThis.crypto; // captured first: the stub replaces globalThis.crypto
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => real.getRandomValues(a) });
    const id = newAuditId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toBe(newAuditId());
  });
});
