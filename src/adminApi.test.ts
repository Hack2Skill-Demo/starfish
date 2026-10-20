import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminApi, type AdminApiDeps, type ApiRequest, type PublicDemoDeps } from "./adminApi.js";
import type { PublicIncidentResult } from "./publicDemo.js";
import type { ClaimResult, PublicActionKind } from "./publicDemoLimit.js";
import { startAdminApiServer } from "./adminApiServer.js";
import { createIpRateLimiter } from "./ipRateLimit.js";
import type { RunSummary } from "./ingest/run.js";

const TOKEN = "t".repeat(40);
const ORIGIN = "https://site.web.app";

const SUMMARY = {
  outcome: "ok",
  windows: 2,
  capped: false,
  totals: { entriesProcessed: 5, incidentsCreated: 1, incidentsUpdated: 2, incidentsRecurred: 0, incidentsReplayed: 0, errorsFoldedIntoOverflow: 0 },
} as unknown as RunSummary;

function fakes(over: Partial<AdminApiDeps> = {}) {
  const calls: string[] = [];
  const deps: AdminApiDeps = {
    verifyToken: (t) => (t === TOKEN ? Promise.resolve({ uid: "admin-1" }) : Promise.reject(new Error("bad token: details that must not leak"))),
    isAdmin: (uid) => Promise.resolve(uid === "admin-1"),
    runIngest: (uid) => (calls.push(`ingest:${uid}`), Promise.resolve({ ok: true, summary: SUMMARY })),
    retire: (id, uid, reason) => (calls.push(`retire:${id}:${uid}:${reason}`), Promise.resolve({ ok: true, alreadyRetired: false })),
    allowedOrigins: [ORIGIN],
    ...over,
  };
  return { deps, calls, api: createAdminApi(deps) };
}

const post = (path: string, extra: Partial<ApiRequest> = {}): ApiRequest => ({ method: "POST", path, authorization: `Bearer ${TOKEN}`, ...extra });

