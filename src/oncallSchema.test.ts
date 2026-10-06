import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, inQuietHours, localMinutes, maskPhone, parsePerson, parsePolicy, validTimeZone } from "./oncallSchema.js";

describe("maskPhone", () => {
  it("shows the first digit of the country code and the last two digits, nothing else", () => {
    expect(maskPhone("+15551234542")).toBe("+1 ••• ••• ••42");
    expect(maskPhone("+447911123456")).toBe("+4 ••• ••• ••56");
    expect(maskPhone("+15551234542")).not.toContain("555");
  });

  it("masks anything that is not an E.164 number whole", () => {
    expect(maskPhone("5551234542")).toBe("•••");
    expect(maskPhone("")).toBe("•••");
  });
});

describe("parsePolicy", () => {
  it("is the defaults, off, for a missing policy", () => {
    expect(parsePolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(DEFAULT_POLICY.enabled).toBe(false);
    expect(DEFAULT_POLICY.waitMinutes).toBe(10);
  });

  it("takes a valid policy", () => {
    expect(parsePolicy({ enabled: true, waitMinutes: 15, quietStart: "22:00", quietEnd: "07:00", timeZone: "Europe/London", dailyCapPerPerson: 3, criticalOccurrences: 50 })).toEqual({
      enabled: true,
      waitMinutes: 15,
      quietStart: "22:00",
      quietEnd: "07:00",
      timeZone: "Europe/London",
      dailyCapPerPerson: 3,
      criticalOccurrences: 50,
    });
    // Empty quiet hours, as the UI saves "none".
    expect(parsePolicy({ enabled: true, quietStart: "", quietEnd: "" })).toMatchObject({ enabled: true });
    expect(parsePolicy({ quietStart: "", quietEnd: "" })?.quietStart).toBeUndefined();
  });

  it("refuses an invalid one as a whole (null), so no call is placed on it", () => {
    for (const bad of [
      { enabled: "yes" },
      { waitMinutes: 0 },
      { waitMinutes: 2.5 },
      { quietStart: "22:00" },
      { quietStart: "25:00", quietEnd: "07:00" },
      { quietStart: "07:00", quietEnd: "07:00" },
      { timeZone: "Mars/Olympus" },
      { dailyCapPerPerson: 21 },
      { criticalOccurrences: 0 },
      "policy",
      [1],
    ]) {
      expect(parsePolicy(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("parsePerson", () => {
  const ok = { name: "Ada", role: "primary", phone: "+15551234542", state: "pending" };
  it("reads a well-formed person", () => {
    expect(parsePerson("p1", ok, 5)).toEqual({ id: "p1", name: "Ada", role: "primary", phone: "+15551234542", state: "pending", createdMs: 5 });
  });
  it("refuses a bad role, number, state, name or id", () => {
    expect(parsePerson("p1", { ...ok, role: "boss" }, 0)).toBeNull();
    expect(parsePerson("p1", { ...ok, phone: "555-1234" }, 0)).toBeNull();
    expect(parsePerson("p1", { ...ok, state: "confirmed?" }, 0)).toBeNull();
    expect(parsePerson("p1", { ...ok, name: "<script>" }, 0)).toBeNull();
    expect(parsePerson("a/b", ok, 0)).toBeNull();
  });
});

describe("quiet hours", () => {
  const policy = { quietStart: "22:00", quietEnd: "07:00", timeZone: "UTC" };
  it("wraps midnight", () => {
    expect(inQuietHours(policy, new Date("2026-10-06T23:30:00Z"))).toBe(true);
    expect(inQuietHours(policy, new Date("2026-10-06T03:00:00Z"))).toBe(true);
    expect(inQuietHours(policy, new Date("2026-10-06T07:00:00Z"))).toBe(false);
    expect(inQuietHours(policy, new Date("2026-10-06T12:00:00Z"))).toBe(false);
    expect(inQuietHours(policy, new Date("2026-10-06T22:00:00Z"))).toBe(true);
  });

  it("works within one day", () => {
    const lunch = { quietStart: "12:00", quietEnd: "13:00", timeZone: "UTC" };
    expect(inQuietHours(lunch, new Date("2026-10-06T12:30:00Z"))).toBe(true);
    expect(inQuietHours(lunch, new Date("2026-10-06T13:30:00Z"))).toBe(false);
  });

  it("is judged in the policy's time zone", () => {
    // 21:30 UTC is 23:30 in Berlin (CEST, UTC+2) in October: quiet there, not in UTC.
    const at = new Date("2026-10-06T21:30:00Z");
    expect(localMinutes(at, "Europe/Berlin")).toBe(23 * 60 + 30);
    expect(inQuietHours({ ...policy, timeZone: "Europe/Berlin" }, at)).toBe(true);
    expect(inQuietHours(policy, at)).toBe(false);
  });

  it("has none without both bounds", () => {
    expect(inQuietHours({ timeZone: "UTC" }, new Date("2026-10-06T03:00:00Z"))).toBe(false);
  });

  it("knows a time zone from a typo", () => {
    expect(validTimeZone("America/New_York")).toBe(true);
    expect(validTimeZone("Nowhere/Special")).toBe(false);
  });
});
