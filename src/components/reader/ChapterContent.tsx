import { useEffect, useCallback, useRef, useMemo, useState } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { useSummaryStore } from "@/stores/summary-store";
import { useUIStore } from "@/stores/ui-store";
import { useRAGStore } from "@/stores/rag-store";
import { useKeyboardShortcuts, type ShortcutBinding } from "@/hooks/useKeyboardShortcuts";
import { usePagination, type PageRange } from "@/hooks/usePagination";
import { useContinuousScroll } from "@/hooks/useContinuousScroll";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Minus, Plus, Sparkles, ChevronLeft, ChevronRight, Type, Loader2 } from "lucide-react";
import { loadChapters } from "@/db/repositories";

interface ChapterContentProps {
  summaryOpen: boolean;
  onToggleSummary: () => void;
  hasSummary: boolean;
  immersive: boolean;
  onToggleImmersive: () => void;
}

const FONT_WEIGHTS = [
  { value: 300, label: "细" },
  { value: 400, label: "正常" },
  { value: 500, label: "中" },
  { value: 600, label: "粗" },
];

const SPINE_WIDTH = 2;
const PAGE_PADDING = 24;
const PAGE_PADDING_MOBILE = 12;
const MAX_SINGLE_WIDTH = 768;

type ReadingMode = "scroll" | "single" | "double";

