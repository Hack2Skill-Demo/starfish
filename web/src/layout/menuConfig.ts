/**
 * Sidebar menu: top-level items with optional
 * children, each optionally restricted to roles (empty/unset = any role).
 */
import { Activity, Settings, type LucideIcon } from "lucide-react";
import type { StarfishRole } from "../auth/authCore";

export interface MenuChild {
  id: string;
  label: string;
  path: string;
  roles?: StarfishRole[];
}

export interface MenuItem extends MenuChild {
  icon: LucideIcon;
  children?: MenuChild[];
}

export const menuItems: MenuItem[] = [
  { id: "incidents", label: "Incidents", path: "/incidents", icon: Activity },
  { id: "settings", label: "Settings", path: "/settings", icon: Settings, roles: ["admin"] },
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
export function visibleMenuItems(items: MenuItem[], roles: readonly StarfishRole[]): MenuItem[] {
  const allowed = (r?: StarfishRole[]) => !r || r.length === 0 || r.some((x) => roles.includes(x));
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
