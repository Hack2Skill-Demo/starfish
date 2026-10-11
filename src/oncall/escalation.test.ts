import { describe, expect, it } from "vitest";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { advance, escalationEligible, inTransaction, isCritical, personFor, STEPS } from "./escalation.js";
import type { OnCallPerson } from "../oncallSchema.js";

describe("inTransaction (#245)", () => {
  /** A runner that, like Firestore's, redoes an attempt that failed ABORTED (code 10), up to five times. */
  const runner = (): Firestore =>
    ({
      runTransaction: async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await fn({} as Transaction);
          } catch (err) {
            if ((err as { code?: unknown }).code !== 10 || attempt >= 5) throw err;
          }
        }
      },
    }) as unknown as Firestore;
  const closed = () => Object.assign(new Error("3 INVALID_ARGUMENT: Transaction is invalid or closed."), { code: 3 });

  it("redoes an attempt whose read found the transaction closed, within the runner's attempts", async () => {
    let calls = 0;
    const r = await inTransaction(runner(), async () => {
      calls += 1;
      if (calls === 1) throw closed();
      return "done";
    });
    expect(r).toBe("done");
    expect(calls).toBe(2);
  });

  it("gives up after the runner's attempts, and passes any other error through untouched", async () => {
    await expect(inTransaction(runner(), () => Promise.reject(closed()))).rejects.toMatchObject({ code: 10 });
    const other = Object.assign(new Error("3 INVALID_ARGUMENT: bad field"), { code: 3 });
    let calls = 0;
    await expect(
      inTransaction(runner(), () => {
        calls += 1;
        return Promise.reject(other);
      })
    ).rejects.toBe(other);
    expect(calls).toBe(1);
  });
});

const now = new Date("2026-10-06T12:00:00Z");
const cycle = (over: Record<string, unknown> = {}, notify: Record<string, unknown> = { state: "sent", at: "2026-10-06T11:50:00.000Z" }) => ({
  state: "waiting-human",
  path: "notify",
  summary: { triage: { decision: "notify" }, notify },
  ...over,
});

describe("escalationEligible", () => {
  it("is the time of the Slack message for an urgent cycle waiting for a person", () => {
    expect(escalationEligible(cycle(), now)?.toISOString()).toBe("2026-10-06T11:50:00.000Z");
    expect(escalationEligible(cycle({ path: "human", summary: { triage: { decision: "act" }, notify: { state: "failed", at: "2026-10-06T11:50:00.000Z" } } }), now)).not.toBeNull();
    // A dry run sent nothing, and the sequence that follows places nothing; it still records what it would do.
    expect(escalationEligible(cycle({}, { state: "dry-run", at: "2026-10-06T11:50:00.000Z" }), now)).not.toBeNull();
  });

  it("is null for anything triage did not judge worth a person, or not waiting for one", () => {
    expect(escalationEligible(cycle({ summary: { triage: { decision: "decline" }, notify: { state: "sent", at: "2026-10-06T11:50:00.000Z" } } }), now)).toBeNull();
    expect(escalationEligible(cycle({ state: "done" }), now)).toBeNull();
    expect(escalationEligible(cycle({ path: "draft" }), now)).toBeNull();
    expect(escalationEligible(undefined, now)).toBeNull();
  });

  it("is null with no recorded message, one still pending, one with no time, or one older than a day", () => {
    expect(escalationEligible(cycle({}, { state: "pending" }), now)).toBeNull();
    expect(escalationEligible(cycle({}, { state: "sent" }), now)).toBeNull();
    expect(escalationEligible(cycle({}, { state: "sent", at: "2026-10-05T11:59:00.000Z" }), now)).toBeNull();
    expect(escalationEligible(cycle({ summary: { triage: { decision: "notify" } } }), now)).toBeNull();
  });
});

describe("isCritical", () => {
  it("never counts an overflow incident's folded occurrences (#303): a flood must not ring during the quiet hours", () => {
    expect(isCritical({ status: "new", signalSource: "overflow", occurrenceCount: 10_000 }, { criticalOccurrences: 100 })).toBe(false);
    expect(isCritical({ status: "recurred", signalSource: "overflow", occurrenceCount: 1 }, { criticalOccurrences: 100 })).toBe(true);
  });

  it("is a regression, or the configured number of occurrences", () => {
    expect(isCritical({ status: "recurred", occurrenceCount: 1 }, { criticalOccurrences: 100 })).toBe(true);
    expect(isCritical({ status: "new", occurrenceCount: 100 }, { criticalOccurrences: 100 })).toBe(true);
    expect(isCritical({ status: "new", occurrenceCount: 99 }, { criticalOccurrences: 100 })).toBe(false);
    expect(isCritical({ status: "new" }, { criticalOccurrences: 1 })).toBe(false);
    expect(isCritical(undefined, { criticalOccurrences: 1 })).toBe(false);
  });
});

describe("personFor", () => {
  const p = (id: string, role: OnCallPerson["role"], state: OnCallPerson["state"], createdMs: number): OnCallPerson => ({ id, name: id, role, phone: "+15551234542", state, createdMs });
  it("is the earliest-added CONFIRMED person for the role; a pending number is never chosen", () => {
    const people = [p("late", "primary", "confirmed", 20), p("early-pending", "primary", "pending", 1), p("early", "primary", "confirmed", 10), p("sec", "secondary", "confirmed", 0)];
    expect(personFor(people, "primary")?.id).toBe("early");
    expect(personFor([p("only-pending", "primary", "pending", 1)], "primary")).toBeUndefined();
    expect(personFor(people, "support-lead")).toBeUndefined();
  });
});

describe("advance", () => {
  const esc = (step: number) => ({ step, call: { step, role: STEPS[step]!.role, to: "+1 ••• ••• ••42" } });
  it("after no answer from the primary, calls the primary again two minutes later", () => {
    const r = advance(esc(0), "no-answer", now);
    expect(r.closed).toBe(false);
    expect(r.update).toMatchObject({ state: "waiting", step: 1 });
    expect((r.update.nextAt as { toMillis(): number }).toMillis()).toBe(now.getTime() + 2 * 60_000);
  });

  it("then the secondary at once, then the support lead, then the end", () => {
    expect(advance(esc(1), "voicemail", now).update).toMatchObject({ step: 2 });
    expect((advance(esc(1), "voicemail", now).update.nextAt as { toMillis(): number }).toMillis()).toBe(now.getTime());
    expect(advance(esc(2), "no-input", now).update).toMatchObject({ step: 3 });
    const end = advance(esc(3), "no-answer", now);
    expect(end.closed).toBe(true);
    expect(end.update).toMatchObject({ open: false, state: "exhausted" });
  });

  it("a pass (3) goes to the next PERSON: the primary's own retry is skipped", () => {
    expect(advance(esc(0), "passed", now).update).toMatchObject({ step: 2 });
  });

  it("records the masked number and the role, never a name", () => {
    const r = advance(esc(0), "no-answer", now);
    expect(r.events[0]).toMatchObject({ stage: "escalation", type: "no-answer", data: { role: "primary", to: "+1 ••• ••• ••42" } });
  });
});
