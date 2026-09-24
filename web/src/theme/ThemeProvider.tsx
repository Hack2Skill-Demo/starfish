/**
 * Light/dark theme. The operator picks light, dark or system (the default,
 * which follows prefers-color-scheme live); the choice is remembered per
 * browser. The resolved theme is applied as a `dark` class on <html>, which is
 * what Tailwind's `dark:` variant keys on (see styles/theme.css).
 */
import { useEffect, useState, type ReactNode } from "react";
import { ThemeContext, type ThemePreference } from "./useTheme";

const STORAGE_KEY = "starfish.theme";
const ORDER: ThemePreference[] = ["light", "dark", "system"];

function readStored(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system"; // storage blocked (private mode, sandboxed frame)
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themePreference, setThemePreference] = useState<ThemePreference>(readStored);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const theme = themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const setPreference = (next: ThemePreference) => {
    setThemePreference(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisted; the choice still applies for this session.
    }
  };

  const toggleTheme = () => setPreference(ORDER[(ORDER.indexOf(themePreference) + 1) % ORDER.length]);

  return (
    <ThemeContext.Provider value={{ theme, themePreference, setThemePreference: setPreference, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
