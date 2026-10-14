import { describe, expect, it } from "vitest";
import { activeMenuItem, matchesPath, menuItems, visibleMenuItems } from "./menuConfig";

describe("menuConfig", () => {
  it("matches exact paths and segment prefixes only", () => {
    expect(matchesPath("/settings/github", "/settings")).toBe(true);
    expect(matchesPath("/settingsx", "/settings")).toBe(false);
    expect(matchesPath("/incidents", "/")).toBe(false);
  });

  it("shows an operator Settings (read-only on the page) as well as an admin (#355)", () => {
    expect(visibleMenuItems(menuItems, ["operator"]).map((i) => i.id)).toEqual(["overview", "incidents", "runs", "settings"]);
    expect(visibleMenuItems(menuItems, ["admin"]).map((i) => i.id)).toEqual(["overview", "incidents", "runs", "settings"]);
  });

  it("hides a role-gated item from a role it does not name", () => {
    const items = [...menuItems, { ...menuItems[0]!, id: "admin-only", path: "/admin-only", roles: ["admin" as const] }];
    expect(visibleMenuItems(items, ["operator"]).map((i) => i.id)).not.toContain("admin-only");
    expect(visibleMenuItems(items, ["admin"]).map((i) => i.id)).toContain("admin-only");
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