describe("admin API: who may call", () => {
  it("answers 401, with one message, for a missing, malformed, or rejected token", async () => {
    const { api, calls } = fakes();
    for (const authorization of [undefined, "", "Bearer", `Basic ${TOKEN}`, "Bearer short", `Bearer ${"x".repeat(40)}`, `bearer ${TOKEN}`]) {
      const r = await api({ method: "POST", path: "/api/ingest/run", ...(authorization !== undefined && { authorization }) });
      expect(r.status, String(authorization)).toBe(401);
      expect(JSON.stringify(r.body)).toBe('{"error":"sign in again"}');
    }
    expect(calls).toEqual([]);
  });

  // #141: the CLI verifies with checkRevoked, so a disabled or revoked account's still-valid token is refused there.
  it("answers the same 401 when verification refuses a revoked or disabled account, and runs nothing", async () => {
    for (const code of ["auth/id-token-revoked", "auth/user-disabled"]) {
      const { api, calls } = fakes({ verifyToken: () => Promise.reject(Object.assign(new Error(code), { code })) });
      const r = await api(post("/api/ingest/run"));
      expect(r.status, code).toBe(401);
      expect(JSON.stringify(r.body)).toBe('{"error":"sign in again"}');
      expect(calls).toEqual([]);
    }
  });

  it("records why a token was refused for the operator, never for the caller, and never the token", async () => {
    const reasons: string[] = [];
    const permission = Object.assign(new Error(`Lookup failed: PERMISSION_DENIED for ${TOKEN}${"A".repeat(60)}`), { code: "auth/internal-error" });
    const { api } = fakes({ verifyToken: () => Promise.reject(permission), onRefused: (r: string) => void reasons.push(r) });
    const r = await api(post("/api/ingest/run"));
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).toBe('{"error":"sign in again"}');
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("auth/internal-error");
    expect(reasons[0]).toContain("PERMISSION_DENIED");
    expect(reasons[0]).not.toContain(TOKEN);
    expect(reasons[0]).not.toContain("AAAAAAAA");
    expect(reasons[0]!.length).toBeLessThanOrEqual(300);
    // No token at all is recorded too, with its own reason.
    await api({ method: "POST", path: "/api/ingest/run" });
    expect(reasons[1]).toBe("no token");
  });

  it("answers the same 401 when recording the reason itself throws", async () => {
    const { api, calls } = fakes({ verifyToken: () => Promise.reject(new Error("x")), onRefused: () => { throw new Error("log failed"); } });
    const r = await api(post("/api/ingest/run"));
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).toBe('{"error":"sign in again"}');
    expect(calls).toEqual([]);
  });

  it("passes the verified uid, and nothing the caller says about itself, to the admin check", async () => {
    const { api, calls } = fakes();
    await api(post("/api/ingest/run", { body: { uid: "someone-else", roles: ["admin"] } }));
    await api(post("/api/incidents/inc-1/retire", { body: { reason: "reset", uid: "someone-else" } }));
    expect(calls).toEqual(["ingest:admin-1", "retire:inc-1:admin-1:reset"]);
  });

  it("says 403 when the operator record says the caller is not an admin", async () => {
    const { api } = fakes({
      runIngest: () => Promise.resolve({ ok: false, reason: "not-admin" }),
      retire: () => Promise.resolve({ ok: false, reason: "not-admin" }),
    });
    expect((await api(post("/api/ingest/run"))).status).toBe(403);
    expect((await api(post("/api/incidents/i/retire"))).status).toBe(403);
  });

  // #305: the locks were taken before the action's own admin check, so any token, an anonymous guest's too, could hold
  // them: an admin then got a 409, and the guest learnt from its own 409 that a run was in progress.
  it("checks the role before any route takes its lock: a non-admin during a held lock gets 403 and never holds it", async () => {
    let releaseIngest: () => void = () => {};
    let releaseAgent: () => void = () => {};
    const ingestGate = new Promise<void>((r) => (releaseIngest = r));
    const agentGate = new Promise<void>((r) => (releaseAgent = r));
    const ran: string[] = [];
    const { api } = fakes({
      verifyToken: (t) => Promise.resolve({ uid: t === TOKEN ? "admin-1" : "guest-1" }),
      runIngest: (uid) => (ran.push(`ingest:${uid}`), ingestGate.then(() => ({ ok: true as const, summary: SUMMARY }))),
      runAgent: (uid) => (ran.push(`agent:${uid}`), agentGate.then(() => ({ ok: true as const }))),
    });
    const guest = (path: string) => post(path, { authorization: `Bearer ${"g".repeat(40)}` });

    // A guest first: refused, and the admin is not held up by it.
    for (const path of ["/api/ingest/run", "/api/agent/run"]) {
      const r = await api(guest(path));
      expect(r, path).toMatchObject({ status: 403, body: { error: "admins only" } });
    }
    expect(ran).toEqual([]);
    const ingest = api(post("/api/ingest/run"));
    const agent = api(post("/api/agent/run"));

    // While the admin's run holds each lock, a guest still gets 403, never the 409 that would say a run is in progress.
    for (const path of ["/api/ingest/run", "/api/agent/run"]) expect((await api(guest(path))).status, path).toBe(403);
    expect((await api(post("/api/ingest/run"))).status).toBe(409);
    expect((await api(post("/api/agent/run"))).status).toBe(409);
    releaseIngest();
    releaseAgent();
    expect((await ingest).status).toBe(200);
    expect((await agent).status).toBe(202);
    expect(ran).toEqual(["ingest:admin-1", "agent:admin-1"]);
  });

  it("refuses every admin route with 403 before the action runs when the caller is not an admin", async () => {
    const { api, calls } = fakes({ isAdmin: () => Promise.resolve(false) });
    expect((await api(post("/api/ingest/run"))).status).toBe(403);
    expect((await api(post("/api/incidents/i/retire"))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("answers 500 with no detail, and runs nothing, when the role cannot be read", async () => {
    let down = true;
    const { api, calls } = fakes({ isAdmin: () => (down ? Promise.reject(new Error("store down: password=hunter2")) : Promise.resolve(true)) });
    const r = await api(post("/api/ingest/run"));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("hunter2");
    expect(calls).toEqual([]);
    // The lock was never taken: the next call, once the store answers, runs.
    down = false;
    expect((await api(post("/api/ingest/run"))).status).toBe(200);
    expect(calls).toEqual(["ingest:admin-1"]);
  });
});

describe("admin API: App Check (#12)", () => {
  const APP_CHECK = "a".repeat(30) + ".b.c";
  const appCheckFakes = () => {
    const seen: string[] = [];
    const f = fakes({
      verifyAppCheck: (t) => (seen.push(t), t === APP_CHECK ? Promise.resolve() : Promise.reject(new Error("bad app check: detail that must not leak"))),
    });
    return { ...f, seen };
  };

  it("is not asked for when not configured: a call with no App Check token runs as before", async () => {
    const { api, calls } = fakes();
    expect((await api(post("/api/ingest/run"))).status).toBe(200);
    expect(calls).toEqual(["ingest:admin-1"]);
  });

  it("when configured, answers the same 401 for a missing, malformed or rejected App Check token, and runs nothing", async () => {
    const { api, calls, seen } = appCheckFakes();
    for (const appCheck of [undefined, "", "short", "x".repeat(40), `${APP_CHECK} `]) {
      const r = await api(post("/api/ingest/run", { ...(appCheck !== undefined && { appCheck }) }));
      expect(r.status, String(appCheck)).toBe(401);
      expect(JSON.stringify(r.body)).toBe('{"error":"sign in again"}');
    }
    expect(calls).toEqual([]);
    // Only the well-formed one reached the verifier.
    expect(seen).toEqual(["x".repeat(40)]);
  });

  it("when configured, a valid App Check token still needs a valid ID token, and both pass the call through", async () => {
    const { api, calls } = appCheckFakes();
    expect((await api(post("/api/ingest/run", { appCheck: APP_CHECK, authorization: "Bearer " + "z".repeat(40) }))).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await api(post("/api/ingest/run", { appCheck: APP_CHECK }))).status).toBe(200);
    expect((await api(post("/api/incidents/inc-1/retire", { appCheck: APP_CHECK }))).status).toBe(200);
    expect(calls).toEqual(["ingest:admin-1", "retire:inc-1:admin-1:"]);
  });

  it("is not needed for health or a preflight, and the preflight allows the header", async () => {
    const { api } = appCheckFakes();
    expect((await api({ method: "GET", path: "/healthz" })).status).toBe(200);
    const pre = await api({ method: "OPTIONS", path: "/api/ingest/run", origin: ORIGIN });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-headers"]).toContain("x-firebase-appcheck");
  });
});

describe("admin API: routes", () => {
  it("serves health without a token, and refuses other paths and methods", async () => {
    const { api } = fakes();
    expect((await api({ method: "GET", path: "/healthz" })).status).toBe(200);
    // The probe on Cloud Run, where Google's front end answers /healthz itself (#212).
    const health = await api({ method: "GET", path: "/api/health" });
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
    expect((await api(post("/api/health"))).status).toBe(404);
    expect((await api(post("/nope"))).status).toBe(404);
    expect((await api({ method: "GET", path: "/api/ingest/run", authorization: `Bearer ${TOKEN}` })).status).toBe(405);
    expect((await api(post("/api/incidents/a%2Fb/retire"))).status).toBe(404);
    expect((await api(post("/api/incidents/a b/retire"))).status).toBe(404);
  });

  it("reports a run's numbers, with a failed run's message redacted and cut", async () => {
    const secret = "AIza" + "x".repeat(35);
    const { api } = fakes({
      runIngest: () => Promise.resolve({ ok: true, summary: { ...SUMMARY, outcome: "failed", error: `boom ${secret} ${"y".repeat(500)}` } as unknown as RunSummary }),
    });
    const r = await api(post("/api/ingest/run"));
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, outcome: "failed", windows: 2, entriesProcessed: 5, incidentsCreated: 1 });
    expect(String(body.error)).not.toContain(secret);
    expect(String(body.error).length).toBeLessThan(400);
  });

  it("turns an escaped fault into a 500 with no detail, and runs one ingest at a time", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { api } = fakes({ runIngest: () => gate.then(() => ({ ok: true as const, summary: SUMMARY })) });
    const first = api(post("/api/ingest/run"));
    const second = await api(post("/api/ingest/run"));
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    // The lock is released afterwards, also when the run threw.
    const { api: bad } = fakes({ runIngest: () => Promise.reject(new Error("db password=hunter2")) });
    const r = await bad(post("/api/ingest/run"));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("hunter2");
    expect((await bad(post("/api/ingest/run"))).status).toBe(500);
  });

  it("maps a retire's outcomes, and bounds the reason", async () => {
    const { api, calls } = fakes({ retire: (id, uid, reason) => Promise.resolve(id === "gone" ? { ok: false, reason: "no-such-incident" as const } : (calls.push(reason.length.toString()), { ok: true as const, alreadyRetired: id === "again" })) });
    expect((await api(post("/api/incidents/gone/retire"))).status).toBe(404);
    expect((await api(post("/api/incidents/again/retire"))).body).toEqual({ ok: true, alreadyRetired: true });
    await api(post("/api/incidents/x/retire", { body: { reason: "r".repeat(1000) } }));
    expect(calls).toContain("200");
    expect((await api(post("/api/incidents/x/retire", { body: { reason: 42 } }))).status).toBe(400);
  });
});

