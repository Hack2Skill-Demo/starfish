/**
 * StarfishLayout — a two-level sidebar (icon rail + section
 * panel), a route-aware header, and the page outlet. Menu items are filtered by the
 * operator's roles; the L2 collapse persists per browser.
 *
 * No command palette or breadcrumbs: with two sections they would not earn their keep.
 */
import { useState } from "react";
import { Outlet, NavLink, Link, useLocation, useNavigate } from "react-router";
import { Menu, X, LogOut, ChevronLeft, ChevronRight, Sun, Moon, Monitor } from "lucide-react";
import { useAuth } from "../auth/authCore";
import { useTheme } from "../theme/useTheme";
import { webConfig } from "../lib/config";
import { StarfishLogo } from "./StarfishLogo";
import { menuItems, visibleMenuItems, activeMenuItem } from "./menuConfig";

const ROLE_LABELS = { admin: "Admin", operator: "Operator", viewer: "Viewer" } as const;
const L2_KEY = "starfish.nav.l2Collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(L2_KEY) === "1";
  } catch {
    return false;
  }
}

export function StarfishLayout() {
  const { user, roles, role, signOut } = useAuth();
  const { themePreference, toggleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [l2Collapsed, setL2Collapsed] = useState(readCollapsed);

  const items = visibleMenuItems(menuItems, roles);
  const active = activeMenuItem(items, location.pathname);

  const toggleL2 = () => {
    setL2Collapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(L2_KEY, next ? "1" : "0");
      } catch {
        // Private mode: the collapse just won't persist.
      }
      return next;
    });
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/signin", { replace: true });
  };

  const ThemeIcon = themePreference === "dark" ? Moon : themePreference === "system" ? Monitor : Sun;

  return (
    <div className="flex h-screen bg-gray-100 dark:bg-gray-900">
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex transform bg-gray-900 transition-transform duration-200 ease-in-out lg:static lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* L1: icon rail */}
        <div className="flex w-16 flex-col items-center border-r border-white/5 bg-gray-900 py-4">
          <Link to="/incidents" onClick={() => setSidebarOpen(false)} className="mb-4" aria-label="Starfish home">
            <StarfishLogo variant="mark" tone="dark" size={32} title="" />
          </Link>
          {l2Collapsed && (
            <button
              onClick={toggleL2}
              aria-label="Expand sidebar"
              className="mb-2 hidden h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-800 hover:text-white lg:flex"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          )}
          <nav className="flex flex-1 flex-col items-center gap-1">
            {items.map((item) => (
              <NavLink
                key={item.id}
                to={item.children?.[0]?.path ?? item.path}
                onClick={() => setSidebarOpen(false)}
                aria-label={item.label}
                title={item.label}
                className={`flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
                  active?.id === item.id
                    ? "bg-gray-800 text-white ring-1 ring-white/15"
                    : "text-gray-400 hover:bg-gray-800 hover:text-white"
                }`}
              >
                <item.icon className="h-5 w-5" />
              </NavLink>
            ))}
          </nav>
          <button
            onClick={handleSignOut}
            aria-label="Sign out"
            title="Sign out"
            className="mt-2 flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>

        {/* L2: section panel */}
        <div className={`w-64 flex-col border-l border-white/5 bg-gray-900 ${l2Collapsed ? "flex lg:hidden" : "flex"}`}>
          <div className="flex h-16 items-center justify-between px-4">
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-display text-xl font-bold tracking-tight text-white">Starfish</span>
              <span className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase leading-none tracking-wide text-gray-300">
                {webConfig().environment}
              </span>
            </div>
            <button
              onClick={toggleL2}
              aria-label="Collapse sidebar"
              className="hidden rounded-md p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white lg:block"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              className="rounded-md p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white lg:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
            {items.map((item) => (
              <NavLink
                key={item.id}
                to={item.path}
                onClick={() => setSidebarOpen(false)}
                className={`block rounded-lg px-3 py-2 text-sm transition-colors ${
                  active?.id === item.id ? "bg-brand-600 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white"
                }`}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-gray-800 p-4">
            <p className="truncate text-sm font-medium text-white">{user?.email}</p>
            {role && <p className="text-xs text-gray-400">{ROLE_LABELS[role]}</p>}
          </div>
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-4 dark:border-gray-700 dark:bg-gray-800 lg:px-6">
          <button className="lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <Menu className="h-6 w-6 text-gray-600 dark:text-gray-400" />
          </button>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{active?.label ?? "Starfish"}</span>
          <button
            onClick={toggleTheme}
            aria-label={`Theme: ${themePreference}. Change theme`}
            title={`Theme: ${themePreference}`}
            className="rounded-lg border border-gray-200 p-2 text-gray-500 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-700/50"
          >
            <ThemeIcon className="h-4 w-4" />
          </button>
        </header>
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
