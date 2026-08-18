/**
 * ReadingChrome — 阅读器的纯展示「外观层」组件。
 *
 * 从 ChapterContent.tsx 中提取的展示性子组件：TopBar / BottomNav /
 * ChapterParagraphs / TTSStartButton。它们不捕获父组件闭包变量，
 * 只通过 props + Zustand store 取数，因此可独立成文件以缩小主文件体积。
 */

import React, { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useTTSStore } from "@/stores/tts-store";
import {
  Sparkles, ChevronLeft, ChevronRight, Type, Loader2, Maximize2, Minimize2, Play,
} from "lucide-react";
import { ReadingToolbar } from "./ReadingToolbar";

export type ReadingMode = "scroll" | "single" | "double";

/** 顶栏"朗读"按钮：点击显示播放栏并开始 TTS 朗读 */
function TTSStartButton() {
  const playing = useTTSStore((s) => s.playing);
  const paused = useTTSStore((s) => s.paused);
  const generating = useTTSStore((s) => s.generating);
  const requestStart = useTTSStore((s) => s.requestStart);
  const isTTSActive = playing || paused || generating;

  if (isTTSActive) return null; // 播放中隐藏，避免重复点击

  return (
    <Button variant="ghost" size="icon"
      className="h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:h-7 md:w-7"
      onClick={requestStart} title="语音朗读">
      <Play className="h-4 w-4" />
    </Button>
  );
}

export interface TopBarProps {
  chapter: { id: string; title: string; content: string };
  currentIndex: number;
  chapters: Array<{ id: string }>;
  summaries: Array<{ id: string; createdAt: number }>;
  summaryOpen: boolean;
  onToggleSummary: () => void;
  hasSummary: boolean;
  showFontPanel: boolean;
  setShowFontPanel: (v: boolean) => void;
  onToggleImmersive?: () => void;
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
  immersive?: boolean;
  isIndexLoading?: boolean;
  windowWidth?: number;
}

