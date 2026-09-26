import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
import { cn } from "@/lib/utils"

/**
 * Radix ScrollArea Viewport 内部有一个 display:table 的包裹层，
 * table 自动布局会按内容宽度撑开，导致溢出父容器。
 * 用 ref 在挂载后强制覆盖两层的 display 和 minWidth。
 */
function useFixViewportDisplay(rootRef: React.RefObject<HTMLDivElement | null>) {
  React.useEffect(() => {
    const ref = rootRef;
    if (!ref.current) return
    const viewport = ref.current.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")
    if (!viewport) return
    // 外层 Viewport
    viewport.style.display = "block"
    viewport.style.minWidth = "0"
    // 内层内容包裹 div（Radix 硬编码的 display:table）
    const inner = viewport.querySelector<HTMLElement>("div")
    if (inner) {
      inner.style.display = "block"
      inner.style.minWidth = "0"
    }
  }, [rootRef])
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

/**
 * 自带的那只滚动条：只画竖排。
 *
 * 原来它是一只导出组件，接 `orientation`/`className`/`ref`/`...props`，横排那一组类是给外部调用点
 * 准备的——实测全仓除本文件自己的 `<ScrollBar />` 之外零调用者（两只调用点 `ChapterNav.tsx:119`、
 * `SummaryPanel.tsx:352` 都只塞 `ScrollArea`）。留着就得一直判一条产品走不到的分支，所以 2026-09-26
 * 收回来当成本文件的内部件：横向那一组类、`orientation` 那两道条件、外部 `className` 合并一起去掉。
 */
function ScrollBar() {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar className="flex touch-none select-none transition-colors h-full w-2.5 border-l border-l-transparent p-[1px]">
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea }
