/**
 * The admin API (#63, #65): the authenticated door to the things only an admin may do and that the operator UI
 * and the demo's reset script cannot do by writing to the store: run ingest now (`triggerIngest`), retire an
 * incident (`retireIncident`) and, where an agent job is named, start one agent pass (`triggerAgentPass`, #276).
 * This file is the request handling, with nothing of the network or Firebase in it:
 * `src/adminApiCli.ts` serves it and supplies the token check, so every rule here is testable with stubs.
 *
 * Who may call. The caller sends a Firebase ID token (`Authorization: Bearer ...`); `verifyToken` turns it
 * into a uid, and that uid is all that is believed. Whether the uid is an ADMIN is decided from the operator record
 * (`starfish_users/{uid}.roles`), read fresh on every call, so a revoked admin loses access on the next request even
 * though their token is valid for an hour. It is checked here (`isAdmin`) right after the token and BEFORE anything
 * else, the one-at-a-time locks included (#305): otherwise anyone signed in, an anonymous guest too, could keep "Run
 * ingest now" held so an admin got a 409, and learn from the 409 that a run was in progress. Each action checks the
 * role again itself (src/ingest/trigger.ts, src/agent/trigger.ts, retire.ts, optIn.ts). A token in a header, not a
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
 * "Run agent now" (#276): `POST /api/agent/run` starts the deployed agent job once and answers 202 when Cloud Run
 * accepted the start; it never waits for the pass, which reports itself in its cycles. The pass is the scheduled one
 * (same switches, caps and leases), so this adds no way for Starfish to act that a schedule tick does not have. One
 * start at a time per instance (a 409 otherwise); a start Cloud Run refuses is a 502. No agent job named: a 404.
 *
 * Phone escalation (#37): two more admin routes, `POST /api/oncall/people/<id>/send-code` and `.../confirm` (a person's
 * consent to be phoned, src/oncall/optIn.ts), under the same token rules; and Twilio's webhooks, `POST /twilio/*`, which
 * carry no ID token and are handed to src/oncall/webhooks.ts, which refuses anything without a valid Twilio signature.
 * Absent wiring (no Twilio configured): all of them are a 404.
 *
 * The public demo's open actions (src/publicDemo.ts): wired (`publicDemo`) only where a deployment turns them on
 * (`STARFISH_PUBLIC_DEMO_ACTIONS`, off by default), and on for a call only while the runtime settings' environment is a
 * public one (resolved per call, #430). Then, and only for an ANONYMOUS caller (the
 * verified token's sign-in provider, never anything the caller says), `POST /api/ingest/run` and `POST /api/agent/run`
 * skip the admin check, and three more routes exist: `POST /api/incidents/<id>/status` (`{ action }`: acknowledge,
 * resolve, ignore, reopen), `.../retriage` and `.../correction` (`{ level, note? }`). Each call is first claimed against
 * the hourly limits (src/publicDemoLimit.ts: per address, and for agent passes per deployment): over one, a 429 with a
 * short reason and `retry-after`. Retire, the on-call routes and everything else stay admin-only for everyone. Off, the
 * three routes are a 404 and an anonymous caller gets the 403 it always got. Built and tested with stubs; never run on
 * a real project.
 *
 * Public on the network on purpose: the browser must reach it (Cloud Run `--allow-unauthenticated`), and
 * everything above is what stands between the internet and the store. The per-address rate limit is the HTTP shell's
 * (src/adminApiServer.ts), not this file's; the deploy caps the instances.
 */
import { redactPii, truncate } from "./ingest/redact.js";
import type { RetireResult } from "./ingest/retire.js";
import type { TriggerResult } from "./ingest/trigger.js";
import type { RunSummary } from "./ingest/run.js";
import type { AgentTriggerResult } from "./agent/trigger.js";
import type { ConfirmResult, SendCodeResult } from "./oncall/optIn.js";
import type { TwilioWebhookRequest, TwilioWebhookResponse } from "./oncall/webhooks.js";
import { isIncidentAction, type IncidentAction } from "./incidentActions.js";
import { isLevel } from "./triageRules.js";
import type { PublicIncidentResult } from "./publicDemo.js";
import type { ClaimResult, PublicActionKind } from "./publicDemoLimit.js";

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
  /** The caller's address as the HTTP shell keys it (src/ipRateLimit.ts `clientKey`): what the public demo's limits count. */
  clientKey?: string;
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

/**
 * The public demo's open actions (src/publicDemo.ts), for an anonymous caller only, bound to the configuration one call
 * resolved; each action checks the switch again itself.
 */
export interface PublicDemoDeps {
  /** Claim one call against the hourly limits (src/publicDemoLimit.ts). Throws only when the store does. */
  claim(kind: PublicActionKind, clientKey: string): Promise<ClaimResult>;
  setStatus(incidentId: string, action: IncidentAction, uid: string): Promise<PublicIncidentResult>;
  requestRetriage(incidentId: string, uid: string): Promise<PublicIncidentResult>;
  /** `level` and `note` as the caller sent them: the action validates them. */
  correct(incidentId: string, level: unknown, note: unknown, uid: string): Promise<PublicIncidentResult>;
  runIngest(uid: string): Promise<TriggerResult | { ok: false; reason: "off" }>;
  /** Absent where no agent job is named: a visitor's agent start is then a 404, as an admin's is. */
  runAgent?(uid: string): Promise<AgentTriggerResult | { ok: false; reason: "off" }>;
}

export interface AdminApiDeps {
  /**
   * The uid in a valid Firebase ID token, and whether its sign-in provider is `anonymous` (a guest of the public demo);
   * throws for anything else.
   */
  verifyToken(idToken: string): Promise<{ uid: string; anonymous?: boolean }>;
  /**
   * Told why a call got the 401, so an operator can tell a missing Auth permission from an expired session. The reason
   * is a short, bounded string with anything token-shaped removed (`refusalReason`); it never reaches the caller, who
   * only ever sees the one message. Absent: nothing is recorded. A throw here is swallowed.
   */
  onRefused?(reason: string): void;
  /**
   * Whether the uid is an admin now, from the operator record (src/adminAuth.ts). Asked before any route takes a lock
   * or calls an action (#305); false, or a throw, and the call is refused (403, or 500) having touched nothing.
   */
  isAdmin(uid: string): Promise<boolean>;
  runIngest(actorUid: string): Promise<TriggerResult>;
  retire(incidentId: string, actorUid: string, reason: string): Promise<RetireResult>;
  /**
   * Start one agent pass (#276): the admin check, the audit entry, then the job start. Resolves once the start was
   * accepted; throws when it was not. Absent (no agent job named on this deployment): the route is a 404.
   */
  runAgent?(actorUid: string): Promise<AgentTriggerResult>;
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
  /**
   * The public demo's open actions, for anonymous callers: asked once per anonymous call to one of their routes, it
   * resolves the runtime settings and returns the actions bound to them, or null when they are off for this call (the
   * call is then answered as if they were not wired; a throw is a 500). Absent (the default): none, and their routes are
   * a 404.
   */
  publicDemo?: () => Promise<PublicDemoDeps | null>;
}

const RETIRE_RE = /^\/api\/incidents\/([A-Za-z0-9_-]{1,128})\/retire$/;
const ONCALL_RE = /^\/api\/oncall\/people\/([A-Za-z0-9_-]{1,64})\/(send-code|confirm)$/;
const PUBLIC_INCIDENT_RE = /^\/api\/incidents\/([A-Za-z0-9_-]{1,128})\/(status|retriage|correction)$/;

/** What each refusal of a visitor's incident action becomes: a status and a message safe to show. */
const PUBLIC_INCIDENT_STATUS: Record<string, [number, string]> = {
  off: [403, "the public demo's actions are off"],
  "invalid-id": [400, "bad request"],
  "bad-request": [400, "bad request"],
  "no-such-incident": [404, "no such incident"],
  "not-applicable": [409, "that change does not apply to this incident as it is now"],
};

/** What a finished ingest run reports to the caller: its numbers, a failed run's message redacted and cut. */
function ingestBody(s: RunSummary): Record<string, unknown> {
  return {
    ok: true,
    outcome: s.outcome,
    windows: s.windows,
    entriesProcessed: s.totals.entriesProcessed,
    incidentsCreated: s.totals.incidentsCreated,
    incidentsUpdated: s.totals.incidentsUpdated,
    incidentsRecurred: s.totals.incidentsRecurred,
    capped: s.capped,
    ...(s.error !== undefined && { error: truncate(redactPii(s.error), 300) }),
  };
}

/** A 429's reason, safe to show: which limit, and when it lifts. */
function limitMessage(r: Extract<ClaimResult, { ok: false }>): string {
  const minutes = Math.max(1, Math.ceil(r.retryAfterSeconds / 60));
  const when = `try again in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  return r.limit === "deployment"
    ? `the public demo's hourly limit of agent passes is reached: ${when}`
    : `the public demo's hourly limit for your address is reached: ${when}`;
}

