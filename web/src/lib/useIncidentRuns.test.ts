import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCycle, type CycleRow } from "./runsModel";

const mocks = vi.hoisted(() => ({
  starts: [] as { ok: (rows: CycleRow[], capped: boolean) => void; err: (e: Error) => void; unsub: ReturnType<typeof vi.fn> }[],
}));
vi.mock("./runs", () => ({
  subscribeCycles: (_env: string, ok: (rows: CycleRow[], capped: boolean) => void, err: (e: Error) => void) => {
    const unsub = vi.fn();
    mocks.starts.push({ ok, err, unsub });
    return unsub;
  },
  readCycle: vi.fn(),
}));

import { useIncidentRuns } from "./useIncidentRuns";
import { LIVE_RETRY_MS } from "./useLiveRecord";

const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const run = (incidentId: string): CycleRow =>
  parseCycle(`${incidentId}_r0`, {
    incidentId,
    environment: "demo",
    state: "declined",
    path: "decline",
    createdAt: ts(Date.now() - 60_000),
    updatedAt: ts(Date.now() - 1000),
    leaseExpiresAt: null,
  })!;

describe("useIncidentRuns", () => {
  afterEach(() => {
    vi.useRealTimers();
    mocks.starts.length = 0;
  });

  it("listens again a while after the runs listener fails, and shows no run until a new snapshot arrives (#357)", () => {
    vi.useFakeTimers();
    const incidents = [{ id: "inc-a", recurrenceCount: 0 }];
    const { result } = renderHook(() => useIncidentRuns("demo", true, incidents));
    act(() => mocks.starts[0].ok([run("inc-a")], false));
    expect(result.current(incidents[0]).kind).toBe("run");

    act(() => mocks.starts[0].err(new Error("unavailable")));
    expect(result.current(incidents[0])).toEqual({ kind: "unknown" });
    act(() => vi.advanceTimersByTime(LIVE_RETRY_MS - 1));
    expect(mocks.starts).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(mocks.starts).toHaveLength(2);
    expect(mocks.starts[0].unsub).toHaveBeenCalled();
    // Started again, nothing read yet: still unknown, never the run it had before (#195).
    expect(result.current(incidents[0])).toEqual({ kind: "unknown" });

    act(() => mocks.starts[1].ok([run("inc-a")], false));
    expect(result.current(incidents[0]).kind).toBe("run");
  });
});
