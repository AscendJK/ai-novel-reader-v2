import { useEffect, useLayoutEffect, useCallback, useRef, useMemo, useState } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { useSummaryStore } from "@/stores/summary-store";
import { useUIStore } from "@/stores/ui-store";
import { useRAGStore } from "@/stores/rag-store";
import { useKeyboardShortcuts, type ShortcutBinding } from "@/hooks/useKeyboardShortcuts";
import { usePagination, type PageRange } from "@/hooks/usePagination";
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
const PAGE_PADDING = 24; // p-6
const PAGE_PADDING_MOBILE = 12; // 移动端更小的内边距
const MAX_SINGLE_WIDTH = 768; // max-w-3xl

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

  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomNavRef = useRef<HTMLDivElement>(null);
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const isLoadingChapterRef = useRef(false);
  const scrollDirectionRef = useRef<"top" | "bottom">("top");
  const isTransitioningRef = useRef(false); // 章节切换过渡中标记

  const chapters = currentNovel?.chapters || [];
  const currentIndex = chapters.findIndex((c) => c.id === selectedChapterId);
  const chapter = currentIndex >= 0 ? chapters[currentIndex] : undefined;
  const prevChapter = currentIndex > 0 ? chapters[currentIndex - 1] : null;
  const nextChapter = currentIndex < chapters.length - 1 ? chapters[currentIndex + 1] : null;

  // 判断 RAG 索引是否正在加载
  const isIndexLoading = useMemo(() => {
    if (!currentNovel) return false;
    const engine = useRAGStore.getState().engine;
    const preloadKey = `${currentNovel.id}-${engine}`;
    return indexLoadingKeys.has(preloadKey);
  }, [currentNovel?.id, indexLoadingKeys]);

  // 计算生效的阅读模式（移动端强制单页）
  const effectiveMode = useMemo<ReadingMode>(() => {
    if (readingMode === "scroll") return "scroll";
    if (windowWidth < 768) return "single"; // 移动端强制单页
    if (autoSwitchPageMode) return windowWidth >= 1024 ? "double" : "single";
    return readingMode;
  }, [readingMode, autoSwitchPageMode, windowWidth]);

  const isDouble = effectiveMode === "double";
  const isPaginated = effectiveMode !== "scroll";
  const isMobile = windowWidth < 768;

  // 页面尺寸
  const pageWidth = useMemo(() => {
    if (!isPaginated) return 0;
    if (isDouble) return Math.floor((containerSize.width - SPINE_WIDTH) / 2);
    return Math.min(containerSize.width, MAX_SINGLE_WIDTH);
  }, [isPaginated, isDouble, containerSize.width]);

  const activePadding = isMobile ? PAGE_PADDING_MOBILE : PAGE_PADDING;
  const contentWidth = Math.max(0, pageWidth - activePadding * 2);
  const contentHeight = Math.max(0, containerSize.height - activePadding * 2);

  // 段落数组
  const contentParagraphs = useMemo(() => chapter?.content.split("\n") || [], [chapter?.content]);

  // 分页
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

  // 容器尺寸监听
  useEffect(() => {
    if (!isPaginated || !containerRef.current) return;
    const el = containerRef.current;

    // 测量容器尺寸
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setContainerSize({
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
        });
      }
    };

    // 延迟测量确保 DOM 已渲染
    const raf = requestAnimationFrame(measure);

    const obs = new ResizeObserver(() => measure());
    obs.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, [isPaginated, chapter?.id]);

  // 切换章节时重置页码和滚动位置
  useLayoutEffect(() => {
    setCurrentPage(0);
    if (isPaginated) return; // 翻页模式不滚动
    if (!scrollRef.current) return;
    const viewport = scrollRef.current.querySelector("[data-radix-scroll-area-viewport]");
    if (!viewport) return;

    // 标记正在过渡，阻止滚动事件触发章节切换
    isTransitioningRef.current = true;

    const direction = scrollDirectionRef.current;
    scrollDirectionRef.current = "top";

    // 立即尝试设置滚动位置
    if (direction === "bottom") {
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      viewport.scrollTop = 0;
    }

    // 多次重试确保内容渲染完成后滚动位置正确
    let retryCount = 0;
    const maxRetries = 5;
    let lastScrollHeight = viewport.scrollHeight;

    const retry = () => {
      if (retryCount >= maxRetries) {
        isTransitioningRef.current = false;
        return;
      }
      retryCount++;
      requestAnimationFrame(() => {
        if (!viewport) return;
        const newScrollHeight = viewport.scrollHeight;
        // scrollHeight 还在变化，说明内容还在渲染，继续重试
        if (newScrollHeight !== lastScrollHeight || retryCount <= 2) {
          lastScrollHeight = newScrollHeight;
          if (direction === "bottom") {
            viewport.scrollTop = viewport.scrollHeight;
          } else {
            viewport.scrollTop = 0;
          }
        }
        // 最后一次重试后解锁
        if (retryCount >= maxRetries) {
          isTransitioningRef.current = false;
        } else {
          retry();
        }
      });
    };
    retry();
  }, [chapter?.id, isPaginated]);

  // 章节切换（含懒加载）
  const goToChapter = useCallback(
    async (chapterId: string) => {
      if (!currentNovel) return;
      const targetChapter = chapters.find((c) => c.id === chapterId);
      if (targetChapter && targetChapter.content) {
        setSelectedChapter(chapterId);
      } else {
        const targetIndex = chapters.findIndex((c) => c.id === chapterId);
        if (targetIndex >= 0) {
          setLoadingChapter(chapterId);
          try {
            const start = Math.max(0, targetIndex - 10);
            const loaded = await loadChapters(currentNovel.id, start, 21);
            addChapters(loaded);
            setSelectedChapter(chapterId);
          } catch (err) {
            console.error("Failed to load chapters:", err);
          } finally {
            setLoadingChapter(null);
          }
        }
      }
    },
    [currentNovel, chapters, setSelectedChapter, addChapters]
  );

  // 用 ref 保持 goToChapter 引用稳定，避免 scroll 监听器频繁重建
  const goToChapterRef = useRef(goToChapter);
  goToChapterRef.current = goToChapter;
  const nextChapterRef = useRef(nextChapter);
  nextChapterRef.current = nextChapter;
  const prevChapterRef = useRef(prevChapter);
  prevChapterRef.current = prevChapter;

  // 无限滚动：自动切换章节（用 ref 读取最新值，函数引用始终稳定）
  const autoLoadNextChapter = useCallback(async () => {
    const nc = nextChapterRef.current;
    if (isLoadingChapterRef.current || !nc) return;
    isLoadingChapterRef.current = true;
    scrollDirectionRef.current = "top";
    try {
      await goToChapterRef.current(nc.id);
    } finally {
      isLoadingChapterRef.current = false;
    }
  }, []); // 空依赖，引用始终稳定

  const autoLoadPrevChapter = useCallback(async () => {
    const pc = prevChapterRef.current;
    if (isLoadingChapterRef.current || !pc) return;
    isLoadingChapterRef.current = true;
    scrollDirectionRef.current = "bottom";
    try {
      await goToChapterRef.current(pc.id);
    } finally {
      isLoadingChapterRef.current = false;
    }
  }, []); // 空依赖，引用始终稳定

  // 无限滚动：监听滚动事件（带节流）
  // 只依赖 isPaginated 和 chapter?.id，autoLoad* 通过 ref 读取最新值
  useEffect(() => {
    if (isPaginated || !scrollRef.current) return;
    const viewport = scrollRef.current.querySelector("[data-radix-scroll-area-viewport]");
    if (!viewport) return;

    let lastTriggerTime = 0;
    let rafId: number | null = null;
    const DEBOUNCE = 300; // 防抖间隔

    const handleScroll = () => {
      if (rafId) return; // 节流：每帧最多执行一次
      rafId = requestAnimationFrame(() => {
        rafId = null;
        // 过渡中不触发章节切换
        if (isTransitioningRef.current) return;
        const now = Date.now();
        if (now - lastTriggerTime < DEBOUNCE) return;
        const { scrollTop, scrollHeight, clientHeight } = viewport;
        // 滚动到底部（距离 < 100px）→ 加载下一章
        if (scrollHeight - scrollTop - clientHeight < 100) {
          lastTriggerTime = now;
          autoLoadNextChapter();
        }
        // 滚动到顶部（距离 < 30px）→ 加载上一章
        else if (scrollTop < 30) {
          lastTriggerTime = now;
          autoLoadPrevChapter();
        }
      });
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [isPaginated, chapter?.id]);

  // 翻页导航
  const goNextPage = useCallback(() => {
    if (isDouble) {
      const nextFirst = (spreadIndex + 1) * 2;
      if (nextFirst < totalPages) setCurrentPage(nextFirst);
      else if (nextChapter) { goToChapter(nextChapter.id); }
    } else {
      if (safePage < totalPages - 1) setCurrentPage(safePage + 1);
      else if (nextChapter) { goToChapter(nextChapter.id); }
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

  // 键盘快捷键（使用 ref 保持回调引用稳定，避免频繁重建监听器）
  const goNextPageRef = useRef(goNextPage);
  const goPrevPageRef = useRef(goPrevPage);
  useEffect(() => { goNextPageRef.current = goNextPage; }, [goNextPage]);
  useEffect(() => { goPrevPageRef.current = goPrevPage; }, [goPrevPage]);

  const readingShortcuts = useMemo<ShortcutBinding[]>(() => {
    if (!isPaginated) {
      return [
        { key: "ArrowLeft", action: () => prevChapter && goToChapter(prevChapter.id), description: "上一章", when: () => !!prevChapter },
        { key: "ArrowRight", action: () => nextChapter && goToChapter(nextChapter.id), description: "下一章", when: () => !!nextChapter },
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
  }, [isPaginated, prevChapter, nextChapter, goToChapter, fontSize, setFontSize, onToggleImmersive]);
  useKeyboardShortcuts(readingShortcuts);

  // 触摸滑动（增加垂直方向容差，避免滚动时误触发翻页）
  const handleTouchStart = (e: React.TouchEvent) => {
    touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchRef.current) return;
    const dx = e.changedTouches[0].clientX - touchRef.current.x;
    const dy = e.changedTouches[0].clientY - touchRef.current.y;
    // 水平滑动距离 > 50px 且水平位移明显大于垂直位移（1.5倍容差）
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      dx < 0 ? goNextPage() : goPrevPage();
    }
    touchRef.current = null;
  };

  // 滚轮翻页（防抖）
  const lastWheelRef = useRef(0);
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!isPaginated) return;
    const now = Date.now();
    if (now - lastWheelRef.current < 300) return; // 300ms 防抖
    if (Math.abs(e.deltaY) < 30) return; // 忽略微小滚动
    lastWheelRef.current = now;
    e.deltaY > 0 ? goNextPage() : goPrevPage();
  }, [isPaginated, goNextPage, goPrevPage]);

  // 点击翻页
  const handlePageClick = (e: React.MouseEvent) => {
    if (window.innerWidth >= 768) return; // 电脑端不响应点击翻页
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    if (ratio < 1 / 3) goPrevPage();
    else if (ratio > 2 / 3) goNextPage();
    else onToggleImmersive();
  };

  // 粗细切换
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

  // 渲染页面段落
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

  // 页码显示
  const pageLabel = isDouble
    ? `${spreadIndex * 2 + 1}${spreadIndex * 2 + 2 < totalPages ? `-${spreadIndex * 2 + 2}` : ""}`
    : `${safePage + 1}`;

  // ========================================
  // 翻页模式渲染
  // ========================================
  if (isPaginated) {
    const leftPage = isDouble ? pages[spreadIndex * 2] : pages[safePage];
    const rightPage = isDouble ? pages[spreadIndex * 2 + 1] : undefined;

    return (
      <div className="flex-1 flex flex-col h-full">
        {/* 顶部栏 */}
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

        {/* 内容区 */}
        <div
          ref={containerRef}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
          onClick={handlePageClick}
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {/* 测量容器 - 样式必须与渲染容器完全一致 */}
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

          {/* 页面内容 */}
          {isDouble ? (
            // 双页模式
            <div className="h-full flex justify-center">
              <div className="h-full flex" style={{ width: pageWidth * 2 + SPINE_WIDTH }}>
                <div className="overflow-hidden flex-1" style={{ padding: `${activePadding}px` }}>
                  <div className="prose prose-neutral dark:prose-invert max-w-none chapter-fade-in" style={textStyles} key={`${chapter.id}-${safePage}`}>
                    {totalPages > 0 ? renderPage(leftPage) : renderPage({ startIndex: 0, endIndex: contentParagraphs.length - 1 })}
                  </div>
                </div>
                <div className="w-px bg-border/30 shrink-0" />
                <div className="overflow-hidden flex-1" style={{ padding: `${activePadding}px` }}>
                  <div className="prose prose-neutral dark:prose-invert max-w-none chapter-fade-in" style={textStyles} key={`${chapter.id}-${safePage}-r`}>
                    {totalPages > 0 ? renderPage(rightPage) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            // 单页模式
            <div className="flex-1 min-h-0 overflow-hidden" style={{ padding: `${activePadding}px` }}>
              <div className="mx-auto overflow-hidden" style={{ width: contentWidth || "100%", maxWidth: MAX_SINGLE_WIDTH }}>
                <div className="prose prose-neutral dark:prose-invert max-w-none chapter-fade-in" style={textStyles} key={`${chapter.id}-${safePage}`}>
                  {totalPages > 0 ? renderPage(leftPage) : renderPage({ startIndex: 0, endIndex: contentParagraphs.length - 1 })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 底部导航 - 移动端沉浸模式下隐藏 */}
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
  // 滚动模式渲染（原始逻辑）
  // ========================================
  return (
    <div className="flex-1 flex flex-col h-full">
      {/* 顶部栏 */}
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

      {/* 内容区（滚动模式下移动端不响应点击切换沉浸，避免滚动误触） */}
      <div className="flex-1 flex flex-col min-h-0">
        <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
          <div className="p-6 max-w-3xl mx-auto pb-24 md:pb-20 chapter-fade-in" key={chapter.id}>
            {summaries.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {summaries.map((s) => (
                  <Badge key={s.id} variant="secondary" className="text-xs">
                    <Sparkles className="h-3 w-3 mr-1" />
                    已总结 · {new Date(s.createdAt).toLocaleString("zh-CN")}
                  </Badge>
                ))}
              </div>
            )}
            <div className="prose prose-neutral dark:prose-invert max-w-none" style={textStyles}>
              {chapter.content.split("\n").map((paragraph, i) => {
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
        </ScrollArea>

        {/* 底部导航 - 移动端沉浸模式下隐藏 */}
        {!immersive && (
          <BottomNav
            immersive={immersive}
            prevLabel={prevChapter ? prevChapter.title : "已是第一章"}
            nextLabel={nextChapter ? nextChapter.title : "已是最后一章"}
            onPrev={() => prevChapter && goToChapter(prevChapter.id)}
            onNext={() => nextChapter && goToChapter(nextChapter.id)}
            prevDisabled={!prevChapter || loadingChapter !== null}
            nextDisabled={!nextChapter || loadingChapter !== null}
            loadingChapter={loadingChapter}
            pageLabel={`${currentIndex + 1} / ${chapters.length}`}
          />
        )}
      </div>
    </div>
  );
}

// ========================================
// 子组件
// ========================================

/** 顶部栏 */
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

  // 沉浸模式下只显示标题
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

          {/* 字体设置 */}
          <div className="relative">
            <Button variant="ghost" size="icon" className="h-7 w-7"
              onClick={() => setShowFontPanel(!showFontPanel)} title="字体设置">
              <Type className="h-4 w-4" />
            </Button>
          {showFontPanel && (
            <div className="absolute right-0 top-full mt-1 p-3 rounded-lg border bg-card shadow-lg z-20 flex flex-col gap-2 min-w-[220px]"
              onClick={(e) => e.stopPropagation()}>
              {/* 阅读模式 */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">阅读</span>
                <div className="flex gap-1">
                  {(["scroll", "single", "double"] as const)
                    .filter(m => m !== "double" || window.innerWidth >= 768) // 移动端隐藏双页选项
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
              {/* 字号 */}
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
              {/* 粗细 */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">粗细</span>
                <Button variant="outline" size="sm" className="h-8 min-h-[44px] md:min-h-0 md:h-6 text-xs"
                  onClick={cycleFontWeight}>{currentWeightLabel}</Button>
              </div>
              {/* 行距 */}
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
              {/* 段距 */}
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
              {/* 字体 */}
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

/** 底部导航 */
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
