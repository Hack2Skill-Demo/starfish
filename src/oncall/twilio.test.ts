import { describe, expect, it } from "vitest";
import { createTwilioClient, SPOKEN, twilioSignature, twiml, verifyTwilioSignature } from "./twilio.js";

const credentials = { accountSid: `AC${"a".repeat(32)}`, authToken: "f".repeat(32), fromNumber: "+15550000000" };

describe("Twilio's webhook signature", () => {
  // The example in Twilio's own documentation of X-Twilio-Signature.
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+14158675309", Digits: "1234", From: "+14158675309", To: "+18005551212" };

  it("matches Twilio's documented example", () => {
    expect(twilioSignature("12345", url, params)).toBe("RSOYDt4T1cUTdK1PDd93/VVr8B8=");
    expect(verifyTwilioSignature("12345", url, params, "RSOYDt4T1cUTdK1PDd93/VVr8B8=")).toBe(true);
  });

  it("rejects a wrong token, a changed URL, a changed or added parameter, and a missing header", () => {
    const sig = "RSOYDt4T1cUTdK1PDd93/VVr8B8=";
    expect(verifyTwilioSignature("54321", url, params, sig)).toBe(false);
    expect(verifyTwilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=3", params, sig)).toBe(false);
    expect(verifyTwilioSignature("12345", url, { ...params, Digits: "1" }, sig)).toBe(false);
    expect(verifyTwilioSignature("12345", url, { ...params, Extra: "x" }, sig)).toBe(false);
    expect(verifyTwilioSignature("12345", url, params, undefined)).toBe(false);
    expect(verifyTwilioSignature("12345", url, params, "")).toBe(false);
  });
});

describe("TwiML", () => {
  it("plays the one recording and reads one key, reporting silence too", () => {
    const x = twiml.menu("https://storage.example/oncall.mp3", "https://admin.example/twilio/gather?e=c1&s=0");
    expect(x).toContain('<Gather numDigits="1"');
    expect(x).toContain('actionOnEmptyResult="true"');
    expect(x).toContain("<Play>https://storage.example/oncall.mp3</Play>");
    expect(x).toContain('action="https://admin.example/twilio/gather?e=c1&amp;s=0"');
    expect(x).toContain(SPOKEN.menu);
  });

  it("escapes what it is given", () => {
    expect(twiml.sayAndHangUp('a <b> & "c"')).toContain("a &lt;b&gt; &amp; &quot;c&quot;");
  });

  it("speaks only fixed text: no incident detail in anything a call says", () => {
    for (const text of Object.values(SPOKEN)) expect(text).not.toMatch(/\$\{|incident [A-Za-z0-9_-]{6,}/);
  });
});

type Call = { url: string; init: RequestInit };
const fakeFetch = (status: number, body: unknown, calls: Call[]): typeof fetch =>
  (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

describe("createTwilioClient", () => {
  it("places a call with the recording URL, the status callback and voicemail detection", async () => {
    const calls: Call[] = [];
    const client = createTwilioClient({ credentials, apiUrl: "http://localhost:9", fetchImpl: fakeFetch(201, { sid: `CA${"1".repeat(32)}` }, calls) });
    const r = await client.placeCall("+15551234542", { voiceUrl: "https://a.example/twilio/voice?e=c&s=0", statusUrl: "https://a.example/twilio/status?e=c&s=0" });
    expect(r).toEqual({ ok: true, callSid: `CA${"1".repeat(32)}` });
    expect(calls[0]!.url).toBe(`http://localhost:9/2010-04-01/Accounts/${credentials.accountSid}/Calls.json`);
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get("To")).toBe("+15551234542");
    expect(form.get("From")).toBe("+15550000000");
    expect(form.get("Url")).toBe("https://a.example/twilio/voice?e=c&s=0");
    expect(form.get("StatusCallback")).toBe("https://a.example/twilio/status?e=c&s=0");
    expect(form.get("MachineDetection")).toBe("Enable");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString("base64")}`);
  });

  it("turns a refusal into a result with the status and Twilio's code, never the token or the number", async () => {
    const calls: Call[] = [];
    const client = createTwilioClient({ credentials, apiUrl: "http://localhost:9", fetchImpl: fakeFetch(400, { code: 21211, message: "The 'To' number +15551234542 is not valid" }, calls) });
    const r = await client.placeCall("+15551234542", { voiceUrl: "v", statusUrl: "s" });
    expect(r).toEqual({ ok: false, reason: "http-400:21211" });
    expect(JSON.stringify(r)).not.toContain(credentials.authToken);
    expect(JSON.stringify(r)).not.toContain("5551234542");
  });

  it("does not retry (a retried call can ring twice), and never throws on a network error", async () => {
    let n = 0;
    const client = createTwilioClient({
      credentials,
      apiUrl: "http://localhost:9",
      fetchImpl: (async () => {
        n += 1;
        throw new Error(`connect ECONNREFUSED https://user:${credentials.authToken}@x`);
      }) as typeof fetch,
    });
    expect(await client.placeCall("+15551234542", { voiceUrl: "v", statusUrl: "s" })).toEqual({ ok: false, reason: "network-error" });
    expect(n).toBe(1);
  });

  it("refuses a response with no call id", async () => {
    const client = createTwilioClient({ credentials, apiUrl: "http://localhost:9", fetchImpl: fakeFetch(201, { sid: "nope" }, []) });
    expect(await client.placeCall("+15551234542", { voiceUrl: "v", statusUrl: "s" })).toEqual({ ok: false, reason: "unexpected-response" });
  });

  it("sends a text", async () => {
    const calls: Call[] = [];
    const client = createTwilioClient({ credentials, apiUrl: "http://localhost:9", fetchImpl: fakeFetch(201, { sid: `SM${"2".repeat(32)}` }, calls) });
    expect(await client.sendSms("+15551234542", "hello")).toEqual({ ok: true });
    expect(calls[0]!.url).toContain("/Messages.json");
    expect(new URLSearchParams(String(calls[0]!.init.body)).get("Body")).toBe("hello");
  });
});
