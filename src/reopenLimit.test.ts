import { describe, expect, it } from "vitest";
import { REOPEN_WINDOW_MS, countedReopenings, isoSeconds, reopenLimit, retryRefusedSummary } from "./reopenLimit.js";

const NOW = Date.parse("2026-10-18T17:31:00Z");
const H = 3_600_000;

describe("reopenLimit (#456)", () => {
  it("counts the reopenings of the last 24 hours, none in the future", () => {
    expect(countedReopenings([NOW - REOPEN_WINDOW_MS, NOW - REOPEN_WINDOW_MS + 1, NOW, NOW + 1, Number.NaN], NOW)).toEqual([NOW - REOPEN_WINDOW_MS + 1, NOW]);
  });

  it("under the limit: not reached, and no time to wait for", () => {
    expect(reopenLimit([NOW - 2 * H, NOW - H], 3, NOW)).toEqual({ reached: false, recent: 2, maxPerDay: 3 });
    expect(reopenLimit([], 3, NOW)).toEqual({ reached: false, recent: 0, maxPerDay: 3 });
  });

  it("the demo's run of 2026-10-18: reopened at 12:46, 13:54 and 16:31Z, so a retry can start at 12:46Z the next day", () => {
    const at = ["2026-10-18T16:31:00Z", "2026-10-18T12:46:00Z", "2026-10-18T13:54:00Z"].map(Date.parse);
    const limit = reopenLimit(at, 3, NOW);
    expect(limit).toEqual({ reached: true, recent: 3, maxPerDay: 3, nextPossibleAtMs: Date.parse("2026-10-19T12:46:00Z") });
    // At that moment the oldest stops counting: the rule reads the same from both sides.
    expect(reopenLimit(at, 3, limit.nextPossibleAtMs!).reached).toBe(false);
    expect(reopenLimit(at, 3, limit.nextPossibleAtMs! - 1).reached).toBe(true);
  });

  it("over the limit (a lowered setting): waits until enough reopenings stop counting", () => {
    const at = [NOW - 5 * H, NOW - 4 * H, NOW - 3 * H, NOW - 2 * H];
    const limit = reopenLimit(at, 2, NOW);
    expect(limit.nextPossibleAtMs).toBe(NOW - 3 * H + REOPEN_WINDOW_MS);
    expect(reopenLimit(at, 2, limit.nextPossibleAtMs!).reached).toBe(false);
  });

  it("words the refusal in the engine's own numbers and an ISO time", () => {
    expect(isoSeconds(Date.parse("2026-10-19T12:46:00.123Z"))).toBe("2026-10-19T12:46:00Z");
    const limit = reopenLimit([NOW - 5 * H, NOW - 2 * H, NOW - H], 3, NOW);
    expect(retryRefusedSummary(limit)).toBe(
      `Retry not started: reopened 3 times in 24 h, the limit is 3; it can start at ${isoSeconds(NOW - 5 * H + REOPEN_WINDOW_MS)}, and the request stands until then`
    );
    expect(retryRefusedSummary(limit).length).toBeLessThanOrEqual(300);
  });
});
