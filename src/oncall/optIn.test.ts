import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { testConfig } from "../testConfig.js";
import { confirmNumber, optInAuditEntry, sendConfirmationCode, type OptInConfig } from "./optIn.js";
import type { TwilioClient } from "./twilio.js";

const T0 = new Date("2026-10-06T12:00:00Z");
const cfg: OptInConfig = { ...testConfig(), phoneEscalation: true };

/** Just enough of Firestore for the paths that never reach a transaction, and a transaction that always fails. */
function fakeDb(opts: { createFails?: boolean } = {}) {
  const created: { collection: string; data: unknown }[] = [];
  const runTransaction = vi.fn(() => Promise.reject(new Error("audit write refused")));
  const db = {
    collection: (collection: string) => ({
      doc: (id?: string) => ({
        // The operator records: admin1 is an admin, anyone else has no role.
        get: () => Promise.resolve({ exists: id === "admin1", get: (field: string) => (field === "roles" && id === "admin1" ? ["admin"] : undefined), data: () => (id === "admin1" ? { roles: ["admin"] } : undefined) }),
        create: (data: unknown) => {
          if (opts.createFails) return Promise.reject(new Error("audit write refused"));
          created.push({ collection, data });
          return Promise.resolve();
        },
        update: () => Promise.resolve(),
      }),
    }),
    runTransaction,
  } as unknown as Firestore;
  return { db, created, runTransaction };
}

const fakeTwilio = () => {
  const sendSms = vi.fn(() => Promise.resolve({ ok: true as const }));
  return { twilio: { sendSms, placeCall: vi.fn() } as unknown as TwilioClient, sendSms };
};

describe("optInAuditEntry", () => {
  it("records who, which person, what, the outcome and when, and nothing else", () => {
    const e = optInAuditEntry("oncall-send-code", "admin1", "p0", "sending", T0);
    expect(Object.keys(e).sort()).toEqual(["action", "actorUid", "at", "outcome", "personId"]);
    expect(e).toMatchObject({ action: "oncall-send-code", actorUid: "admin1", personId: "p0", outcome: "sending" });
    expect(e.at.toDate()).toEqual(T0);
  });

  it("leaves out a person id that is not a well-formed id", () => {
    expect(optInAuditEntry("oncall-confirm", "admin1", "../+15555550142", "invalid-id", T0)).not.toHaveProperty("personId");
  });
});

describe("refusals decided before the transaction", () => {
  it("records a send-code while escalation is off, and texts nothing", async () => {
    const { db, created } = fakeDb();
    const { twilio, sendSms } = fakeTwilio();
    expect(await sendConfirmationCode(db, { ...cfg, phoneEscalation: false }, twilio, "p0", "admin1", T0, () => "424242")).toEqual({ ok: false, reason: "off" });
    expect(created).toEqual([{ collection: cfg.auditCollection, data: expect.objectContaining({ action: "oncall-send-code", actorUid: "admin1", personId: "p0", outcome: "off" }) as unknown }]);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("records a confirm with a malformed code, without the code", async () => {
    const { db, created } = fakeDb();
    expect(await confirmNumber(db, cfg, "p0", "12345x", "admin1", T0)).toEqual({ ok: false, reason: "invalid-id" });
    expect(created).toHaveLength(1);
    expect(created[0]!.data).toMatchObject({ action: "oncall-confirm", outcome: "invalid-id", personId: "p0" });
    expect(JSON.stringify(created[0]!.data)).not.toContain("12345x");
  });

  it("records nothing for a call with no valid actor: there is nobody to attribute it to", async () => {
    const { db, created } = fakeDb();
    expect(await confirmNumber(db, cfg, "p0", "424242", "", T0)).toEqual({ ok: false, reason: "invalid-id" });
    expect(created).toHaveLength(0);
  });

  it("records nothing for a caller who is not an admin, so a guest cannot fill the audit collection", async () => {
    const { db, created, runTransaction } = fakeDb();
    const { twilio, sendSms } = fakeTwilio();
    expect(await sendConfirmationCode(db, cfg, twilio, "p0", "guest1", T0, () => "424242")).toEqual({ ok: false, reason: "not-admin" });
    expect(await confirmNumber(db, cfg, "p0", "424242", "guest1", T0)).toEqual({ ok: false, reason: "not-admin" });
    expect(created).toHaveLength(0);
    expect(runTransaction).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("throws when the refusal cannot be recorded", async () => {
    const { db } = fakeDb({ createFails: true });
    await expect(sendConfirmationCode(db, { ...cfg, phoneEscalation: false }, fakeTwilio().twilio, "p0", "admin1", T0)).rejects.toThrow();
  });
});

describe("fail closed", () => {
  it("sends no text when the transaction that writes the audit entry fails", async () => {
    const { db, runTransaction } = fakeDb();
    const { twilio, sendSms } = fakeTwilio();
    await expect(sendConfirmationCode(db, cfg, twilio, "p0", "admin1", T0, () => "424242")).rejects.toThrow("audit write refused");
    expect(runTransaction).toHaveBeenCalledOnce();
    expect(sendSms).not.toHaveBeenCalled();
  });
});
