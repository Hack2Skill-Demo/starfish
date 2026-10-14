/**
 * Sidebar menu: top-level items with optional
 * children, each optionally restricted to roles (empty/unset = any role).
 */
import { Activity, LayoutDashboard, Settings, Workflow, type LucideIcon } from "lucide-react";
import type { ViewerRole } from "../auth/authCore";

export interface MenuChild {
  id: string;
  label: string;
  path: string;
  roles?: ViewerRole[];
}

export interface MenuItem extends MenuChild {
  icon: LucideIcon;
  children?: MenuChild[];
}

export const menuItems: MenuItem[] = [
  { id: "overview", label: "Overview", path: "/overview", icon: LayoutDashboard },
  { id: "incidents", label: "Incidents", path: "/incidents", icon: Activity },
  { id: "runs", label: "Runs", path: "/runs", icon: Workflow },
  // Operators and guests see Settings read-only: the connections and the settings in force, no editor and no On-call
  // (admins only, Settings.tsx). An admin edits.
  { id: "settings", label: "Settings", path: "/settings", icon: Settings, roles: ["admin", "operator", "guest"] },
];

/**
 * Prefix-aware route match: exact, or a path-segment prefix (/settings matches
 * /settings/github but not /settingsx).
 */
export function matchesPath(pathname: string, path: string): boolean {
  if (path === "/") return pathname === "/";
  return pathname === path || pathname.startsWith(path + "/");
}

/** Items (and children) the given roles may see. Gates on the full roles array. */
export function visibleMenuItems(items: MenuItem[], roles: readonly ViewerRole[]): MenuItem[] {
  const allowed = (r?: ViewerRole[]) => !r || r.length === 0 || r.some((x) => roles.includes(x));
  return items
    .filter((item) => allowed(item.roles))
    .map((item) => ({ ...item, children: item.children?.filter((c) => allowed(c.roles)) }));
}

/** The active top-level item: longest-prefix match over each item's and its children's paths. */
export function activeMenuItem(items: MenuItem[], pathname: string): MenuItem | undefined {
  let best: MenuItem | undefined;
  let bestLen = -1;
  for (const item of items) {
    for (const p of [item.path, ...(item.children?.map((c) => c.path) ?? [])]) {
      if (matchesPath(pathname, p) && p.length > bestLen) {
        best = item;
        bestLen = p.length;
      }
    }
  }
  return best;
}
