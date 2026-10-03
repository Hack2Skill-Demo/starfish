import { describe, it, expect } from "vitest";
import { SEEDED_SECRETS } from "./testSecrets.js";
import { redactPii, redactCredentials, sanitize, isSensitiveKey } from "./redact.js";

describe("redactCredentials", () => {
  for (const [name, secret] of Object.entries(SEEDED_SECRETS)) {
    it(`removes a ${name}`, () => {
      const out = redactCredentials(`call failed: ${secret} (retrying)`);
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted-secret]");
      expect(out).toContain("call failed:");
    });
  }

  it("removes a private key block that truncation cut off before its END line", () => {
    const out = redactCredentials("key: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7");
    expect(out).not.toContain("MIIEowIBAAKCAQEA7");
  });

  it("removes credentials embedded in a URL, keeping scheme and host", () => {
    expect(redactCredentials("connect postgres://admin:hunter2@db.internal:5432/app failed")).toBe(
      "connect postgres://[redacted-secret]@db.internal:5432/app failed"
    );
  });

  it("removes the value of a credential-named field in text and JSON dumps", () => {
    expect(redactPii("login failed password=hunter2 user=bob")).toBe(
      "login failed password=[redacted-secret] user=bob"
    );
    const dump = redactPii('{"user":"bob","apiKey":"k-123456","client_secret": "s3cr3t"}');
    expect(dump).not.toContain("k-123456");
    expect(dump).not.toContain("s3cr3t");
    expect(dump).toContain('"user":"bob"');
  });

  it("removes the whole Authorization header value, not just the scheme", () => {
    const out = redactPii("Authorization: Bearer abcdef0123456789");
    expect(out).toBe("Authorization: [redacted-secret]");
  });

  it("leaves common auth error text alone, so fingerprints don't move", () => {
    for (const text of [
      "Unauthorized: invalid grant",
      "Token expired: please sign in again",
      "authentication failed: bad request",
      "Missing authorization header",
    ]) {
      expect(redactPii(text)).toBe(text);
    }
  });

  it("leaves ordinary error text alone", () => {
    const text = "TypeError: Cannot read properties of undefined (reading 'uid') at handler (index.js:42:7)";
    expect(redactCredentials(text)).toBe(text);
    expect(redactCredentials("Basic auth is disabled")).toBe("Basic auth is disabled");
  });
});

describe("redactCredentials", () => {
  it("leaves source code assignments intact but still removes token formats", () => {
    const code = "const token = getToken();\nconst password = process.env.DB_PASSWORD;";
    expect(redactCredentials(code)).toBe(code);
    expect(redactCredentials(`const k = "${SEEDED_SECRETS.githubToken}";`)).toBe(
      'const k = "[redacted-secret]";'
    );
  });
});

describe("redactPii", () => {
  it("is idempotent, so layers can each apply it", () => {
    const once = redactPii(`mail bob@y.org ${SEEDED_SECRETS.jwt} password=x`);
    expect(redactPii(once)).toBe(once);
  });

  it("redacts emails and credentials together", () => {
    const out = redactPii(`user bob@y.org sent ${SEEDED_SECRETS.githubToken}`);
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
    expect(redactCredentials(`tok_${SEEDED_SECRETS.githubToken}`)).not.toContain("ghp_");
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
