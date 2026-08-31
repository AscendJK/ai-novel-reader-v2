import React, { useEffect, useCallback, useRef, useMemo, useState, startTransition } from "react";
import { useNovelStore } from "@/stores/novel-store";
import { useSummaryStore } from "@/stores/summary-store";
import { useUIStore } from "@/stores/ui-store";
import { useRAGStore } from "@/stores/rag-store";
import { useTTSStore } from "@/stores/tts-store";
import { useKeyboardShortcuts, type ShortcutBinding } from "@/hooks/useKeyboardShortcuts";
import { usePagination, type PageRange } from "@/hooks/usePagination";
import { useContinuousScroll } from "@/hooks/useContinuousScroll";
import { useAutoRead } from "@/hooks/useAutoRead";
import { AudioPlayer } from "@/components/tts/AudioPlayer";
import type { ScrollControl } from "./ReadingPanel";
import { TopBar, BottomNav, ChapterParagraphs, type ReadingMode } from "./ReadingChrome";
import { Loader2 } from "lucide-react";
import { loadChapters } from "@/db/repositories";
import { userKey } from "@/lib/user-utils";
import { showToast } from "@/lib/toast-store";

interface ChapterContentProps {
  summaryOpen: boolean;
  onToggleSummary: () => void;
  hasSummary: boolean;
  immersive: boolean;
  onToggleImmersive: () => void;
  scrollControlRef?: React.RefObject<{ scrollToChapter: (chapterId: string, chapterOffset?: number) => void; suppressIO: (targetChapterId?: string) => () => void } | null>;
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

export function ChapterContent({ summaryOpen, onToggleSummary, hasSummary, immersive, onToggleImmersive, scrollControlRef }: ChapterContentProps) {
  const currentNovel = useNovelStore((s) => s.currentNovel);
  const selectedChapterId = useNovelStore((s) => s.selectedChapterId);
  const setSelectedChapter = useNovelStore((s) => s.setSelectedChapter);
  const addChapters = useNovelStore((s) => s.addChapters);
  const saveScrollTop = useNovelStore((s) => s.saveScrollTop);
  const { getSummariesByNovel } = useSummaryStore();
  const fontSize = useUIStore((s) => s.fontSize);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const fontWeight = useUIStore((s) => s.fontWeight);
  const setFontWeight = useUIStore((s) => s.setFontWeight);
  const lineHeight = useUIStore((s) => s.lineHeight);
  const setLineHeight = useUIStore((s) => s.setLineHeight);
  const paragraphSpacing = useUIStore((s) => s.paragraphSpacing);
  const setParagraphSpacing = useUIStore((s) => s.setParagraphSpacing);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const setFontFamily = useUIStore((s) => s.setFontFamily);
  const readingMode = useUIStore((s) => s.readingMode);
  const setReadingMode = useUIStore((s) => s.setReadingMode);
  const autoSwitchPageMode = useUIStore((s) => s.autoSwitchPageMode);
  const setAutoSwitchPageMode = useUIStore((s) => s.setAutoSwitchPageMode);
  // ── 自动阅读状态（开关不持久化，间隔/滑动窗口持久化）──
  const autoReadEnabled = useUIStore((s) => s.autoReadEnabled);
  const autoReadInterval = useUIStore((s) => s.autoReadInterval);
  const autoReadScrollStep = useUIStore((s) => s.autoReadScrollStep);
  const setAutoReadEnabled = useUIStore((s) => s.setAutoReadEnabled);
  const setAutoReadInterval = useUIStore((s) => s.setAutoReadInterval);
  const setAutoReadScrollStep = useUIStore((s) => s.setAutoReadScrollStep);
  const indexLoadingKeys = useRAGStore((s) => s.indexLoadingKeys);

  const [showFontPanel, setShowFontPanel] = useState(false);
  const [loadingChapter, setLoadingChapter] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);

  const containerRef = useRef<HTMLDivElement>(null);
  const bottomNavRef = useRef<HTMLDivElement>(null);
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef(0); // 双击检测

