import React from "react";
import { Button } from "@/components/ui/button";
import { Minus, Plus } from "lucide-react";

type ReadingMode = "scroll" | "single" | "double";

interface ReadingToolbarProps {
  fontSize: number;
  setFontSize: (v: number) => void;
  fontWeight: number;
  cycleFontWeight: () => void;
  currentWeightLabel: string;
  lineHeight: number;
  setLineHeight: (v: number) => void;
  paragraphSpacing: number;
  setParagraphSpacing: (v: number) => void;
  fontFamily: string;
  setFontFamily: (v: string) => void;
  readingMode: ReadingMode;
  setReadingMode: (m: ReadingMode) => void;
  autoSwitchPageMode: boolean;
  setAutoSwitchPageMode: (v: boolean) => void;
}

export const ReadingToolbar = React.memo(function ReadingToolbar(props: ReadingToolbarProps) {
  const {
    fontSize, setFontSize, cycleFontWeight, currentWeightLabel,
    lineHeight, setLineHeight, paragraphSpacing, setParagraphSpacing,
    fontFamily, setFontFamily,
    readingMode, setReadingMode, autoSwitchPageMode, setAutoSwitchPageMode,
  } = props;

  return (
    <div className="absolute right-0 top-full mt-1 p-3 rounded-lg border bg-card shadow-lg z-20 flex flex-col gap-2 min-w-[220px]"
      onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">阅读</span>
        <div className="flex gap-1">
          {(["scroll", "single", "double"] as const)
            .filter(m => m !== "double" || window.innerWidth >= 768)
            .map((m) => (
              <Button key={m} variant={readingMode === m ? "default" : "outline"}
                size="sm" className="h-6 text-[10px] px-1.5"
                onClick={() => setReadingMode(m)}>
                {m === "scroll" ? "滚动" : m === "single" ? "单页" : "双页"}
              </Button>
            ))}
        </div>
      </div>
      {readingMode !== "scroll" && window.innerWidth >= 768 && (
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={autoSwitchPageMode}
            onChange={(e) => setAutoSwitchPageMode(e.target.checked)}
            className="rounded border-input" />
          <span className="text-[10px] text-muted-foreground">大屏自动双页</span>
        </label>
      )}
      <div className="h-px bg-border" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">字号</span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:h-6 md:w-6" disabled={fontSize <= 12}
            onClick={() => setFontSize(Math.max(12, fontSize - 1))}><Minus className="h-3 w-3" /></Button>
          <span className="text-xs w-7 text-center tabular-nums">{fontSize}</span>
          <Button variant="outline" size="icon" className="h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:h-6 md:w-6" disabled={fontSize >= 24}
            onClick={() => setFontSize(Math.min(24, fontSize + 1))}><Plus className="h-3 w-3" /></Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">粗细</span>
        <Button variant="outline" size="sm" className="h-8 min-h-[44px] md:min-h-0 md:h-6 text-xs"
          onClick={cycleFontWeight}>{currentWeightLabel}</Button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">行距</span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:h-6 md:w-6" disabled={lineHeight <= 1.2}
            onClick={() => setLineHeight(lineHeight - 0.1)}><Minus className="h-3 w-3" /></Button>
          <span className="text-xs w-7 text-center tabular-nums">{lineHeight.toFixed(1)}</span>
          <Button variant="outline" size="icon" className="h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:h-6 md:w-6" disabled={lineHeight >= 2.4}
            onClick={() => setLineHeight(lineHeight + 0.1)}><Plus className="h-3 w-3" /></Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">段距</span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:h-6 md:w-6" disabled={paragraphSpacing <= 0}
            onClick={() => setParagraphSpacing(paragraphSpacing - 2)}><Minus className="h-3 w-3" /></Button>
          <span className="text-xs w-7 text-center tabular-nums">{paragraphSpacing}</span>
          <Button variant="outline" size="icon" className="h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:h-6 md:w-6" disabled={paragraphSpacing >= 20}
            onClick={() => setParagraphSpacing(paragraphSpacing + 2)}><Plus className="h-3 w-3" /></Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">字体</span>
        <div className="flex gap-1">
          {[
            { key: "system-ui", label: "默认" },
            { key: "SimSun, serif", label: "宋体" },
            { key: "KaiTi, serif", label: "楷体" },
            { key: "monospace", label: "等宽" },
          ].map((f) => (
            <Button key={f.key} variant={fontFamily === f.key ? "default" : "outline"}
              size="sm" className="h-6 text-[10px] px-1.5"
              onClick={() => setFontFamily(f.key)}>{f.label}</Button>
          ))}
        </div>
      </div>
    </div>
  );
});
