/**
 * The admin API (#63, #65): the authenticated door to two things only an admin may do and that the operator UI
 * and the demo's reset script cannot do by writing to the store: run ingest now (`triggerIngest`) and retire an
 * incident (`retireIncident`). This file is the request handling, with nothing of the network or Firebase in it:
 * `src/adminApiCli.ts` serves it and supplies the token check, so every rule here is testable with stubs.
 *
 * Who may call. The caller sends a Firebase ID token (`Authorization: Bearer ...`); `verifyToken` turns it
 * into a uid, and that uid is all that is believed. Whether the uid is an ADMIN is decided by the two functions
 * this calls, from the operator record (`starfish_users/{uid}.roles`), read fresh on every call, so a revoked
 * admin loses access on the next request even though their token is valid for an hour. A token in a header, not a
 * cookie, so a page on another site cannot make the browser send it (no CSRF); CORS is an allowlist of the
 * operator UI's origin and nothing else.
 *
 * What it will not do. It never says why a token failed (one 401 for missing, malformed, expired, forged, revoked or disabled), never
 * returns an error's text from inside (a failed run's message is redacted and cut), reads at most 4 KB of body, and
 * runs one ingest at a time per instance: a second request while one runs is a 409, not a pile-up.
 *
 * Public on the network on purpose: the browser must reach it (Cloud Run `--allow-unauthenticated`), and
 * everything above is what stands between the internet and the store. There is no rate limit here; the deploy caps
 * the instances, and a token check is cheap.
 */
import { redactPii, truncate } from "./ingest/redact.js";
import type { RetireResult } from "./ingest/retire.js";
import type { TriggerResult } from "./ingest/trigger.js";

export interface ApiRequest {
  method: string;
  /** The path without the query string. */
  path: string;
  authorization?: string;
  origin?: string;
  /** The parsed JSON body, or undefined when there was none (or it was not JSON). */
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON-serialisable; absent for a 204. */
  body?: unknown;
}

export interface AdminApiDeps {
  /** The uid in a valid Firebase ID token; throws for anything else. */
  verifyToken(idToken: string): Promise<{ uid: string }>;
  runIngest(actorUid: string): Promise<TriggerResult>;
  retire(incidentId: string, actorUid: string, reason: string): Promise<RetireResult>;
  /** Exact origins allowed to call from a browser. */
  allowedOrigins: readonly string[];
}

const RETIRE_RE = /^\/api\/incidents\/([A-Za-z0-9_-]{1,128})\/retire$/;
const MAX_REASON = 200;

function corsHeaders(deps: AdminApiDeps, origin: string | undefined): Record<string, string> {
  if (origin === undefined || !deps.allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function createAdminApi(deps: AdminApiDeps): (req: ApiRequest) => Promise<ApiResponse> {
  let ingestRunning = false;

  return async (req) => {
    const cors = corsHeaders(deps, req.origin);
    const reply = (status: number, body?: unknown): ApiResponse => ({
      status,
      headers: { ...cors, "cache-control": "no-store", ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body }),
    });

    if (req.method === "OPTIONS") return { status: 204, headers: cors };
    if (req.method === "GET" && req.path === "/healthz") return reply(200, { ok: true });

    const retireMatch = RETIRE_RE.exec(req.path);
    const route = req.path === "/api/ingest/run" ? "ingest" : retireMatch ? "retire" : undefined;
    if (route === undefined) return reply(404, { error: "not found" });
    if (req.method !== "POST") return reply(405, { error: "method not allowed" });

    // One answer for every way a token can be wrong: nothing here helps someone guess.
    const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(req.authorization ?? "");
    let uid: string;
    try {
      if (!match) throw new Error("no token");
      uid = (await deps.verifyToken(match[1]!)).uid;
    } catch {
      return reply(401, { error: "sign in again" });
    }

    if (route === "ingest") {
      if (ingestRunning) return reply(409, { error: "an ingest run is already in progress here" });
      ingestRunning = true;
      try {
        const result = await deps.runIngest(uid);
        if (!result.ok) return reply(result.reason === "not-admin" ? 403 : 400, { error: result.reason === "not-admin" ? "admins only" : "bad request" });
        const s = result.summary;
        return reply(200, {
          ok: true,
          outcome: s.outcome,
          windows: s.windows,
          entriesProcessed: s.totals.entriesProcessed,
          incidentsCreated: s.totals.incidentsCreated,
          incidentsUpdated: s.totals.incidentsUpdated,
          incidentsRecurred: s.totals.incidentsRecurred,
          capped: s.capped,
          ...(s.error !== undefined && { error: truncate(redactPii(s.error), 300) }),
        });
      } catch {
        // The run's own failure is recorded in last_run; what escaped is an infrastructure fault, and its text stays in the log.
        return reply(500, { error: "the run failed to start" });
      } finally {
        ingestRunning = false;
      }
    }

    const reasonRaw = typeof req.body === "object" && req.body !== null ? (req.body as { reason?: unknown }).reason : undefined;
    if (reasonRaw !== undefined && typeof reasonRaw !== "string") return reply(400, { error: "bad request" });
    const reason = (reasonRaw ?? "").slice(0, MAX_REASON);
    try {
      const result = await deps.retire(retireMatch![1]!, uid, reason);
      if (result.ok) return reply(200, { ok: true, alreadyRetired: result.alreadyRetired });
      if (result.reason === "not-admin") return reply(403, { error: "admins only" });
      if (result.reason === "no-such-incident") return reply(404, { error: "no such incident" });
      return reply(400, { error: "bad request" });
    } catch {
      return reply(500, { error: "could not retire the incident" });
    }
  };
}
