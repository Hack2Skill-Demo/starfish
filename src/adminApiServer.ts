/** The HTTP shell around the admin API's handler (src/adminApi.ts): reads a bounded body, calls it, writes the answer. */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { ApiRequest, ApiResponse } from "./adminApi.js";
import { clientKey, type IpRateLimiter } from "./ipRateLimit.js";

const MAX_BODY_BYTES = 4096;
/** Twilio's webhooks post a few dozen form fields (#37): more room for those, and only for those. */
const MAX_FORM_BYTES = 16_384;

const isForm = (req: IncomingMessage): boolean => String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");

/** The JSON body (or, for a form, its fields), undefined for none or for something that is neither; null when it is too big. */
async function readBody(req: IncomingMessage): Promise<{ json?: unknown; form?: Record<string, string> } | null> {
  const form = isForm(req);
  const limit = form ? MAX_FORM_BYTES : MAX_BODY_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (form) return { form: Object.fromEntries(new URLSearchParams(text)) };
  if (size === 0 || !String(req.headers["content-type"] ?? "").toLowerCase().includes("json")) return {};
  try {
    return { json: JSON.parse(text) as unknown };
  } catch {
    return {};
  }
}

export function startAdminApiServer(
  handle: (req: ApiRequest) => Promise<ApiResponse>,
  port: number,
  opts: { limiter?: IpRateLimiter; now?: () => number; onLimited?: (key: string) => void } = {}
): Server {
  const now = opts.now ?? Date.now;
  const server = createServer((req, res) => {
    void (async () => {
      // The per-IP limit comes first (src/ipRateLimit.ts): a refused caller costs no body read, token check or store read.
      if (opts.limiter) {
        const key = clientKey(req.headers["x-forwarded-for"], req.socket.remoteAddress);
        const decision = opts.limiter.take(key, now());
        if (!decision.ok) {
          if (decision.firstRefusal) opts.onLimited?.(key);
          res.writeHead(429, { "content-type": "application/json", "retry-after": String(decision.retryAfterSeconds), "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "too many requests" }));
          req.resume();
          return;
        }
      }
      let out: ApiResponse;
      try {
        const body = await readBody(req);
        if (body === null) {
          out = { status: 413, headers: { "content-type": "application/json" }, body: { error: "too large" } };
        } else {
          const raw = req.url ?? "/";
          const path = new URL(raw, "http://localhost").pathname;
          const q = raw.indexOf("?");
          out = await handle({
            method: req.method ?? "GET",
            path,
            ...(q >= 0 && { query: raw.slice(q + 1) }),
            ...(typeof req.headers.authorization === "string" && { authorization: req.headers.authorization }),
            ...(typeof req.headers["x-firebase-appcheck"] === "string" && { appCheck: req.headers["x-firebase-appcheck"] }),
            ...(typeof req.headers["x-twilio-signature"] === "string" && { twilioSignature: req.headers["x-twilio-signature"] }),
            ...(typeof req.headers.origin === "string" && { origin: req.headers.origin }),
            ...(body.json !== undefined && { body: body.json }),
            ...(body.form !== undefined && { form: body.form }),
          });
        }
      } catch {
        out = { status: 500, headers: { "content-type": "application/json" }, body: { error: "server error" } };
      }
      res.writeHead(out.status, out.headers);
      res.end(out.text !== undefined ? out.text : out.body === undefined ? undefined : JSON.stringify(out.body));
    })();
  });
  // A run can take minutes; Cloud Run's own request timeout (set at deploy) is the limit, not this server's.
  server.requestTimeout = 0;
  server.listen(port);
  return server;
}
