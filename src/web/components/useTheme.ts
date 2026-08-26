/**
 * Light, dark, or whatever the device says.
 *
 * The system preference is the default and `system` is a real third state, not
 * a starting guess: a device that switches at sunset should take the UI with
 * it. An explicit choice writes `data-theme` on <html>, which the stylesheet
 * lets win in both directions.
 */
import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "casatube.theme";

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    // Private windows and blocked site data throw on access rather than
    // returning null. Following the system preference is the right fallback.
    return "system";
  }
}

export function useTheme(): { theme: ThemeChoice; cycle: () => void } {
  const [theme, setTheme] = useState<ThemeChoice>(stored);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // A theme that does not persist is still a theme.
    }
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme((current) => (current === "system" ? "light" : current === "light" ? "dark" : "system"));
  }, []);

  return { theme, cycle };
}
