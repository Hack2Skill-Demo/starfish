import { describe, it, expect } from "vitest";
import { computeErrorFingerprint } from "./fingerprint.js";
import { detectErrorType, detectService, extractErrorCode } from "./classify.js";
import { buildLogFilter, parseLogEntry, type RawLogEntry } from "./parseLogEntry.js";
import { DEFAULT_IGNORED_MESSAGES, DEFAULT_LOG_RESOURCE_TYPES } from "../config.js";
import { mergeOccurrenceBuckets, hourBucketKey, MS_PER_HOUR } from "./buckets.js";
import { redactPii, truncate } from "./redact.js";

describe("fingerprint", () => {
  it("is stable across a varying message tail", () => {
    const a = computeErrorFingerprint("api", `${"x".repeat(100)} request-id=aaa`);
    const b = computeErrorFingerprint("api", `${"x".repeat(100)} request-id=bbb`);
    expect(a).toBe(b);
  });

  it("separates different functions with identical messages", () => {
    expect(computeErrorFingerprint("api", "boom")).not.toBe(
      computeErrorFingerprint("worker", "boom")
    );
  });

  it("does not throw on malformed stored rows", () => {
    expect(() =>
      computeErrorFingerprint(undefined as unknown as string, null as unknown as string)
    ).not.toThrow();
  });
});

describe("detectErrorType preference order", () => {
  const msg = "firestore write failed";

  it("trusts the source-asserted class over everything else", () => {
    const type = detectErrorType(msg, {
      sourceErrorClass: "auth",
      errorCode: "not-found",
      httpStatus: 429,
    });
    expect(type).toBe("AuthError");
  });

  it("falls to the structured code when no source class is present", () => {
    expect(detectErrorType(msg, { errorCode: "not-found", httpStatus: 429 })).toBe("NotFoundError");
  });

  it("falls to the numeric status when no code is present", () => {
    expect(detectErrorType("unauthorized", { httpStatus: 401 })).toBe("AuthError");
  });

  it("classifies a bare provider 401 that carries no structured fields", () => {
    expect(detectErrorType("unauthorized", { httpStatus: 401 })).toBe("AuthError");
  });

  it("ignores an inherited key masquerading as a source class", () => {
    expect(detectErrorType(msg, { sourceErrorClass: "constructor" })).toBe("DatabaseError");
  });

  it("falls back to UnknownError rather than guessing", () => {
    expect(detectErrorType("something inexplicable happened")).toBe("UnknownError");
  });
});

describe("extractErrorCode", () => {
  it("lifts a canonical code out of free text, lowercased", () => {
    expect(extractErrorCode("9 FAILED-PRECONDITION: query requires an index")).toBe("failed-precondition");
  });

  it("returns undefined rather than guessing", () => {
    expect(extractErrorCode("something broke")).toBeUndefined();
  });
});

describe("detectService", () => {
  const patterns = { billing: "billing", orders: "orders" };

  it("attributes by substring", () => {
    expect(detectService("orders-updateOrder", patterns)).toBe("orders");
  });

  it("returns null instead of defaulting to the first pattern", () => {
    // The regression this guards: a default return silently blamed one service
    // for every unattributable error in the system.
    expect(detectService("platformIssueMcp", patterns)).toBeNull();
  });
});

