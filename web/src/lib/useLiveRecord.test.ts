import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RETRY_MS, useLiveRecord } from "./useLiveRecord";

type Listener = { onData: (v: number) => void; onError: (e: Error) => void; unsubscribe: ReturnType<typeof vi.fn> };

function harness() {
  const listeners: Listener[] = [];
  const subscribe = (onData: (v: number) => void, onError: (e: Error) => void) => {
    const unsubscribe = vi.fn();
    listeners.push({ onData, onError, unsubscribe });
    return unsubscribe;
  };
  return { listeners, subscribe };
}

describe("useLiveRecord", () => {
  afterEach(() => vi.useRealTimers());

  it("is pending until the first value, then follows each value the listener hands over", () => {
    const { listeners, subscribe } = harness();
    const { result } = renderHook(() => useLiveRecord("k", subscribe));
    expect(result.current).toEqual({ status: "pending" });
    act(() => listeners[0].onData(1));
    expect(result.current).toEqual({ status: "ok", data: 1 });
    act(() => listeners[0].onData(2));
    expect(result.current).toEqual({ status: "ok", data: 2 });
  });

  it("shows a failed listener as an error, not its last value, and listens again after a while", () => {
    vi.useFakeTimers();
    const { listeners, subscribe } = harness();
    const { result } = renderHook(() => useLiveRecord("k", subscribe));
    act(() => listeners[0].onData(1));
    act(() => listeners[0].onError(new Error("permission-denied")));
    expect(result.current).toEqual({ status: "error" });
    expect(listeners).toHaveLength(1);
    act(() => vi.advanceTimersByTime(LIVE_RETRY_MS));
    expect(listeners).toHaveLength(2);
    expect(listeners[0].unsubscribe).toHaveBeenCalled();
    act(() => listeners[1].onData(3));
    expect(result.current).toEqual({ status: "ok", data: 3 });
  });

  it("stops listening, and retrying, when unmounted", () => {
    vi.useFakeTimers();
    const { listeners, subscribe } = harness();
    const { unmount } = renderHook(() => useLiveRecord("k", subscribe));
    act(() => listeners[0].onError(new Error("unavailable")));
    unmount();
    expect(listeners[0].unsubscribe).toHaveBeenCalled();
    vi.advanceTimersByTime(LIVE_RETRY_MS);
    expect(listeners).toHaveLength(1);
  });
});
