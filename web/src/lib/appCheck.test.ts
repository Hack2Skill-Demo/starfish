import type { FirebaseApp } from "firebase/app";
import type { AppCheck } from "firebase/app-check";
import { describe, expect, it, vi } from "vitest";
import { appCheckMode, appCheckToken, startAppCheck, type AppCheckSdk } from "./appCheck";
import type { AppCheckConfig } from "./config";

const app = { name: "[DEFAULT]" } as unknown as FirebaseApp;
const on: AppCheckConfig = { siteKey: "site-key", provider: "enterprise" };

function fakeSdk(over: Partial<AppCheckSdk> = {}) {
  const instance = { app } as unknown as AppCheck;
  const sdk = {
    initializeAppCheck: vi.fn(() => instance),
    getToken: vi.fn(async () => ({ token: "tok" })),
    enterprise: vi.fn((k: string) => ({ kind: "enterprise", k })),
    v3: vi.fn((k: string) => ({ kind: "v3", k })),
    ...over,
  } as unknown as AppCheckSdk;
  return { sdk, instance };
}

describe("appCheckMode", () => {
  it("is off with no site key, skipped on the emulators, and on otherwise", () => {
    expect(appCheckMode({ siteKey: "", provider: "enterprise" }, false)).toBe("off");
    expect(appCheckMode(on, true)).toBe("emulators");
    expect(appCheckMode(on, false)).toBe("on");
  });
});

describe("startAppCheck", () => {
  it("does nothing at all without a site key: the app (and guest access) work as before", () => {
    const { sdk } = fakeSdk();
    const global: Record<string, unknown> = {};
    expect(startAppCheck(app, { siteKey: "", provider: "enterprise", debugToken: "dbg" }, false, sdk, global)).toBeUndefined();
    expect(sdk.initializeAppCheck).not.toHaveBeenCalled();
    expect(global).toEqual({});
  });

  it("does nothing on the emulators", () => {
    const { sdk } = fakeSdk();
    expect(startAppCheck(app, on, true, sdk, {})).toBeUndefined();
    expect(sdk.initializeAppCheck).not.toHaveBeenCalled();
  });

  it("starts reCAPTCHA Enterprise by default, v3 when asked, with token auto-refresh", () => {
    const { sdk, instance } = fakeSdk();
    expect(startAppCheck(app, on, false, sdk, {})).toBe(instance);
    expect(sdk.initializeAppCheck).toHaveBeenCalledWith(app, {
      provider: { kind: "enterprise", k: "site-key" },
      isTokenAutoRefreshEnabled: true,
    });
    startAppCheck(app, { ...on, provider: "v3" }, false, sdk, {});
    expect(sdk.v3).toHaveBeenCalledWith("site-key");
  });

  it("sets the debug token global before initialising, and only when one is configured", () => {
    const order: string[] = [];
    const global: Record<string, unknown> = {};
    const { sdk } = fakeSdk({
      initializeAppCheck: vi.fn(() => {
        order.push(`init:${String(global.FIREBASE_APPCHECK_DEBUG_TOKEN)}`);
        return {} as AppCheck;
      }),
    });
    startAppCheck(app, { ...on, debugToken: true }, false, sdk, global);
    expect(order).toEqual(["init:true"]);
    const none: Record<string, unknown> = {};
    startAppCheck(app, on, false, fakeSdk().sdk, none);
    expect("FIREBASE_APPCHECK_DEBUG_TOKEN" in none).toBe(false);
  });

  it("carries on without App Check when it fails to start", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sdk } = fakeSdk({
      initializeAppCheck: vi.fn(() => {
        throw new Error("already initialised");
      }),
    });
    expect(startAppCheck(app, on, false, sdk, {})).toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("appCheckToken", () => {
  it("is null with no App Check, and the token when there is one", async () => {
    const { sdk, instance } = fakeSdk();
    expect(await appCheckToken(sdk, undefined)).toBeNull();
    expect(await appCheckToken(sdk, instance)).toBe("tok");
    expect(sdk.getToken).toHaveBeenCalledWith(instance, false);
  });

  it("is null, never a throw, when the SDK fails or reports an error", async () => {
    const { instance } = fakeSdk();
    const failing = { getToken: vi.fn(() => Promise.reject(new Error("x"))) } as unknown as AppCheckSdk;
    const erroring = { getToken: vi.fn(async () => ({ token: "dummy", error: new Error("throttled") })) } as unknown as AppCheckSdk;
    const empty = { getToken: vi.fn(async () => ({ token: "" })) } as unknown as AppCheckSdk;
    expect(await appCheckToken(failing, instance)).toBeNull();
    expect(await appCheckToken(erroring, instance)).toBeNull();
    expect(await appCheckToken(empty, instance)).toBeNull();
  });
});
