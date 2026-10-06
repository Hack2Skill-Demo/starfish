import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildNeedsHumanMessage, buildNewIncidentMessage, createSlackAlerter, createSlackNotifier, deliverToSlack, slackEscape, type AlertRequest, type NotifyRequest } from "./slack.js";
import { SEEDED_SECRETS } from "../ingest/testSecrets.js";

const req: NotifyRequest = {
  cycleId: "inc1_r0",
  incidentId: "inc1",
  functionName: "invoices-renderPdf",
  service: "invoices",
  errorType: "PermissionDenied",
  occurrenceCount: 31,
  path: "notify",
  rule: "notify:config",
  reason: "Cloud Translation API is disabled for this project.",
};
const UI = "https://starfish.example";

describe("buildNeedsHumanMessage", () => {
  it("says what failed, why a person is needed, and links to the incident and the run", () => {
    const m = buildNeedsHumanMessage(req, UI);
    const text = JSON.stringify(m);
    expect(m.text).toContain("invoices-renderPdf");
    expect(text).toContain("failed 31 times");
    expect(text).toContain("Cloud Translation API is disabled");
    expect(text).toContain("https://starfish.example/incidents/inc1");
    expect(text).toContain("https://starfish.example/runs?run=inc1_r0");
  });

  it("never says an incident failed zero times when its count is unknown", () => {
    const text = JSON.stringify(buildNeedsHumanMessage({ ...req, occurrenceCount: null }, UI));
    expect(text).toContain("invoices-renderPdf failed.");
    expect(text).not.toMatch(/failed \d+ times/);
  });

  it("adds a link to the incident's GitHub issue, only when it is a plain https URL", () => {
    const withIssue = JSON.stringify(buildNeedsHumanMessage({ ...req, issueUrl: "https://github.com/acme/shop/issues/9" }, ""));
    expect(withIssue).toContain("https://github.com/acme/shop/issues/9");
    for (const bad of ["javascript:alert(1)", "http://github.com/acme/shop/issues/9", "https://u:p@github.com/x", "not a url"]) {
      expect(JSON.stringify(buildNeedsHumanMessage({ ...req, issueUrl: bad }, "")), bad).not.toContain("Open the issue");
    }
  });

  it("tells a notify cycle from one where a fix was tried", () => {
    expect(buildNeedsHumanMessage(req, UI).text).toContain("No code change helps");
    expect(buildNeedsHumanMessage({ ...req, path: "human" }, UI).text).toContain("tried a fix");
  });

  it("has no links without a UI origin, or for an id that is not a plain id", () => {
    expect(JSON.stringify(buildNeedsHumanMessage(req, ""))).not.toContain("http");
    // each link is judged on its own id: a bad incident id costs only the incident link
    const onlyRun = JSON.stringify(buildNeedsHumanMessage({ ...req, incidentId: "a/../b" }, UI));
    expect(onlyRun).not.toContain("/incidents/");
    expect(onlyRun).toContain("/runs?run=inc1_r0");
    expect(JSON.stringify(buildNeedsHumanMessage({ ...req, incidentId: "a/../b", cycleId: "x y" }, UI))).not.toContain("http");
  });

  it("redacts credentials in every dynamic field", () => {
    const secrets = Object.values(SEEDED_SECRETS);
    const dirty = secrets.join(" ");
    const m = buildNeedsHumanMessage({ ...req, reason: dirty, functionName: dirty, service: dirty, errorType: dirty, rule: dirty }, UI);
    const text = JSON.stringify(m);
    for (const [name, secret] of Object.entries(SEEDED_SECRETS)) {
      // a multi-line secret is JSON-escaped in the payload, so compare on its first line
      expect(text, name).not.toContain(secret.split("\n")[0]!);
    }
  });

  it("cannot be steered by incident text: no markup is parsed, and the fields are bounded", () => {
    const m = buildNeedsHumanMessage({ ...req, reason: "<!channel> <@U123> <https://evil.example|click> ".repeat(100) }, UI);
    expect(m.mrkdwn).toBe(false);
    for (const b of m.blocks as Array<{ type: string; text?: { type: string; text: string } }>) {
      if (b.text) {
        expect(b.text.type).toBe("plain_text");
        expect(b.text.text.length).toBeLessThan(1000);
      }
    }
    // the attacker's text is inert plain text; the only thing a person can click is the two links this module built
    const clickable = (m.blocks as Array<{ elements?: Array<{ url?: string }> }>).flatMap((b) => (b.elements ?? []).map((e) => e.url));
    expect(clickable).toEqual(["https://starfish.example/incidents/inc1", "https://starfish.example/runs?run=inc1_r0"]);
  });

  // #141: Slack reads `<!channel>` in the top-level text (the notification and fallback) as a control sequence.
  it("escapes &, < and > in the top-level text, so incident text cannot ping a channel or make a link there", () => {
    const m = buildNeedsHumanMessage({ ...req, functionName: "<!channel> a&b", errorType: "<https://evil.example|x>" }, UI);
    expect(m.text).not.toMatch(/[<>]/);
    expect(m.text).toContain("&lt;!channel&gt; a&amp;b");
    expect(m.text).toContain("&lt;https://evil.example|x&gt;");
    expect(m.text.replace(/&(amp|lt|gt);/g, "")).not.toContain("&");
  });
});

