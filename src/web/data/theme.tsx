/**
 * Light, dark, or whatever the device says.
 *
 * `system` is a real third state, not a starting guess: a device that switches
 * at sunset takes the UI with it. The choice is resolved **in JavaScript** and
 * written as a single `dark` class on <html>, because Tailwind's `dark:`
 * variant needs one selector to key off — resolving it in a media query
 * instead means an explicit "light" cannot beat a dark OS.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "casatube.theme";

interface ThemeApi {
  /** What the user asked for. */
  choice: ThemeChoice;
  /** What that means right now. */
  resolved: "light" | "dark";
  set(choice: ThemeChoice): void;
  /** system → light → dark → system. */
  cycle(): void;
}

const ThemeContext = createContext<ThemeApi | null>(null);

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    // Private windows and blocked site data throw on access rather than
    // returning null. Following the system preference is the right fallback.
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(stored);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolved: "light" | "dark" = choice === "system" ? (systemDark ? "dark" : "light") : choice;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  /**
   * ⚠️ The write happens **outside** the state updater.
   *
   * React may call an updater twice (StrictMode does, deliberately), so an
   * updater that touches localStorage is a side effect running an unpredictable
   * number of times. Persisting here, where it runs exactly once per call, is
   * the only version that is honest about how many times it happens.
   */
  const set = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // A theme that does not persist is still a theme.
    }
  }, []);

  const cycle = useCallback(() => {
    set(choice === "system" ? "light" : choice === "light" ? "dark" : "system");
  }, [choice, set]);

  const value = useMemo<ThemeApi>(() => ({ choice, resolved, set, cycle }), [choice, resolved, set, cycle]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeApi {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme outside ThemeProvider");
  return value;
}
