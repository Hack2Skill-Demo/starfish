/** The HTTP shell around the admin API's handler (src/adminApi.ts): reads a bounded body, calls it, writes the answer. */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { ApiRequest, ApiResponse } from "./adminApi.js";

const MAX_BODY_BYTES = 4096;

/** The JSON body, undefined for none or for something that is not JSON; null when it is too big. */
async function readBody(req: IncomingMessage): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  if (size === 0 || !String(req.headers["content-type"] ?? "").toLowerCase().includes("json")) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function startAdminApiServer(handle: (req: ApiRequest) => Promise<ApiResponse>, port: number): Server {
  const server = createServer((req, res) => {
    void (async () => {
      let out: ApiResponse;
      try {
        const body = await readBody(req);
        if (body === null) {
          out = { status: 413, headers: { "content-type": "application/json" }, body: { error: "too large" } };
        } else {
          const path = new URL(req.url ?? "/", "http://localhost").pathname;
          out = await handle({
            method: req.method ?? "GET",
            path,
            ...(typeof req.headers.authorization === "string" && { authorization: req.headers.authorization }),
            ...(typeof req.headers.origin === "string" && { origin: req.headers.origin }),
            ...(body !== undefined && { body }),
          });
        }
      } catch {
        out = { status: 500, headers: { "content-type": "application/json" }, body: { error: "server error" } };
      }
      res.writeHead(out.status, out.headers);
      res.end(out.body === undefined ? undefined : JSON.stringify(out.body));
    })();
  });
  // A run can take minutes; Cloud Run's own request timeout (set at deploy) is the limit, not this server's.
  server.requestTimeout = 0;
  server.listen(port);
  return server;
}
