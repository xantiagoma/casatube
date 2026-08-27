/**
 * The panel the options live in — a **vaul** drawer, one component at both
 * widths.
 *
 * 🔴 Why a dedicated panel and not the inline expansion it replaced: analysing
 * a YouTube video produces six codec choices, a resolution list, a hundred
 * audio dubs and a hundred and fifty subtitle languages. Growing the dashboard
 * card by that much pushed the queue, storage and analytics off the bottom of
 * the screen, so a decision about one download rearranged the whole screen.
 *
 * 🔴 Why vaul rather than a second `Sheet`: on a touch screen it is a real
 * sheet — it drags, it has momentum, it dismisses downwards — which is the
 * behaviour an iPad already teaches. `direction` is the only thing that changes
 * with width: a bottom sheet on a phone, a right-hand dialog on a desktop.
 *
 * ⚠️ **`direction` is a prop, not a different component.** `docs/DISCOVERIES.md`
 * records a `matchMedia` layout switch that swapped component *identity* and so
 * unmounted a fullscreen video mid-playback. Changing one prop on one mounted
 * `Drawer.Root` cannot do that; the media query is frozen while anything is
 * fullscreen anyway, for the same reason.
 *
 * ⚠️ The body scrolls, the header and footer do not. "Add to queue" must be
 * reachable without scrolling past a hundred and fifty languages to find it.
 */
import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";
import { Drawer } from "vaul";

import { cn } from "@/lib/utils";
import { useMediaQuery } from "../../hooks/use-media-query";

/** Below this a bottom sheet is the native-feeling shape; above it, a panel. */
const WIDE_QUERY = "(min-width: 768px)";

export function AnalysisDrawer({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange(next: boolean): void;
  title: string;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const wide = useMediaQuery(WIDE_QUERY, true);

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} direction={wide ? "right" : "bottom"}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Drawer.Content
          aria-describedby={undefined}
          className={cn(
            "fixed z-50 flex flex-col bg-background text-foreground outline-none",
            wide
              ? "inset-y-2 right-2 w-[min(44rem,calc(100vw-1rem))] rounded-xl border shadow-xl"
              : "inset-x-0 bottom-0 h-[92dvh] rounded-t-xl border-t shadow-xl",
          )}
          /* vaul parks the panel off-screen by `--initial-transform`; the
             default 100% leaves the 0.5rem inset showing during the slide. */
          style={wide ? ({ "--initial-transform": "calc(100% + 0.5rem)" } as CSSProperties) : undefined}
        >
          {!wide && (
            <div className="shrink-0 pt-2 pb-1">
              <Drawer.Handle className="mx-auto !w-12 !bg-muted-foreground/30" />
            </div>
          )}

          <div className="flex shrink-0 items-start gap-3 border-b px-4 py-3 sm:px-5">
            <div className="min-w-0 flex-1">
              <Drawer.Title className="truncate text-base font-semibold">{title}</Drawer.Title>
              {description ? (
                <div className="truncate text-xs text-muted-foreground">{description}</div>
              ) : null}
            </div>
            <Drawer.Close
              aria-label="Close options"
              className="-mr-1 shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </Drawer.Close>
          </div>

          {/* ⚠️ `data-vaul-no-drag` is on the inner lists, not here: the panel
              still has to be draggable by its padding and its headings. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">{children}</div>

          {footer ? (
            <div className="shrink-0 border-t bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
              {footer}
            </div>
          ) : null}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