export function ChapterContent({ summaryOpen, onToggleSummary, hasSummary, immersive, onToggleImmersive }: ChapterContentProps) {
  const { currentNovel, selectedChapterId, setSelectedChapter, addChapters } = useNovelStore();
  const { getSummariesByNovel } = useSummaryStore();
  const {
    fontSize, setFontSize, fontWeight, setFontWeight, lineHeight, setLineHeight,
    paragraphSpacing, setParagraphSpacing, fontFamily, setFontFamily,
    readingMode, setReadingMode, autoSwitchPageMode, setAutoSwitchPageMode,
  } = useUIStore();
  const indexLoadingKeys = useRAGStore((s) => s.indexLoadingKeys);

  const [showFontPanel, setShowFontPanel] = useState(false);
  const [loadingChapter, setLoadingChapter] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomNavRef = useRef<HTMLDivElement>(null);
  const touchRef = useRef<{ x: number; y: number } | null>(null);

  const chapters = currentNovel?.chapters || [];
  const currentIndex = chapters.findIndex((c) => c.id === selectedChapterId);
  const chapter = currentIndex >= 0 ? chapters[currentIndex] : undefined;
  const prevChapter = currentIndex > 0 ? chapters[currentIndex - 1] : null;
  const nextChapter = currentIndex < chapters.length - 1 ? chapters[currentIndex + 1] : null;

  // RAG 索引加载状态
  const isIndexLoading = useMemo(() => {
    if (!currentNovel) return false;
    const engine = useRAGStore.getState().engine;
    const preloadKey = `${currentNovel.id}-${engine}`;
    return indexLoadingKeys.has(preloadKey);
  }, [currentNovel?.id, indexLoadingKeys]);

  // 阅读模式计算
  const effectiveMode = useMemo<ReadingMode>(() => {
    if (readingMode === "scroll") return "scroll";
    if (windowWidth < 768) return "single";
    if (autoSwitchPageMode) return windowWidth >= 1024 ? "double" : "single";
    return readingMode;
  }, [readingMode, autoSwitchPageMode, windowWidth]);

  const isDouble = effectiveMode === "double";
  const isPaginated = effectiveMode !== "scroll";
  const isMobile = windowWidth < 768;

  // ── 连续滚动 hook（仅滚动模式） ───────────────────────────────
  const handleChapterChange = useCallback((chapterId: string) => {
    if (chapterId !== selectedChapterId) {
      setSelectedChapter(chapterId);
    }
  }, [selectedChapterId, setSelectedChapter]);

  const {
    containerRef: scrollContainerRef,
    loadedChapters,
    scrollToChapter,
    isLoadingMore,
  } = useContinuousScroll({
    novelId: currentNovel?.id || "",
    chapters,
    onChapterChange: handleChapterChange,
  });

  // ── 翻页模式相关 ──────────────────────────────────────────────
  const pageWidth = useMemo(() => {
    if (!isPaginated) return 0;
    if (isDouble) return Math.floor((containerSize.width - SPINE_WIDTH) / 2);
    return Math.min(containerSize.width, MAX_SINGLE_WIDTH);
  }, [isPaginated, isDouble, containerSize.width]);

  const activePadding = isMobile ? PAGE_PADDING_MOBILE : PAGE_PADDING;
  const contentWidth = Math.max(0, pageWidth - activePadding * 2);
  const contentHeight = Math.max(0, containerSize.height - activePadding * 2);
  const contentParagraphs = useMemo(() => chapter?.content.split("\n") || [], [chapter?.content]);

  const { pages, totalPages, measureRef } = usePagination({
    paragraphs: contentParagraphs,
    fontSize, lineHeight, fontWeight, fontFamily, paragraphSpacing,
    contentWidth, contentHeight,
    enabled: isPaginated,
  });

  const safePage = Math.min(currentPage, Math.max(0, totalPages - 1));
  const spreadIndex = Math.floor(safePage / 2);
  const totalSpreads = Math.ceil(totalPages / 2);

  // 窗口尺寸监听
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 翻页模式容器尺寸监听
  useEffect(() => {
    if (!isPaginated || !containerRef.current) return;
    const el = containerRef.current;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setContainerSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      }
    };
    const raf = requestAnimationFrame(measure);
    const obs = new ResizeObserver(() => measure());
    obs.observe(el);
    return () => { cancelAnimationFrame(raf); obs.disconnect(); };
  }, [isPaginated, chapter?.id]);

  // 翻页模式章节切换
  const goToChapter = useCallback(async (chapterId: string) => {
    if (!currentNovel) return;
    const targetChapter = chapters.find((c) => c.id === chapterId);
    if (targetChapter && targetChapter.content) {
      setSelectedChapter(chapterId);
      setCurrentPage(0);
    } else {
      const targetIndex = chapters.findIndex((c) => c.id === chapterId);
      if (targetIndex >= 0) {
        setLoadingChapter(chapterId);
        try {
          const start = Math.max(0, targetIndex - 10);
          const loaded = await loadChapters(currentNovel.id, start, 21);
          addChapters(loaded);
          setSelectedChapter(chapterId);
          setCurrentPage(0);
        } catch (err) {
          console.error("Failed to load chapters:", err);
        } finally {
          setLoadingChapter(null);
        }
      }
    }
  }, [currentNovel, chapters, setSelectedChapter, addChapters]);

  // 翻页导航
  const goNextPage = useCallback(() => {
    if (isDouble) {
      const nextFirst = (spreadIndex + 1) * 2;
      if (nextFirst < totalPages) setCurrentPage(nextFirst);
      else if (nextChapter) goToChapter(nextChapter.id);
    } else {
      if (safePage < totalPages - 1) setCurrentPage(safePage + 1);
      else if (nextChapter) goToChapter(nextChapter.id);
    }
  }, [isDouble, spreadIndex, totalPages, safePage, nextChapter, goToChapter]);

  const goPrevPage = useCallback(() => {
    if (isDouble) {
      if (spreadIndex > 0) setCurrentPage((spreadIndex - 1) * 2);
      else if (prevChapter) goToChapter(prevChapter.id);
    } else {
      if (safePage > 0) setCurrentPage(safePage - 1);
      else if (prevChapter) goToChapter(prevChapter.id);
    }
  }, [isDouble, spreadIndex, safePage, prevChapter, goToChapter]);

  // 键盘快捷键
  const goNextPageRef = useRef(goNextPage);
  const goPrevPageRef = useRef(goPrevPage);
  useEffect(() => { goNextPageRef.current = goNextPage; }, [goNextPage]);
  useEffect(() => { goPrevPageRef.current = goPrevPage; }, [goPrevPage]);

  // 滚动容器 ref（用于键盘滚动）
  const scrollContainerRefForKeys = scrollContainerRef;

  const readingShortcuts = useMemo<ShortcutBinding[]>(() => {
    if (!isPaginated) {
      return [
        { key: "ArrowLeft", action: () => {
          const el = scrollContainerRefForKeys.current;
          if (el) el.scrollBy({ top: -el.clientHeight * 0.8, behavior: "smooth" });
        }, description: "向上翻页" },
        { key: "ArrowRight", action: () => {
          const el = scrollContainerRefForKeys.current;
          if (el) el.scrollBy({ top: el.clientHeight * 0.8, behavior: "smooth" });
        }, description: "向下翻页" },
        { key: "+", action: () => setFontSize(Math.min(24, fontSize + 1)), description: "增大字号" },
        { key: "-", action: () => setFontSize(Math.max(12, fontSize - 1)), description: "减小字号" },
        { key: "i", action: onToggleImmersive, description: "切换沉浸模式" },
      ];
    }
    return [
      { key: "ArrowLeft", action: () => goPrevPageRef.current(), description: "上一页" },
      { key: "ArrowRight", action: () => goNextPageRef.current(), description: "下一页" },
      { key: " ", action: () => goNextPageRef.current(), description: "下一页" },
      { key: "+", action: () => setFontSize(Math.min(24, fontSize + 1)), description: "增大字号" },
      { key: "-", action: () => setFontSize(Math.max(12, fontSize - 1)), description: "减小字号" },
      { key: "i", action: onToggleImmersive, description: "切换沉浸模式" },
    ];
  }, [isPaginated, fontSize, setFontSize, onToggleImmersive, scrollContainerRefForKeys]);
  useKeyboardShortcuts(readingShortcuts);

  // 翻页模式触摸滑动
  const handleTouchStart = (e: React.TouchEvent) => {
    touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchRef.current) return;
    const dx = e.changedTouches[0].clientX - touchRef.current.x;
    const dy = e.changedTouches[0].clientY - touchRef.current.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      dx < 0 ? goNextPage() : goPrevPage();
    }
    touchRef.current = null;
  };

  // 翻页模式滚轮
  const lastWheelRef = useRef(0);
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!isPaginated) return;
    const now = Date.now();
    if (now - lastWheelRef.current < 300) return;
    if (Math.abs(e.deltaY) < 30) return;
    lastWheelRef.current = now;
    e.deltaY > 0 ? goNextPage() : goPrevPage();
  }, [isPaginated, goNextPage, goPrevPage]);

  // 翻页模式点击
  const handlePageClick = (e: React.MouseEvent) => {
    if (window.innerWidth >= 768) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    if (ratio < 1 / 3) goPrevPage();
    else if (ratio > 2 / 3) goNextPage();
    else onToggleImmersive();
  };

  const cycleFontWeight = () => {
    const idx = FONT_WEIGHTS.findIndex((w) => w.value === fontWeight);
    setFontWeight(FONT_WEIGHTS[(idx + 1) % FONT_WEIGHTS.length].value);
  };

  if (!chapter) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p>请从左侧选择一个章节</p>
      </div>
    );
  }

  const summaries = currentNovel
    ? getSummariesByNovel(currentNovel.id).filter((s) => s.chapterId === chapter.id)
    : [];
  const currentWeightLabel = FONT_WEIGHTS.find((w) => w.value === fontWeight)?.label || "正常";
  const textStyles: React.CSSProperties = { fontSize: `${fontSize}px`, lineHeight, fontWeight, fontFamily };

  const renderPage = (page: PageRange | undefined) => {
    if (!page || !contentParagraphs.length) return null;
    const items: React.ReactNode[] = [];
    const end = Math.min(page.endIndex, contentParagraphs.length - 1);
    for (let i = page.startIndex; i <= end; i++) {
      const para = contentParagraphs[i];
      if (!para) continue;
      const trimmed = para.trim();
      if (!trimmed) {
        items.push(<br key={i} />);
      } else {
        items.push(
          <p key={i} className="text-justify" style={{ marginBottom: `${paragraphSpacing}px` }}>
            {trimmed}
          </p>
        );
      }
    }
    return items;
  };

  const pageLabel = isDouble
    ? `${spreadIndex * 2 + 1}${spreadIndex * 2 + 2 < totalPages ? `-${spreadIndex * 2 + 2}` : ""}`
    : `${safePage + 1}`;

  // ========================================
  // 翻页模式渲染（完全保留原逻辑）
  // ========================================
  if (isPaginated) {
    const leftPage = isDouble ? pages[spreadIndex * 2] : pages[safePage];
    const rightPage = isDouble ? pages[spreadIndex * 2 + 1] : undefined;

    return (
      <div className="flex-1 flex flex-col h-full">
        <TopBar
          chapter={chapter} currentIndex={currentIndex} chapters={chapters}
          summaries={summaries} summaryOpen={summaryOpen} onToggleSummary={onToggleSummary}
          hasSummary={hasSummary}
          showFontPanel={showFontPanel} setShowFontPanel={setShowFontPanel}
          fontSize={fontSize} setFontSize={setFontSize}
          fontWeight={fontWeight} cycleFontWeight={cycleFontWeight} currentWeightLabel={currentWeightLabel}
          lineHeight={lineHeight} setLineHeight={setLineHeight}
          paragraphSpacing={paragraphSpacing} setParagraphSpacing={setParagraphSpacing}
          fontFamily={fontFamily} setFontFamily={setFontFamily}
          readingMode={readingMode} setReadingMode={setReadingMode}
          autoSwitchPageMode={autoSwitchPageMode} setAutoSwitchPageMode={setAutoSwitchPageMode}
          immersive={immersive}
          isIndexLoading={isIndexLoading}
        />

        <div
          ref={containerRef}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
          onClick={handlePageClick}
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div
            style={{
              position: "absolute", visibility: "hidden", pointerEvents: "none",
              padding: `${activePadding}px`, boxSizing: "border-box",
            }}
          >
            <div style={{ width: contentWidth || "100%", overflow: "hidden" }}>
              <div ref={measureRef} className="prose prose-neutral dark:prose-invert max-w-none" style={textStyles}>
                {contentParagraphs.map((p, i) => {
                  const trimmed = p.trim();
                  if (!trimmed) return <br key={i} />;
                  return (
                    <p key={i} className="text-justify" style={{ marginBottom: `${paragraphSpacing}px` }}>
                      {trimmed}
                    </p>
                  );
                })}
              </div>
            </div>
          </div>

          {isDouble ? (
            <div className="h-full flex justify-center">
              <div className="h-full flex" style={{ width: pageWidth * 2 + SPINE_WIDTH }}>
                <div className="overflow-hidden flex-1" style={{ padding: `${activePadding}px` }}>
                  <div className="prose prose-neutral dark:prose-invert max-w-none" style={textStyles}>
                    {totalPages > 0 ? renderPage(leftPage) : renderPage({ startIndex: 0, endIndex: contentParagraphs.length - 1 })}
                  </div>
                </div>
                <div className="w-px bg-border/30 shrink-0" />
                <div className="overflow-hidden flex-1" style={{ padding: `${activePadding}px` }}>
                  <div className="prose prose-neutral dark:prose-invert max-w-none" style={textStyles}>
                    {totalPages > 0 ? renderPage(rightPage) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-hidden" style={{ padding: `${activePadding}px` }}>
              <div className="mx-auto overflow-hidden" style={{ width: contentWidth || "100%", maxWidth: MAX_SINGLE_WIDTH }}>
                <div className="prose prose-neutral dark:prose-invert max-w-none" style={textStyles}>
                  {totalPages > 0 ? renderPage(leftPage) : renderPage({ startIndex: 0, endIndex: contentParagraphs.length - 1 })}
                </div>
              </div>
            </div>
          )}
        </div>

        {!immersive && (
          <BottomNav
            ref={bottomNavRef}
            immersive={immersive}
            prevLabel={safePage > 0 ? "上一页" : (prevChapter ? prevChapter.title : "已是第一章")}
            nextLabel={safePage < totalPages - 1 ? "下一页" : (nextChapter ? nextChapter.title : "已是最后一章")}
            onPrev={goPrevPage} onNext={goNextPage}
            prevDisabled={safePage === 0 && !prevChapter}
            nextDisabled={safePage >= totalPages - 1 && !nextChapter}
            loadingChapter={loadingChapter}
            pageLabel={`${pageLabel} / ${totalPages}`}
          />
        )}
      </div>
    );
  }

  // ========================================
  // 连续滚动模式渲染
  // ========================================
  return (
    <div className="flex-1 flex flex-col h-full">
      <TopBar
        chapter={chapter} currentIndex={currentIndex} chapters={chapters}
        summaries={summaries} summaryOpen={summaryOpen} onToggleSummary={onToggleSummary}
        hasSummary={hasSummary}
        showFontPanel={showFontPanel} setShowFontPanel={setShowFontPanel}
        fontSize={fontSize} setFontSize={setFontSize}
        fontWeight={fontWeight} cycleFontWeight={cycleFontWeight} currentWeightLabel={currentWeightLabel}
        lineHeight={lineHeight} setLineHeight={setLineHeight}
        paragraphSpacing={paragraphSpacing} setParagraphSpacing={setParagraphSpacing}
        fontFamily={fontFamily} setFontFamily={setFontFamily}
        readingMode={readingMode} setReadingMode={setReadingMode}
        immersive={immersive}
        autoSwitchPageMode={autoSwitchPageMode} setAutoSwitchPageMode={setAutoSwitchPageMode}
        isIndexLoading={isIndexLoading}
      />

      {/* 连续滚动容器 */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto scroll-smooth"
      >
        <div className="max-w-3xl mx-auto px-4 md:px-6 pb-24 md:pb-20">
          {loadedChapters.map((ch) => (
            <div
              key={ch.id}
              data-chapter-id={ch.id}
              className="chapter-section"
            >
              {/* 章节分割线 */}
              {ch.id !== loadedChapters[0]?.id && (
                <div className="chapter-divider">
                  <div className="h-px bg-border/50 my-6 md:my-8" />
                </div>
              )}

              {/* 章节标题 */}
              <div className="pt-4 md:pt-6 pb-2">
                <h2 className="text-lg md:text-xl font-semibold">{ch.title}</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  {ch.content.length.toLocaleString()} 字
                </p>
              </div>

              {/* 章节内容 */}
              <div className="prose prose-neutral dark:prose-invert max-w-none" style={textStyles}>
                {ch.content.split("\n").map((paragraph, i) => {
                  const trimmed = paragraph.trim();
                  if (!trimmed) return <br key={i} />;
                  return (
                    <p key={i} className="text-justify" style={{ marginBottom: `${paragraphSpacing}px` }}>
                      {trimmed}
                    </p>
                  );
                })}
              </div>
            </div>
          ))}

          {/* 加载更多提示 */}
          {isLoadingMore && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="text-sm">加载中...</span>
            </div>
          )}
        </div>
      </div>

      {/* 底部导航 */}
      {!immersive && (
        <BottomNav
          ref={bottomNavRef}
          immersive={immersive}
          prevLabel={prevChapter ? prevChapter.title : "已是第一章"}
          nextLabel={nextChapter ? nextChapter.title : "已是最后一章"}
          onPrev={() => {
            if (prevChapter) {
              scrollToChapter(prevChapter.id);
              setSelectedChapter(prevChapter.id);
            }
          }}
          onNext={() => {
            if (nextChapter) {
              scrollToChapter(nextChapter.id);
              setSelectedChapter(nextChapter.id);
            }
          }}
          prevDisabled={!prevChapter}
          nextDisabled={!nextChapter}
          loadingChapter={null}
          pageLabel={`${currentIndex + 1} / ${chapters.length}`}
        />
      )}
    </div>
  );
}

