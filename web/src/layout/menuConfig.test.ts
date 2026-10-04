import { describe, expect, it } from "vitest";
import { activeMenuItem, matchesPath, menuItems, visibleMenuItems } from "./menuConfig";

describe("menuConfig", () => {
  it("matches exact paths and segment prefixes only", () => {
    expect(matchesPath("/settings/github", "/settings")).toBe(true);
    expect(matchesPath("/settingsx", "/settings")).toBe(false);
    expect(matchesPath("/incidents", "/")).toBe(false);
  });

  it("hides admin-only items from operators", () => {
    expect(visibleMenuItems(menuItems, ["operator"]).map((i) => i.id)).toEqual(["overview", "incidents", "runs"]);
    expect(visibleMenuItems(menuItems, ["admin"]).map((i) => i.id)).toEqual(["overview", "incidents", "runs", "settings"]);
  });

  it("shows a guest the incidents and a view-only Settings, never anything role-gated beyond that", () => {
    expect(visibleMenuItems(menuItems, ["guest"]).map((i) => i.id)).toEqual(["overview", "incidents", "runs", "settings"]);
    // A guest is not an admin or an operator.
    expect(visibleMenuItems(menuItems, []).map((i) => i.id)).toEqual(["overview", "incidents", "runs"]);
  });

  it("finds the active section by longest prefix", () => {
    expect(activeMenuItem(menuItems, "/settings")?.id).toBe("settings");
    expect(activeMenuItem(menuItems, "/runs")?.id).toBe("runs");
    expect(activeMenuItem(menuItems, "/nowhere")).toBeUndefined();
  });
});