/** What each refusal of the on-call routes becomes: a status and a message safe to show. */
const ONCALL_STATUS: Record<string, [number, string]> = {
  "not-admin": [403, "admins only"],
  "no-such-person": [404, "no such person"],
  "invalid-id": [400, "bad request"],
  "already-confirmed": [409, "already confirmed"],
  "too-soon": [429, "a code was sent less than a minute ago"],
  "daily-cap": [429, "today's limit of confirmation texts is reached: try again tomorrow"],
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
  let agentStarting = false;

  return async (req) => {
    const cors = corsHeaders(deps, req.origin);
    const reply = (status: number, body?: unknown): ApiResponse => ({
      status,
      headers: { ...cors, "cache-control": "no-store", ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body }),
    });

    /** Over a limit: 429, the reason, and when it lifts. */
    const limited = (r: Extract<ClaimResult, { ok: false }>): ApiResponse => {
      const out = reply(429, { error: limitMessage(r) });
      return { ...out, headers: { ...out.headers, "retry-after": String(r.retryAfterSeconds) } };
    };
    /** Claim one call; a refusal or a store failure is the answer, null lets the call run. */
    const claim = async (pub: PublicDemoDeps, kind: PublicActionKind): Promise<ApiResponse | null> => {
      let claimed: ClaimResult;
      try {
        claimed = await pub.claim(kind, req.clientKey ?? "unknown");
      } catch {
        return reply(500, { error: "could not check the public demo's limits" });
      }
      return claimed.ok ? null : limited(claimed);
    };

    const handlePublic = async (pub: PublicDemoDeps, route: "ingest" | "agent" | "incident", uid: string, incident: RegExpExecArray | null): Promise<ApiResponse> => {
      if (route === "ingest") {
        // The lock is looked at first so a call that would get a 409 costs the caller nothing, then again after the claim.
        if (ingestRunning) return reply(409, { error: "an ingest run is already in progress here" });
        const refused = await claim(pub, "ingest");
        if (refused) return refused;
        if (ingestRunning) return reply(409, { error: "an ingest run is already in progress here" });
        ingestRunning = true;
        try {
          const result = await pub.runIngest(uid);
          if (!result.ok) return reply(result.reason === "off" || result.reason === "not-admin" ? 403 : 400, { error: result.reason === "off" ? "the public demo's actions are off" : "bad request" });
          return reply(200, ingestBody(result.summary));
        } catch {
          return reply(500, { error: "the run failed to start" });
        } finally {
          ingestRunning = false;
        }
      }

      if (route === "agent") {
        if (agentStarting) return reply(409, { error: "an agent pass is already being started here" });
        const refused = await claim(pub, "agent");
        if (refused) return refused;
        if (agentStarting) return reply(409, { error: "an agent pass is already being started here" });
        agentStarting = true;
        try {
          const result = await pub.runAgent!(uid);
          if (!result.ok) return reply(result.reason === "off" || result.reason === "not-admin" ? 403 : 400, { error: result.reason === "off" ? "the public demo's actions are off" : "bad request" });
          return reply(202, { ok: true, started: true });
        } catch {
          return reply(502, { error: "the agent job could not be started" });
        } finally {
          agentStarting = false;
        }
      }

      // The incident routes: the body is checked before anything is claimed, so a malformed call costs nothing.
      const [, incidentId, kind] = incident!;
      const body = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
      if (kind === "status" && !isIncidentAction(body.action)) return reply(400, { error: "bad request" });
      if (kind === "correction" && (!isLevel(body.level) || (body.note !== undefined && typeof body.note !== "string"))) return reply(400, { error: "bad request" });
      const refused = await claim(pub, "action");
      if (refused) return refused;
      let result: PublicIncidentResult;
      try {
        result =
          kind === "status"
            ? await pub.setStatus(incidentId!, body.action as IncidentAction, uid)
            : kind === "retriage"
              ? await pub.requestRetriage(incidentId!, uid)
              : await pub.correct(incidentId!, body.level, body.note, uid);
      } catch {
        return reply(500, { error: "the change could not be saved" });
      }
      if (result.ok) return reply(200, { ok: true });
      const [status, error] = PUBLIC_INCIDENT_STATUS[result.reason] ?? [400, "bad request"];
      return reply(status, { error });
    };

    if (req.method === "OPTIONS") return { status: 204, headers: cors };
    // `/api/health` is the probe on Cloud Run: its front end answers `/healthz` on a run.app URL itself (#212).
    if (req.method === "GET" && (req.path === "/api/health" || req.path === "/healthz")) return reply(200, { ok: true });

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
    // The visitors' incident routes exist only where the public demo's actions are wired; otherwise a 404, as before.
    const publicMatch = deps.publicDemo ? PUBLIC_INCIDENT_RE.exec(req.path) : null;
    const route = req.path === "/api/ingest/run" ? "ingest" : req.path === "/api/agent/run" && deps.runAgent ? "agent" : retireMatch ? "retire" : onCallMatch && (onCallMatch[2] === "send-code" ? deps.sendOnCallCode : deps.confirmOnCallNumber) ? "oncall" : publicMatch ? "incident" : undefined;
    if (route === undefined) return reply(404, { error: "not found" });
    if (req.method !== "POST") return reply(405, { error: "method not allowed" });

    // One answer for every way a token can be wrong: nothing here helps someone guess. That includes the App Check
    // token: a missing or rejected one is the same 401, and it is checked first, so a call from outside the web app
    // never reaches the ID-token check (one Auth lookup per call, #141).
    const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(req.authorization ?? "");
    let uid: string;
    let anonymous: boolean;
    try {
      if (deps.verifyAppCheck) {
        const appCheck = /^[A-Za-z0-9._-]{20,4096}$/.exec(req.appCheck ?? "");
        if (!appCheck) throw new Error("no app check token");
        await deps.verifyAppCheck(appCheck[0]);
      }
      if (!match) throw new Error("no token");
      const caller = await deps.verifyToken(match[1]!);
      uid = caller.uid;
      anonymous = caller.anonymous === true;
    } catch (e) {
      try {
        deps.onRefused?.(refusalReason(e));
      } catch {
        // Recording why must never change the answer.
      }
      return reply(401, { error: "sign in again" });
    }

    // A visitor of the public demo (an anonymous session), where its open actions are on: the routes it may use, each
    // claimed against the hourly limits before it runs. Everyone else, and a visitor anywhere else, goes on to the role.
    // Whether they are on is decided per call, from the runtime settings (#430).
    let pub: PublicDemoDeps | null = null;
    if (deps.publicDemo && anonymous && (route === "ingest" || route === "incident" || route === "agent")) {
      try {
        pub = await deps.publicDemo();
      } catch {
        return reply(500, { error: "could not read the public demo's settings" });
      }
      // Off for this call: the visitors' incident routes do not exist, as when the actions are not wired.
      if (!pub && route === "incident") return reply(404, { error: "not found" });
    }
    if (pub && (route === "ingest" || route === "incident" || (route === "agent" && pub.runAgent))) {
      return handlePublic(pub, route, uid, publicMatch);
    }
    if (route === "incident") return reply(403, { error: "for the public demo's visitors only" });

    // The role before any lock (#305): a caller who is not an admin never holds one, so it can neither block an admin
    // with a 409 nor learn from one that a run is in progress. The awaited read comes before the lock's check-and-set,
    // which stays one synchronous step.
    let admin: boolean;
    try {
      admin = await deps.isAdmin(uid);
    } catch {
      return reply(500, { error: "could not check the caller's role" });
    }
    if (!admin) return reply(403, { error: "admins only" });

    if (route === "ingest") {
      if (ingestRunning) return reply(409, { error: "an ingest run is already in progress here" });
      ingestRunning = true;
      try {
        const result = await deps.runIngest(uid);
        if (!result.ok) return reply(result.reason === "not-admin" ? 403 : 400, { error: result.reason === "not-admin" ? "admins only" : "bad request" });
        return reply(200, ingestBody(result.summary));
      } catch {
        // The run's own failure is recorded in last_run; what escaped is an infrastructure fault, and its text stays in the log.
        return reply(500, { error: "the run failed to start" });
      } finally {
        ingestRunning = false;
      }
    }

    if (route === "agent") {
      if (agentStarting) return reply(409, { error: "an agent pass is already being started here" });
      agentStarting = true;
      try {
        const result = await deps.runAgent!(uid);
        if (!result.ok) return reply(result.reason === "not-admin" ? 403 : 400, { error: result.reason === "not-admin" ? "admins only" : "bad request" });
        // Accepted, not done: the pass runs in its own job and records its own cycles.
        return reply(202, { ok: true, started: true });
      } catch {
        // Why Cloud Run refused (a missing role, no such job) stays in the service's log.
        return reply(502, { error: "the agent job could not be started" });
      } finally {
        agentStarting = false;
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
