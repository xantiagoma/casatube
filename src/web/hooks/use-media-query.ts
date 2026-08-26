/**
 * A CSS media query, as a boolean.
 *
 * Used where a layout decision cannot be made in CSS alone — a docked panel and
 * a modal sheet are different *components*, not the same one at two widths, and
 * rendering both and hiding one leaves an invisible overlay swallowing clicks.
 */
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof matchMedia === "function" ? matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(query);
    setMatches(media.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Wide enough to dock an inspector beside the content. */
export function useDockedPanels(): boolean {
  return useMediaQuery("(min-width: 1536px)");
}
