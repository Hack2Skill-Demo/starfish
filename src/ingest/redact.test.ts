import { describe, it, expect } from "vitest";
import { SEEDED_SECRETS } from "./testSecrets.js";
import { redactPii, redactCredentials, sanitize, isSensitiveKey, sliceWellFormed, truncate, clipWellFormed, redactHead, redactTail } from "./redact.js";

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
    const parts = [
      "?", "&", "key=", "token=", "sig=", "[", "]", "a", " ", "=", "redacted-", "password:", "x@y.io", "://u:p@",
      // #298's shapes
      "Cookie: ", "Authorization: ", "Basic ", '\\"', '"', "pass", "sid:", "\n", "+1", "5551234567", "-", "(",
    ];
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

  it("flags the short credential names as a whole name or its last part, not inside a word (#298)", () => {
    for (const k of ["pass", "pwd", "sid", "otp", "db_pass", "userPwd", "connect.sid", "DB_PASS", "sessionId"]) {
      expect(isSensitiveKey(k), k).toBe(true);
    }
    for (const k of ["bypass", "passes", "compass", "considered", "otpEnabledAt", "sidebar"]) expect(isSensitiveKey(k), k).toBe(false);
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

describe("redactHead and redactTail: a cut never keeps part of a secret (#18)", () => {
  /** The part of a secret that identifies it: its longest run without whitespace. */
  const core = (secret: string) => secret.split(/\s+/).sort((a, b) => b.length - a.length)[0]!;
  /** Does `out` hold 8 or more characters in a row of the secret's core? */
  const leaks = (out: string, secret: string) => {
    const c = core(secret);
    for (let i = 0; i + 8 <= c.length; i++) if (out.includes(c.slice(i, i + 8))) return true;
    return false;
  };
  const many = `${SEEDED_SECRETS.github}\n`.repeat(40);

  for (const [name, secret] of Object.entries(SEEDED_SECRETS)) {
    it(`redactHead: a cut anywhere inside a ${name} keeps none of it`, () => {
      const lead = "call failed at step 3:\n";
      for (let k = 1; k < secret.length; k++) {
        const out = redactHead(`${lead}${secret} and then more`, lead.length + k);
        expect(leaks(out, secret), `cut after ${k}: ${JSON.stringify(out)}`).toBe(false);
        expect(out.startsWith("call failed at step")).toBe(true);
      }
    });

    it(`redactTail: a cut anywhere inside a ${name} keeps none of it`, () => {
      const lead = "first line\n";
      const text = `${lead}${secret}\n${".".repeat(200)}\n`;
      for (let k = 1; k < secret.length; k++) {
        // The kept tail starts inside the secret: the window it was redacted in held all of it.
        const out = redactTail(text, text.length - lead.length - k);
        expect(leaks(out, secret), `cut after ${k}: ${JSON.stringify(out)}`).toBe(false);
        // The text already started inside it (what a stream's bounded buffer keeps): its first line is dropped.
        const fromCut = redactTail(`${secret.slice(k)}\n${many}`, 10_000, true);
        expect(leaks(fromCut, secret), `stream cut after ${k}: ${JSON.stringify(fromCut)}`).toBe(false);
      }
    });
  }

  it("redactTail: a secret cut by the window's own edge stays out even when redaction shrinks what follows", () => {
    const body = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVow".padEnd(38, "Q");
    const pem = `-----BEGIN ${"PRIVATE KEY"}-----\n${"Zm9v".repeat(50)}\n${body}\n-----END ${"PRIVATE KEY"}-----\n`;
    const text = `${pem}${many}`;
    // The window (twice what is kept) starts inside the key, and the 40 tokens after it shrink to 18 characters each.
    for (const max of [100, 150, 400, 900]) {
      const out = redactTail(text, max);
      expect(out).not.toContain(body.slice(-8));
      expect(out).not.toContain("Zm9vZm9v");
      expect(out).not.toContain("-----END");
      expect(out).not.toContain(SEEDED_SECRETS.github);
      expect(out.length).toBeLessThanOrEqual(max);
    }
  });

  it("are the plain redaction when nothing is cut, and bounded when something is", () => {
    const text = `boom ${SEEDED_SECRETS.github} jane.roe@example.com`;
    expect(redactHead(text, 1000)).toBe(redactPii(text));
    expect(redactTail(text, 1000)).toBe(redactPii(text));
    expect(redactHead("a ".repeat(5000), 100).length).toBeLessThanOrEqual(100);
    expect(redactTail("a\n".repeat(5000), 100).length).toBeLessThanOrEqual(100);
    expect(redactTail("tail", 10)).toBe("tail");
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

// #298: shapes the policy missed. Each first case is the issue's own example.
describe("redactPii: headers, escaped JSON, short key names and phone numbers (#298)", () => {
  it("removes a Basic credential with its scheme, not just the scheme word", () => {
    expect(redactPii("Authorization: Basic dXNlcjpzZWNyZXRwYXNzd29yZA==")).toBe("Authorization: [redacted-secret]");
    expect(redactPii("proxy-authorization=Digest abc123 failed")).toBe("proxy-authorization=[redacted-secret] failed");
    expect(redactPii("authorization: abc123, retrying")).toBe("authorization: [redacted-secret], retrying");
    expect(redactPii('{"authorization":"Basic dXNlcjpw"}')).toBe('{"authorization":[redacted-secret]}');
    // A JWT already redacted after the scheme does not leave a stray `]` behind.
    const once = redactPii(`Authorization: Basic ${SEEDED_SECRETS.jwt}`);
    expect(once).not.toMatch(/\]\]/);
    expect(redactPii(once)).toBe(once);
  });

  it("reads cookie and authorization only as whole header names, so `nocookie:` keeps its text", () => {
    expect(redactPii("nocookie: true and the rest")).toBe("nocookie: true and the rest");
    expect(redactPii("xauthorization: pending review")).toBe("xauthorization: pending review");
    expect(redactPii("Cookie: a=1; b=2")).not.toContain("b=2");
  });

  it("removes every cookie in a Cookie header, to the end of the line", () => {
    expect(redactPii("Cookie: theme=dark; __session=SECRETVALUE123; connect.sid=abc\nnext line")).toBe(
      "Cookie: [redacted-secret]\nnext line"
    );
    expect(redactPii("Set-Cookie: sid=abc; Path=/; HttpOnly")).toBe("Set-Cookie: [redacted-secret]");
    expect(redactPii('{"cookie":"a=1; b=2","user":"bob"}')).toBe('{"cookie":[redacted-secret],"user":"bob"}');
    // A `Cookie:` that ends its line does not take the next one.
    expect(redactPii("Cookie:\nTypeError: x")).toBe("Cookie:\nTypeError: x");
  });

  it("removes a value in escaped JSON (a JSON dump logged inside a string)", () => {
    expect(redactPii('{\\"password\\":\\"hunter2\\",\\"user\\":\\"bob\\"}')).toBe(
      '{\\"password\\":[redacted-secret],\\"user\\":\\"bob\\"}'
    );
    expect(redactPii('{\\"token\\": \\"abc\\"}')).not.toContain("abc");
    expect(redactPii('{\\"cookie\\":\\"a=1; b=2\\"}')).toBe('{\\"cookie\\":[redacted-secret]}');
    expect(redactPii('{\\"authorization\\":\\"Basic dXNlcjpw\\"}')).toBe('{\\"authorization\\":[redacted-secret]}');
  });

  it("removes the value of session, sid, otp, pwd and pass keys", () => {
    for (const [text, want] of [
      ["sessionId=abc123 user=bob", "sessionId=[redacted-secret] user=bob"],
      ['{"session_id":"abc"}', '{"session_id":[redacted-secret]}'],
      ["session: abc", "session: [redacted-secret]"],
      ["sid=abc", "sid=[redacted-secret]"],
      ["connect.sid=s%3Aabc", "connect.sid=[redacted-secret]"],
      ["otp: 123456", "otp: [redacted-secret]"],
      ['{"pwd":"hunter2"}', '{"pwd":[redacted-secret]}'],
      ["db_pass=hunter2", "db_pass=[redacted-secret]"],
      ["userPass=hunter2", "userPass=[redacted-secret]"],
      ["DB_PASS=hunter2", "DB_PASS=[redacted-secret]"],
    ] as const) {
      expect(redactPii(text), text).toBe(want);
    }
  });

  it("leaves words that merely contain a short key name alone", () => {
    for (const text of ["bypass=true", "compass: north", "passed: 3", "Sessions: 4", "Session expired, sign in again"]) {
      expect(redactPii(text), text).toBe(text);
    }
  });

  it("removes phone numbers written with a + country code", () => {
    for (const phone of ["+15551234567", "+1 555 123 4567", "+1-555-123-4567", "+44 (20) 7946 0958", "+33 6 12 34 56 78"]) {
      expect(redactPii(`call ${phone} failed`), phone).toBe("call [redacted-phone] failed");
    }
    expect(redactPii('{"phone":"+15551234567"}')).toBe('{"phone":"[redacted-phone]"}');
    expect(redactPii("tel:+15551234567")).toBe("tel:[redacted-phone]");
  });

  it("leaves timestamps, offsets, ids, ports, versions and counts that are not phone numbers alone", () => {
    for (const text of [
      "at 2026-10-11T12:00:00+00:00 the call failed",
      "at 2026-10-11T12:00:00.000+0000",
      "offset +05:30 and +10:00",
      "version 1.0.0+20130313144700",
      "connect ECONNREFUSED 10.0.0.12:8080",
      "order 123456789012 not found",
      "id +123456789012345678 is too long for a number",
      "duration +12345678ms",
      "added +1234 rows",
      "host +192.168.100.200",
      "x+15551234567",
    ]) {
      expect(redactPii(text), text).toBe(text);
    }
    // Plus-addressing is one email address, not an address and a number.
    expect(redactPii("mail bob+15551234567@example.com")).toBe("mail [redacted-email]");
  });

  it("is idempotent on every new shape", () => {
    for (const text of [
      "Authorization: Basic dXNlcjpw",
      "Cookie: a=1; b=2",
      '{\\"password\\":\\"hunter2\\"}',
      "userPass=x sid=y otp=1",
      "call +1 555 123 4567",
    ]) {
      const once = redactPii(text);
      expect(redactPii(once), text).toBe(once);
    }
  });

  it("redacts before it truncates, so a phone or cookie straddling the cap does not survive in part", () => {
    const out = sanitize("x".repeat(3990) + " +15551234567 Cookie: a=SECRETVALUE123") ?? "";
    expect(out).not.toContain("5551234567");
    expect(out).not.toContain("SECRETVALUE");
  });

  it("stays fast over long runs of the new patterns' characters (#96)", () => {
    for (const input of [
      "+1 ".repeat(33_000),
      "+1-(2)".repeat(16_000),
      "Authorization: ".repeat(6_000),
      "authorization:a ".repeat(6_000),
      "cookie=".repeat(14_000),
      '\\"pass\\":'.repeat(10_000),
      "Pass=".repeat(20_000),
    ]) {
      const t = Date.now();
      redactPii(input);
      expect(Date.now() - t, input.slice(0, 20)).toBeLessThan(1500);
    }
  });
});
