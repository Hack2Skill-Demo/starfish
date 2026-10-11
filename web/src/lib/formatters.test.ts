import { describe, expect, it } from "vitest";
import { formatRecentTime, formatRelativeTime } from "./formatters";

const NOW = Date.parse("2026-10-11T02:00:00.000Z");

describe("formatRecentTime", () => {
  it("counts seconds under a minute, where formatRelativeTime says 'just now'", () => {
    expect(formatRelativeTime(NOW - 40_000, undefined, NOW)).toBe("just now");
    expect(formatRecentTime(NOW - 40_000, undefined, NOW)).toMatch(/40 seconds ago/);
  });
  it("reads like formatRelativeTime from a minute on, and falls back on a missing time", () => {
    expect(formatRecentTime(NOW - 5 * 60_000, undefined, NOW)).toBe(formatRelativeTime(NOW - 5 * 60_000, undefined, NOW));
    expect(formatRecentTime(undefined, "Never", NOW)).toBe("Never");
  });
});
