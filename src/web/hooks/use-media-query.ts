/**
 * A CSS media query, as a boolean.
 *
 * Used where a layout decision cannot be made in CSS alone — a docked panel and
 * a modal sheet are different *components*, not the same one at two widths, and
 * rendering both and hiding one leaves an invisible overlay swallowing clicks.
 */
import { useEffect, useState } from "react";

/** Wide enough to dock an inspector beside the content. */
const DOCK_QUERY = "(min-width: 1536px)";

/**
 * Whatever the browser currently has in fullscreen, or `null`.
 *
 * Both spellings, because Safari before 16.4 only has the prefixed one and the
 * iPad is the machine this is watched on.
 */
function fullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * @param freezeWhileFullscreen Stop tracking the query for as long as anything
 * is fullscreen. `useDockedPanels` below is the reason this exists, and carries
 * the explanation.
 */
export function useMediaQuery(query: string, freezeWhileFullscreen = false): boolean {
  const [matches, setMatches] = useState(() =>
    typeof matchMedia === "function" ? matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(query);

    const sync = () => {
      // The width this would be reading is the screen's, not the window's, and
      // acting on it destroys the element that owns the screen.
      if (freezeWhileFullscreen && fullscreenElement()) return;
      setMatches(media.matches);
    };

    sync();
    media.addEventListener("change", sync);
    if (!freezeWhileFullscreen) {
      return () => media.removeEventListener("change", sync);
    }

    // Leaving fullscreen is when a swallowed change has to be applied.
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      media.removeEventListener("change", sync);
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [query, freezeWhileFullscreen]);

  return matches;
}

/**
 * Wide enough to dock an inspector beside the content — **and frozen for as
 * long as anything is fullscreen**.
 *
 * 🔴 The freeze is the whole point, and it is not defensive coding: without it,
 * fullscreen is unusable on any window narrower than the monitor.
 *
 * Entering fullscreen resizes the **layout viewport to the screen**. A 1440 px
 * window on a 1920 px monitor becomes a 1920 px viewport the moment the video
 * goes fullscreen — measured here as 945 → 1920. That crosses this query, so
 * `docked` flips; and because docked and undocked are different components, the
 * inspector is torn down and rebuilt elsewhere in the tree. The `<video>` goes
 * with it — and **removing the fullscreen element from the document exits
 * fullscreen**. The browser then restores the old viewport, the query flips
 * back, the panel is rebuilt again, and the whole thing reads as "fullscreen
 * turns itself off". Measured on the real MKV, with no emulation:
 *
 * ```
 * 2117  fullscreenchange IN   innerWidth=1920
 * 2402  <video> removed       ← the sheet unmounts, the docked aside takes over
 * 2418  fullscreenchange OUT  ← because the fullscreen element is gone
 * ```
 *
 * ⚠️ Reading `document.fullscreenElement` inside the handler is what makes this
 * work, and the order was verified rather than assumed. On the way *in*, Chrome
 * fires `resize` and the media-query change with `fullscreenElement` **already
 * set**, so the change is swallowed. On the way *out* it fires them with it
 * **already null**, so the layout comes back by itself. `fullscreenchange` is
 * listened to as well, for a browser that does it the other way round: a change
 * swallowed during fullscreen would otherwise leave the panel in the wrong
 * shape after exiting.
 */
export function useDockedPanels(): boolean {
  return useMediaQuery(DOCK_QUERY, true);
}
