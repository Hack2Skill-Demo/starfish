import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readPublicSettings: vi.fn() }));
vi.mock("./settingsWrite", async (orig) => ({
  ...(await orig<typeof import("./settingsWrite")>()),
  readPublicSettings: mocks.readPublicSettings,
}));
vi.mock("./firebase", () => ({ firestore: () => ({}) }));
vi.mock("./config", () => ({ webConfig: () => ({ environment: "build-label", settingsCollection: "starfish_settings" }) }));

import { useEnvironment } from "./useSettings";

function renderEnvironment() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useEnvironment(), { wrapper });
}

describe("useEnvironment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is not ready until the settings read settles, so the wrong label is never queried first", async () => {
    mocks.readPublicSettings.mockReturnValue(new Promise(() => {}));
    const { result } = renderEnvironment();
    expect(result.current.ready).toBe(false);
  });

  it("uses the label the settings override", async () => {
    mocks.readPublicSettings.mockResolvedValue({ environment: "qa-label", revision: 3 });
    const { result } = renderEnvironment();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ environment: "qa-label", ready: true, settingsUnavailable: false });
  });

  it("with no settings document, uses the build-time label and says nothing is wrong", async () => {
    mocks.readPublicSettings.mockResolvedValue(null);
    const { result } = renderEnvironment();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ environment: "build-label", ready: true, settingsUnavailable: false });
  });

  it("settings that override only other fields still use the build-time label", async () => {
    mocks.readPublicSettings.mockResolvedValue({ watchedProjectId: "watched-app-1", revision: 1 });
    const { result } = renderEnvironment();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toMatchObject({ environment: "build-label", settingsUnavailable: false });
  });

  it("when the read FAILS, falls back to the build-time label but reports that it is a guess (#43)", async () => {
    mocks.readPublicSettings.mockRejectedValue(Object.assign(new Error("denied"), { code: "permission-denied" }));
    const { result } = renderEnvironment();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ environment: "build-label", ready: true, settingsUnavailable: true });
  });
});
