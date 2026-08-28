import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * 🔴 **A height limit belongs on `viewportClassName`, not on `className`.**
 *
 * The viewport is the element Radix gives `overflow: scroll`, and it carries
 * `height: 100%`. Against a root whose height is only *bounded* — `max-h-96`,
 * the obvious thing to write — `100%` has no definite length to resolve
 * against, so it behaves as `auto`: the viewport grows to the full height of
 * its content, `scrollHeight` equals `clientHeight`, and there is nothing to
 * scroll. Measured on the notification bell with 40 rows: root 384 px,
 * viewport **3483 px**, and the list painted straight out of the popover.
 *
 * Both halves of that are one bug, and it reads as two: "it overflows" and "it
 * does not scroll". So `max-h-*` goes on the viewport, where it makes the
 * scrollport short and the content scrollable — and the panel still shrinks to
 * fit a short list, which a definite `h-96` on the root would not do.
 */
function ScrollArea({
  className,
  viewportClassName,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /** Where a height limit goes. See the note above. */
  viewportClassName?: string
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          viewportClassName
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" &&
          "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
