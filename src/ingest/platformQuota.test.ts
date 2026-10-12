import { describe, it, expect } from "vitest";
import { describePlatformQuotaImpact, parsePlatformQuotaRejection, PLATFORM_QUOTA_FUNCTION, platformQuotaMessage } from "./platformQuota.js";
import { fingerprintOf } from "./fingerprint.js";

describe("parsePlatformQuotaRejection", () => {
  it("reads the Cloud Run quota metric from Google's rejection", () => {
    expect(
      parsePlatformQuotaRejection("The request failed because the project exceeded its quota limit for run.googleapis.com/cpu_allocation recently.")
    ).toEqual({ metric: "run.googleapis.com/cpu_allocation" });
    expect(
      parsePlatformQuotaRejection("The request failed because the project exceeded its quota limit for run.googleapis.com/Memory_Allocation")
    ).toEqual({ metric: "run.googleapis.com/memory_allocation" });
  });

  it("matches no other quota and no other platform failure", () => {
    expect(
      parsePlatformQuotaRejection("The request failed because the project exceeded its quota limit for firestore.googleapis.com/reads recently.")
    ).toBeNull();
    // Can be real saturation of one function: it keeps its own incident.
    expect(parsePlatformQuotaRejection("The request was aborted because there was no available instance.")).toBeNull();
    expect(parsePlatformQuotaRejection("Error: validation failed")).toBeNull();
    expect(parsePlatformQuotaRejection(undefined as unknown as string)).toBeNull();
  });

  it("matches only Google's whole message: an error that echoes the text is not folded out of triage", () => {
    const echoed = "The request failed because the project exceeded its quota limit for run.googleapis.com/cpu_allocation recently.";
    expect(parsePlatformQuotaRejection(`Invalid display name: ${echoed}`)).toBeNull();
    expect(parsePlatformQuotaRejection(`${echoed} DROP TABLE users`)).toBeNull();
  });
});

describe("the consolidated incident's identity", () => {
  it("is one fingerprint per metric, in its own namespace", () => {
    const cpu = fingerprintOf(PLATFORM_QUOTA_FUNCTION, platformQuotaMessage("run.googleapis.com/cpu_allocation"), "platform-quota");
    const memory = fingerprintOf(PLATFORM_QUOTA_FUNCTION, platformQuotaMessage("run.googleapis.com/memory_allocation"), "platform-quota");
    expect(cpu).toMatch(/^pq-[0-9a-f]{16}$/);
    expect(memory).not.toBe(cpu);
    // A deployed function that happened to carry the synthetic name never shares it.
    expect(fingerprintOf(PLATFORM_QUOTA_FUNCTION, platformQuotaMessage("run.googleapis.com/cpu_allocation"))).not.toBe(cpu);
  });
});

describe("describePlatformQuotaImpact", () => {
  it("lists the functions sorted, singular and plural", () => {
    expect(describePlatformQuotaImpact(new Set(["b-fn"]), 1)).toBe("In this window: 1 rejected request across 1 function: b-fn");
    expect(describePlatformQuotaImpact(new Set(["b-fn", "a-fn"]), 5)).toBe("In this window: 5 rejected requests across 2 functions: a-fn, b-fn");
  });

  it("lists at most ten and counts the rest", () => {
    const ids = new Set(Array.from({ length: 13 }, (_, i) => `fn-${String(i).padStart(2, "0")}`));
    const out = describePlatformQuotaImpact(ids, 13);
    expect(out).toContain("across 13 functions");
    expect(out).toContain("(+3 more)");
    expect(out).not.toContain("fn-12");
  });
});