// ========================================
// 子组件
// ========================================

function TopBar(props: {
  chapter: { id: string; title: string; content: string };
  currentIndex: number;
  chapters: Array<{ id: string }>;
  summaries: Array<{ id: string; createdAt: string }>;
  summaryOpen: boolean;
  onToggleSummary: () => void;
  hasSummary: boolean;
  showFontPanel: boolean;
  setShowFontPanel: (v: boolean) => void;
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
}) {
  const {
    chapter, currentIndex, chapters, summaries, summaryOpen, onToggleSummary, hasSummary,
    showFontPanel, setShowFontPanel,
    fontSize, setFontSize, fontWeight, cycleFontWeight, currentWeightLabel,
    lineHeight, setLineHeight, paragraphSpacing, setParagraphSpacing,
    fontFamily, setFontFamily,
    readingMode, setReadingMode, autoSwitchPageMode, setAutoSwitchPageMode,
    immersive,
    isIndexLoading,
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

      {!isImmersive && (
        <div className="flex items-center gap-1 md:gap-2">
          {!summaryOpen && (
            <div className="flex items-center gap-1" title={hasSummary ? "已有章节总结" : "暂无章节总结"}>
              <Sparkles className={`h-3.5 w-3.5 ${hasSummary ? "text-primary" : "text-muted-foreground/40"}`} />
            </div>
          )}

          <div className="relative">
            <Button variant="ghost" size="icon" className="h-7 w-7"
              onClick={() => setShowFontPanel(!showFontPanel)} title="字体设置">
              <Type className="h-4 w-4" />
            </Button>
          {showFontPanel && (
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
          )}
        </div>
        {showFontPanel && <div className="fixed inset-0 z-10" onClick={() => setShowFontPanel(false)} />}
      </div>
      )}
    </div>
  );
}

function BottomNav(props: {
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
}) {
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
}
