import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { cn } from "@/lib/utils"

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => {
  // Radix 只认 `typeof value === "number"`，而 NaN 恰好是 number——先归一再交给 Root，
  // 否则 `ChapterTab.tsx:160` 那种 (current/total)*100 在排队的一拍（0÷0）会把
  // aria-valuenow="NaN" 发给读屏。不是有限数就当"还不知道"：属性缺席、条子空着。
  const shown = Number.isFinite(value) ? value : undefined
  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={shown}
      className={cn("relative h-4 w-full overflow-hidden rounded-full bg-secondary", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="h-full w-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - (shown || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
})
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
