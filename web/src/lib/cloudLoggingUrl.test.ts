import { describe, it, expect, vi } from "vitest";
// The region comes from config, so it's mocked here instead of imported.
const REGION = "asia-southeast1";
vi.mock("./config", () => ({ webConfig: () => ({ functionsRegion: "asia-southeast1" }) }));

import { buildCloudLoggingUrl } from "./cloudLoggingUrl";

// The `;query=` matrix segment is double-encoded (parens pre-escaped to
// %28/%29, then the whole segment percent-encoded) so it round-trips through
// the console's two decode passes. Decode twice to recover the real query text.
function decodeQuery(url: string): string {
  const raw = url.match(/;query=([^;]+)/)![1];
  return decodeURIComponent(decodeURIComponent(raw));
}

describe("buildCloudLoggingUrl", () => {
  const base = {
    functionName: "mailQueueDrainer",
    projectId: "demo-project",
    lastOccurredAt: "2026-09-02T10:30:00.000Z",
    windowHours: 24,
  };

  it("returns null when the project is missing (legacy docs)", () => {
    expect(buildCloudLoggingUrl({ ...base, projectId: undefined })).toBeNull();
    expect(buildCloudLoggingUrl({ ...base, projectId: "" })).toBeNull();
  });

  it("targets the Logs Explorer with the row's project as the query param", () => {
    const url = buildCloudLoggingUrl(base)!;
    expect(url).toContain("https://console.cloud.google.com/logs/query");
    expect(url).toContain("?project=demo-project");
  });

  it("uses the console share-link shape: cursorTimestamp + a PTnH duration", () => {
    const url = buildCloudLoggingUrl({ ...base, windowHours: 72 })!;
    // The cursor is the row's last occurrence; the look-back is expressed as an
    // ISO-8601 duration (PT72H), exactly as the console's own Share link does.
    expect(url).toContain(`;cursorTimestamp=${base.lastOccurredAt}`);
    expect(url).toContain(";duration=PT72H");
  });

  it("never emits a timeRange (its encoded '/' bounces the console to /welcome)", () => {
    // The `%2F` in timeRange=<start>%2F<end> is decoded to `/` by the console
    // router before route matching, splitting the path segment and redirecting
    // the whole link to /welcome. Guard against regressing to that shape.
    const url = buildCloudLoggingUrl(base)!;
    expect(url).not.toContain("timeRange");
    expect(url).not.toContain("%2F");
  });

  it("does not scope to a storage bucket (defaults to the project's logs)", () => {
    // The console share-link omits storageScope for a project-scoped query;
    // including it is unnecessary and diverges from the verified-working shape.
    const url = buildCloudLoggingUrl(base)!;
    expect(url).not.toContain("storageScope");
  });

  it("falls back to a now-anchored cursor when lastOccurredAt is unparseable", () => {
    const url = buildCloudLoggingUrl({ ...base, lastOccurredAt: "not-a-date" })!;
    expect(url).toContain(";cursorTimestamp=");
    expect(url).not.toContain("Invalid Date");
  });

  it("falls back to now (not the 1970 epoch) when lastOccurredAt is null", () => {
    // `new Date(null)` is epoch 0 — a finite number — so a naive finiteness
    // check would produce a 1969→1970 cursor. lastOccurredAt is typed string
    // but can be null at runtime. Freeze the clock so the fallback resolves to a
    // known instant and the assertion is deterministic regardless of wall time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:30:00.000Z"));
    try {
      const url = buildCloudLoggingUrl({
        ...base,
        lastOccurredAt: null as unknown as string,
      })!;
      const cursorIso = url.match(/;cursorTimestamp=([^;?]+)/)![1];
      expect(cursorIso).toBe("2026-09-02T10:30:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("covers both gen1 and gen2 resource shapes at severity>=ERROR", () => {
    const url = buildCloudLoggingUrl(base)!;
    const query = decodeQuery(url);
    // gen1: camelCase function_name + region label
    expect(query).toContain(
      `resource.type="cloud_function" resource.labels.function_name="mailQueueDrainer" resource.labels.region="${REGION}"`
    );
    // gen2: lowercased service_name + location label
    expect(query).toContain(
      `resource.type="cloud_run_revision" resource.labels.service_name="mailqueuedrainer" resource.labels.location="${REGION}"`
    );
    expect(query).toContain("severity>=ERROR");
  });

  it("maps underscores to hyphens for the gen2 Cloud Run service name", () => {
    // Firebase gen2 deploys the Cloud Run service under a Cloud-Run-legal name
    // (no underscores), replacing `_` with `-`. The gen2 clause must match that.
    const url = buildCloudLoggingUrl({ ...base, functionName: "orders_update_order" })!;
    const query = decodeQuery(url);
    expect(query).toContain('resource.labels.service_name="orders-update-order"');
    // gen1 keeps the raw function_name label (only the service_name is remapped).
    expect(query).toContain('resource.labels.function_name="orders_update_order"');
  });

  it("groups the OR clauses so severity>=ERROR applies to both gen shapes", () => {
    // Cloud Logging's implicit AND binds tighter than OR, so the two resource
    // clauses must be wrapped in an outer (... OR ...) group; otherwise the
    // severity filter would only constrain the gen2 branch and gen1 would match
    // any severity.
    const url = buildCloudLoggingUrl(base)!;
    const query = decodeQuery(url);
    const orIndex = query.indexOf("OR");
    const severityIndex = query.indexOf("severity>=ERROR");
    // severity must sit OUTSIDE (after) the closing paren of the OR group.
    const closeParenBeforeSeverity = query.lastIndexOf(")", severityIndex);
    expect(closeParenBeforeSeverity).toBeGreaterThan(orIndex);
    expect(severityIndex).toBeGreaterThan(closeParenBeforeSeverity);
    // Sanity: the query opens with a group paren before the first resource clause.
    expect(query.trimStart().startsWith("(")).toBe(true);
  });

  it("uses an explicit region override when provided", () => {
    const url = buildCloudLoggingUrl({ ...base, region: "us-central1" })!;
    const query = decodeQuery(url);
    expect(query).toContain('resource.labels.region="us-central1"');
    expect(query).toContain('resource.labels.location="us-central1"');
  });

  it("URL-encodes the query segment so parens/quotes are safe", () => {
    const url = buildCloudLoggingUrl(base)!;
    // The raw query (with " and parens) must not leak into the URL verbatim.
    const matrixQuery = url.match(/;query=([^;]+)/)![1];
    expect(matrixQuery).not.toContain('"');
    expect(matrixQuery).not.toContain("(");
    expect(matrixQuery).not.toContain(")");
    expect(matrixQuery).toContain("%22"); // encoded double-quote
    // Parens are double-encoded (pre-escaped, then percent-encoded) so they
    // survive the console's two decode passes, matching a share-link exactly.
    expect(matrixQuery).toContain("%2528"); // double-encoded "("
    expect(matrixQuery).toContain("%2529"); // double-encoded ")"
  });
});
