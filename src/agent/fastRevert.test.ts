/**
 * Fast-revert's recurrence check (#9), pure: what counts as "the same incident came back after Starfish's merge". The
 * watch and the revert itself run against the emulator (autoMerge.emulator.test.ts).
 */
import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { hourBucketKey } from "../ingest/buckets.js";
import { recurredAfterMerge, watchSpan } from "./fastRevert.js";

const cfg = { fastRevertMinutes: 60, fastRevertGraceMinutes: 10 };
const merged = Date.parse("2026-10-06T12:00:00.000Z");
const at = (minutes: number) => Timestamp.fromMillis(merged + minutes * 60_000);
const watch = { mergedAtMs: merged, recurrence: 0 };

describe("recurredAfterMerge", () => {
  it("is an occurrence after the grace and within the window", () => {
    expect(recurredAfterMerge({ lastOccurredAt: at(11) }, watch, cfg)).toBe(true);
    expect(recurredAfterMerge({ lastOccurredAt: at(60) }, watch, cfg)).toBe(true);
  });

  it("is not an occurrence during the grace: the old code may still be running until the deploy finishes", () => {
    expect(recurredAfterMerge({ lastOccurredAt: at(-5) }, watch, cfg)).toBe(false);
    expect(recurredAfterMerge({ lastOccurredAt: at(3) }, watch, cfg)).toBe(false);
    expect(recurredAfterMerge({ lastOccurredAt: at(10) }, watch, cfg)).toBe(false);
  });

  it("is not an occurrence after the window: that may be another cause", () => {
    expect(recurredAfterMerge({ lastOccurredAt: at(61) }, watch, cfg)).toBe(false);
  });

  it("sees a regression the ingest marked, by its time", () => {
    expect(recurredAfterMerge({ lastOccurredAt: at(200), recurrenceCount: 1, lastRecurredAt: at(30) }, watch, cfg)).toBe(true);
    expect(recurredAfterMerge({ lastOccurredAt: at(200), recurrenceCount: 1, lastRecurredAt: at(-30) }, watch, cfg)).toBe(false);
    // A regression counted before this cycle began is not a new one.
    expect(recurredAfterMerge({ lastOccurredAt: at(200), recurrenceCount: 1, lastRecurredAt: at(30) }, { mergedAtMs: merged, recurrence: 1 }, cfg)).toBe(false);
  });

  it("sees an occurrence whose last one is already past the window, from an hour of the series wholly inside it", () => {
    const wide = { fastRevertMinutes: 180, fastRevertGraceMinutes: 10 };
    const inside = hourBucketKey(merged + 60 * 60_000); // 13:00-14:00, inside (12:10, 15:00]
    expect(recurredAfterMerge({ lastOccurredAt: at(400), occurrencesByHour: { [inside]: 3 } }, watch, wide)).toBe(true);
    const straddling = hourBucketKey(merged); // 12:00-13:00 starts before the grace ends
    expect(recurredAfterMerge({ lastOccurredAt: at(400), occurrencesByHour: { [straddling]: 3 } }, watch, wide)).toBe(false);
    expect(recurredAfterMerge({ lastOccurredAt: at(400), occurrencesByHour: { [inside]: 0 } }, watch, wide)).toBe(false);
  });

  /** One occurrence a minute from `from` to `to` (minutes from the merge), counted by the hour as the store does. */
  const firing = (mergedAtMs: number, from: number, to: number) => {
    const byHour: Record<string, number> = {};
    for (let t = from; t <= to; t++) {
      const k = hourBucketKey(mergedAtMs + t * 60_000);
      byHour[k] = (byHour[k] ?? 0) + 1;
    }
    return { lastOccurredAt: Timestamp.fromMillis(mergedAtMs + to * 60_000), occurrencesByHour: byHour };
  };

  it("does not infer an in-window occurrence from a bucket crossing the deadline (#252)", () => {
    // The aggregate cannot distinguish an error that fired continuously from one that first fired after the deadline.
    const at1035 = Date.parse("2026-10-06T10:35:00.000Z");
    expect(recurredAfterMerge(firing(at1035, -60, 63), { mergedAtMs: at1035, recurrence: 0 }, cfg)).toBe(false);
    expect(recurredAfterMerge(firing(at1035, -60, 300), { mergedAtMs: at1035, recurrence: 0 }, cfg)).toBe(false);
    const at1055 = Date.parse("2026-10-06T10:55:00.000Z");
    expect(recurredAfterMerge(firing(at1055, -60, 75), { mergedAtMs: at1055, recurrence: 0 }, cfg)).toBe(false);
    const at1200 = Date.parse("2026-10-06T12:00:00.000Z");
    expect(recurredAfterMerge(firing(at1200, 70, 70), { mergedAtMs: at1200, recurrence: 0 }, { fastRevertMinutes: 15, fastRevertGraceMinutes: 10 })).toBe(false);
  });

  it("never counts an occurrence from before the merge or from the grace, however late it was ingested (#201)", () => {
    const at1035 = Date.parse("2026-10-06T10:35:00.000Z");
    expect(recurredAfterMerge(firing(at1035, -90, -1), { mergedAtMs: at1035, recurrence: 0 }, cfg)).toBe(false);
    expect(recurredAfterMerge(firing(at1035, -90, 10), { mergedAtMs: at1035, recurrence: 0 }, cfg)).toBe(false);
    // An hour that starts during the grace is not after it.
    const at1055 = Date.parse("2026-10-06T10:55:00.000Z");
    expect(recurredAfterMerge(firing(at1055, 2, 9), { mergedAtMs: at1055, recurrence: 0 }, cfg)).toBe(false);
  });

  it("keeps the watch open until the last counted hour has ended and been ingested", () => {
    expect(watchSpan(merged, cfg)).toEqual({ start: merged + 10 * 60_000, end: merged + 60 * 60_000, reach: merged + 60 * 60_000, closesAt: merged + 180 * 60_000 });
    const at1055 = Date.parse("2026-10-06T10:55:00.000Z");
    expect(watchSpan(at1055, cfg).reach).toBe(Date.parse("2026-10-06T12:00:00.000Z"));
  });

  it("never fires for a retired incident, a window shorter than the grace, or a missing time", () => {
    expect(recurredAfterMerge({ lastOccurredAt: at(20), retired: true }, watch, cfg)).toBe(false);
    expect(recurredAfterMerge({ lastOccurredAt: at(20) }, watch, { fastRevertMinutes: 5, fastRevertGraceMinutes: 10 })).toBe(false);
    expect(recurredAfterMerge({}, watch, cfg)).toBe(false);
    expect(recurredAfterMerge({ lastOccurredAt: "not a time" }, watch, cfg)).toBe(false);
  });

  it("reads ISO strings as well as timestamps", () => {
    expect(recurredAfterMerge({ lastOccurredAt: new Date(merged + 20 * 60_000).toISOString() }, watch, cfg)).toBe(true);
  });
});
