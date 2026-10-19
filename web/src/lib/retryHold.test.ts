import { describe, expect, it } from "vitest";
import { retryHold, retryHoldWords } from "./retryHold";

const NOW = Date.parse("2026-10-18T17:31:00Z");
const H = 3_600_000;
// The demo's run of 2026-10-18 (#456): reopened at 12:46, 13:54 and 16:31Z.
const reopenedAt = ["2026-10-18T12:46:00Z", "2026-10-18T13:54:00Z", "2026-10-18T16:31:00Z"].map(Date.parse);
const NEXT = Date.parse("2026-10-19T12:46:00Z");

describe("retryHold (#456)", () => {
  it("holds Retry back by the engine's rule and the limit the agent recorded, and says until when", () => {
    expect(retryHold({ reopenedAt, summary: {} }, 3, NOW)).toEqual({ reopenings: 3, maxPerDay: 3, nextPossibleAt: new Date(NEXT), requestHeld: false });
    expect(retryHold({ reopenedAt, summary: {} }, 3, NEXT)).toBeNull();
    // A raised limit frees it at once.
    expect(retryHold({ reopenedAt, summary: {} }, 4, NOW)).toBeNull();
  });

  it("says a request the engine already held back stands", () => {
    const summary = { retryRefused: { requestedAt: "2026-10-18T17:30:55.000Z", reopenings: 3, maxPerDay: 3, nextPossibleAt: new Date(NEXT).toISOString() } };
    expect(retryHold({ reopenedAt, summary }, 3, NOW)?.requestHeld).toBe(true);
  });

  it("without the recorded limit, believes only the engine's own note, and only while its time is ahead", () => {
    expect(retryHold({ reopenedAt, summary: {} }, undefined, NOW)).toBeNull();
    const summary = { retryRefused: { requestedAt: "2026-10-18T17:30:55.000Z", reopenings: 3, maxPerDay: 3, nextPossibleAt: new Date(NEXT).toISOString() } };
    expect(retryHold({ summary }, undefined, NOW)).toEqual({ reopenings: 3, maxPerDay: 3, nextPossibleAt: new Date(NEXT), requestHeld: true });
    expect(retryHold({ summary }, undefined, NEXT)).toBeNull();
    expect(retryHold({ summary: { retryRefused: { requestedAt: "x", nextPossibleAt: "nope" } } }, undefined, NOW)).toBeNull();
    // A guest's trimmed copy keeps neither: nothing is held back on a guess.
    expect(retryHold({ summary: {} }, 3, NOW)).toBeNull();
  });

  it("words the hold with the count, the limit and the time", () => {
    const hold = { reopenings: 3, maxPerDay: 3, nextPossibleAt: new Date(NOW + H), requestHeld: false };
    expect(retryHoldWords(hold, "19 Oct 2026, 12:46")).toBe("This run was reopened 3 times in 24 hours, the most allowed (3). A retry can start again at 19 Oct 2026, 12:46.");
    expect(retryHoldWords({ ...hold, reopenings: 1, maxPerDay: 1, requestHeld: true }, "then")).toBe(
      "This run was reopened 1 time in 24 hours, the most allowed (1). A retry can start again at then. The retry already asked for stands: the first agent pass after then can start it."
    );
  });
});
