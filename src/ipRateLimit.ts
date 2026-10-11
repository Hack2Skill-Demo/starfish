/**
 * A per-IP request limit for the admin API (src/adminApiServer.ts): the one Starfish service a stranger can reach.
 *
 * Why it exists: the service is public on purpose (a browser must reach it), and any anonymous guest can mint a VALID
 * Firebase ID token. Each call with one costs an Auth lookup (`checkRevoked`) and a Firestore read of the operator
 * record before the 403; each refused token costs a log line. Capped instances bound the bill; this keeps one caller
 * from spending all of it, and answers 429 before the body is read or a token is checked.
 *
 * In memory, per instance (the service runs at most a few), so the effective limit is this times the instance count.
 * Fixed one-minute windows. The table is bounded: past `maxKeys` the oldest entries go first, so a flood from many
 * addresses can reset some of them early but can never grow the instance's memory.
 */

const WINDOW_MS = 60_000;

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number; firstRefusal: boolean };

export interface IpRateLimiter {
  take(key: string, nowMs: number): RateDecision;
}

/** `perMinute` is a whole number above zero (config.ts checks it). */
export function createIpRateLimiter(opts: { perMinute: number; maxKeys?: number }): IpRateLimiter {
  const maxKeys = opts.maxKeys ?? 10_000;
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    take(key, nowMs) {
      const entry = windows.get(key);
      if (!entry || nowMs >= entry.resetAt) {
        if (entry) windows.delete(key);
        if (windows.size >= maxKeys) {
          for (const [k, v] of windows) if (nowMs >= v.resetAt) windows.delete(k);
          // Still full: every entry is live. Drop the oldest (a Map iterates in insertion order).
          for (const k of windows.keys()) {
            if (windows.size < maxKeys) break;
            windows.delete(k);
          }
        }
        windows.set(key, { count: 1, resetAt: nowMs + WINDOW_MS });
        return { ok: true };
      }
      entry.count++;
      if (entry.count <= opts.perMinute) return { ok: true };
      // `firstRefusal` lets the caller log once per address per window: a log line per refused request would put the
      // flood's cost into Cloud Logging instead.
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)), firstRefusal: entry.count === opts.perMinute + 1 };
    },
  };
}

/**
 * The caller's address, as the key to limit on. On Cloud Run, Google's front end APPENDS the connecting peer's address
 * to `X-Forwarded-For`, so its last entry is the one a client cannot forge; anything before it is whatever the client
 * sent. (Behind a load balancer of your own, the last entry would be the balancer, and every caller would share one
 * limit.) Without the header, the socket's address. An IPv6 address is keyed by its /64, the block one host is
 * usually given, so rotating through it does not buy a new limit.
 */
export function clientKey(forwardedFor: string | string[] | undefined, socketAddress: string | undefined): string {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  const last = header?.split(",").map((s) => s.trim()).filter(Boolean).pop();
  const raw = (last ?? socketAddress ?? "").trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  const ip = mapped ? mapped[1] : raw;
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  return `${ipv6Groups(ip).slice(0, 4).join(":")}::/64`;
}

/** The eight groups of an IPv6 address, `::` expanded, each lower-case without leading zeros. Malformed input still gives eight strings. */
function ipv6Groups(ip: string): string[] {
  const [head = "", tail] = (ip.split("%")[0] ?? "").toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0");
  return [...left, ...fill, ...right].slice(0, 8).map((g) => (g.replace(/^0+(?=.)/, "") || "0"));
}
