import { describe, expect, it, vi } from "vitest";
import { FIREBASE_INIT_PATH, bootstrapWebConfig, resolveFirebaseConfig, webConfig } from "./config";

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
