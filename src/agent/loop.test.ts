import { describe, expect, it } from "vitest";
import { counterCheckRecord } from "./loop.js";

describe("counterCheckRecord: the recount kept with triage's decision (#39)", () => {
  it("keeps the count, window, cap, time and the exact filter", () => {
    expect(counterCheckRecord({ window: "24h", count: 12, capped: true, filter: 'severity>=ERROR AND resource.labels.function_name="f"', checkedAt: "2026-10-05T10:00:00.000Z" })).toEqual({
      counterCount: 12,
      counterWindow: "24h",
      counterCapped: true,
      counterCheckedAt: "2026-10-05T10:00:00.000Z",
      counterFilter: 'severity>=ERROR AND resource.labels.function_name="f"',
    });
  });

  it("records a missing check as missing, never as zero", () => {
    expect(counterCheckRecord(undefined)).toEqual({ counterCount: null });
    expect(counterCheckRecord({ window: "24h", count: Number.NaN })).toEqual({ counterCount: null });
  });

  it("keeps a realistic filter longer than an ordinary record value whole", () => {
    const filter = `severity>=ERROR AND ${"NOT resource.labels.service_name=\"starfish-ingest\" ".repeat(10)}`;
    expect(filter.length).toBeGreaterThan(300);
    expect(counterCheckRecord({ window: "24h", count: 1, filter }).counterFilter).toBe(filter);
  });

  it("leaves out a filter too long to store whole, rather than keeping a cut one that would count something else", () => {
    const r = counterCheckRecord({ window: "24h", count: 3, filter: "x".repeat(2001) });
    expect(r.counterFilter).toBeUndefined();
    expect(r.counterCount).toBe(3);
  });
});
