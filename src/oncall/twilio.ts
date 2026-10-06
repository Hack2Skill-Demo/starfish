/**
 * Twilio, the telephony provider of the phone escalation (#37): place one call, send one text, and check that a webhook
 * really came from Twilio. Built, tested against a fake Twilio over an injected `fetch`; never run against real Twilio.
 *
 * What it will not do:
 *   - Throw. A call or a text that could not be placed is a RESULT (`ok: false` with a short reason), recorded by the
 *     caller, because the escalation must move on to the next person rather than die with the request.
 *   - Retry. Twilio has no idempotency key: a call retried after a timeout may ring twice. The sequence itself is the
 *     retry (the primary is called again two minutes later; then the next person).
 *   - Reveal the credentials or the number. The auth token is only ever in the Authorization header; a failure's
 *     reason is the HTTP status and, at most, Twilio's numeric error code.
 *   - Speak incident text. The call plays the ONE configured audio file; everything else said on a call is fixed text
 *     in this file (`SPOKEN`). The text message carries a link to the incident and nothing else of it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { TwilioCredentials } from "../config.js";

export type PlaceResult = { ok: true; callSid: string } | { ok: false; reason: string };
export type SmsResult = { ok: true } | { ok: false; reason: string };

export interface TwilioClient {
  /** Dial `to`; Twilio fetches `voiceUrl` when it is answered and posts the call's end to `statusUrl`. */
  placeCall(to: string, urls: { voiceUrl: string; statusUrl: string }): Promise<PlaceResult>;
  sendSms(to: string, body: string): Promise<SmsResult>;
}

export interface TwilioDeps {
  credentials: TwilioCredentials;
  /** `https://api.twilio.com`, or a local fake in tests. */
  apiUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** How long a phone rings before Twilio gives up and reports `no-answer`. */
export const RING_SECONDS = 25;
const TIMEOUT_MS = 10_000;

/** Everything a call says aloud apart from the recorded file: fixed text, never data. */
export const SPOKEN = {
  menu: "Press 1 to take it. Press 2 to get a text with the link. Press 3 to pass it to the next person.",
  voicemail: "This is Starfish. An urgent incident needs a person. The details are in the on-call channel.",
  noInput: "No key was pressed. Starfish will try the next person. Goodbye.",
  taken: "Thank you. It is yours. Goodbye.",
  linkSent: "The link is on its way.",
  linkFailed: "The text could not be sent. The details are in the on-call channel.",
  passed: "Passing it to the next person. Goodbye.",
  invalid: "That key does nothing.",
  over: "Someone has already taken this, or it no longer needs a person. Goodbye.",
} as const;

/** Twilio's documented `X-Twilio-Signature`: HMAC-SHA1 over the full URL followed by each POST key and value, sorted by key. */
export function twilioSignature(authToken: string, url: string, params: Readonly<Record<string, string>>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/** Constant-time comparison of the header against the signature this URL and these params must carry. */
export function verifyTwilioSignature(authToken: string, url: string, params: Readonly<Record<string, string>>, header: string | undefined): boolean {
  if (typeof header !== "string" || header.length === 0 || header.length > 200) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const xml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A TwiML document. Every value is escaped; the only dynamic ones are our own URLs. */
export const twiml = {
  /** The call: the recorded message, then one key. `actionOnEmptyResult` so silence is reported too. */
  menu: (audioUrl: string, actionUrl: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" method="POST" actionOnEmptyResult="true" action="${xml(actionUrl)}"><Play>${xml(audioUrl)}</Play><Say>${xml(SPOKEN.menu)}</Say></Gather></Response>`,
  /** After a text, or a key that does nothing: say so, then the menu again without the recording. */
  again: (lead: string, actionUrl: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" method="POST" actionOnEmptyResult="true" action="${xml(actionUrl)}"><Say>${xml(`${lead} ${SPOKEN.menu}`)}</Say></Gather></Response>`,
  sayAndHangUp: (text: string): string => `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(text)}</Say><Hangup/></Response>`,
  empty: (): string => `<?xml version="1.0" encoding="UTF-8"?><Response/>`,
};

async function post(deps: TwilioDeps, resource: "Calls" | "Messages", form: Record<string, string>): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  const { accountSid, authToken } = deps.credentials;
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${deps.apiUrl}/2010-04-01/Accounts/${accountSid}/${resource}.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (err) {
    // The error text can carry the URL (with the account SID): say only what kind of failure it was.
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, reason: timedOut ? "timeout" : "network-error" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const code = (body as { code?: unknown } | undefined)?.code;
    return { ok: false, reason: `http-${res.status}${typeof code === "number" && Number.isInteger(code) ? `:${code}` : ""}` };
  }
  return { ok: true, body };
}

export function createTwilioClient(deps: TwilioDeps): TwilioClient {
  return {
    async placeCall(to, urls) {
      const r = await post(deps, "Calls", {
        To: to,
        From: deps.credentials.fromNumber,
        Url: urls.voiceUrl,
        Method: "POST",
        StatusCallback: urls.statusUrl,
        StatusCallbackMethod: "POST",
        // Tells a person from an answering machine on the voice webhook (`AnsweredBy`), so voicemail hears no menu.
        MachineDetection: "Enable",
        Timeout: String(RING_SECONDS),
      });
      if (!r.ok) return r;
      const sid = (r.body as { sid?: unknown } | undefined)?.sid;
      return typeof sid === "string" && /^CA[0-9a-f]{32}$/.test(sid) ? { ok: true, callSid: sid } : { ok: false, reason: "unexpected-response" };
    },
    async sendSms(to, body) {
      const r = await post(deps, "Messages", { To: to, From: deps.credentials.fromNumber, Body: body });
      return r.ok ? { ok: true } : r;
    },
  };
}
