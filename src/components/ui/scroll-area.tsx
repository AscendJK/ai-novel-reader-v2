import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
import { cn } from "@/lib/utils"

/**
 * Override Radix Viewport's inline `display:table` which causes content overflow.
 * Radix applies this via JS style prop, so CSS alone can't reliably override it.
 */
function useFixViewportDisplay(rootRef: React.RefObject<HTMLDivElement | null>) {
  React.useEffect(() => {
    if (!rootRef.current) return
    const viewport = rootRef.current.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")
    if (!viewport) return
    viewport.style.display = "block"
    viewport.style.minWidth = "0"
  })
}

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => {
  const internalRef = React.useRef<HTMLDivElement>(null)
  const composedRef = (node: HTMLDivElement | null) => {
    ;(internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node
    if (typeof ref === "function") ref(node)
    else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
  }
  useFixViewportDisplay(internalRef)

  return (
    <ScrollAreaPrimitive.Root
      ref={composedRef}
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
})
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-colors",
      orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar }
