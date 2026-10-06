import { describe, expect, it } from "vitest";
import { formFromPolicy, policyFromForm } from "./onCallForm";
import { normalizePhone } from "./onCallWrite";

describe("the on-call policy form (#37)", () => {
  it("starts from the defaults, off", () => {
    expect(formFromPolicy(null)).toMatchObject({ enabled: false, waitMinutes: "10", quietStart: "", timeZone: "UTC" });
  });

  it("round-trips a valid policy", () => {
    const r = policyFromForm({ enabled: true, waitMinutes: "15", quietStart: "22:00", quietEnd: "07:00", timeZone: "Europe/London", dailyCapPerPerson: "3", criticalOccurrences: "50" });
    expect(r).toEqual({ ok: true, policy: { enabled: true, waitMinutes: 15, quietStart: "22:00", quietEnd: "07:00", timeZone: "Europe/London", dailyCapPerPerson: 3, criticalOccurrences: 50 } });
    if (r.ok) expect(formFromPolicy(r.policy)).toMatchObject({ waitMinutes: "15", quietEnd: "07:00" });
  });

  it("says what is wrong", () => {
    const base = formFromPolicy(null);
    expect(policyFromForm({ ...base, waitMinutes: "0" })).toMatchObject({ ok: false, problems: [expect.stringContaining("Wait")] });
    expect(policyFromForm({ ...base, quietStart: "22:00" })).toMatchObject({ ok: false, problems: [expect.stringContaining("both ends")] });
    expect(policyFromForm({ ...base, timeZone: "Mars/Olympus" })).toMatchObject({ ok: false });
    expect(policyFromForm({ ...base, dailyCapPerPerson: "99" })).toMatchObject({ ok: false });
  });
});

describe("normalizePhone", () => {
  it("accepts an international number however it is spaced, and nothing else", () => {
    expect(normalizePhone("+1 (555) 000-0142")).toBe("+15550000142");
    expect(normalizePhone("555 000 0142")).toBeNull();
    expect(normalizePhone("+0 555")).toBeNull();
  });
});
