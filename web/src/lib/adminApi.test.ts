import { describe, expect, it, vi } from "vitest";
import {
  confirmOnCallNumber,
  correctTriageAsVisitor,
  requestRetriageAsVisitor,
  retireIncident,
  runAgentNow,
  runIngestNow,
  sendOnCallCode,
  setIncidentStatusAsVisitor,
  type AdminApiDeps,
} from "./adminApi";

vi.mock("./config", () => ({ webConfig: () => ({ adminApiUrl: "" }) }));
vi.mock("./firebase", () => ({ firebaseAuth: vi.fn() }));

const reply = (status: number, body: unknown = {}) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
const deps = (fetchImpl: typeof fetch, token: string | null = "tok"): AdminApiDeps => ({
  baseUrl: "https://admin.example",
  getToken: async () => token,
  fetchImpl,
});

describe("runIngestNow", () => {
  it("posts with the bearer token and reads the summary", async () => {
    const f = reply(200, { ok: true, outcome: "ok", windows: 2, entriesProcessed: 9, incidentsCreated: 1, incidentsUpdated: 2, incidentsRecurred: 0, capped: false });
    const r = await runIngestNow(deps(f));
    expect(r).toEqual({ ok: true, value: { outcome: "ok", windows: 2, entriesProcessed: 9, incidentsCreated: 1, incidentsUpdated: 2, incidentsRecurred: 0, capped: false } });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://admin.example/api/ingest/run");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("never reads a missing field as a count it was not given", async () => {
    const r = await runIngestNow(deps(reply(200, { ok: true })));
    expect(r).toMatchObject({ ok: true, value: { outcome: "unknown", incidentsCreated: 0, capped: false } });
  });

  it.each([
    [401, "expired"],
    [403, "Only admins"],
    [409, "already in progress"],
    [500, "could not do that"],
  ])("explains a %i", async (status, text) => {
    const r = await runIngestNow(deps(reply(status, { error: "internal detail" })));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain(text);
    expect(!r.ok && r.message).not.toContain("internal detail");
  });

  it("does not call the network without a token or a configured URL", async () => {
    const f = reply(200);
    expect(await runIngestNow(deps(f, null))).toMatchObject({ ok: false });
    expect(await runIngestNow({ ...deps(f), baseUrl: "" })).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("reports an unreachable service", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await runIngestNow(deps(f))).toEqual({ ok: false, message: "Could not reach the admin service." });
  });
});

