import { describe, expect, it } from "vitest";
import { activeMenuItem, matchesPath, menuItems, visibleMenuItems } from "./menuConfig";

describe("menuConfig", () => {
  it("matches exact paths and segment prefixes only", () => {
    expect(matchesPath("/settings/github", "/settings")).toBe(true);
    expect(matchesPath("/settingsx", "/settings")).toBe(false);
    expect(matchesPath("/incidents", "/")).toBe(false);
  });

  it("hides admin-only items from operators", () => {
    expect(visibleMenuItems(menuItems, ["operator"]).map((i) => i.id)).toEqual(["incidents"]);
    expect(visibleMenuItems(menuItems, ["admin"]).map((i) => i.id)).toEqual(["incidents", "settings"]);
  });

  it("finds the active section by longest prefix", () => {
    expect(activeMenuItem(menuItems, "/settings")?.id).toBe("settings");
    expect(activeMenuItem(menuItems, "/nowhere")).toBeUndefined();
  });
});
