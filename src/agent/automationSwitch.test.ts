import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { makeAutomationSwitch } from "./automationSwitch.js";
import { RuntimeConfigLoader, SETTINGS_DOC } from "../runtimeSettings.js";
import type { ResolvedConfig } from "../runtimeSettings.js";
import { testConfig } from "../testConfig.js";

const db = {} as Firestore;
const resolved = (over: Partial<ResolvedConfig> & { automationEnabled?: boolean } = {}): ResolvedConfig => {
  const { automationEnabled, ...rest } = over;
  return { config: testConfig({ automationEnabled: automationEnabled ?? true }), source: "settings", problems: [], actionsAllowed: true, ...rest };
};

describe("makeAutomationSwitch", () => {
  it("is on when the settings say so, and off when they say off", async () => {
    expect(await makeAutomationSwitch({ resolve: async () => resolved() }, db)()).toBe(true);
    expect(await makeAutomationSwitch({ resolve: async () => resolved({ automationEnabled: false }) }, db)()).toBe(false);
  });

  it("is off when nothing usable is known, even if the defaults would say on (fail closed)", async () => {
    expect(await makeAutomationSwitch({ resolve: async () => resolved({ actionsAllowed: false, source: "env" }) }, db)()).toBe(false);
  });

  it("is off when the settings cannot be resolved at all", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("store unreachable");
    });
    expect(await makeAutomationSwitch({ resolve }, db)()).toBe(false);
  });

  it("reads the settings fresh each time it is asked: a switch turned off mid-run is seen at the next step", async () => {
    let on = true;
    const resolve = vi.fn(async () => resolved({ automationEnabled: on }));
    const ask = makeAutomationSwitch({ resolve }, db);
    expect(await ask()).toBe(true);
    on = false;
    expect(await ask()).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("works against the real loader: an admin's saved document turns it off, and an unreadable store turns it off", async () => {
    const docs: Record<string, unknown> = { [SETTINGS_DOC]: { version: 1, automationEnabled: false } };
    let failRead = false;
    const fake = {
      collection: () => ({
        doc: (id: string) => ({
          get: async () => {
            if (failRead) throw Object.assign(new Error("down"), { code: "unavailable" });
            return { exists: id in docs, data: () => docs[id] };
          },
          set: async (d: unknown) => void (docs[id] = d),
          delete: async () => void delete docs[id],
        }),
      }),
    } as unknown as Firestore;
    const ask = makeAutomationSwitch(new RuntimeConfigLoader(testConfig({ automationEnabled: true })), fake);
    expect(await ask()).toBe(false); // the admin turned it off
    docs[SETTINGS_DOC] = { version: 1, automationEnabled: true };
    expect(await ask()).toBe(true);
    delete docs[SETTINGS_DOC];
    expect(await ask()).toBe(true); // no document: the environment default (on)
    // Unreadable now, with a known-good copy from before: that copy decides. A fresh instance with none: off.
    failRead = true;
    expect(await makeAutomationSwitch(new RuntimeConfigLoader(testConfig({ automationEnabled: true })), fake)()).toBe(false);
  });
});
