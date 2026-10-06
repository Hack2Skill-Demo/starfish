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

describe("admin API: routes", () => {
  it("serves health without a token, and refuses other paths and methods", async () => {
    const { api } = fakes();
    expect((await api({ method: "GET", path: "/healthz" })).status).toBe(200);
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
  });

  it("refuses a body over 4 KB, and treats a body that is not JSON as no body", async () => {
    const base = await start();
    const big = await fetch(`${base}/api/ingest/run`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "x".repeat(6000) }) });
    expect(big.status).toBe(413);
    const junk = await fetch(`${base}/api/incidents/i/retire`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{not json" });
    expect(junk.status).toBe(200);
  });
});
