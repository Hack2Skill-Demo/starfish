import { describe, expect, it, vi } from "vitest";
import {
  FIREBASE_INIT_PATH,
  bootstrapWebConfig,
  normalizeAdminApiUrl,
  readAppCheckConfig,
  resolveFirebaseConfig,
  webConfig,
} from "./config";

const full = {
  VITE_FIREBASE_API_KEY: "k",
  VITE_FIREBASE_AUTH_DOMAIN: "p.firebaseapp.com",
  VITE_FIREBASE_PROJECT_ID: "p",
  VITE_FIREBASE_APP_ID: "a",
};
const served = { apiKey: "hk", authDomain: "h.firebaseapp.com", projectId: "hosted", appId: "ha", storageBucket: "x" };

const respond = (body: unknown, init: { status?: number } = {}) =>
  vi.fn(async () => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => {
      if (typeof body === "string") throw new SyntaxError("Unexpected token <");
      return body;
    },
  })) as unknown as typeof fetch;

describe("resolveFirebaseConfig", () => {
  it("uses VITE_FIREBASE_* when all four are set, without touching the network", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(resolveFirebaseConfig(full, fetchImpl)).resolves.toEqual({
      apiKey: "k",
      authDomain: "p.firebaseapp.com",
      projectId: "p",
      appId: "a",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads Hosting's init.json when none are set, keeping only the four fields", async () => {
    const fetchImpl = respond(served);
    await expect(resolveFirebaseConfig({}, fetchImpl)).resolves.toEqual({
      apiKey: "hk",
      authDomain: "h.firebaseapp.com",
      projectId: "hosted",
      appId: "ha",
    });
    expect(fetchImpl).toHaveBeenCalledWith(FIREBASE_INIT_PATH, { cache: "no-store" });
  });

  it("refuses a half-configured dev build instead of falling through to Hosting", async () => {
    const fetchImpl = respond(served);
    await expect(
      resolveFirebaseConfig({ VITE_FIREBASE_API_KEY: "k", VITE_FIREBASE_PROJECT_ID: "p" }, fetchImpl)
    ).rejects.toThrow("VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_APP_ID not set");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains a non-JSON answer: the site isn't on Firebase Hosting", async () => {
    await expect(resolveFirebaseConfig({}, respond("<!doctype html>"))).rejects.toThrow(
      "not served by Firebase Hosting"
    );
  });

  it("reports an error status and a network failure", async () => {
    await expect(resolveFirebaseConfig({}, respond({}, { status: 404 }))).rejects.toThrow("returned 404");
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(resolveFirebaseConfig({}, down)).rejects.toThrow("Failed to fetch");
  });

  it("names the fields an incomplete init.json is missing", async () => {
    await expect(resolveFirebaseConfig({}, respond({ apiKey: "hk", projectId: "" }))).rejects.toThrow(
      "missing authDomain, projectId, appId"
    );
  });
});

describe("bootstrapWebConfig", () => {
  // Module state is shared across tests in this file, so the failure case runs
  // first and the successful one last.
  it("retries after a failure instead of caching it", async () => {
    await expect(bootstrapWebConfig({}, respond({}, { status: 404 }))).rejects.toThrow("returned 404");
    expect(() => webConfig()).toThrow("before bootstrapWebConfig()");
    await expect(bootstrapWebConfig({}, respond(served))).resolves.toMatchObject({
      firebase: { projectId: "hosted" },
    });
  });

  it("serves the cached config without resolving again", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const config = await bootstrapWebConfig({}, fetchImpl);
    expect(webConfig()).toBe(config);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("shares one resolution between concurrent calls", async () => {
    // A fresh module, so nothing is cached and the two calls really overlap.
    vi.resetModules();
    const fresh = await import("./config");
    const fetchImpl = respond(served);
    const [a, b] = await Promise.all([fresh.bootstrapWebConfig({}, fetchImpl), fresh.bootstrapWebConfig({}, fetchImpl)]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("bootstrapWebConfig: the engine's run record", () => {
  it("defaults to starfish_runs and a 90-minute stale threshold, and reads both from the environment", async () => {
    vi.resetModules();
    const fresh = await import("./config");
    expect(await fresh.bootstrapWebConfig({}, respond(served))).toMatchObject({
      runCollection: "starfish_runs",
      engineStaleMinutes: 90,
    });

    vi.resetModules();
    const other = await import("./config");
    expect(
      await other.bootstrapWebConfig(
        { VITE_STARFISH_RUN_COLLECTION: "my_runs", VITE_STARFISH_STALE_MINUTES: "15" },
        respond(served)
      )
    ).toMatchObject({ runCollection: "my_runs", engineStaleMinutes: 15 });
  });

  it("reads the demo's sign-in hint trimmed, and leaves it empty when unset", async () => {
    vi.resetModules();
    const fresh = await import("./config");
    expect(await fresh.bootstrapWebConfig({}, respond(served))).toMatchObject({ demoSignInHint: "" });

    vi.resetModules();
    const other = await import("./config");
    expect(
      await other.bootstrapWebConfig({ VITE_STARFISH_DEMO_SIGNIN_HINT: "  In the slides.  " }, respond(served))
    ).toMatchObject({ demoSignInHint: "In the slides." });
  });

  it("defaults the cycle collection to starfish_cycles and reads it from the environment", async () => {
    vi.resetModules();
    const fresh = await import("./config");
    expect(await fresh.bootstrapWebConfig({}, respond(served))).toMatchObject({ cycleCollection: "starfish_cycles" });

    vi.resetModules();
    const other = await import("./config");
    expect(
      await other.bootstrapWebConfig({ VITE_STARFISH_CYCLE_COLLECTION: "my_cycles" }, respond(served))
    ).toMatchObject({ cycleCollection: "my_cycles" });
  });

  it.each(["0", "-5", "abc", "Infinity"])("falls back to the default for %s rather than blocking startup", async (bad) => {
    vi.resetModules();
    const fresh = await import("./config");
    expect(await fresh.bootstrapWebConfig({ VITE_STARFISH_STALE_MINUTES: bad }, respond(served))).toMatchObject({
      engineStaleMinutes: 90,
    });
  });
});


describe("readAppCheckConfig (#12)", () => {
  it("is off by default: no site key, enterprise, no debug token", () => {
    expect(readAppCheckConfig({})).toEqual({ siteKey: "", provider: "enterprise" });
  });

  it("reads the site key and the provider; an unknown provider is enterprise", () => {
    expect(readAppCheckConfig({ VITE_STARFISH_APPCHECK_SITE_KEY: " key ", VITE_STARFISH_APPCHECK_PROVIDER: "V3" })).toEqual({
      siteKey: "key",
      provider: "v3",
    });
    expect(
      readAppCheckConfig({ VITE_STARFISH_APPCHECK_SITE_KEY: "key", VITE_STARFISH_APPCHECK_PROVIDER: "v2" }).provider
    ).toBe("enterprise");
  });

  it("honours a debug token only in the dev server, never in a production build", () => {
    expect(readAppCheckConfig({ DEV: true, VITE_STARFISH_APPCHECK_DEBUG_TOKEN: "abc" }).debugToken).toBe("abc");
    expect(readAppCheckConfig({ DEV: true, VITE_STARFISH_APPCHECK_DEBUG_TOKEN: "true" }).debugToken).toBe(true);
    expect(readAppCheckConfig({ DEV: false, VITE_STARFISH_APPCHECK_DEBUG_TOKEN: "abc" })).not.toHaveProperty("debugToken");
    expect(readAppCheckConfig({ VITE_STARFISH_APPCHECK_DEBUG_TOKEN: "abc" })).not.toHaveProperty("debugToken");
  });

  it("is part of the bootstrapped config", async () => {
    vi.resetModules();
    const fresh = await import("./config");
    const cfg = await fresh.bootstrapWebConfig({ VITE_STARFISH_APPCHECK_SITE_KEY: "k" }, respond(served));
    expect(cfg.appCheck).toEqual({ siteKey: "k", provider: "enterprise" });
  });
});

describe("normalizeAdminApiUrl", () => {
  it("keeps an https URL without its trailing slash", () => {
    expect(normalizeAdminApiUrl("https://starfish-admin-abc-uc.a.run.app/")).toBe("https://starfish-admin-abc-uc.a.run.app");
  });
  it("allows http only on localhost", () => {
    expect(normalizeAdminApiUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeAdminApiUrl("http://example.com")).toBe("");
  });
  it("shows nothing for a missing, malformed or credentialed value", () => {
    for (const bad of [undefined, "", "not a url", "ftp://x.example", "https://u:p@x.example", "https://x.example/?a=1"]) {
      expect(normalizeAdminApiUrl(bad)).toBe("");
    }
  });
});