describe("buildNewIncidentMessage (#ops-alerts)", () => {
  const alert: AlertRequest = {
    cycleId: "inc1_r0",
    incidentId: "inc1",
    functionName: "orders-create",
    service: "orders",
    errorType: "TypeError",
    occurrenceCount: 12,
    path: "act",
    reason: "A null customer reaches the total.",
  };

  it("says what is new, what Starfish will do next, and links to the incident, the run and the issue", () => {
    const m = buildNewIncidentMessage({ ...alert, issueUrl: "https://github.com/acme/shop/issues/9" }, UI);
    const text = JSON.stringify(m);
    expect(m.text).toContain("New incident: orders-create (TypeError)");
    expect(m.text).toContain("drafting a fix");
    expect(text).toContain("failed 12 times");
    expect(text).toContain("A null customer reaches the total.");
    const clickable = (m.blocks as Array<{ elements?: Array<{ url?: string }> }>).flatMap((b) => (b.elements ?? []).map((e) => e.url));
    expect(clickable).toEqual(["https://starfish.example/incidents/inc1", "https://starfish.example/runs?run=inc1_r0", "https://github.com/acme/shop/issues/9"]);
  });

  it("tells an escalated incident from one Starfish acts on, and never says zero times for an unknown count", () => {
    const m = buildNewIncidentMessage({ ...alert, path: "notify", occurrenceCount: null }, UI);
    expect(m.text).toContain("No code change helps");
    expect(JSON.stringify(m)).not.toMatch(/failed \d+ times/);
  });

  it("is plain text, escaped in the top-level text, bounded and redacted", () => {
    const dirty = `<!channel> <@U1> ${Object.values(SEEDED_SECRETS).join(" ")} `.repeat(20);
    const m = buildNewIncidentMessage({ ...alert, functionName: "<!here> a&b", reason: dirty, service: dirty }, UI);
    expect(m.mrkdwn).toBe(false);
    expect(m.text).not.toMatch(/[<>]/);
    expect(m.text).toContain("&lt;!here&gt; a&amp;b");
    const text = JSON.stringify(m);
    for (const [name, secret] of Object.entries(SEEDED_SECRETS)) expect(text, name).not.toContain(secret.split("\n")[0]!);
    for (const b of m.blocks as Array<{ text?: { type: string; text: string } }>) {
      if (b.text) {
        expect(b.text.type).toBe("plain_text");
        expect(b.text.text.length).toBeLessThan(1000);
      }
    }
  });
});

describe("slackEscape", () => {
  it("escapes & first, so an escape is not escaped twice", () => {
    expect(slackEscape("<&>")).toBe("&lt;&amp;&gt;");
    expect(slackEscape("plain")).toBe("plain");
  });
});

