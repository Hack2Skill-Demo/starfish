import { describe, expect, it } from "vitest";
import { computeErrorFingerprint } from "./ingest/fingerprint.js";
import { SEEDED_SECRETS } from "./ingest/testSecrets.js";
import { scrubDocument } from "./scrub.js";

const raw = `auth failed for bob@y.org ${SEEDED_SECRETS.google}`;
const legacy = (over: Record<string, unknown> = {}) => ({
  functionName: "mailDrainer",
  environment: "prod",
  errorMessage: raw,
  errorDetail: `password=hunter2 ${SEEDED_SECRETS.bearerHeader}`,
  stackTrace: `at x ${SEEDED_SECRETS.awsId}`,
  errorName: `E ${SEEDED_SECRETS.slack}`,
  fingerprint: computeErrorFingerprint("mailDrainer", raw),
  ...over,
});

describe("scrubDocument", () => {
  it("returns null for a record that is already clean", () => {
    expect(scrubDocument({ functionName: "f", errorMessage: "send failed", errorDetail: "421 busy", fingerprint: "x" })).toBeNull();
  });

  it("redacts every text field the store redacts, and nothing else", () => {
    const result = scrubDocument(legacy({ requestId: "req-123", tenantId: "t1" }))!;
    expect(Object.keys(result.updates).sort()).toEqual(["errorDetail", "errorMessage", "errorName", "stackTrace"]);
    const written = JSON.stringify(result);
    for (const needle of ["bob@y.org", "hunter2", ...Object.values(SEEDED_SECRETS)]) {
      expect(written).not.toContain(needle);
    }
  });

  it("recomputes the fingerprint from the REDACTED message, as the store does", () => {
    const result = scrubDocument(legacy())!;
    expect(result.fingerprint).toBe(computeErrorFingerprint("mailDrainer", result.updates.errorMessage!));
    expect(result.fingerprint).not.toBe(computeErrorFingerprint("mailDrainer", raw));
  });

  it("leaves the fingerprint alone when only a field outside the fingerprint was dirty", () => {
    const result = scrubDocument(legacy({ errorMessage: "send failed", fingerprint: computeErrorFingerprint("mailDrainer", "send failed") }))!;
    expect(result.updates.errorMessage).toBeUndefined();
    expect(result.fingerprint).toBeUndefined();
  });

  it("doesn't touch a fingerprint that already matches the redacted message", () => {
    const clean = scrubDocument(legacy())!.updates.errorMessage!;
    const result = scrubDocument(legacy({ fingerprint: computeErrorFingerprint("mailDrainer", clean) }))!;
    expect(result.fingerprint).toBeUndefined();
  });

  it("ignores values that aren't strings, and a record with no function name keeps its fingerprint", () => {
    expect(scrubDocument({ errorMessage: 42, errorDetail: null, stackTrace: { a: 1 } })).toBeNull();
    const result = scrubDocument({ errorMessage: raw, fingerprint: "old" })!;
    expect(result.updates.errorMessage).toBeDefined();
    expect(result.fingerprint).toBeUndefined();
  });

  it("is idempotent: scrubbing a scrubbed record changes nothing", () => {
    const first = scrubDocument(legacy())!;
    const after = { ...legacy(), ...first.updates, fingerprint: first.fingerprint };
    expect(scrubDocument(after)).toBeNull();
  });
});