describe("parseLogEntry", () => {
  const base: RawLogEntry = {
    metadata: {
      timestamp: "2026-09-21T00:00:00.000Z",
      resource: { labels: { function_name: "api", project_id: "proj" } },
    },
  };

  it("lifts structured fields from a JSON payload", () => {
    const parsed = parseLogEntry({
      ...base,
      data: { message: "boom", errorClass: "auth", httpStatus: 401, stack: "at x" },
    });
    expect(parsed?.sourceErrorClass).toBe("auth");
    expect(parsed?.httpStatus).toBe(401);
    expect(parsed?.stackTrace).toBe("at x");
    expect(parsed?.sourceProjectId).toBe("proj");
  });

  it("drops audit-log entries", () => {
    const parsed = parseLogEntry({
      ...base,
      data: { type_url: "type.googleapis.com/google.cloud.audit.AuditLog", value: "..." },
    });
    expect(parsed).toBeNull();
  });

  it("drops callable-framework GET-probe noise", () => {
    expect(parseLogEntry({ ...base, data: "Invalid request, unable to process" })).toBeNull();
    expect(parseLogEntry({ ...base, data: "Request has invalid method" })).toBeNull();
  });

  it("drops entries with no identifiable function", () => {
    expect(parseLogEntry({ metadata: {}, data: "boom" })).toBeNull();
  });

  it("keeps jsonPayload.error as its own field instead of losing it behind the message", () => {
    const parsed = parseLogEntry({
      ...base,
      data: { message: "send failed", error: "421 too many connections" },
    });
    // The title keys the fingerprint; the cause is what a fixer needs.
    expect(parsed?.errorMessage).toBe("send failed");
    expect(parsed?.errorDetail).toBe("421 too many connections");
  });

  it("falls back to the error when the title is empty", () => {
    const parsed = parseLogEntry({ ...base, data: { message: "", error: "boom" } });
    expect(parsed?.errorMessage).toBe("boom");
    expect(parsed?.errorDetail).toBeUndefined();
  });

  it("stringifies a structured error rather than dropping it", () => {
    const parsed = parseLogEntry({ ...base, data: { message: "rpc failed", error: { code: 9 } } });
    expect(parsed?.errorDetail).toBe('{"code":9}');
  });

  it("survives a malformed timestamp instead of poisoning the write batch", () => {
    const parsed = parseLogEntry({
      metadata: { ...base.metadata, timestamp: "not a date" },
      data: "boom",
    });
    expect(Number.isNaN(parsed?.timestamp.getTime())).toBe(false);
  });

  it("applies configured noise, not just the defaults", () => {
    expect(parseLogEntry({ ...base, data: "healthcheck failed" }, ["healthcheck"])).toBeNull();
  });
});

describe("buildLogFilter", () => {
  const since = new Date("2026-09-21T00:00:00.000Z");
  const source = { logResourceTypes: DEFAULT_LOG_RESOURCE_TYPES, ignoredMessages: DEFAULT_IGNORED_MESSAGES };

  it("excludes the same noise at query time that parsing drops", () => {
    const filter = buildLogFilter(source, since);
    for (const m of DEFAULT_IGNORED_MESSAGES) {
      expect(filter).toContain(`NOT textPayload:"${m}"`);
      expect(filter).toContain(`NOT jsonPayload.message:"${m}"`);
    }
    expect(filter).toContain('NOT logName:"cloudaudit.googleapis.com"');
    expect(filter).toContain('(resource.type="cloud_function" OR resource.type="cloud_run_revision")');
  });

  it("reads resource types from config", () => {
    const filter = buildLogFilter({ logResourceTypes: ["k8s_container"], ignoredMessages: [] }, since);
    expect(filter).toContain('(resource.type="k8s_container")');
    expect(filter).not.toContain("cloud_function");
  });

  it("escapes configured messages so they cannot break out of the literal", () => {
    const filter = buildLogFilter({ logResourceTypes: ["x"], ignoredMessages: ['say "hi"'] }, since);
    expect(filter).toContain('NOT textPayload:"say \\"hi\\""');
  });
});

describe("occurrence buckets", () => {
  it("adds into the current bucket and drops expired ones", () => {
    const now = Date.now();
    const stale = String(Math.floor(now / MS_PER_HOUR) - 200);
    const key = hourBucketKey(now);

    const merged = mergeOccurrenceBuckets({ [stale]: 5, [key]: 2 }, key, 3, now);

    expect(merged[key]).toBe(5);
    expect(merged[stale]).toBeUndefined();
  });
});

describe("redaction", () => {
  it("redacts emails", () => {
    expect(redactPii("failed for jane.doe@example.org")).toBe("failed for [redacted-email]");
  });

  it("bounds text that redaction cannot clean", () => {
    const out = truncate("y".repeat(5000), 100);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain("truncated");
  });
});
