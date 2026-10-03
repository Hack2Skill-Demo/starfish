import { describe, it, expect } from "vitest";
import { SEEDED_SECRETS } from "./testSecrets.js";
import { redact, redactSecrets, sanitize, isSensitiveKey } from "./redact.js";

describe("redactSecrets", () => {
  for (const [name, secret] of Object.entries(SEEDED_SECRETS)) {
    it(`removes a ${name}`, () => {
      const out = redactSecrets(`call failed: ${secret} (retrying)`);
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted-secret]");
      expect(out).toContain("call failed:");
    });
  }

  it("removes a private key block that truncation cut off before its END line", () => {
    const out = redactSecrets("key: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7");
    expect(out).not.toContain("MIIEowIBAAKCAQEA7");
  });

  it("removes credentials embedded in a URL, keeping scheme and host", () => {
    expect(redactSecrets("connect postgres://admin:hunter2@db.internal:5432/app failed")).toBe(
      "connect postgres://[redacted-secret]@db.internal:5432/app failed"
    );
  });

  it("removes the value of a credential-named field in text and JSON dumps", () => {
    expect(redactSecrets("login failed password=hunter2 user=bob")).toBe(
      "login failed password=[redacted-secret] user=bob"
    );
    const dump = redactSecrets('{"user":"bob","apiKey":"k-123456","client_secret": "s3cr3t"}');
    expect(dump).not.toContain("k-123456");
    expect(dump).not.toContain("s3cr3t");
    expect(dump).toContain('"user":"bob"');
  });

  it("removes the whole Authorization header value, not just the scheme", () => {
    const out = redactSecrets("Authorization: Bearer abcdef0123456789");
    expect(out).toBe("Authorization: [redacted-secret]");
  });

  it("leaves ordinary error text alone", () => {
    const text = "TypeError: Cannot read properties of undefined (reading 'uid') at handler (index.js:42:7)";
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets("Basic auth is disabled; Bearer token missing")).toBe(
      "Basic auth is disabled; Bearer token missing"
    );
  });
});

describe("redact", () => {
  it("is idempotent, so layers can each apply it", () => {
    const once = redact(`mail bob@y.org ${SEEDED_SECRETS.jwt} password=x`);
    expect(redact(once)).toBe(once);
  });

  it("redacts emails and credentials together", () => {
    const out = redact(`user bob@y.org sent ${SEEDED_SECRETS.githubToken}`);
    expect(out).toBe("user [redacted-email] sent [redacted-secret]");
  });
});

describe("sanitize", () => {
  it("redacts before bounding, so a secret straddling the cap can't survive in part", () => {
    const text = "x".repeat(3990) + " " + SEEDED_SECRETS.githubToken;
    const out = sanitize(text) ?? "";
    expect(out).not.toContain("ghp_");
  });

  it("still redacts a token glued to a preceding word character", () => {
    expect(redactSecrets(`tok_${SEEDED_SECRETS.githubToken}`)).not.toContain("ghp_");
  });

  it("passes undefined through", () => {
    expect(sanitize(undefined)).toBeUndefined();
  });
});

describe("isSensitiveKey", () => {
  it("flags credential-named keys and not ordinary ones", () => {
    for (const k of ["password", "apiKey", "access_token", "Authorization", "privateKey", "sessionId", "Set-Cookie"]) {
      expect(isSensitiveKey(k)).toBe(true);
    }
    for (const k of ["userId", "orderId", "path", "keyboard"]) expect(isSensitiveKey(k)).toBe(false);
  });
});
