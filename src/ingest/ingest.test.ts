import { describe, it, expect } from "vitest";
import { canonicalFunctionName, computeErrorFingerprint, normalizeErrorMessage } from "./fingerprint.js";
import { detectErrorType, detectService, extractErrorCode } from "./classify.js";
import { buildLogFilter, isExcludedService, parseLogEntry, type RawLogEntry } from "./parseLogEntry.js";
import { DEFAULT_IGNORED_MESSAGES, DEFAULT_LOG_RESOURCE_TYPES } from "../config.js";
import { mergeOccurrenceBuckets, hourBucketKey, MS_PER_HOUR } from "./buckets.js";
import { redactCredentials, redactPii, sanitize, truncate } from "./redact.js";

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

  it("collapses per-occurrence ids, paths, timestamps and counts into one fingerprint", () => {
    const a = computeErrorFingerprint("api", "Upload failed for uploads/t1/docs/run-e53584a0-v1.pdf after 30000ms at 2026-09-24T15:04:05Z");
    const b = computeErrorFingerprint("api", "Upload failed for uploads/t2/docs/run-84456140-v2.pdf after 120ms at 2026-09-25T09:00:00Z");
    expect(a).toBe(b);
  });

  it("keeps distinct bugs apart: quoted property names and status codes still differ", () => {
    expect(computeErrorFingerprint("api", "Cannot read properties of undefined (reading 'lrn')")).not.toBe(
      computeErrorFingerprint("api", "Cannot read properties of undefined (reading 'name')")
    );
    expect(computeErrorFingerprint("api", "provider returned status 401")).not.toBe(
      computeErrorFingerprint("api", "provider returned status 500")
    );
  });

  it("normalizes before cutting at 100 chars, so the boundary can't split variants", () => {
    const head = "x".repeat(90);
    expect(computeErrorFingerprint("api", `${head} id 1234567890123`)).toBe(
      computeErrorFingerprint("api", `${head} id 99`)
    );
  });

  it("treats both spellings of one function as the same function", () => {
    expect(canonicalFunctionName("syncOrders_v2")).toBe("syncorders-v2");
    expect(computeErrorFingerprint("syncOrders_v2", "boom")).toBe(computeErrorFingerprint("syncorders-v2", "boom"));
  });

  it("normalization is idempotent", () => {
    const once = normalizeErrorMessage("fail 42 at https://x.example/a?b=1 for a@b.co uuid 123e4567-e89b-12d3-a456-426614174000");
    expect(normalizeErrorMessage(once)).toBe(once);
  });
});

