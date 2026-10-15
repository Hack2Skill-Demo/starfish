/**
 * The one switch between a guest and everyone else (dataSource.ts), with the public demo's open actions on and off:
 * off (the default), a guest reads the trimmed copies and gets no controls, exactly as before; on, on a demo build with
 * an admin API, a guest reads the stored documents and acts through the admin API.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ currentUser: null as null | { isAnonymous: boolean } }));
const cfg = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
vi.mock("./firebase", () => ({ firebaseAuth: () => auth }));
vi.mock("./config", () => ({ webConfig: () => cfg.value }));

import { actsThroughAdminApi, canOperate, dataSource, publicDemoActionsOn } from "./dataSource";

const base = {
  environment: "demo",
  adminApiUrl: "https://admin.example",
  incidentCollection: "incidents",
  cycleCollection: "starfish_cycles",
  publicIncidentCollection: "starfish_public_incidents",
  publicCycleCollection: "starfish_public_cycles",
  publicEventCollection: "starfish_public_events",
  publicDemoActions: false,
};
const STORED = { guest: false, incidents: "incidents", cycles: "starfish_cycles" };
const TRIMMED = { guest: true, incidents: "starfish_public_incidents", cycles: "starfish_public_cycles", publicEvents: "starfish_public_events" };

beforeEach(() => {
  cfg.value = { ...base };
  auth.currentUser = { isAnonymous: true };
});

describe("dataSource with the open actions OFF (the default): exactly as before", () => {
  it("a guest reads the trimmed copies, gets no controls and acts through nothing", () => {
    expect(publicDemoActionsOn()).toBe(false);
    expect(dataSource()).toEqual(TRIMMED);
    expect(canOperate([], true)).toBe(false);
    expect(actsThroughAdminApi()).toBe(false);
  });

  it("an operator reads the stored documents and triages, as always", () => {
    auth.currentUser = { isAnonymous: false };
    expect(dataSource()).toEqual(STORED);
    expect(canOperate(["operator"], false)).toBe(true);
    expect(actsThroughAdminApi()).toBe(false);
  });
});

describe("dataSource with the open actions ON", () => {
  beforeEach(() => {
    cfg.value = { ...base, publicDemoActions: true };
  });

  it("a guest reads the stored documents, gets the operator's controls and acts through the admin API", () => {
    expect(publicDemoActionsOn()).toBe(true);
    expect(dataSource()).toEqual(STORED);
    expect(canOperate([], true)).toBe(true);
    expect(actsThroughAdminApi()).toBe(true);
  });

  it("a signed-in operator still writes Firestore directly; a role-less email account still gets nothing", () => {
    auth.currentUser = { isAnonymous: false };
    expect(actsThroughAdminApi()).toBe(false);
    expect(canOperate(["operator"], false)).toBe(true);
    expect(canOperate([], false)).toBe(false);
  });

  it("without an admin API to send them to, a guest reads the records but gets no controls", () => {
    cfg.value = { ...base, publicDemoActions: true, adminApiUrl: "" };
    expect(dataSource()).toEqual(STORED);
    expect(canOperate([], true)).toBe(false);
    expect(actsThroughAdminApi()).toBe(false);
  });

  it("is ignored on any build but the demo's", () => {
    cfg.value = { ...base, publicDemoActions: true, environment: "prod" };
    expect(publicDemoActionsOn()).toBe(false);
    expect(dataSource()).toEqual(TRIMMED);
    expect(canOperate([], true)).toBe(false);
  });
});
