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
 * Optionally (`STARFISH_ADMIN_API_APPCHECK`, off by default), a POST must also carry a Firebase App Check token in
 * `X-Firebase-AppCheck` (#12): proof the call comes from the registered web app. It is refused with the same 401.
 *
 * What it will not do. It never says why a token failed (one 401 for missing, malformed, expired, forged, revoked or disabled), never
 * returns an error's text from inside (a failed run's message is redacted and cut), reads at most 4 KB of body, and
 * runs one ingest at a time per instance: a second request while one runs is a 409, not a pile-up.
 *
 * Phone escalation (#37): two more admin routes, `POST /api/oncall/people/<id>/send-code` and `.../confirm` (a person's
 * consent to be phoned, src/oncall/optIn.ts), under the same token rules; and Twilio's webhooks, `POST /twilio/*`, which
 * carry no ID token and are handed to src/oncall/webhooks.ts, which refuses anything without a valid Twilio signature.
 * Absent wiring (no Twilio configured): all of them are a 404.
 *
 * Public on the network on purpose: the browser must reach it (Cloud Run `--allow-unauthenticated`), and
 * everything above is what stands between the internet and the store. There is no rate limit here; the deploy caps
 * the instances, and a token check is cheap.
 */
import { redactPii, truncate } from "./ingest/redact.js";
import type { RetireResult } from "./ingest/retire.js";
import type { TriggerResult } from "./ingest/trigger.js";
import type { ConfirmResult, SendCodeResult } from "./oncall/optIn.js";
import type { TwilioWebhookRequest, TwilioWebhookResponse } from "./oncall/webhooks.js";

export interface ApiRequest {
  method: string;
  /** The path without the query string. */
  path: string;
  authorization?: string;
  /** The `X-Firebase-AppCheck` header, when the browser sent one. */
  appCheck?: string;
  origin?: string;
  /** The parsed JSON body, or undefined when there was none (or it was not JSON). */
  body?: unknown;
  /** The raw query string, without `?` (Twilio's webhooks are signed over it). */
  query?: string;
  /** A form-encoded body's parameters (Twilio's webhooks). */
  form?: Record<string, string>;
  /** The `X-Twilio-Signature` header. */
  twilioSignature?: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON-serialisable; absent for a 204. */
  body?: unknown;
  /** A body sent as it is (TwiML), instead of `body`; its content type is in `headers`. */
  text?: string;
}

/**
 * A short account of why a token was refused, for the service's own log and never for the caller: the error's code and
 * its message, cut to a bound, with every long run of token characters removed so a credential cannot reach the log.
 */
export function refusalReason(e: unknown): string {
  const code = typeof (e as { code?: unknown } | null)?.code === "string" ? (e as { code: string }).code : "";
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const text = `${code} ${message}`.replace(/[A-Za-z0-9._~+/=-]{40,}/g, "[removed]").replace(/\s+/g, " ").trim();
  return text.slice(0, 300) || "refused";
}

export interface AdminApiDeps {
  /** The uid in a valid Firebase ID token; throws for anything else. */
  verifyToken(idToken: string): Promise<{ uid: string }>;
  /**
   * Told why a call got the 401, so an operator can tell a missing Auth permission from an expired session. The reason
   * is a short, bounded string with anything token-shaped removed (`refusalReason`); it never reaches the caller, who
   * only ever sees the one message. Absent: nothing is recorded. A throw here is swallowed.
   */
  onRefused?(reason: string): void;
  runIngest(actorUid: string): Promise<TriggerResult>;
  retire(incidentId: string, actorUid: string, reason: string): Promise<RetireResult>;
  /**
   * When set, a POST must also carry a Firebase App Check token this accepts (throws for anything else): the call then
   * has to come from the registered web app, not just from someone holding an ID token. Absent: no App Check check (the
   * default; `STARFISH_ADMIN_API_APPCHECK`).
   */
  verifyAppCheck?(appCheckToken: string): Promise<void>;
  /** Exact origins allowed to call from a browser. */
  allowedOrigins: readonly string[];
  /** Phone escalation (#37): text a person their confirmation code. Absent: the route is a 404. */
  sendOnCallCode?(personId: string, actorUid: string): Promise<SendCodeResult>;
  /** Phone escalation (#37): confirm a person's number with the code they read back. Absent: a 404. */
  confirmOnCallNumber?(personId: string, code: string, actorUid: string): Promise<ConfirmResult>;
  /** Twilio's webhooks (#37), signature-checked there. Absent: `/twilio/*` is a 404. */
  twilioWebhooks?(req: TwilioWebhookRequest): Promise<TwilioWebhookResponse>;
}

