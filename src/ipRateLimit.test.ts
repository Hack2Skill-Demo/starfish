import { describe, expect, it } from "vitest";
import { clientKey, createIpRateLimiter } from "./ipRateLimit.js";

describe("createIpRateLimiter", () => {
  it("allows perMinute requests per key in a window, refuses the rest with a retry time, and starts afresh after it", () => {
    const limiter = createIpRateLimiter({ perMinute: 3 });
    const t0 = 1_000_000;
    expect([0, 1, 2].map((i) => limiter.take("1.2.3.4", t0 + i).ok)).toEqual([true, true, true]);
    expect(limiter.take("1.2.3.4", t0 + 20_000)).toEqual({ ok: false, retryAfterSeconds: 40, firstRefusal: true });
    expect(limiter.take("1.2.3.4", t0 + 59_500)).toEqual({ ok: false, retryAfterSeconds: 1, firstRefusal: false });
    expect(limiter.take("5.6.7.8", t0 + 30_000).ok).toBe(true);
    expect(limiter.take("1.2.3.4", t0 + 60_000).ok).toBe(true);
  });

  it("never holds more than maxKeys addresses: expired ones go first, then the oldest live ones", () => {
    const limiter = createIpRateLimiter({ perMinute: 1, maxKeys: 2 });
    limiter.take("a", 0);
    limiter.take("b", 1);
    // "a" is live and the table is full: the oldest ("a") makes room for "c", so "a" starts a new window.
    limiter.take("c", 2);
    expect(limiter.take("b", 3).ok).toBe(false);
    expect(limiter.take("a", 4).ok).toBe(true);
    // Every window has expired by now: the table is cleared of them, not just of one.
    expect(limiter.take("d", 120_000).ok).toBe(true);
    expect(limiter.take("e", 120_001).ok).toBe(true);
    expect(limiter.take("d", 120_002).ok).toBe(false);
  });
});

describe("clientKey", () => {
  it("takes the LAST X-Forwarded-For entry, the one Cloud Run's front end appends, so a forged first entry buys nothing", () => {
    expect(clientKey("6.6.6.6, 203.0.113.9", "10.0.0.1")).toBe("203.0.113.9");
    expect(clientKey(["1.1.1.1", "198.51.100.7"], undefined)).toBe("198.51.100.7");
    expect(clientKey("203.0.113.9", undefined)).toBe("203.0.113.9");
  });

  it("falls back to the socket's address, unwraps an IPv4-mapped one, and says unknown with neither", () => {
    expect(clientKey(undefined, "::ffff:192.0.2.4")).toBe("192.0.2.4");
    expect(clientKey("", "127.0.0.1")).toBe("127.0.0.1");
    expect(clientKey(undefined, undefined)).toBe("unknown");
  });

  it("keys an IPv6 caller by its /64, however the address is written", () => {
    const k = "2001:db8:aa:1::/64";
    expect(clientKey("2001:db8:aa:1::1", undefined)).toBe(k);
    expect(clientKey("2001:0DB8:00aa:0001:ffff:1:2:3", undefined)).toBe(k);
    expect(clientKey(undefined, "2001:db8:aa:1:dead:beef::9%eth0")).toBe(k);
    expect(clientKey("2001:db8:aa:2::1", undefined)).not.toBe(k);
  });
});