describe("runAgentNow (#276)", () => {
  it("posts to the agent route with the bearer token, and reads only the server's own \"started\" as a start", async () => {
    const f = reply(202, { ok: true, started: true });
    expect(await runAgentNow(deps(f))).toEqual({ ok: true, value: null });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://admin.example/api/agent/run");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");

    expect(await runAgentNow(deps(reply(200, { ok: true })))).toMatchObject({ ok: false });
    expect(await runAgentNow(deps(reply(200, null)))).toMatchObject({ ok: false });
  });

  it.each([
    [401, "expired"],
    [403, "Only admins"],
    [404, "no agent job"],
    [409, "already being started"],
    [502, "could not be started"],
    [500, "could not do that"],
  ])("explains a %i in the route's own words, never the server's detail", async (status, text) => {
    const r = await runAgentNow(deps(reply(status, { error: "internal detail" })));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain(text);
    expect(!r.ok && r.message).not.toContain("internal detail");
    expect(!r.ok && r.message).not.toContain("incident");
  });

  it("does not call the network without a token or a configured URL", async () => {
    const f = reply(202, { started: true });
    expect(await runAgentNow(deps(f, null))).toMatchObject({ ok: false });
    expect(await runAgentNow({ ...deps(f), baseUrl: "" })).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("on-call opt-in (#37)", () => {
  it("asks for a code and confirms one, on the person's own route", async () => {
    const f = reply(200, { ok: true });
    expect(await sendOnCallCode(deps(f), "p1")).toEqual({ ok: true, value: null });
    expect(await confirmOnCallNumber(deps(f), "p1", "123456")).toEqual({ ok: true, value: null });
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    expect(calls.map((c) => c[0])).toEqual(["https://admin.example/api/oncall/people/p1/send-code", "https://admin.example/api/oncall/people/p1/confirm"]);
    expect(calls[1]![1].body).toBe(JSON.stringify({ code: "123456" }));
  });

  it("shows the server's short reason for a refusal about the code, and the usual words for the session or the role", async () => {
    expect(await confirmOnCallNumber(deps(reply(400, { error: "wrong code" })), "p1", "123456")).toEqual({ ok: false, message: "Wrong code." });
    expect(await sendOnCallCode(deps(reply(409, { error: "phone escalation is off on this deployment" })), "p1")).toEqual({ ok: false, message: "Phone escalation is off on this deployment." });
    expect(await sendOnCallCode(deps(reply(403, { error: "admins only" })), "p1")).toEqual({ ok: false, message: "Only admins can do this." });
  });
});

describe("retireIncident", () => {
  it("encodes the id and sends the reason as JSON", async () => {
    const f = reply(200, { ok: true, alreadyRetired: true });
    const r = await retireIncident(deps(f), "a/b", "noise");
    expect(r).toEqual({ ok: true, value: { alreadyRetired: true } });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://admin.example/api/incidents/a%2Fb/retire");
    expect(init.body).toBe(JSON.stringify({ reason: "noise" }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("says so when the incident is gone", async () => {
    expect(await retireIncident(deps(reply(404)), "x", "")).toEqual({ ok: false, message: "That incident no longer exists." });
  });
});

describe("App Check header (#12)", () => {
  const headersOf = (f: typeof fetch) =>
    ((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;

  it("sends the App Check token as X-Firebase-AppCheck when there is one", async () => {
    const f = reply(200, { ok: true });
    await runIngestNow({ ...deps(f), getAppCheckToken: async () => "app-check-token" });
    expect(headersOf(f)["x-firebase-appcheck"]).toBe("app-check-token");
    expect(headersOf(f).authorization).toBe("Bearer tok");
  });

  it("sends no header, and still calls, when App Check is off, has no token, or fails", async () => {
    const variants: (AdminApiDeps["getAppCheckToken"] | undefined)[] = [
      undefined,
      async () => null,
      () => Promise.reject(new Error("recaptcha")),
    ];
    for (const getAppCheckToken of variants) {
      const f = reply(200, { ok: true });
      const r = await runIngestNow({ ...deps(f), ...(getAppCheckToken && { getAppCheckToken }) });
      expect(r.ok).toBe(true);
      expect("x-firebase-appcheck" in headersOf(f)).toBe(false);
    }
  });
});

describe("the public demo's visitor actions", () => {
  it("posts each incident action to its route with only what it needs", async () => {
    const f = reply(200, { ok: true });
    expect(await setIncidentStatusAsVisitor(deps(f), "inc 1", "resolve")).toEqual({ ok: true, value: null });
    expect(await requestRetriageAsVisitor(deps(f), "inc-1")).toEqual({ ok: true, value: null });
    expect(await correctTriageAsVisitor(deps(f), "inc-1", "log", "  ")).toEqual({ ok: true, value: null });
    expect(await correctTriageAsVisitor(deps(f), "inc-1", "fix", " flaky ")).toEqual({ ok: true, value: null });
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.body])).toEqual([
      ["https://admin.example/api/incidents/inc%201/status", JSON.stringify({ action: "resolve" })],
      ["https://admin.example/api/incidents/inc-1/retriage", undefined],
      ["https://admin.example/api/incidents/inc-1/correction", JSON.stringify({ level: "log" })],
      ["https://admin.example/api/incidents/inc-1/correction", JSON.stringify({ level: "fix", note: "flaky" })],
    ]);
  });

  it("shows the server's own reason for a refused change, and a plain one for a 403", async () => {
    expect(await setIncidentStatusAsVisitor(deps(reply(409, { error: "that change does not apply to this incident as it is now" })), "i", "acknowledge")).toEqual({
      ok: false,
      message: "That change does not apply to this incident as it is now.",
    });
    expect(await requestRetriageAsVisitor(deps(reply(403, { error: "anything" })), "i")).toEqual({ ok: false, message: "Visitors can't do this on this deployment." });
  });

  it("shows a limit's own message (which limit, when it lifts) on every route, a run included", async () => {
    const limit = { error: "the public demo's hourly limit for your address is reached: try again in 25 minutes" };
    const shown = "The public demo's hourly limit for your address is reached: try again in 25 minutes.";
    expect(await runAgentNow(deps(reply(429, limit)))).toEqual({ ok: false, message: shown });
    expect(await runIngestNow(deps(reply(429, limit)))).toEqual({ ok: false, message: shown });
    expect(await requestRetriageAsVisitor(deps(reply(429, limit)), "i")).toEqual({ ok: false, message: shown });
    // No readable reason: a generic one, never silence.
    expect(await runAgentNow(deps(reply(429, null)))).toEqual({ ok: false, message: "Too many requests from here. Try again later." });
  });
});
