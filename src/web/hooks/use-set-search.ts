/**
 * Change search params without the page jumping to the top.
 *
 * 🔴 TanStack Router treats a search-param change as a navigation, and
 * `resetScroll` defaults to **true** — so moving a filter, opening a side panel
 * or typing a single character in a search box each scrolled the page back to
 * the start. It was measured, not guessed: after clicking the last row of a
 * long table the `<tbody>` and its first `<tr>` are the same DOM nodes, so
 * nothing had remounted; the scroll came from the router.
 *
 * Every screen that keeps state in the URL must navigate through this. A direct
 * `navigate({ search })` anywhere reintroduces the bug in that one place, which
 * is exactly how it survived unnoticed on six screens.
 */
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";

export function useSetSearch<S extends Record<string, unknown>>() {
  const navigate = useNavigate();
  return useCallback(
    (update: (previous: S) => S) => {
      void navigate({
        search: update as never,
        replace: true,
        // The whole point of this hook.
        resetScroll: false,
      });
    },
    [navigate],
  );
}