describe("admin API: run agent now (#276)", () => {
  const withAgent = (over: Partial<AdminApiDeps> = {}) => {
    const started: string[] = [];
    const f = fakes({ runAgent: (uid) => (started.push(uid), Promise.resolve({ ok: true as const })), ...over });
    return { ...f, started };
  };

  it("is a 404 where no agent job is named, before any token is looked at", async () => {
    const { api, calls } = fakes();
    expect((await api(post("/api/agent/run"))).status).toBe(404);
    expect((await api({ method: "POST", path: "/api/agent/run" })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("starts one pass for the token's uid and answers 202: accepted, not finished", async () => {
    const { api, started } = withAgent();
    const r = await api(post("/api/agent/run"));
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true, started: true });
    expect(started).toEqual(["admin-1"]);
  });

  it("needs the same token as every other route, and POST", async () => {
    const { api, started } = withAgent();
    const none = await api({ method: "POST", path: "/api/agent/run" });
    expect(none.status).toBe(401);
    expect(JSON.stringify(none.body)).toBe('{"error":"sign in again"}');
    expect((await api({ method: "GET", path: "/api/agent/run", authorization: `Bearer ${TOKEN}` })).status).toBe(405);
    expect(started).toEqual([]);
  });

  it("requires the App Check token too, where that is on", async () => {
    const { api, started } = withAgent({ verifyAppCheck: (t) => (t === "a".repeat(40) ? Promise.resolve() : Promise.reject(new Error("bad"))) });
    expect((await api(post("/api/agent/run"))).status).toBe(401);
    expect((await api(post("/api/agent/run", { appCheck: "a".repeat(40) }))).status).toBe(202);
    expect(started).toEqual(["admin-1"]);
  });

  it("refuses a caller who is not an admin with a 403, and a malformed uid with a 400", async () => {
    const { api: notAdmin } = withAgent({ runAgent: () => Promise.resolve({ ok: false, reason: "not-admin" }) });
    const r = await notAdmin(post("/api/agent/run"));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "admins only" });
    const { api: badId } = withAgent({ runAgent: () => Promise.resolve({ ok: false, reason: "invalid-id" }) });
    expect((await badId(post("/api/agent/run"))).status).toBe(400);
  });

  it("answers 502 with no detail when the job could not be started, and starts one at a time", async () => {
    const { api: refused } = withAgent({ runAgent: () => Promise.reject(new Error("Cloud Run answered 403 for sa-key=hunter2")) });
    const r = await refused(post("/api/agent/run"));
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "the agent job could not be started" });
    // The lock is released after a failed start.
    expect((await refused(post("/api/agent/run"))).status).toBe(502);

    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    const { api } = withAgent({ runAgent: () => gate.then(() => ({ ok: true as const })) });
    const first = api(post("/api/agent/run"));
    expect((await api(post("/api/agent/run"))).status).toBe(409);
    release();
    expect((await first).status).toBe(202);
    expect((await api(post("/api/agent/run"))).status).toBe(202);
  });

  it("does not hold up an ingest run, nor the other way round", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    const { api, started } = withAgent({ runIngest: () => gate.then(() => ({ ok: true as const, summary: SUMMARY })) });
    const ingest = api(post("/api/ingest/run"));
    expect((await api(post("/api/agent/run"))).status).toBe(202);
    release();
    expect((await ingest).status).toBe(200);
    expect(started).toEqual(["admin-1"]);
  });
});

