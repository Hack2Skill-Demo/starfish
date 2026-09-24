import { describe, it, expect } from "vitest";
import {
  COUNTER_CHECK_MAX,
  fetchRecentErrorSamples,
  runLogCounterCheck,
  toSample,
  type EntryReader,
} from "./counterCheck.js";
import { DEFAULT_IGNORED_MESSAGES, DEFAULT_LOG_RESOURCE_TYPES } from "../config.js";

const source = {
  logResourceTypes: DEFAULT_LOG_RESOURCE_TYPES,
  ignoredMessages: DEFAULT_IGNORED_MESSAGES,
};
const nowMs = Date.parse("2026-09-21T00:00:00.000Z");

/** Serves `pages` in order, recording each request. */
function reader(pages: number[]): EntryReader & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  let i = 0;
  return {
    requests,
    async getEntries(request: object) {
      requests.push(request as Record<string, unknown>);
      const size = pages[i] ?? 0;
      i += 1;
      // Like the real client: the next-page request does NOT carry autoPaginate,
      // because @google-cloud/logging deletes it before handing the request on.
      const next = i < pages.length ? { filter: (request as { filter?: string }).filter, pageToken: `p${i}` } : null;
      return [Array.from({ length: size }, () => ({})), next];
    },
  };
}

describe("runLogCounterCheck", () => {
  it("counts across pages, scoped to the one function", async () => {
    const logging = reader([500, 120]);
    const check = await runLogCounterCheck(logging, source, "mailDrainer", { nowMs });

    expect(check).toMatchObject({ window: "24h", count: 620 });
    expect(check?.capped).toBeUndefined();
    expect(check?.filter).toContain('resource.labels.function_name="mailDrainer"');
    expect(check?.filter).toContain('timestamp>"2026-09-20T00:00:00.000Z"');
  });

  it("stops at the cap and says so, rather than paging into a timeout", async () => {
    const logging = reader([500, 500, 500, 500]);
    const check = await runLogCounterCheck(logging, source, "noisy", { nowMs });

    expect(check).toMatchObject({ count: COUNTER_CHECK_MAX, capped: true });
    expect(logging.requests).toHaveLength(2);
  });

  it("keeps every page bounded — the next-page request would otherwise auto-paginate", async () => {
    const logging = reader([500, 100, 100]);
    await runLogCounterCheck(logging, source, "fn", { nowMs });
    expect(logging.requests).toHaveLength(3);
    for (const r of logging.requests) expect(r.autoPaginate).toBe(false);
  });

  it("returns null on a Logging failure — missing is not the same as zero", async () => {
    const failing: EntryReader = {
      getEntries: () => Promise.reject(new Error("PERMISSION_DENIED")),
    };
    expect(await runLogCounterCheck(failing, source, "fn", { nowMs })).toBeNull();
  });

  it("refuses a name no function could have, rather than counting a rewritten one", async () => {
    // Also the filter-injection guard: nothing outside the label charset gets in.
    const logging = reader([5]);
    expect(await runLogCounterCheck(logging, source, 'fn" OR severity>=DEBUG OR "', { nowMs })).toBeNull();
    expect(await runLogCounterCheck(logging, source, "my.fn", { nowMs })).toBeNull();
    expect(logging.requests).toHaveLength(0);
  });
});

describe("toSample", () => {
  const meta = { timestamp: "2026-09-21T00:00:00.000Z", labels: { execution_id: "exec-1" } };

  it("keeps the underlying cause separately from the title", () => {
    const sample = toSample({
      metadata: meta,
      data: {
        message: "managePost [list]: unexpected",
        error: "9 FAILED_PRECONDITION: The query requires an index",
      },
    });
    expect(sample?.message).toBe("managePost [list]: unexpected");
    expect(sample?.error).toBe("9 FAILED_PRECONDITION: The query requires an index");
  });

  it("takes the message out of a logged Error object instead of [object Object]", () => {
    const sample = toSample({ metadata: meta, data: { error: { message: "boom", stack: "at x" } } });
    expect(sample?.message).toBe("boom");
    expect(sample?.error).toBeUndefined();
  });

  it("never passes credential-shaped fields or emails to the model", () => {
    const sample = toSample({
      metadata: meta,
      data: { message: "failed for a@b.co", apiKey: "sk-live", authToken: "t", tenantId: "acme" },
    });
    expect(sample?.message).toBe("failed for [redacted-email]");
    expect(sample?.context).toEqual({ execution_id: "exec-1", tenantId: "acme" });
  });

  it("drops the credential keys that don't say 'token'", () => {
    const sample = toSample({
      metadata: meta,
      data: { message: "m", auth: "a", privateKey: "k", accessKey: "k", jwt: "j", signature: "s", sessionId: "s" },
    });
    expect(sample?.context).toEqual({ execution_id: "exec-1" });
  });

  it("redacts credential-shaped values whatever key they sit under", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    const sample = toSample({
      metadata: meta,
      data: { message: `rejected ${jwt}`, header: "Bearer abc.def-123", detail: "AIza" + "x".repeat(35) },
    });
    expect(sample?.message).toBe("rejected [redacted-secret]");
    expect(sample?.context.header).toBe("[redacted-secret]");
    expect(sample?.context.detail).toBe("[redacted-secret]");
  });

  it("drops audit-log entries", () => {
    expect(toSample({ metadata: meta, data: { type_url: "google.cloud.audit.AuditLog" } })).toBeNull();
  });
});

describe("fetchRecentErrorSamples", () => {
  it("returns [] on a Logging failure", async () => {
    const failing: EntryReader = { getEntries: () => Promise.reject(new Error("x")) };
    expect(await fetchRecentErrorSamples(failing, source, "fn", { nowMs })).toEqual([]);
  });
});
