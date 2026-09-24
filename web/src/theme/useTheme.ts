import { createContext, useContext } from "react";

export type ThemePreference = "light" | "dark" | "system";

export interface ThemeValue {
  /** What is on screen now. */
  theme: "light" | "dark";
  /** What the operator chose; "system" follows the OS setting. */
  themePreference: ThemePreference;
  setThemePreference: (next: ThemePreference) => void;
  /** Cycle light → dark → system. */
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeValue | null>(null);

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
