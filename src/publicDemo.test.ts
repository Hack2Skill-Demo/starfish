/**
 * `publicDemoSettings` (#430): the configuration a visitor's call runs with follows the runtime settings' environment,
 * and the read gate follows it too. Stubs only; the store's side is in publicDemo.emulator.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { StarfishConfig } from "./config.js";
import { testConfig } from "./testConfig.js";
import { publicDemoSettings, type GateEvent, type GateResult } from "./publicDemo.js";

const base = testConfig({ environment: "x", publicEnvironments: ["demo"], publicDemoActions: true });

function harness(opts: { resolved: () => { config: StarfishConfig; actionsAllowed: boolean } | Promise<never>; sync?: (cfg: StarfishConfig) => Promise<GateResult> }) {
  const synced: { on: boolean; environment: string }[] = [];
  const events: GateEvent[] = [];
  const current = publicDemoSettings({
    resolve: () => {
      const r = opts.resolved();
      return r instanceof Promise ? r : Promise.resolve(r);
    },
    syncGate: (cfg) => {
      synced.push({ on: cfg.publicDemoActions, environment: cfg.environment });
      return opts.sync ? opts.sync(cfg) : Promise.resolve("enabled");
    },
    onGate: (e) => events.push(e),
  });
  return { current, synced, events };
}

describe("publicDemoSettings (#430)", () => {
  it("acts in the settings' environment, not the environment variable's", async () => {
    const { current, synced } = harness({ resolved: () => ({ config: { ...base, environment: "demo" }, actionsAllowed: true }) });
    expect((await current())?.environment).toBe("demo");
    expect(synced).toEqual([{ on: true, environment: "demo" }]);
  });

  it("is off when the settings move to an environment that is not public, and the gate is brought in line", async () => {
    const { current, synced, events } = harness({ resolved: () => ({ config: { ...base, environment: "prod" }, actionsAllowed: true }), sync: () => Promise.resolve("disabled") });
    expect(await current()).toBeNull();
    expect(synced).toEqual([{ on: true, environment: "prod" }]);
    expect(events).toEqual([{ on: false, environment: "prod", gate: "disabled" }]);
  });

  it("resolves again on every call, so a Settings change is followed without a restart", async () => {
    let environment = "demo";
    const { current } = harness({ resolved: () => ({ config: { ...base, environment }, actionsAllowed: true }) });
    expect(await current()).not.toBeNull();
    environment = "prod";
    expect(await current()).toBeNull();
    environment = "demo";
    expect(await current()).not.toBeNull();
  });

  it("is off with unusable settings, and closes the gate with them", async () => {
    const { current, synced } = harness({ resolved: () => ({ config: { ...base, environment: "demo" }, actionsAllowed: false }) });
    expect(await current()).toBeNull();
    expect(synced).toEqual([{ on: false, environment: "demo" }]);
  });

  it("a failed gate write is reported by its code and does not refuse the call", async () => {
    const { current, events } = harness({
      resolved: () => ({ config: { ...base, environment: "demo" }, actionsAllowed: true }),
      sync: () => Promise.reject(Object.assign(new Error("secret detail"), { code: "unavailable" })),
    });
    expect((await current())?.environment).toBe("demo");
    expect(events).toEqual([{ on: true, environment: "demo", error: "unavailable" }]);
  });

  it("never throws: a resolver that does is off, and a reporter that throws changes nothing", async () => {
    expect(await harness({ resolved: () => Promise.reject(new Error("x")) }).current()).toBeNull();
    const current = publicDemoSettings({
      resolve: () => Promise.resolve({ config: { ...base, environment: "demo" }, actionsAllowed: true }),
      syncGate: () => Promise.resolve("unchanged"),
      onGate: () => {
        throw new Error("log down");
      },
    });
    expect((await current())?.environment).toBe("demo");
  });

  it("with the switch off, is off whatever the environment, and closes the gate", async () => {
    const { current, synced } = harness({ resolved: () => ({ config: { ...base, environment: "demo", publicDemoActions: false }, actionsAllowed: true }) });
    expect(await current()).toBeNull();
    expect(synced).toEqual([{ on: false, environment: "demo" }]);
  });
});
