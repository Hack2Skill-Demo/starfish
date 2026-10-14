import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_RETRY_MS, useLiveRecord, useRetryingSubscription } from "./useLiveRecord";

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

describe("useRetryingSubscription", () => {
  afterEach(() => vi.useRealTimers());

  function starts() {
    const calls: { key: string | null; retrying: boolean; onError: () => void; unsubscribe: ReturnType<typeof vi.fn> }[] = [];
    const start = (key: string | null) => (onError: () => void, retrying: boolean) => {
      const unsubscribe = vi.fn();
      calls.push({ key, retrying, onError, unsubscribe });
      return unsubscribe;
    };
    return { calls, start };
  }

  it("starts nothing while the key is null", () => {
    const { calls, start } = starts();
    renderHook(() => useRetryingSubscription(null, start(null)));
    expect(calls).toHaveLength(0);
  });

  it("starts again after a failure as a retry of the same key, and afresh for a new key (#357)", () => {
    vi.useFakeTimers();
    const { calls, start } = starts();
    const { rerender } = renderHook(({ k }) => useRetryingSubscription(k, start(k)), { initialProps: { k: "a" as string | null } });
    expect(calls.map((c) => c.retrying)).toEqual([false]);
    act(() => calls[0].onError());
    act(() => vi.advanceTimersByTime(LIVE_RETRY_MS - 1));
    expect(calls).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(calls.map((c) => c.retrying)).toEqual([false, true]);
    expect(calls[0].unsubscribe).toHaveBeenCalled();
    rerender({ k: "b" });
    expect(calls.map((c) => [c.key, c.retrying])).toEqual([
      ["a", false],
      ["a", true],
      ["b", false],
    ]);
    // Off, then on again for the same key: a fresh start, not a retry.
    rerender({ k: null });
    rerender({ k: "b" });
    expect(calls.at(-1)).toMatchObject({ key: "b", retrying: false });
  });

  it("ignores a failure reported after the listener was stopped", () => {
    vi.useFakeTimers();
    const { calls, start } = starts();
    const { rerender } = renderHook(({ k }) => useRetryingSubscription(k, start(k)), { initialProps: { k: "a" } });
    rerender({ k: "b" });
    act(() => calls[0].onError());
    act(() => vi.advanceTimersByTime(LIVE_RETRY_MS));
    expect(calls.map((c) => c.key)).toEqual(["a", "b"]);
  });
});
