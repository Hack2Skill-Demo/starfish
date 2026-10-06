/**
 * A person's consent to be phoned (#37): no number is ever called until its owner read back a code Starfish texted it.
 *
 *   1. An admin adds a person in Settings -> On-call: firestore.rules lets a client create one only as `pending`, and
 *      changing a number makes it `pending` again.
 *   2. An admin asks for a code (`sendConfirmationCode`, the admin API's `POST /api/oncall/people/<id>/send-code`):
 *      one text with a six-digit code, valid ten minutes, at most one a minute. Only on that explicit request: a number
 *      being added texts nothing.
 *   3. The person tells the admin the code, who enters it (`confirmNumber`, `POST .../confirm`): right code, same number,
 *      not expired, fewer than five wrong tries, and the number becomes `confirmed`.
 * Only the engine writes `confirmed` (the Admin SDK); the code itself is never stored, only a hash bound to the person
 * AND the number, so a code sent to one number cannot confirm another.
 *
 * Admin only, checked HERE from the operator record, like src/ingest/retire.ts. Built, tested against a fake Twilio and
 * the Firestore emulator; never run against real Twilio.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { StarfishConfig } from "../config.js";
import { hasAdminRole, isValidUid } from "../adminAuth.js";
import { parsePerson } from "../oncallSchema.js";
import type { TwilioClient } from "./twilio.js";

export type OptInConfig = Pick<StarfishConfig, "usersCollection" | "onCallPeopleCollection" | "phoneEscalation">;

export type SendCodeResult = { ok: true } | { ok: false; reason: "not-admin" | "invalid-id" | "no-such-person" | "already-confirmed" | "too-soon" | "off" | "send-failed" };
export type ConfirmResult = { ok: true } | { ok: false; reason: "not-admin" | "invalid-id" | "no-such-person" | "no-code" | "expired" | "wrong-code" | "too-many-tries" };

export const CODE_TTL_MS = 10 * 60_000;
export const RESEND_AFTER_MS = 60_000;
export const MAX_TRIES = 5;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const ms = (v: unknown): number | undefined => {
  const t = v as { toMillis?: unknown } | null | undefined;
  return typeof t?.toMillis === "function" ? (t.toMillis() as number) : undefined;
};

/** The stored form of a code: bound to the person and the number. */
export const codeHash = (personId: string, phone: string, code: string): string => createHash("sha256").update(`${personId}\n${phone}\n${code}`).digest("hex");

export async function sendConfirmationCode(
  db: Firestore,
  cfg: OptInConfig,
  twilio: TwilioClient | undefined,
  personId: string,
  actorUid: string,
  now: Date,
  makeCode: () => string = () => String(randomInt(0, 1_000_000)).padStart(6, "0")
): Promise<SendCodeResult> {
  if (!ID_RE.test(personId) || !isValidUid(actorUid)) return { ok: false, reason: "invalid-id" };
  // A text costs money: nothing is sent while the deployment has phone escalation off, or has no Twilio.
  if (!cfg.phoneEscalation || !twilio) return { ok: false, reason: "off" };
  const ref = db.collection(cfg.onCallPeopleCollection).doc(personId);
  const code = makeCode();
  const claimed = await db.runTransaction(async (tx): Promise<SendCodeResult | { ok: true; phone: string }> => {
    const [actor, snap] = await Promise.all([tx.get(db.collection(cfg.usersCollection).doc(actorUid)), tx.get(ref)]);
    if (!hasAdminRole(actor)) return { ok: false, reason: "not-admin" };
    const person = snap.exists ? parsePerson(personId, snap.data(), 0) : null;
    if (!person) return { ok: false, reason: "no-such-person" };
    if (person.state === "confirmed") return { ok: false, reason: "already-confirmed" };
    const last = ms(snap.get("codeSentAt"));
    if (last !== undefined && now.getTime() - last < RESEND_AFTER_MS) return { ok: false, reason: "too-soon" };
    tx.update(ref, {
      codeHash: codeHash(personId, person.phone, code),
      codeSentAt: Timestamp.fromDate(now),
      codeExpiresAt: Timestamp.fromMillis(now.getTime() + CODE_TTL_MS),
      codeTries: 0,
    });
    return { ok: true, phone: person.phone };
  });
  if (!("phone" in claimed)) return claimed;
  let sent: Awaited<ReturnType<TwilioClient["sendSms"]>>;
  try {
    sent = await twilio.sendSms(claimed.phone, `Starfish on-call: your confirmation code is ${code}. Give it to your Starfish admin to agree to be phoned about urgent incidents.`);
  } catch {
    sent = { ok: false, reason: "client-error" };
  }
  return sent.ok ? { ok: true } : { ok: false, reason: "send-failed" };
}

export async function confirmNumber(db: Firestore, cfg: OptInConfig, personId: string, code: string, actorUid: string, now: Date): Promise<ConfirmResult> {
  if (!ID_RE.test(personId) || !isValidUid(actorUid) || !/^\d{6}$/.test(code)) return { ok: false, reason: "invalid-id" };
  const ref = db.collection(cfg.onCallPeopleCollection).doc(personId);
  return db.runTransaction(async (tx): Promise<ConfirmResult> => {
    const [actor, snap] = await Promise.all([tx.get(db.collection(cfg.usersCollection).doc(actorUid)), tx.get(ref)]);
    if (!hasAdminRole(actor)) return { ok: false, reason: "not-admin" };
    const person = snap.exists ? parsePerson(personId, snap.data(), 0) : null;
    if (!person) return { ok: false, reason: "no-such-person" };
    if (person.state === "confirmed") return { ok: true };
    const stored = snap.get("codeHash") as unknown;
    if (typeof stored !== "string") return { ok: false, reason: "no-code" };
    if ((ms(snap.get("codeExpiresAt")) ?? 0) <= now.getTime()) return { ok: false, reason: "expired" };
    const tries = Number(snap.get("codeTries") ?? 0);
    if (tries >= MAX_TRIES) return { ok: false, reason: "too-many-tries" };
    const expected = Buffer.from(stored);
    const given = Buffer.from(codeHash(personId, person.phone, code));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      tx.update(ref, { codeTries: tries + 1 });
      return { ok: false, reason: "wrong-code" };
    }
    tx.update(ref, {
      state: "confirmed",
      confirmedAt: Timestamp.fromDate(now),
      confirmedBy: actorUid,
      codeHash: FieldValue.delete(),
      codeSentAt: FieldValue.delete(),
      codeExpiresAt: FieldValue.delete(),
      codeTries: FieldValue.delete(),
    });
    return { ok: true };
  });
}