const TopBar = React.memo(function TopBar(props: TopBarProps) {
  const {
    chapter, currentIndex, chapters, summaryOpen, hasSummary,
    showFontPanel, setShowFontPanel, onToggleImmersive,
    fontSize, setFontSize, fontWeight, cycleFontWeight, currentWeightLabel,
    lineHeight, setLineHeight, paragraphSpacing, setParagraphSpacing,
    fontFamily, setFontFamily,
    readingMode, setReadingMode, autoSwitchPageMode, setAutoSwitchPageMode,
    immersive,
    isIndexLoading,
    windowWidth,
  } = props;

  const isImmersive = immersive || false;

  return (
    <div className={`p-3 md:p-4 border-b flex items-center justify-between shrink-0 ${isImmersive ? "py-2" : ""}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className={`font-semibold truncate ${isImmersive ? "text-sm" : "text-base md:text-xl"}`}>{chapter.title}</h2>
          {isIndexLoading && (
            <span className="flex items-center gap-1 text-blue-500 shrink-0">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs font-medium">加载中</span>
            </span>
          )}
        </div>
        {!isImmersive && (
          <p className="text-xs md:text-sm text-muted-foreground mt-0.5 md:mt-1">
            {chapter.content.length.toLocaleString()} 字
            <span className="mx-1 md:mx-2 text-border">|</span>
            {currentIndex + 1} / {chapters.length}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1 md:gap-2">
        {!isImmersive && !summaryOpen && (
          <div className="flex items-center gap-1" title={hasSummary ? "已有章节总结" : "暂无章节总结"}>
            <Sparkles className={`h-3.5 w-3.5 ${hasSummary ? "text-primary" : "text-muted-foreground/40"}`} />
          </div>
        )}

        {/* 朗读按钮 — 点击显示播放栏并开始朗读 */}
        <TTSStartButton />
        {/* 沉浸模式按钮 - 始终可见 */}
        {onToggleImmersive && (
          <Button variant="ghost" size="icon" className="h-7 w-7"
            onClick={onToggleImmersive} title={isImmersive ? "退出沉浸模式" : "沉浸模式"}>
            {isImmersive ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        )}

        {!isImmersive && (
          <>
            <div className="relative">
              <Button variant="ghost" size="icon" className="h-7 w-7"
                onClick={() => setShowFontPanel(!showFontPanel)} title="字体设置">
                <Type className="h-4 w-4" />
              </Button>
            {showFontPanel && (
              <ReadingToolbar
                fontSize={fontSize} setFontSize={setFontSize}
                fontWeight={fontWeight} cycleFontWeight={cycleFontWeight} currentWeightLabel={currentWeightLabel}
                lineHeight={lineHeight} setLineHeight={setLineHeight}
                paragraphSpacing={paragraphSpacing} setParagraphSpacing={setParagraphSpacing}
                fontFamily={fontFamily} setFontFamily={setFontFamily}
                readingMode={readingMode} setReadingMode={setReadingMode}
                autoSwitchPageMode={autoSwitchPageMode} setAutoSwitchPageMode={setAutoSwitchPageMode}
                windowWidth={windowWidth ?? 1024}
              />
            )}
            </div>
            {showFontPanel && <div className="fixed inset-0 z-10" onClick={() => setShowFontPanel(false)} />}
          </>
        )}
      </div>
    </div>
  );
});

export interface BottomNavProps {
  immersive: boolean;
  prevLabel: string;
  nextLabel: string;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
  loadingChapter: string | null;
  pageLabel: string;
  ref?: React.RefObject<HTMLDivElement | null>;
}

const BottomNav = React.memo(function BottomNav(props: BottomNavProps) {
  const { immersive, prevLabel, nextLabel, onPrev, onNext, prevDisabled, nextDisabled, loadingChapter, pageLabel, ref } = props;

  return (
    <div
      ref={ref}
      className={`border-t bg-card px-4 py-2.5 relative flex items-center justify-between shrink-0 safe-area-bottom ${immersive ? "pb-2.5" : "md:pb-2.5 pb-16"}`}
      onClick={(e) => e.stopPropagation()}
    >
      <Button variant="outline" size="sm" disabled={prevDisabled || loadingChapter !== null}
        onClick={onPrev} className="max-w-[40%] z-10">
        {loadingChapter !== null && prevDisabled ? (
          <Loader2 className="h-4 w-4 mr-1 shrink-0 animate-spin" />
        ) : (
          <ChevronLeft className="h-4 w-4 mr-1 shrink-0" />
        )}
        <span className="truncate text-xs">{prevLabel}</span>
      </Button>

      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="text-xs text-muted-foreground select-none whitespace-nowrap">{pageLabel}</span>
      </div>

      <Button variant="outline" size="sm" disabled={nextDisabled || loadingChapter !== null}
        onClick={onNext} className="max-w-[40%] z-10">
        <span className="truncate text-xs">{nextLabel}</span>
        {loadingChapter !== null && nextDisabled ? (
          <Loader2 className="h-4 w-4 ml-1 shrink-0 animate-spin" />
        ) : (
          <ChevronRight className="h-4 w-4 ml-1 shrink-0" />
        )}
      </Button>
    </div>
  );
});

/** Memoized chapter paragraphs - avoids re-splitting content on every render */
const ChapterParagraphs = React.memo(function ChapterParagraphs({
  content, paragraphSpacing, ttsActive, ttsParagraph, chapterId, selectedChapterId,
}: {
  content: string;
  paragraphSpacing: number;
  ttsActive: boolean;
  ttsParagraph: number;
  chapterId: string;
  selectedChapterId: string | null;
}) {
  const paragraphs = useMemo(() => content.split(/\n+/), [content]);
  return (
    <>
      {paragraphs.map((paragraph, i) => {
        const trimmed = paragraph.trim();
        if (!trimmed) return <br key={i} />;
        const isHighlighted = ttsActive && chapterId === selectedChapterId && ttsParagraph === i;
        return (
          <p key={i} data-tts-paragraph={i} className={`text-justify ${isHighlighted ? "bg-primary/10 border-l-2 border-primary pl-3 rounded-r" : ""}`} style={{ marginBottom: `${paragraphSpacing}px` }}>
            {trimmed}
          </p>
        );
      })}
    </>
  );
});

export { TopBar, BottomNav, ChapterParagraphs };