describe("detectErrorType: a missing composite index (#11)", () => {
  const url = "https://console.firebase.google.com/v1/r/project/demo-shop/firestore/indexes?create_composite=Ckxwcm9qZWN0cy9kZW1v";
  const grpc = `9 FAILED_PRECONDITION: The query requires an index. You can create it here: ${url}`;

  it("is its own class when the failed precondition carries Google's create-index URL", () => {
    expect(detectErrorType(grpc)).toBe("MissingIndexError");
    expect(detectErrorType("orders query failed", { errorCode: "failed-precondition", errorDetail: grpc })).toBe("MissingIndexError");
    // The URL in the cause, kept apart from the title, still counts.
    expect(detectErrorType("listRecentOrders failed", { errorDetail: grpc })).toBe("MissingIndexError");
  });

  it("needs both the code and the URL: words alone are a keyword guess", () => {
    expect(detectErrorType("9 FAILED_PRECONDITION: The query requires an index.")).not.toBe("MissingIndexError");
    expect(detectErrorType(`see ${url}`, { errorCode: "not-found" })).toBe("NotFoundError");
    expect(detectErrorType("precondition", { errorCode: "failed-precondition" })).toBe("ValidationError");
  });

  it("still yields to a class the source asserted", () => {
    expect(detectErrorType(grpc, { sourceErrorClass: "timeout" })).toBe("TimeoutError");
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

  it("reads an object-valued message instead of titling it [object Object] (#131)", () => {
    const a = parseLogEntry({ ...base, data: { message: { code: 5, text: "boom" } } });
    const b = parseLogEntry({ ...base, data: { message: { code: 7, text: "other" } } });
    expect(a?.errorMessage).toBe('{"code":5,"text":"boom"}');
    // Two unrelated errors from one function must not share a title, and so a fingerprint.
    expect(a?.errorMessage).not.toBe(b?.errorMessage);
    const withMessage = parseLogEntry({ ...base, data: { message: { message: "inner", code: 1 } } });
    expect(withMessage?.errorMessage).toBe("inner");
  });

  it("titles a string, number or array message exactly as before, so no fingerprint moves", () => {
    expect(parseLogEntry({ ...base, data: { message: "boom" } })?.errorMessage).toBe("boom");
    expect(parseLogEntry({ ...base, data: { message: 42 } })?.errorMessage).toBe("42");
    expect(parseLogEntry({ ...base, data: { message: ["a", "b"] } })?.errorMessage).toBe("a,b");
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

  it("bounds a window at both ends when given an upper bound, and only below otherwise", () => {
    const until = new Date("2026-09-21T06:00:00.000Z");
    expect(buildLogFilter(source, since)).not.toContain("timestamp<=");
    const bounded = buildLogFilter(source, since, undefined, until);
    expect(bounded).toContain('timestamp>"2026-09-21T00:00:00.000Z"');
    expect(bounded).toContain('timestamp<="2026-09-21T06:00:00.000Z"');
  });

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

  it("scopes to a function under both of its label spellings", () => {
    const filter = buildLogFilter(source, since, "syncOrders_v2");
    expect(filter).toContain(
      '(resource.labels.function_name="syncOrders_v2" OR resource.labels.service_name="syncorders-v2")'
    );
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

  it("redacts credential-shaped values wherever they sit in the text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    expect(redactCredentials(`rejected ${jwt}`)).toBe("rejected [redacted-secret]");
    expect(redactCredentials("sent Authorization: Bearer abc.def-123")).toBe("sent Authorization: [redacted-secret]");
    expect(redactCredentials(`key ${"AIza"}${"x".repeat(35)}`)).toBe("key [redacted-secret]");
    expect(redactCredentials(null as unknown as string)).toBe("");
  });

  it("redacts credential URL parameters but keeps the URL readable", () => {
    expect(redactCredentials("GET https://s.example/o/f.png?alt=media&token=abc-123-def failed")).toBe(
      "GET https://s.example/o/f.png?alt=media&token=[redacted-secret] failed"
    );
  });

  it("sanitize, which guards everything stored and sent to the model, redacts credentials too", () => {
    expect(sanitize("401 for Bearer abc.def-123 user a@b.co")).toBe("401 for [redacted-secret] user [redacted-email]");
  });

  it("bounds text that redaction cannot clean", () => {
    const out = truncate("y".repeat(5000), 100);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain("truncated");
  });
});

describe("self-exclusion (#32)", () => {
  const entryFrom = (labels: Record<string, string>): RawLogEntry => ({
    metadata: { timestamp: "2026-09-21T00:00:00.000Z", resource: { labels } },
    data: "boom",
  });

  it("drops an entry from an excluded service, whichever label names it", () => {
    expect(parseLogEntry(entryFrom({ service_name: "starfish" }), [], ["starfish"])).toBeNull();
    expect(parseLogEntry(entryFrom({ function_name: "starfish" }), [], ["starfish"])).toBeNull();
    // A gen2 function carries both labels; either one naming it is enough.
    expect(parseLogEntry(entryFrom({ function_name: "orders", service_name: "starfish" }), [], ["starfish"])).toBeNull();
    expect(parseLogEntry(entryFrom({ function_name: "starfish", service_name: "orders" }), [], ["starfish"])).toBeNull();
  });

  it("compares on the canonical spelling: case and underscores do not slip past", () => {
    expect(parseLogEntry(entryFrom({ function_name: "Starfish_Ingest" }), [], ["starfish-ingest"])).toBeNull();
    expect(parseLogEntry(entryFrom({ service_name: "starfish-ingest" }), [], ["Starfish_Ingest"])).toBeNull();
  });

  it("keeps everything else, and keeps everything when nothing is excluded", () => {
    expect(parseLogEntry(entryFrom({ service_name: "orders" }), [], ["starfish"])).not.toBeNull();
    expect(parseLogEntry(entryFrom({ service_name: "starfish-web" }), [], ["starfish"])).not.toBeNull();
    expect(parseLogEntry(entryFrom({ service_name: "starfish" }), [], [])).not.toBeNull();
    expect(parseLogEntry(entryFrom({ service_name: "starfish" }))).not.toBeNull();
  });

  it("isExcludedService is exact, not a substring", () => {
    expect(isExcludedService("starfish-web", ["starfish"])).toBe(false);
    expect(isExcludedService(undefined, ["starfish"])).toBe(false);
    expect(isExcludedService("starfish", [])).toBe(false);
  });

  it("excludes at query time too, on both labels and both spellings", () => {
    const f = buildLogFilter({ logResourceTypes: ["cloud_run_revision"], ignoredMessages: [], excludedServices: ["Starfish_Ingest"] }, new Date(0));
    for (const spelling of ["Starfish_Ingest", "starfish-ingest"]) {
      expect(f).toContain(`NOT resource.labels.function_name="${spelling}"`);
      expect(f).toContain(`NOT resource.labels.service_name="${spelling}"`);
    }
  });

  it("excludes by prefix with a trailing *, on the canonical spelling, and not by a bare or inner *", () => {
    const ex = ["control-*", "Stub_*"];
    expect(isExcludedService("control-triggerFault", ex)).toBe(true);
    expect(isExcludedService("CONTROL_reset", ex)).toBe(true);
    expect(isExcludedService("stub-mail", ex)).toBe(true);
    expect(isExcludedService("orders-createOrder", ex)).toBe(false);
    expect(isExcludedService("controller", ex)).toBe(false); // the prefix is control-, not control
    expect(isExcludedService("orders-createOrder", ["*"])).toBe(false); // one stray * excludes nothing
    expect(isExcludedService("a*b", ["a*b"])).toBe(true); // an inner * is part of a literal name, not a pattern
    expect(isExcludedService("axxb", ["a*b"])).toBe(false);
  });

  it("excludes a prefix at query time with an anchored, case-insensitive pattern, safe against a hostile entry", () => {
    const f = buildLogFilter({ logResourceTypes: ["x"], ignoredMessages: [], excludedServices: ["control-*", 'a" OR severity>=DEBUG*'] }, new Date(0));
    expect(f).toContain('NOT resource.labels.function_name=~"(?i)^control[-_]"');
    expect(f).toContain('NOT resource.labels.service_name=~"(?i)^control[-_]"');
    expect(f).not.toContain("severity>=DEBUG");
    expect(f).toContain('=~"(?i)^aorseveritydebug"');
    // A prefix of nothing but characters the filter drops adds no clause (and so excludes nothing).
    expect(buildLogFilter({ logResourceTypes: ["x"], ignoredMessages: [], excludedServices: ['"*'] }, new Date(0))).not.toContain("=~");
  });

  it("adds no exclusion clause when none is configured, and keeps a hostile name inside its literal", () => {
    expect(buildLogFilter({ logResourceTypes: ["x"], ignoredMessages: [] }, new Date(0))).not.toContain("NOT resource.labels");
    const f = buildLogFilter({ logResourceTypes: ["x"], ignoredMessages: [], excludedServices: ['a" OR severity>=DEBUG OR "b'] }, new Date(0));
    expect(f).not.toContain("severity>=DEBUG");
    expect(f).toContain('NOT resource.labels.function_name="aORseverityDEBUGORb"');
  });
});

