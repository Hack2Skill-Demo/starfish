import { describe, it, expect } from "vitest";
import { SEEDED_SECRETS } from "./testSecrets.js";
import { redactPii, redactCredentials, sanitize, isSensitiveKey, sliceWellFormed, truncate, clipWellFormed } from "./redact.js";

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
    expect(redactCredentials(`const k = "${SEEDED_SECRETS.github}";`)).toBe(
      'const k = "[redacted-secret]";'
    );
  });
});

describe("redactPii", () => {
  it("is idempotent, so layers can each apply it", () => {
    const once = redactPii(`mail bob@y.org ${SEEDED_SECRETS.jwt} password=x`);
    expect(redactPii(once)).toBe(once);
  });

  it("is idempotent on a credential in a URL query parameter, with or without a scheme (#128)", () => {
    for (const text of [
      "bad callback example.com/hook?key=abc",
      "Invalid request ?api_key=XYZ",
      "GET /o/x?alt=media&token=abc&sig=xyz",
      "https://example.com/hook?key=abc",
    ]) {
      const once = redactPii(text);
      expect(once).not.toMatch(/\]\]/);
      expect(redactPii(once)).toBe(once);
    }
  });

  it("is idempotent over random mixes of the characters its patterns turn on (#128)", () => {
    // A deterministic generator, so a failure reproduces.
    let seed = 128;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    const parts = ["?", "&", "key=", "token=", "sig=", "[", "]", "a", " ", "=", "redacted-", "password:", "x@y.io", "://u:p@"];
    for (let i = 0; i < 5000; i++) {
      let text = "";
      for (let j = next() % 12; j >= 0; j--) text += parts[next() % parts.length];
      const once = redactPii(text);
      expect(redactPii(once), JSON.stringify(text)).toBe(once);
    }
  });

  it("redacts emails and credentials together", () => {
    const out = redactPii(`user bob@y.org sent ${SEEDED_SECRETS.github}`);
    expect(out).toBe("user [redacted-email] sent [redacted-secret]");
  });
});

describe("sanitize", () => {
  it("redacts before bounding, so a secret straddling the cap can't survive in part", () => {
    const text = "x".repeat(3990) + " " + SEEDED_SECRETS.github;
    const out = sanitize(text) ?? "";
    expect(out).not.toContain("ghp_");
  });

  it("still redacts a token glued to a preceding word character", () => {
    expect(redactCredentials(`tok_${SEEDED_SECRETS.github}`)).not.toContain("ghp_");
  });

  it("never splits a surrogate pair at the cap, so Firestore accepts the write (#126)", () => {
    // "😀" is two UTF-16 units; at 3999 it straddles the 4000-unit cut.
    const text = "x".repeat(3999) + "😀" + "tail";
    const out = sanitize(text) ?? "";
    // Well-formed UTF-16 survives a UTF-8 round trip; a lone surrogate becomes U+FFFD.
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
    expect(out.startsWith("x".repeat(3999) + "\n…[truncated 6 chars]")).toBe(true);
    // A pair that fits whole is kept.
    expect(truncate("x".repeat(3998) + "😀" + "tail").startsWith("x".repeat(3998) + "😀\n")).toBe(true);
    expect(sliceWellFormed("😀", 1)).toBe("");
  });

  it("passes undefined through", () => {
    expect(sanitize(undefined)).toBeUndefined();
  });
});

describe("clipWellFormed: short stored text, redacted and cut without a lone surrogate (#183)", () => {
  const wellFormed = (s: string) => Buffer.from(s, "utf8").toString("utf8") === s;

  it("never splits a pair at the cut", () => {
    const out = clipWellFormed("x".repeat(299) + "😢 Payment failed", 300);
    expect(out).toBe("x".repeat(299));
    expect(wellFormed(out)).toBe(true);
    expect(clipWellFormed("x".repeat(298) + "😢 tail", 300)).toBe("x".repeat(298) + "😢");
  });

  it("replaces a lone surrogate the text already held (parsed JSON may carry one)", () => {
    const out = clipWellFormed("before \ud83d after", 300);
    expect(wellFormed(out)).toBe(true);
    expect(out).toBe("before \ufffd after");
  });

  it("redacts before it cuts", () => {
    expect(clipWellFormed(`mail ops@example.com ${SEEDED_SECRETS.github}`, 300)).not.toContain("ops@example.com");
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

// #96: a long untrusted log field must not block the event loop. Before the fix, 100 KB of one
// character took ~10 s here and `"a-".repeat(50_000)` ~12 s; linear time is a few ms. The budget is
// far above that and far below the old cost, so a slow CI machine does not flake it.
describe("redaction time", () => {
  const BUDGET_MS = 1500;
  const runs: Record<string, string> = {
    "one word character": "y".repeat(100_000),
    "dash-joined": "a-".repeat(50_000),
    "dot-joined": "a.".repeat(50_000),
    "no @ in a local-part-shaped run": "a_%+".repeat(25_000),
    "keyword-free key-shaped run": "x.".repeat(50_000) + "=",
    "repeated keyword": "token ".repeat(20_000),
    "repeated scheme": "a.http://".repeat(10_000),
  };
  for (const [name, input] of Object.entries(runs)) {
    it(`handles 100 KB of ${name} quickly`, () => {
      const t = Date.now();
      redactPii(input);
      sanitize(input);
      expect(Date.now() - t).toBeLessThan(BUDGET_MS);
    });
  }

  it("still redacts what sits after a long run", () => {
    const out = redactPii(`${"y".repeat(100_000)} password=hunter2 mail ops@example.com ${"a-".repeat(50_000)}`);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("ops@example.com");
  });
});

describe("redaction shapes the linear-time rewrite must keep", () => {
  it("redacts a second address glued to the first by a character only the local part allows", () => {
    const out = redactPii("a@b.com_c@d.com");
    expect(out).not.toContain("c@d.com");
    expect(out).toBe("[redacted-email][redacted-email]");
  });

  it("leaves a lone @domain alone and keeps the text around an address", () => {
    expect(redactPii("see @example.com now")).toBe("see @example.com now");
    expect(redactPii("mail ops.team+x@example.co.uk, thanks")).toBe("mail [redacted-email], thanks");
  });

  it("redacts userinfo whatever dots and dashes precede the scheme", () => {
    for (const prefix of ["", "x.", "-", "a-b.", "\"'."]) {
      const out = redactPii(`${prefix}postgres://admin:s3cretPw@db.internal/app`);
      expect(out).not.toContain("s3cretPw");
    }
  });

  it("redacts a credential key whatever precedes it in the name, keeping the name", () => {
    expect(redactPii("x-api-token: abc123")).toBe("x-api-token: [redacted-secret]");
    expect(redactPii("db.password=hunter2")).toBe("db.password=[redacted-secret]");
    expect(redactPii('{"client_secret":"abc"}')).toBe('{"client_secret":[redacted-secret]}');
  });
});
