import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminApi, type AdminApiDeps, type ApiRequest } from "./adminApi.js";
import { startAdminApiServer } from "./adminApiServer.js";
import type { RunSummary } from "./ingest/run.js";

const TOKEN = "t".repeat(40);
const ORIGIN = "https://site.web.app";

const SUMMARY = {
  outcome: "ok",
  windows: 2,
  capped: false,
  totals: { entriesProcessed: 5, incidentsCreated: 1, incidentsUpdated: 2, incidentsRecurred: 0, incidentsReplayed: 0 },
} as unknown as RunSummary;

function fakes(over: Partial<AdminApiDeps> = {}) {
  const calls: string[] = [];
  const deps: AdminApiDeps = {
    verifyToken: (t) => (t === TOKEN ? Promise.resolve({ uid: "admin-1" }) : Promise.reject(new Error("bad token: details that must not leak"))),
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

  async function start(over: Partial<AdminApiDeps> = {}): Promise<string> {
    server = startAdminApiServer(fakes(over).api, 0);
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