  const chapters = useMemo(() => currentNovel?.chapters || [], [currentNovel?.chapters]);
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
  }, [currentNovel?.id, indexLoadingKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  // 阅读模式计算
  const effectiveMode = useMemo<ReadingMode>(() => {
    if (readingMode === "scroll") return "scroll";
    if (windowWidth < 768) return "single";
    if (autoSwitchPageMode) {
      // 右栏 AI 分析面板展开时会压缩阅读区，双页模式需要更宽的可用区域
      // 目录 224px(或收起 32px) + 右栏 320px + 折叠按钮 32px + 留白；估算预留 ~360px
      return windowWidth >= (summaryOpen ? 1400 : 1024) ? "double" : "single";
    }
    return readingMode;
  }, [readingMode, autoSwitchPageMode, windowWidth, summaryOpen]);

  const isDouble = effectiveMode === "double";
  const isPaginated = effectiveMode !== "scroll";
  const isMobile = windowWidth < 768;

  // ── 连续滚动 hook（仅滚动模式启用） ───────────────────────────
  const selectedChapterRef = useRef(selectedChapterId);
  useEffect(() => { selectedChapterRef.current = selectedChapterId; }, [selectedChapterId]);

  const handleChapterChange = useCallback((chapterId: string) => {
    if (chapterId !== selectedChapterRef.current) {
      setSelectedChapter(chapterId);
    }
  }, [setSelectedChapter]);

  // 获取保存的章节偏移量（用于恢复，只在挂载时读取一次）
  const savedChapterOffset = useMemo(() => {
    if (!currentNovel) return undefined;
    const pos = useNovelStore.getState().readingPositions[currentNovel.id];
    return pos?.chapterOffset;
  }, [currentNovel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const {
    containerRef: scrollContainerRef,
    topSentinelRef,
    bottomSentinelRef,
    loadedChapters,
    scrollToChapter,
    isLoadingMore,
    suppressIO,
  } = useContinuousScroll({
    novelId: currentNovel?.id || "",
    chapters,
    onChapterChange: handleChapterChange,
    enabled: !isPaginated,
    initialChapterId: selectedChapterId,
    initialChapterOffset: savedChapterOffset,
  });

  // 暴露 scrollToChapter 和 suppressIO 给 ChapterNav（effect 中更新，供事件处理器读取）
  useEffect(() => {
    const control: ScrollControl = { scrollToChapter, suppressIO };
    const ref = scrollControlRef as React.MutableRefObject<ScrollControl | null> | undefined;
    if (ref) {
      ref.current = control;
    }
  }, [scrollControlRef, scrollToChapter, suppressIO]);

  // ── 滚动位置保存（节流 + 页面退出时立即保存）──────────────────
  const saveScrollTopRef = useRef(saveScrollTop);
  useEffect(() => { saveScrollTopRef.current = saveScrollTop; }, [saveScrollTop]);
  const scrollToChapterRef = useRef(scrollToChapter);
  useEffect(() => { scrollToChapterRef.current = scrollToChapter; }, [scrollToChapter]);
  const suppressIORef = useRef(suppressIO);
  useEffect(() => { suppressIORef.current = suppressIO; }, [suppressIO]);
  const visibilityTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 缓存当前章节元素，避免每次滚动都遍历所有章节
  const cachedChapterElRef = useRef<HTMLElement | null>(null);

  // 计算当前章节内偏移量（相对于章节元素顶部的像素偏移）
  const calcChapterOffset = useCallback((): { scrollTop: number; chapterOffset: number } | null => {
    const container = scrollContainerRef.current;
    if (!container) return null;
    const scrollTop = container.scrollTop;
    const containerRect = container.getBoundingClientRect();

    // 先检查缓存的章节元素是否仍然在当前滚动位置
    const cached = cachedChapterElRef.current;
    if (cached && cached.isConnected) {
      const cachedRect = cached.getBoundingClientRect();
      const cachedTop = cachedRect.top - containerRect.top + scrollTop;
      const cachedBottom = cachedTop + cachedRect.height;
      if (scrollTop >= cachedTop && scrollTop < cachedBottom) {
        return { scrollTop, chapterOffset: scrollTop - cachedTop };
      }
    }

    // 缓存未命中，遍历查找
    const sections = container.querySelectorAll(".chapter-section[data-chapter-id]");
    let chapterOffset = 0;
    for (const section of sections) {
      const el = section as HTMLElement;
      const elRect = el.getBoundingClientRect();
      const relativeTop = elRect.top - containerRect.top + scrollTop;
      const relativeBottom = relativeTop + elRect.height;
      if (relativeBottom > scrollTop) {
        chapterOffset = scrollTop - relativeTop;
        cachedChapterElRef.current = el;
        break;
      }
    }
    return { scrollTop, chapterOffset };
  }, [scrollContainerRef]);

  const savePositionNow = useCallback(() => {
    const pos = calcChapterOffset();
    if (pos) saveScrollTopRef.current(pos.scrollTop, pos.chapterOffset);
  }, [calcChapterOffset]);

  // 退出或切换小说时立即保存滚动位置
  const prevNovelIdRef = useRef(currentNovel?.id);
  const prevContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const prevId = prevNovelIdRef.current;
    const curId = currentNovel?.id;
    prevNovelIdRef.current = curId;
    // 小说变化（退出或切换到另一本小说），用之前的 container 保存旧小说的位置
    if (prevId && prevId !== curId && prevContainerRef.current) {
      const container = prevContainerRef.current;
      const scrollTop = container.scrollTop;
      const containerRect = container.getBoundingClientRect();
      // 计算章节偏移量（使用 getBoundingClientRect 避免 offsetParent 问题）
      const sections = container.querySelectorAll(".chapter-section[data-chapter-id]");
      let chapterOffset = 0;
      for (const section of sections) {
        const el = section as HTMLElement;
        const elRect = el.getBoundingClientRect();
        const relativeTop = elRect.top - containerRect.top + scrollTop;
        const relativeBottom = relativeTop + elRect.height;
        if (relativeBottom > scrollTop) {
          chapterOffset = scrollTop - relativeTop;
          break;
        }
      }
      const { readingPositions } = useNovelStore.getState();
      const existingPos = readingPositions[prevId];
      if (existingPos) {
        const positions = { ...readingPositions, [prevId]: { ...existingPos, scrollTop, chapterOffset } };
        localStorage.setItem(userKey("novel-reader-positions"), JSON.stringify(positions));
        useNovelStore.setState({ readingPositions: positions });
      }
    }
    prevContainerRef.current = scrollContainerRef.current;
  }, [currentNovel?.id, scrollContainerRef]);

  // 节流保存滚动位置（每 3 秒最多保存一次）
  const lastSaveTimeRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isPaginated || !currentNovel) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const now = Date.now();
      if (now - lastSaveTimeRef.current >= 3000) {
        lastSaveTimeRef.current = now;
        savePositionNow();
      } else {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          lastSaveTimeRef.current = Date.now();
          savePositionNow();
        }, 3000);
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [isPaginated, currentNovel?.id, scrollContainerRef, savePositionNow]); // eslint-disable-line react-hooks/exhaustive-deps

  // 页面退出时立即保存滚动位置
  useEffect(() => {
    if (isPaginated || !currentNovel) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        savePositionNow();
      } else if (document.visibilityState === "visible") {
        // 清除之前的定时器，防止快速切屏导致竞态（前一次 release 在本次 suppress 窗口期内触发）
        if (visibilityTimeoutRef.current) clearTimeout(visibilityTimeoutRef.current);
        const novel = useNovelStore.getState().currentNovel;
        if (!novel) return;
        const pos = useNovelStore.getState().readingPositions[novel.id];
        if (pos?.chapterId) {
          const release = suppressIORef.current(pos.chapterId);
          scrollToChapterRef.current(pos.chapterId, pos.chapterOffset);
          visibilityTimeoutRef.current = setTimeout(release, 500);
        }
      }
    };

    window.addEventListener("beforeunload", savePositionNow);
    window.addEventListener("pagehide", savePositionNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (visibilityTimeoutRef.current) clearTimeout(visibilityTimeoutRef.current);
      window.removeEventListener("beforeunload", savePositionNow);
      window.removeEventListener("pagehide", savePositionNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isPaginated, currentNovel?.id, savePositionNow]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 翻页模式相关 ──────────────────────────────────────────────
  const pageWidth = useMemo(() => {
    if (!isPaginated) return 0;
    if (isDouble) return Math.floor((containerSize.width - SPINE_WIDTH) / 2);
    return Math.min(containerSize.width, MAX_SINGLE_WIDTH);
  }, [isPaginated, isDouble, containerSize.width]);

  const activePadding = isMobile ? PAGE_PADDING_MOBILE : PAGE_PADDING;
  const contentWidth = Math.max(0, pageWidth - activePadding * 2);
  const contentHeight = Math.max(0, containerSize.height - activePadding * 2);
  const contentParagraphs = useMemo(() => chapter?.content.split(/\n+/) || [], [chapter?.content]);
  // F1: 用 Zustand selector 减少不必要的重渲染
  const ttsParagraph = useTTSStore(s => s.playing && s.currentChapterIndex === currentIndex ? s.currentParagraph : -1);
  const ttsActive = ttsParagraph >= 0;

  const { pages, totalPages, measureRef } = usePagination({
    paragraphs: contentParagraphs,
    fontSize, lineHeight, fontWeight, fontFamily, paragraphSpacing,
    contentWidth, contentHeight,
    enabled: isPaginated,
  });

  const safePage = Math.min(currentPage, Math.max(0, totalPages - 1));
  const spreadIndex = Math.floor(safePage / 2);

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

  // U6: TTS 朗读时自动滚动——跟随当前高亮段落
  useEffect(() => {
    if (ttsParagraph < 0) return;
    if (isPaginated) {
      // 翻页模式：找到段落所在页面并翻到该页
      if (pages.length > 0) {
        const pageIdx = pages.findIndex(p => ttsParagraph >= p.startIndex && ttsParagraph <= p.endIndex);
        if (pageIdx >= 0 && pageIdx !== currentPage) {
          // 延迟到下一帧，避免 effect 中同步 setState 造成级联渲染
          const raf = requestAnimationFrame(() => setCurrentPage(pageIdx));
          return () => cancelAnimationFrame(raf);
        }
      }
    } else {
      // 滚动模式：将高亮段落在当前章节内滚动到可见区域
      const container = scrollContainerRef.current;
      if (!container) return;
      const section = container.querySelector(`.chapter-section[data-chapter-id="${selectedChapterId}"]`);
      const el = section?.querySelector(`[data-tts-paragraph="${ttsParagraph}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  }, [ttsParagraph, isPaginated, pages, selectedChapterId, scrollContainerRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // 翻页模式章节切换
  const goToChapter = useCallback(async (chapterId: string) => {
    if (!currentNovel) return;
    const targetChapter = chapters.find((c) => c.id === chapterId);
    if (targetChapter && targetChapter.content) {
      startTransition(() => {
        setSelectedChapter(chapterId);
        setCurrentPage(0);
      });
    } else {
      const targetIndex = chapters.findIndex((c) => c.id === chapterId);
      if (targetIndex >= 0) {
        setLoadingChapter(chapterId);
        try {
          const start = Math.max(0, targetIndex - 10);
          const loaded = await loadChapters(currentNovel.id, start, 21);
          addChapters(loaded);
          startTransition(() => {
            setSelectedChapter(chapterId);
            setCurrentPage(0);
          });
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

  // ── 自动阅读 ────────────────────────────────────────────
  // 自动翻页标记：区分"hook 自动翻页切章"与"用户手动切章"（手动切章需停止自动阅读）
  const autoAdvancingRef = useRef(false);
  const handleAutoNextPage = useCallback(() => {
    autoAdvancingRef.current = true;
    goNextPageRef.current();
    requestAnimationFrame(() => { autoAdvancingRef.current = false; });
  }, []);

  // 分页模式是否已到最后一章末页（滚动模式的"到底"由 hook 内部检测）
  const isAtEnd = useCallback(
    () => currentIndex >= chapters.length - 1 && safePage >= totalPages - 1,
    [currentIndex, chapters.length, safePage, totalPages]
  );

  const handleAutoReadStop = useCallback((reason: "end" | "user") => {
    setAutoReadEnabled(false);
    if (reason === "end") showToast("已阅读到底部，自动阅读已停止");
  }, [setAutoReadEnabled]);

  // 正文容器：分页模式为翻页容器，滚动模式为滚动容器（两者互斥渲染，同一时刻只存在一个）
  const autoReadContentRef = isPaginated ? containerRef : scrollContainerRef;

  useAutoRead({
    enabled: autoReadEnabled,
    intervalSec: autoReadInterval,
    scrollStepPercent: autoReadScrollStep,
    paginated: isPaginated,
    scrollRef: scrollContainerRef,
    contentRef: autoReadContentRef,
    onNextPage: handleAutoNextPage,
    isAtEnd,
    onStop: handleAutoReadStop,
  });

  // 自动阅读开启期间，用户打开设置面板 / 切换阅读模式 / 切换沉浸模式 → 视为干扰，停止
  const autoReadEnabledRef = useRef(autoReadEnabled);
  useEffect(() => { autoReadEnabledRef.current = autoReadEnabled; });
  useEffect(() => {
    if (autoReadEnabledRef.current) setAutoReadEnabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFontPanel, summaryOpen, readingMode, immersive]);

  // TTS 互斥：用户开始语音朗读 → 停止自动阅读（两者都是"自动前进"，不能同时跑）
  const ttsPlaying = useTTSStore((s) => s.playing);
  useEffect(() => {
    if (ttsPlaying && autoReadEnabledRef.current) setAutoReadEnabled(false);
  }, [ttsPlaying, setAutoReadEnabled]);

  // 分页模式：用户手动切章（目录点击/底部翻章，非自动翻页触发）→ 停止自动阅读
  useEffect(() => {
    if (!isPaginated) return;
    if (autoReadEnabledRef.current && !autoAdvancingRef.current) setAutoReadEnabled(false);
  }, [selectedChapterId, isPaginated, setAutoReadEnabled]);

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
        { key: "PageUp", action: () => {
          const el = scrollContainerRefForKeys.current;
          if (el) el.scrollBy({ top: -el.clientHeight * 0.8, behavior: "smooth" });
        }, description: "向上翻页" },
        { key: "PageDown", action: () => {
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
      { key: "PageUp", action: () => goPrevPageRef.current(), description: "上一页" },
      { key: "PageDown", action: () => goNextPageRef.current(), description: "下一页" },
      { key: " ", action: () => goNextPageRef.current(), description: "下一页", when: () => !showFontPanel && (document.activeElement?.tagName ?? "") !== "BUTTON" },
      { key: "+", action: () => setFontSize(Math.min(24, fontSize + 1)), description: "增大字号" },
      { key: "-", action: () => setFontSize(Math.max(12, fontSize - 1)), description: "减小字号" },
      { key: "i", action: onToggleImmersive, description: "切换沉浸模式" },
    ];
  }, [isPaginated, fontSize, setFontSize, onToggleImmersive, scrollContainerRefForKeys]); // eslint-disable-line react-hooks/exhaustive-deps
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
      if (dx < 0) goNextPage(); else goPrevPage();
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
    if (e.deltaY > 0) goNextPage(); else goPrevPage();
  }, [isPaginated, goNextPage, goPrevPage]);

  // 翻页模式点击
  const handlePageClick = (e: React.MouseEvent) => {
    if (window.innerWidth >= 768) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    if (ratio < 1 / 3) goPrevPage();
    else if (ratio > 2 / 3) goNextPage();
    else {
      // 中间区域双击切换沉浸模式（与滚动模式保持一致）
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        onToggleImmersive();
        lastTapRef.current = 0; // 防止三次点击再次触发
      } else {
        lastTapRef.current = now;
      }
    }
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
        // F1: 高亮当前朗读段落
        const hl = ttsActive && ttsParagraph === i;
        items.push(
          <p key={i} data-tts-paragraph={i} className={`text-justify ${hl ? "bg-primary/10 border-l-2 border-primary pl-3 rounded-r" : ""}`} style={{ marginBottom: `${paragraphSpacing}px` }}>
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

  // TTS AudioPlayer 配置（在两种模式外渲染，切换时不卸载）
  const audioPlayer = currentNovel && chapter ? (
    <AudioPlayer
      novelId={currentNovel.id}
      chapterContent={chapter.content || null}
      chapterIndex={currentIndex}
      chapterTitle={chapter.title}
      // U8: 翻章时根据模式触发放内容加载（懒加载兼容）
      onPrevChapter={currentIndex > 0 ? () => {
        const prevId = chapters[currentIndex - 1]?.id;
        if (isPaginated) goToChapter(prevId);
        else {
          const release = suppressIO(prevId);
          setSelectedChapter(prevId);
          scrollToChapter(prevId);
          setTimeout(release, 500);
        }
      } : undefined}
      onNextChapter={currentIndex < chapters.length - 1 ? () => {
        const nextId = chapters[currentIndex + 1]?.id;
        if (isPaginated) goToChapter(nextId);
        else {
          const release = suppressIO(nextId);
          setSelectedChapter(nextId);
          scrollToChapter(nextId);
          setTimeout(release, 500);
        }
      } : undefined}
    />
  ) : null;

  // 构建模式相关的内容（赋值给变量，最后统一 return）
  let content: React.ReactNode;

  // ========================================
  // 翻页模式渲染（完全保留原逻辑）
  // ========================================
  if (isPaginated) {
    const leftPage = isDouble ? pages[spreadIndex * 2] : pages[safePage];
    const rightPage = isDouble ? pages[spreadIndex * 2 + 1] : undefined;

    const renderControls = (
      <div className="flex-1 flex flex-col h-full">
        <TopBar
          chapter={chapter} currentIndex={currentIndex} chapters={chapters}
          summaries={summaries} summaryOpen={summaryOpen} onToggleSummary={onToggleSummary}
          hasSummary={hasSummary}
          showFontPanel={showFontPanel} setShowFontPanel={setShowFontPanel}
          onToggleImmersive={onToggleImmersive}
          fontSize={fontSize} setFontSize={setFontSize}
          fontWeight={fontWeight} cycleFontWeight={cycleFontWeight} currentWeightLabel={currentWeightLabel}
          lineHeight={lineHeight} setLineHeight={setLineHeight}
          paragraphSpacing={paragraphSpacing} setParagraphSpacing={setParagraphSpacing}
          fontFamily={fontFamily} setFontFamily={setFontFamily}
          readingMode={readingMode} setReadingMode={setReadingMode}
          autoSwitchPageMode={autoSwitchPageMode} setAutoSwitchPageMode={setAutoSwitchPageMode}
          autoReadInterval={autoReadInterval} setAutoReadInterval={setAutoReadInterval}
          autoReadScrollStep={autoReadScrollStep} setAutoReadScrollStep={setAutoReadScrollStep}
          immersive={immersive}
          windowWidth={windowWidth}
          isIndexLoading={isIndexLoading}
        />

        <div
          ref={containerRef}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
          style={{ touchAction: "none" }}
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
            onPrev={() => { setAutoReadEnabled(false); goPrevPage(); }}
            onNext={() => { setAutoReadEnabled(false); goNextPage(); }}
            prevDisabled={safePage === 0 && !prevChapter}
            nextDisabled={safePage >= totalPages - 1 && !nextChapter}
            loadingChapter={loadingChapter}
            pageLabel={`${pageLabel} / ${totalPages}`}
          />
        )}

      </div>
    );
    content = renderControls;
  } else {
  // ========================================
  // 连续滚动模式渲染
  // ========================================
  content = (
    <div className="flex-1 flex flex-col h-full">
      <TopBar
        chapter={chapter} currentIndex={currentIndex} chapters={chapters}
        summaries={summaries} summaryOpen={summaryOpen} onToggleSummary={onToggleSummary}
        hasSummary={hasSummary}
        showFontPanel={showFontPanel} setShowFontPanel={setShowFontPanel}
        onToggleImmersive={onToggleImmersive}
                  fontSize={fontSize} setFontSize={setFontSize}
                  fontWeight={fontWeight} cycleFontWeight={cycleFontWeight} currentWeightLabel={currentWeightLabel}
                  lineHeight={lineHeight} setLineHeight={setLineHeight}
                  paragraphSpacing={paragraphSpacing} setParagraphSpacing={setParagraphSpacing}
                  fontFamily={fontFamily} setFontFamily={setFontFamily}
                  readingMode={readingMode} setReadingMode={setReadingMode}
                  autoSwitchPageMode={autoSwitchPageMode} setAutoSwitchPageMode={setAutoSwitchPageMode}
                  autoReadInterval={autoReadInterval} setAutoReadInterval={setAutoReadInterval}
                  autoReadScrollStep={autoReadScrollStep} setAutoReadScrollStep={setAutoReadScrollStep}
                  immersive={immersive}
                  windowWidth={windowWidth}
                  isIndexLoading={isIndexLoading}
              />

      {/* 连续滚动容器 */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto scroll-smooth chapter-scroll-container"
        onClick={(e) => {
          // 移动端双击中间区域切换沉浸模式
          if (window.innerWidth >= 768 || !onToggleImmersive) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / rect.width;
          if (ratio < 1 / 3 || ratio > 2 / 3) return; // 只响应中间区域
          const now = Date.now();
          if (now - lastTapRef.current < 300) {
            onToggleImmersive();
            lastTapRef.current = 0; // 防止三次点击再次触发
          } else {
            lastTapRef.current = now;
          }
        }}
      >
        <div className="max-w-3xl mx-auto px-4 md:px-6 pb-24 md:pb-20">
          {/* 顶部哨兵（IntersectionObserver 触发向前加载） */}
          <div ref={topSentinelRef} className="h-px" />

          {loadedChapters.map((ch) => (
            <div
              key={ch.id}
              data-chapter-id={ch.id}
              className="chapter-section"
              style={{ contain: "content", contentVisibility: "auto", containIntrinsicSize: "0 500px" }}
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
                <ChapterParagraphs
                  content={ch.content}
                  paragraphSpacing={paragraphSpacing}
                  ttsActive={ttsActive}
                  ttsParagraph={ttsParagraph}
                  chapterId={ch.id}
                  selectedChapterId={selectedChapterId}
                />
              </div>
            </div>
          ))}

          {/* 底部哨兵（IntersectionObserver 触发向后加载） */}
          <div ref={bottomSentinelRef} className="h-px" />

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
              const release = suppressIO(prevChapter.id);
              setSelectedChapter(prevChapter.id);
              scrollToChapter(prevChapter.id);
              setTimeout(release, 500);
            }
          }}
          onNext={() => {
            if (nextChapter) {
              const release = suppressIO(nextChapter.id);
              setSelectedChapter(nextChapter.id);
              scrollToChapter(nextChapter.id);
              setTimeout(release, 500);
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
  } // end else (scroll mode)

  // 统一 return：内容 + 始终挂载的 AudioPlayer（切换模式不卸载）
  return <>{content}{audioPlayer}</>;
}