const RETIRE_RE = /^\/api\/incidents\/([A-Za-z0-9_-]{1,128})\/retire$/;
const ONCALL_RE = /^\/api\/oncall\/people\/([A-Za-z0-9_-]{1,64})\/(send-code|confirm)$/;

/** What each refusal of the on-call routes becomes: a status and a message safe to show. */
const ONCALL_STATUS: Record<string, [number, string]> = {
  "not-admin": [403, "admins only"],
  "no-such-person": [404, "no such person"],
  "invalid-id": [400, "bad request"],
  "already-confirmed": [409, "already confirmed"],
  "too-soon": [429, "a code was sent less than a minute ago"],
  off: [409, "phone escalation is off on this deployment"],
  "send-failed": [502, "the text could not be sent"],
  "no-code": [409, "send a code first"],
  expired: [409, "the code expired: send a new one"],
  "wrong-code": [400, "wrong code"],
  "too-many-tries": [409, "too many wrong codes: send a new one"],
};
const MAX_REASON = 200;

function corsHeaders(deps: AdminApiDeps, origin: string | undefined): Record<string, string> {
  if (origin === undefined || !deps.allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-firebase-appcheck",
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

    // Twilio's webhooks carry no ID token: webhooks.ts checks Twilio's signature instead, before anything else.
    if (req.path.startsWith("/twilio/")) {
      if (!deps.twilioWebhooks) return reply(404, { error: "not found" });
      try {
        const out = await deps.twilioWebhooks({ method: req.method, path: req.path, query: req.query ?? "", form: req.form ?? {}, ...(req.twilioSignature !== undefined && { signature: req.twilioSignature }) });
        return { status: out.status, headers: { "content-type": out.contentType, "cache-control": "no-store" }, text: out.body };
      } catch {
        return { status: 500, headers: { "content-type": "text/plain", "cache-control": "no-store" }, text: "server error" };
      }
    }

    const retireMatch = RETIRE_RE.exec(req.path);
    const onCallMatch = ONCALL_RE.exec(req.path);
    const route = req.path === "/api/ingest/run" ? "ingest" : retireMatch ? "retire" : onCallMatch && (onCallMatch[2] === "send-code" ? deps.sendOnCallCode : deps.confirmOnCallNumber) ? "oncall" : undefined;
    if (route === undefined) return reply(404, { error: "not found" });
    if (req.method !== "POST") return reply(405, { error: "method not allowed" });

    // One answer for every way a token can be wrong: nothing here helps someone guess. That includes the App Check
    // token: a missing or rejected one is the same 401, and it is checked first, so a call from outside the web app
    // never reaches the ID-token check (one Auth lookup per call, #141).
    const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(req.authorization ?? "");
    let uid: string;
    try {
      if (deps.verifyAppCheck) {
        const appCheck = /^[A-Za-z0-9._-]{20,4096}$/.exec(req.appCheck ?? "");
        if (!appCheck) throw new Error("no app check token");
        await deps.verifyAppCheck(appCheck[0]);
      }
      if (!match) throw new Error("no token");
      uid = (await deps.verifyToken(match[1]!)).uid;
    } catch (e) {
      try {
        deps.onRefused?.(refusalReason(e));
      } catch {
        // Recording why must never change the answer.
      }
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

    if (route === "oncall") {
      const [, personId, action] = onCallMatch!;
      try {
        let result: SendCodeResult | ConfirmResult;
        if (action === "send-code") {
          result = await deps.sendOnCallCode!(personId!, uid);
        } else {
          const code = typeof req.body === "object" && req.body !== null ? (req.body as { code?: unknown }).code : undefined;
          if (typeof code !== "string" || !/^\d{6}$/.test(code)) return reply(400, { error: "bad request" });
          result = await deps.confirmOnCallNumber!(personId!, code, uid);
        }
        if (result.ok) return reply(200, { ok: true });
        const [status, error] = ONCALL_STATUS[result.reason] ?? [400, "bad request"];
        return reply(status, { error });
      } catch {
        return reply(500, { error: "the on-call change failed" });
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