describe("admin API: CORS", () => {
  it("allows exactly the configured origins, answers a preflight without a token, and sets nothing for others", async () => {
    const { api } = fakes();
    const pre = await api({ method: "OPTIONS", path: "/api/ingest/run", origin: ORIGIN });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(pre.headers["access-control-allow-headers"]).toContain("authorization");
    const other = await api({ method: "OPTIONS", path: "/api/ingest/run", origin: "https://evil.example" });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    const real = await api(post("/api/ingest/run", { origin: ORIGIN }));
    expect(real.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(real.headers.vary).toBe("Origin");
    expect(real.headers["cache-control"]).toBe("no-store");
    expect((await api(post("/api/ingest/run", { origin: "https://evil.example" }))).headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("admin API server", () => {
  let server: ReturnType<typeof startAdminApiServer> | undefined;
  afterEach(() => void server?.close());

  async function start(over: Partial<AdminApiDeps> = {}, opts: Parameters<typeof startAdminApiServer>[2] = {}): Promise<string> {
    server = startAdminApiServer(fakes(over).api, 0, opts);
    await new Promise((r) => server!.once("listening", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("serves the handler over HTTP, with a JSON body and the token header", async () => {
    const calls: string[] = [];
    const base = await start({ retire: (id, uid, reason) => (calls.push(`${id}:${uid}:${reason}`), Promise.resolve({ ok: true, alreadyRetired: false })) });
    const r = await fetch(`${base}/api/incidents/inc-9/retire`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "demo reset" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, alreadyRetired: false });
    expect(calls).toEqual(["inc-9:admin-1:demo reset"]);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it("passes the X-Firebase-AppCheck header through to the handler", async () => {
    const appCheck = "q".repeat(30);
    const seen: string[] = [];
    const base = await start({ verifyAppCheck: (t) => (seen.push(t), Promise.resolve()) });
    const without = await fetch(`${base}/api/ingest/run`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(without.status).toBe(401);
    const withIt = await fetch(`${base}/api/ingest/run`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "X-Firebase-AppCheck": appCheck } });
    expect(withIt.status).toBe(200);
    expect(seen).toEqual([appCheck]);
  });

  it("refuses a body over 4 KB, and treats a body that is not JSON as no body", async () => {
    const base = await start();
    const big = await fetch(`${base}/api/ingest/run`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "x".repeat(6000) }) });
    expect(big.status).toBe(413);
    const junk = await fetch(`${base}/api/incidents/i/retire`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{not json" });
    expect(junk.status).toBe(200);
  });

  it("answers 429 past the per-address limit before the handler runs, logs the address once, and limits by the last X-Forwarded-For entry", async () => {
    const handled: string[] = [];
    const limited: string[] = [];
    const base = await start(
      { verifyToken: (t) => (handled.push(t), Promise.resolve({ uid: "admin-1" })) },
      { limiter: createIpRateLimiter({ perMinute: 2 }), now: () => 1_000, onLimited: (k) => limited.push(k) }
    );
    const call = (xff: string) => fetch(`${base}/api/ingest/run`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": xff } });
    expect((await call("9.9.9.9, 203.0.113.5")).status).toBe(200);
    expect((await call("8.8.8.8, 203.0.113.5")).status).toBe(200);
    const refused = await call("7.7.7.7, 203.0.113.5");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toEqual({ error: "too many requests" });
    expect((await call("203.0.113.5")).status).toBe(429);
    expect(handled).toHaveLength(2);
    expect(limited).toEqual(["203.0.113.5"]);
    expect((await call("203.0.113.6")).status).toBe(200);
  });

  it("hands Twilio's form body, raw query and signature header to the webhooks, and answers with their TwiML as it is", async () => {
    const seen: unknown[] = [];
    const base = await start({
      twilioWebhooks: (req) => (seen.push(req), Promise.resolve({ status: 200, contentType: "text/xml", body: "<Response/>" })),
    });
    const r = await fetch(`${base}/twilio/gather?e=c1_r0&s=0`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "sig=" },
      body: new URLSearchParams({ Digits: "1", CallSid: "CA1" }).toString(),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/xml");
    expect(await r.text()).toBe("<Response/>");
    expect(seen).toEqual([{ method: "POST", path: "/twilio/gather", query: "e=c1_r0&s=0", form: { Digits: "1", CallSid: "CA1" }, signature: "sig=" }]);
  });
});

describe("admin API: phone escalation (#37)", () => {
  it("answers 404 for every on-call and Twilio route when Twilio is not wired", async () => {
    const { api } = fakes();
    expect((await api(post("/api/oncall/people/p1/send-code"))).status).toBe(404);
    expect((await api(post("/api/oncall/people/p1/confirm", { body: { code: "123456" } }))).status).toBe(404);
    expect((await api({ method: "POST", path: "/twilio/voice", query: "e=a&s=0", form: {} })).status).toBe(404);
  });

  it("needs the ID token for the opt-in routes, and passes the verified uid", async () => {
    const calls: string[] = [];
    const { api } = fakes({
      sendOnCallCode: (id, uid) => (calls.push(`send:${id}:${uid}`), Promise.resolve({ ok: true })),
      confirmOnCallNumber: (id, code, uid) => (calls.push(`confirm:${id}:${code}:${uid}`), Promise.resolve({ ok: true })),
    });
    expect((await api({ method: "POST", path: "/api/oncall/people/p1/send-code" })).status).toBe(401);
    expect((await api(post("/api/oncall/people/p1/send-code"))).status).toBe(200);
    expect((await api(post("/api/oncall/people/p1/confirm", { body: { code: "123456" } }))).status).toBe(200);
    expect((await api(post("/api/oncall/people/p1/confirm", { body: { code: "12x456" } }))).status).toBe(400);
    expect((await api(post("/api/oncall/people/p1/confirm"))).status).toBe(400);
    expect(calls).toEqual(["send:p1:admin-1", "confirm:p1:123456:admin-1"]);
  });

  it("turns each refusal into a status and a short reason safe to show", async () => {
    const { api } = fakes({
      sendOnCallCode: () => Promise.resolve({ ok: false, reason: "not-admin" }),
      confirmOnCallNumber: () => Promise.resolve({ ok: false, reason: "wrong-code" }),
    });
    expect((await api(post("/api/oncall/people/p1/send-code"))).status).toBe(403);
    const wrong = await api(post("/api/oncall/people/p1/confirm", { body: { code: "123456" } }));
    expect(wrong).toMatchObject({ status: 400, body: { error: "wrong code" } });
  });

  it("sends Twilio's routes to the webhooks WITHOUT an ID token (the signature is checked there), and hides their errors", async () => {
    const { api } = fakes({ twilioWebhooks: () => Promise.reject(new Error("store down: secret details")) });
    const r = await api({ method: "POST", path: "/twilio/status", query: "e=a&s=0", form: {} });
    expect(r.status).toBe(500);
    expect(r.text).toBe("server error");
  });
});

describe("admin API: the public demo's open actions", () => {
  const GUEST_TOKEN = "g".repeat(40);
  /** Two callers: TOKEN is the admin, GUEST_TOKEN an anonymous session; `limits` decides each claim. */
  const withPublic = (opts: { publicDemo?: boolean; forCall?: "on" | "off" | "throws"; agent?: boolean; claim?: (kind: PublicActionKind, key: string) => Promise<ClaimResult> } = {}) => {
    const resolved: string[] = [];
    const done: string[] = [];
    const claims: string[] = [];
    const publicDemo: PublicDemoDeps = {
      claim: opts.claim ?? ((kind, key) => (claims.push(`${kind}:${key}`), Promise.resolve({ ok: true as const }))),
      setStatus: (id, action, uid) => (done.push(`status:${id}:${action}:${uid}`), Promise.resolve({ ok: true as const })),
      requestRetriage: (id, uid) => (done.push(`retriage:${id}:${uid}`), Promise.resolve({ ok: true as const })),
      correct: (id, level, note, uid) => (done.push(`correct:${id}:${String(level)}:${String(note)}:${uid}`), Promise.resolve({ ok: true as const })),
      runIngest: (uid) => (done.push(`guest-ingest:${uid}`), Promise.resolve({ ok: true as const, summary: SUMMARY })),
      ...(opts.agent !== false && { runAgent: (uid: string) => (done.push(`guest-agent:${uid}`), Promise.resolve({ ok: true as const })) }),
    };
    const f = fakes({
      verifyToken: (t) => (t === TOKEN ? Promise.resolve({ uid: "admin-1" }) : t === GUEST_TOKEN ? Promise.resolve({ uid: "anon-1", anonymous: true }) : Promise.reject(new Error("bad"))),
      ...(opts.agent !== false && { runAgent: (uid: string) => (done.push(`agent:${uid}`), Promise.resolve({ ok: true as const })) }),
      sendOnCallCode: () => Promise.resolve({ ok: true as const }),
      confirmOnCallNumber: () => Promise.resolve({ ok: true as const }),
      ...(opts.publicDemo !== false && {
        publicDemo: () => {
          resolved.push("resolve");
          if (opts.forCall === "throws") return Promise.reject(new Error("store down"));
          return Promise.resolve(opts.forCall === "off" ? null : publicDemo);
        },
      }),
    });
    return { ...f, done, claims, publicDemo, resolved };
  };
  const asGuest = (path: string, body?: unknown): ApiRequest => ({ method: "POST", path, authorization: `Bearer ${GUEST_TOKEN}`, clientKey: "203.0.113.7", ...(body !== undefined && { body }) });

  describe("switch off (no publicDemo wired): exactly as before", () => {
    it("an anonymous caller is refused every admin route with the same 403, and the incident routes do not exist", async () => {
      const { api, done, calls } = withPublic({ publicDemo: false });
      for (const path of ["/api/ingest/run", "/api/agent/run", "/api/incidents/i1/retire", "/api/oncall/people/p1/send-code"]) {
        const r = await api(asGuest(path));
        expect(r.status, path).toBe(403);
        expect(r.body).toEqual({ error: "admins only" });
      }
      for (const kind of ["status", "retriage", "correction"]) {
        expect((await api(asGuest(`/api/incidents/i1/${kind}`, { action: "resolve", level: "log" }))).status, kind).toBe(404);
        expect((await api(post(`/api/incidents/i1/${kind}`))).status, kind).toBe(404);
      }
      expect(done).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("an admin's routes run as before", async () => {
      const { api, done, calls } = withPublic({ publicDemo: false });
      expect((await api(post("/api/ingest/run"))).status).toBe(200);
      expect((await api(post("/api/agent/run"))).status).toBe(202);
      expect(calls).toEqual(["ingest:admin-1"]);
      expect(done).toEqual(["agent:admin-1"]);
    });
  });

  describe("switch on, but off for this call: the runtime settings' environment is not a public one (#430)", () => {
    it("an anonymous caller gets what it gets with the switch off, and no limit is claimed", async () => {
      const { api, done, claims, calls, resolved } = withPublic({ forCall: "off" });
      for (const path of ["/api/ingest/run", "/api/agent/run"]) {
        const r = await api(asGuest(path));
        expect(r.status, path).toBe(403);
        expect(r.body).toEqual({ error: "admins only" });
      }
      for (const kind of ["status", "retriage", "correction"]) {
        expect((await api(asGuest(`/api/incidents/i1/${kind}`, { action: "resolve", level: "log" }))).status, kind).toBe(404);
      }
      expect(resolved).toHaveLength(5); // asked once per call
      expect(done).toEqual([]);
      expect(claims).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("is never asked for an admin's call, which runs as before", async () => {
      const { api, done, calls, resolved } = withPublic({ forCall: "off" });
      expect((await api(post("/api/ingest/run"))).status).toBe(200);
      expect((await api(post("/api/agent/run"))).status).toBe(202);
      expect(calls).toEqual(["ingest:admin-1"]);
      expect(done).toEqual(["agent:admin-1"]);
      expect(resolved).toEqual([]);
    });

    it("answers 500 and does nothing when the settings could not be read", async () => {
      const { api, done, claims, calls } = withPublic({ forCall: "throws" });
      for (const path of ["/api/ingest/run", "/api/agent/run", "/api/incidents/i1/retriage"]) {
        expect((await api(asGuest(path))).status, path).toBe(500);
      }
      expect([...done, ...claims, ...calls]).toEqual([]);
    });
  });

  describe("switch on", () => {
    it("lets an anonymous caller run ingest and the agent through the visitors' path, each claimed by its address", async () => {
      const { api, done, claims, calls } = withPublic();
      const ingest = await api(asGuest("/api/ingest/run"));
      expect(ingest.status).toBe(200);
      expect(ingest.body).toMatchObject({ ok: true, outcome: "ok", incidentsCreated: 1 });
      expect((await api(asGuest("/api/agent/run"))).status).toBe(202);
      expect(done).toEqual(["guest-ingest:anon-1", "guest-agent:anon-1"]);
      expect(claims).toEqual(["ingest:203.0.113.7", "agent:203.0.113.7"]);
      expect(calls).toEqual([]); // the admin's own ingest never ran
    });

    it("lets an anonymous caller change status, ask for a retry and correct triage, passing only what it validated", async () => {
      const { api, done, claims } = withPublic();
      expect((await api(asGuest("/api/incidents/inc-1/status", { action: "acknowledge" }))).status).toBe(200);
      expect((await api(asGuest("/api/incidents/inc-1/retriage"))).status).toBe(200);
      expect((await api(asGuest("/api/incidents/inc-1/correction", { level: "log", note: "flaky provider" }))).status).toBe(200);
      expect(done).toEqual(["status:inc-1:acknowledge:anon-1", "retriage:inc-1:anon-1", "correct:inc-1:log:flaky provider:anon-1"]);
      expect(claims).toEqual(["action:203.0.113.7", "action:203.0.113.7", "action:203.0.113.7"]);
    });

    it("refuses a malformed body with a 400 before anything is claimed", async () => {
      const { api, done, claims } = withPublic();
      for (const [path, body] of [
        ["/api/incidents/inc-1/status", { action: "delete" }],
        ["/api/incidents/inc-1/status", undefined],
        ["/api/incidents/inc-1/correction", { level: "everything" }],
        ["/api/incidents/inc-1/correction", { level: "log", note: 3 }],
      ] as const) {
        expect((await api(asGuest(path, body))).status, JSON.stringify(body)).toBe(400);
      }
      expect((await api(asGuest("/api/incidents/bad id/status", { action: "resolve" }))).status).toBe(404);
      expect(done).toEqual([]);
      expect(claims).toEqual([]);
    });

    it("keeps Settings-adjacent and admin-only routes closed to anonymous callers: Retire and On-call are 403", async () => {
      const { api, done } = withPublic();
      for (const path of ["/api/incidents/inc-1/retire", "/api/oncall/people/p1/send-code", "/api/oncall/people/p1/confirm"]) {
        const r = await api(asGuest(path, { code: "123456", reason: "x" }));
        expect(r.status, path).toBe(403);
        expect(r.body).toEqual({ error: "admins only" });
      }
      expect(done).toEqual([]);
    });

    it("keeps the incident routes for anonymous callers only: an admin or operator triages from the UI as before", async () => {
      const { api, done } = withPublic();
      const r = await api(post("/api/incidents/inc-1/status", { body: { action: "resolve" } }));
      expect(r.status).toBe(403);
      expect(done).toEqual([]);
      // An admin's ingest and agent still take the admin's path, unclaimed.
      expect((await api(post("/api/agent/run"))).status).toBe(202);
      expect(done).toEqual(["agent:admin-1"]);
    });

    it("answers 429 with the limit's reason and retry-after, and runs nothing, past a limit", async () => {
      const refuse = (limit: "address" | "deployment") => () => Promise.resolve({ ok: false as const, limit, retryAfterSeconds: 1500 });
      const { api, done } = withPublic({ claim: refuse("address") });
      const r = await api(asGuest("/api/incidents/inc-1/retriage"));
      expect(r.status).toBe(429);
      expect(r.headers["retry-after"]).toBe("1500");
      expect(r.body).toEqual({ error: "the public demo's hourly limit for your address is reached: try again in 25 minutes" });
      expect((await api(asGuest("/api/ingest/run"))).status).toBe(429);
      const { api: capped, done: cappedDone } = withPublic({ claim: refuse("deployment") });
      const a = await capped(asGuest("/api/agent/run"));
      expect(a.status).toBe(429);
      expect(a.body).toEqual({ error: "the public demo's hourly limit of agent passes is reached: try again in 25 minutes" });
      expect([...done, ...cappedDone]).toEqual([]);
    });

    it("answers 500 with no detail when the limits cannot be checked, and runs nothing", async () => {
      const { api, done } = withPublic({ claim: () => Promise.reject(new Error("firestore down: secret detail")) });
      const r = await api(asGuest("/api/agent/run"));
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toContain("secret");
      expect(done).toEqual([]);
    });

    it("maps an action's refusals to a status and a short reason", async () => {
      const cases: [string, number][] = [["no-such-incident", 404], ["not-applicable", 409], ["off", 403], ["bad-request", 400], ["invalid-id", 400]];
      for (const [reason, status] of cases) {
        const f = withPublic();
        const api = createAdminApi({ ...f.deps, publicDemo: () => Promise.resolve({ ...f.publicDemo, setStatus: () => Promise.resolve({ ok: false, reason } as PublicIncidentResult) }) });
        expect((await api(asGuest("/api/incidents/inc-1/status", { action: "resolve" }))).status, reason).toBe(status);
      }
    });

    it("a visitor's agent start is a 404 where no agent job is named, as an admin's is", async () => {
      const { api, done } = withPublic({ agent: false });
      expect((await api(asGuest("/api/agent/run"))).status).toBe(404);
      expect(done).toEqual([]);
    });

    it("needs a valid token, and App Check where it is on, like every route", async () => {
      const { api, done } = withPublic();
      expect((await api({ method: "POST", path: "/api/incidents/inc-1/retriage", clientKey: "x" })).status).toBe(401);
      const f = withPublic();
      const strict = createAdminApi({ ...f.deps, verifyAppCheck: () => Promise.reject(new Error("no")) });
      expect((await strict(asGuest("/api/incidents/inc-1/retriage"))).status).toBe(401);
      expect([...done, ...f.done]).toEqual([]);
    });
  });

  it("the HTTP shell hands the caller's address (the last X-Forwarded-For entry) to the handler", async () => {
    const seen: (string | undefined)[] = [];
    const server = startAdminApiServer((req) => (seen.push(req.clientKey), Promise.resolve({ status: 200, headers: {}, body: {} })), 0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await fetch(`${base}/api/ingest/run`, { method: "POST", headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.5" } });
    server.close();
    expect(seen).toEqual(["203.0.113.5"]);
  });
});