describe("delivery against a fake webhook", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
  });

  /** A webhook that answers from a script, one entry per request, and records what it was sent. */
  async function webhook(script: Array<{ status: number; body?: string; headers?: Record<string, string>; hang?: boolean }>) {
    const received: string[] = [];
    let i = 0;
    server = createServer((rq: IncomingMessage, rs: ServerResponse) => {
      let data = "";
      rq.on("data", (c) => (data += c));
      rq.on("end", () => {
        received.push(data);
        const step = script[Math.min(i++, script.length - 1)]!;
        if (step.hang) return; // never answers
        rs.writeHead(step.status, step.headers ?? {});
        rs.end(step.body ?? "");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/services/T000/B000/XXXX`, received };
  }
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  afterEach(() => void (sleeps.length = 0));

  it("sends the payload once and reports sent", async () => {
    const hook = await webhook([{ status: 200, body: "ok" }]);
    const result = await createSlackNotifier({ webhookUrl: hook.url, uiBaseUrl: UI, sleep })(req);
    expect(result).toEqual({ state: "sent", attempts: 1 });
    expect(hook.received).toHaveLength(1);
    expect(JSON.parse(hook.received[0]!).text).toContain("invoices-renderPdf");
  });

  it("posts the new-incident message through the alerter, to its own webhook", async () => {
    const hook = await webhook([{ status: 200, body: "ok" }]);
    const result = await createSlackAlerter({ webhookUrl: hook.url, uiBaseUrl: UI, sleep })({ ...req, path: "act", reason: "x" });
    expect(result).toEqual({ state: "sent", attempts: 1 });
    expect(JSON.parse(hook.received[0]!).text).toContain("New incident: invoices-renderPdf");
  });

  it("retries a 5xx and then succeeds", async () => {
    const hook = await webhook([{ status: 503 }, { status: 200, body: "ok" }]);
    expect(await deliverToSlack({ webhookUrl: hook.url, uiBaseUrl: UI, sleep }, buildNeedsHumanMessage(req, UI))).toEqual({ state: "sent", attempts: 2 });
    expect(sleeps).toEqual([500]);
  });

  it("waits what Slack asks on a 429, capped", async () => {
    const hook = await webhook([{ status: 429, headers: { "retry-after": "3" } }, { status: 429, headers: { "retry-after": "999" } }, { status: 200, body: "ok" }]);
    expect(await deliverToSlack({ webhookUrl: hook.url, uiBaseUrl: UI, sleep }, buildNeedsHumanMessage(req, UI))).toMatchObject({ state: "sent", attempts: 3 });
    expect(sleeps).toEqual([3000, 10_000]);
  });

  it("gives up after the bound, saying so, with the last reason", async () => {
    const hook = await webhook([{ status: 500 }]);
    const r = await deliverToSlack({ webhookUrl: hook.url, uiBaseUrl: UI, sleep }, buildNeedsHumanMessage(req, UI));
    expect(r).toEqual({ state: "failed", attempts: 3, reason: "http-500 (gave up after 3 attempts)" });
    expect(hook.received).toHaveLength(3);
  });

  it("does not retry a refusal that repeating cannot fix, and keeps only Slack's short error code", async () => {
    const hook = await webhook([{ status: 404, body: "no_service" }]);
    const r = await deliverToSlack({ webhookUrl: hook.url, uiBaseUrl: UI, sleep }, buildNeedsHumanMessage(req, UI));
    expect(r).toEqual({ state: "failed", attempts: 1, reason: "http-404:no_service" });
    expect(hook.received).toHaveLength(1);
  });

  it("never echoes a response body that is not a short code, and never contains the webhook URL", async () => {
    const hook = await webhook([{ status: 400, body: `<html>leaked ${SEEDED_SECRETS.github}</html>` }]);
    const r = await deliverToSlack({ webhookUrl: hook.url, uiBaseUrl: UI, sleep }, buildNeedsHumanMessage(req, UI));
    expect(r).toEqual({ state: "failed", attempts: 1, reason: "http-400" });
    expect(JSON.stringify(r)).not.toContain(hook.url);
  });

  it("treats a 200 that is not Slack's `ok` as a failure rather than a delivery", async () => {
    const hook = await webhook([{ status: 200, body: "<html>captive portal</html>" }]);
    expect(await deliverToSlack({ webhookUrl: hook.url, uiBaseUrl: UI, sleep }, buildNeedsHumanMessage(req, UI))).toMatchObject({ state: "failed", reason: "unexpected-response" });
  });

  it("reports an unreachable webhook without leaking its URL", async () => {
    const hook = await webhook([{ status: 200, body: "ok" }]);
    await new Promise((r) => server!.close(r));
    server = undefined;
    const r = await deliverToSlack({ webhookUrl: hook.url, uiBaseUrl: UI, sleep }, buildNeedsHumanMessage(req, UI));
    expect(r).toMatchObject({ state: "failed", attempts: 3 });
    expect(r.reason).toContain("network-error");
    expect(JSON.stringify(r)).not.toContain("127.0.0.1");
  });

  it("times out a webhook that never answers", async () => {
    const hook = await webhook([{ status: 200, hang: true }]);
    const r = await deliverToSlack({ webhookUrl: hook.url, uiBaseUrl: UI, sleep, maxAttempts: 1, timeoutMs: 50 }, buildNeedsHumanMessage(req, UI));
    expect(r).toMatchObject({ state: "failed", attempts: 1 });
    expect(r.reason).toContain("timeout");
  });

  it("does not follow a redirect to somewhere else", async () => {
    const hook = await webhook([{ status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } }]);
    const r = await deliverToSlack({ webhookUrl: hook.url, uiBaseUrl: UI, sleep, maxAttempts: 1 }, buildNeedsHumanMessage(req, UI));
    expect(r.state).toBe("failed");
  });
});
