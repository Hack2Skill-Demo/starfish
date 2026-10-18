/**
 * Twilio's webhooks for the phone escalation (#37): what a call says and hears. Served by the admin API's HTTP shell
 * (src/adminApi.ts routes `/twilio/*` here) WITHOUT a Firebase ID token, because Twilio has none; instead every request
 * must carry a valid `X-Twilio-Signature` over the configured public URL (never the request's Host header) and its POST
 * parameters, made with the account's auth token. Anything else is a 403 before the store is read. Nobody can place a
 * call through these routes: they only report on a call Starfish itself placed (the escalation and step are in the
 * signed URL), and the only thing they can start is the next step of a sequence that is already running.
 *
 *   /twilio/voice   the call was answered: a person hears the recording and the menu; voicemail hears a short fixed
 *                   message with no incident detail
 *   /twilio/gather  the key pressed: 1 takes it (the sequence ends; a `new` or `logged` incident becomes `acknowledged`, attributed
 *                   to `oncall:<person id>`), 2 texts the link to the incident (the link only, and only to the number
 *                   the call was placed to while it is still confirmed), 3 passes it to the next person, nothing or a
 *                   wrong key twice moves on
 *   /twilio/status  the call ended: no answer, busy, failed, voicemail or answered-with-no-decision moves the sequence on
 *
 * Every answer, keypress and outcome is a run event on the cycle (escalation.ts), masked, named by role.
 * Built, tested against signed requests and the Firestore emulator; never run against real Twilio.
 */
import { Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { appendEventsInTransaction, type RunEvent } from "../agent/cycle.js";
import { isTriageStatus, nextStatus } from "../incidentActions.js";
import { incidentUrl } from "../integrations/links.js";
import { refreshPublicCycle, refreshPublicIncident } from "../publicViewStore.js";
import { ROLE_LABELS, maskPhone, parsePerson, type OnCallRole } from "../oncallSchema.js";
import { advance, callNumberHash, closeUpdate, inTransaction, readCurrentCall, stopReason, STEPS, type CallOutcome, type EscalationConfig } from "./escalation.js";
import { SPOKEN, twiml, verifyTwilioSignature, type TwilioClient } from "./twilio.js";

export interface TwilioWebhookRequest {
  method: string;
  path: string;
  /** The raw query string, without `?`, exactly as Twilio requested it. */
  query: string;
  /** The POST parameters (form-encoded). */
  form: Record<string, string>;
  signature?: string;
}

export interface TwilioWebhookResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface TwilioWebhookDeps {
  db: Firestore;
  config: EscalationConfig & { uiBaseUrl: string };
  authToken: string;
  twilio: TwilioClient;
  now: () => Date;
  /** Take the sequence one step further now (escalation.ts `stepEscalation`), after a call ended. Errors are swallowed. */
  kick?: (escalationId: string) => Promise<void>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_INVALID_KEYS = 2;
const roleName = (role: unknown): string => (typeof role === "string" && role in ROLE_LABELS ? ROLE_LABELS[role as OnCallRole].toLowerCase() : "on-call person");

const xmlReply = (body: string): TwilioWebhookResponse => ({ status: 200, contentType: "text/xml", body });
const plainReply = (status: number, body: string): TwilioWebhookResponse => ({ status, contentType: "text/plain", body });

export function createTwilioWebhooks(deps: TwilioWebhookDeps): (req: TwilioWebhookRequest) => Promise<TwilioWebhookResponse> {
  const { db, config: cfg } = deps;

  return async (req) => {
    const route = req.path === "/twilio/voice" ? "voice" : req.path === "/twilio/gather" ? "gather" : req.path === "/twilio/status" ? "status" : undefined;
    if (route === undefined || cfg.twilioWebhookUrl === "") return plainReply(404, "not found");
    if (req.method !== "POST") return plainReply(405, "method not allowed");
    const url = `${cfg.twilioWebhookUrl}${req.path}${req.query ? `?${req.query}` : ""}`;
    if (!verifyTwilioSignature(deps.authToken, url, req.form, req.signature)) return plainReply(403, "forbidden");

    const params = new URLSearchParams(req.query);
    const id = params.get("e") ?? "";
    const step = Number(params.get("s"));
    if (!ID_RE.test(id) || !Number.isInteger(step) || step < 0 || step >= STEPS.length) return plainReply(400, "bad request");
    const selfUrl = (path: string) => `${cfg.twilioWebhookUrl}${path}?e=${encodeURIComponent(id)}&s=${step}`;

    /**
     * Run `fn` against the current call in a transaction; null when the call is no longer the one in flight. After the
     * commit, the guest copies of the call's cycle and incident are brought up to date with what was stored (#18).
     */
    const withCall = <T>(fn: (c: Extract<Awaited<ReturnType<typeof readCurrentCall>>, { current: true }>, tx: FirebaseFirestore.Transaction, note: (events: RunEvent[]) => void, now: Date) => T) => {
      let touched: { cycleId: string; incidentId: string } | undefined;
      return inTransaction(db, async (tx) => {
        touched = undefined;
        const now = deps.now();
        const c = await readCurrentCall(tx, db, cfg, id, step);
        if (!c.current) return null;
        touched = { cycleId: c.cycleRef.id, incidentId: c.incident.id };
        return fn(c, tx, (events) => appendEventsInTransaction(tx, c.cycleRef, c.cycle, now, events, cfg), now);
      }).then(async (result) => {
        if (touched) {
          await refreshPublicCycle(db, cfg, touched.cycleId);
          await refreshPublicIncident(db, cfg, touched.incidentId);
        }
        return result;
      });
    };

    /** End the current call with `outcome` and move the sequence on; then kick the next step. */
    const finishCall = async (outcome: CallOutcome): Promise<void> => {
      const moved = await withCall((c, tx, note, now) => {
        const r = advance(c.esc, outcome, now);
        tx.update(c.ref, r.update);
        note(r.events);
        return r;
      });
      if (moved && !moved.closed && deps.kick) await deps.kick(id).catch(() => undefined);
    };

    if (route === "voice") {
      const machine = /^(machine|fax)/.test(req.form.AnsweredBy ?? "");
      const answered = await withCall((c, tx, note, now) => {
        const stop = stopReason(c.incident);
        if (stop) {
          tx.update(c.ref, closeUpdate(stop.state, now));
          note([{ stage: "escalation", type: stop.state, summary: stop.summary, record: { state: stop.state } }]);
          return "over" as const;
        }
        tx.update(c.ref, {
          ...(typeof c.call.callSid !== "string" && /^CA[0-9a-f]{32}$/.test(req.form.CallSid ?? "") && { "call.callSid": req.form.CallSid }),
          "call.answeredBy": machine ? "machine" : "human",
          updatedAt: Timestamp.fromDate(now),
        });
        note([
          machine
            ? { stage: "escalation", type: "voicemail", summary: `Voicemail for the ${roleName(c.call.role)}: left a message with no incident detail`, data: { step } }
            : { stage: "escalation", type: "answered", summary: `The ${roleName(c.call.role)} answered`, data: { step } },
        ]);
        return machine ? ("voicemail" as const) : ("menu" as const);
      });
      if (answered === "menu") return xmlReply(twiml.menu(cfg.onCallAudioUrl, selfUrl("/twilio/gather")));
      if (answered === "voicemail") return xmlReply(twiml.sayAndHangUp(SPOKEN.voicemail));
      return xmlReply(twiml.sayAndHangUp(SPOKEN.over));
    }

    if (route === "status") {
      const status = req.form.CallStatus ?? "";
      if (!["completed", "busy", "no-answer", "failed", "canceled"].includes(status)) return xmlReply(twiml.empty());
      const outcome = await withCall((c) => {
        if (status === "busy" || status === "no-answer") return "no-answer" as const;
        if (status === "failed" || status === "canceled") return "failed" as const;
        if (c.call.answeredBy === "machine") return "voicemail" as const;
        return c.call.linkSent === true ? ("link-sent" as const) : ("no-input" as const);
      });
      if (outcome) await finishCall(outcome);
      return xmlReply(twiml.empty());
    }

    // ---- gather: the key pressed --------------------------------------------------------------------------------
    const digits = req.form.Digits ?? "";
    if (digits === "1") {
      const taken = await withCall((c, tx, note, now) => {
        const incident = c.incident.data();
        const personId = typeof c.call.personId === "string" ? c.call.personId : "unknown";
        tx.update(c.ref, { ...closeUpdate("acknowledged", now), ackBy: { personId, role: c.call.role ?? null, step }, ackAt: Timestamp.fromDate(now) });
        // Acknowledged "as that person": the operator transition the UI makes (`nextStatus`, the one table, #410).
        if (c.incident.exists && isTriageStatus(incident?.status) && nextStatus(incident.status, "acknowledge") !== null && incident.retired !== true) {
          tx.update(c.incident.ref, { status: "acknowledged", statusChangedBy: `oncall:${personId}`, updatedAt: Timestamp.fromDate(now) });
        }
        note([{ stage: "escalation", type: "acknowledged", summary: `The ${roleName(c.call.role)} pressed 1 and took it`, data: { step }, record: { state: "acknowledged", step } }]);
        return true;
      });
      return xmlReply(twiml.sayAndHangUp(taken ? SPOKEN.taken : SPOKEN.over));
    }
    if (digits === "2") {
      // Claimed in a transaction so a repeated 2 (or a retried webhook) texts once per call. The claim (`linkClaimed`) is
      // not the text: `linkSent` is set only once Twilio took it, and only that makes the call's outcome `link-sent` (#234).
      const target = await withCall(async (c, tx, _note, now) => {
        if (c.call.linkClaimed === true || c.call.linkSent === true || typeof c.call.personId !== "string") {
          return { already: true as const, sent: c.call.linkSent === true };
        }
        const person = await tx.get(db.collection(cfg.onCallPeopleCollection).doc(c.call.personId));
        const p = parsePerson(person.id, person.data(), 0);
        // Only to the number this call was placed to, and only while it is still confirmed (#187): an admin who changed the
        // number mid-call made it `pending`, and the new number never consented to anything.
        const same = p !== null && p.state === "confirmed" && c.call.numberHash === callNumberHash(p.id, p.phone);
        tx.update(c.ref, { "call.linkClaimed": true, updatedAt: Timestamp.fromDate(now) });
        return { already: false as const, phone: same ? p.phone : undefined, incidentId: String(c.esc.incidentId), role: c.call.role };
      });
      if (target === null) return xmlReply(twiml.sayAndHangUp(SPOKEN.over));
      if (target.already) return xmlReply(twiml.again(target.sent ? SPOKEN.linkSent : SPOKEN.linkFailed, selfUrl("/twilio/gather")));
      const link = incidentUrl(cfg.uiBaseUrl, target.incidentId);
      let sent: { ok: boolean; reason?: string } = { ok: false, reason: link === null ? "no-ui-url" : "no-confirmed-number" };
      if (link !== null && target.phone) {
        try {
          // The link and nothing else of the incident: a text message is not a place for incident detail.
          sent = await deps.twilio.sendSms(target.phone, `Starfish: the incident that needs a person: ${link}`);
        } catch {
          sent = { ok: false, reason: "client-error" };
        }
      }
      await withCall((c, tx, note, now) => {
        if (sent.ok) tx.update(c.ref, { "call.linkSent": true, updatedAt: Timestamp.fromDate(now) });
        note([
          sent.ok
            ? { stage: "escalation", type: "link-sent", summary: `The ${roleName(c.call.role)} pressed 2: the link was texted to ${target.phone ? maskPhone(target.phone) : "them"}`, data: { step } }
            : { stage: "escalation", type: "link-failed", summary: `The ${roleName(c.call.role)} pressed 2: the link could not be texted (${sent.reason ?? "unknown"})`, data: { step, reason: sent.reason ?? "unknown" } },
        ]);
      });
      return xmlReply(twiml.again(sent.ok ? SPOKEN.linkSent : SPOKEN.linkFailed, selfUrl("/twilio/gather")));
    }
    if (digits === "3") {
      await finishCall("passed");
      return xmlReply(twiml.sayAndHangUp(SPOKEN.passed));
    }
    if (digits === "") {
      const linkSent = await withCall((c) => c.call.linkSent === true);
      if (linkSent === null) return xmlReply(twiml.sayAndHangUp(SPOKEN.over));
      await finishCall(linkSent ? "link-sent" : "no-input");
      return xmlReply(twiml.sayAndHangUp(SPOKEN.noInput));
    }
    // A key that does nothing: say so and ask again, once; a second one ends the call like silence.
    const invalid = await withCall((c, tx, note, now) => {
      const count = Number(c.call.invalidKeys ?? 0) + 1;
      tx.update(c.ref, { "call.invalidKeys": count, updatedAt: Timestamp.fromDate(now) });
      note([{ stage: "escalation", type: "invalid-key", summary: `The ${roleName(c.call.role)} pressed a key that does nothing`, data: { step, count } }]);
      return count;
    });
    if (invalid === null) return xmlReply(twiml.sayAndHangUp(SPOKEN.over));
    if (invalid < MAX_INVALID_KEYS) return xmlReply(twiml.again(SPOKEN.invalid, selfUrl("/twilio/gather")));
    await finishCall("invalid-key");
    return xmlReply(twiml.sayAndHangUp(SPOKEN.noInput));
  };
}
