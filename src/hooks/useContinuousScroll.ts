import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { loadChapters } from "@/db/repositories";
import { useNovelStore } from "@/stores/novel-store";

interface Chapter {
  id: string;
  title: string;
  index: number;
  content: string;
}

interface UseContinuousScrollOptions {
  novelId: string;
  chapters: Chapter[];
  onChapterChange: (chapterId: string) => void;
  enabled: boolean; // 仅在滚动模式下启用
  initialChapterId?: string | null; // 初始章节 ID（用于恢复位置）
  initialChapterOffset?: number; // 恢复时的章节内偏移量（像素）
}

interface UseContinuousScrollReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  bottomSentinelRef: React.RefObject<HTMLDivElement | null>;
  loadedChapters: Chapter[];
  scrollToChapter: (chapterId: string, chapterOffset?: number) => void;
  isLoadingMore: boolean;
  /** 临时抑制 IO 回调（用于目录点击等场景），返回解锁函数 */
  suppressIO: () => () => void;
}

const LOAD_BATCH = 10;

/**
 * 连续滚动 hook：管理多章节在一个滚动容器中的懒加载、章节检测、滚动定位。
 */
export function useContinuousScroll({
  novelId,
  chapters,
  onChapterChange,
  enabled,
  initialChapterId,
  initialChapterOffset,
}: UseContinuousScrollOptions): UseContinuousScrollReturn {
  const containerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const { addChapters } = useNovelStore();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const isLoadingRef = useRef(false);

  // 用 ref 读取最新 chapters，避免 stale closure
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;

  // 已加载内容的章节
  const loadedChapters = useMemo(
    () => chapters.filter((ch) => ch.content),
    [chapters]
  );

  // 章节索引映射
  const chapterIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    chapters.forEach((ch) => map.set(ch.id, ch.index));
    return map;
  }, [chapters]);

  // ── 加载更多章节（使用 ref 读取最新数据，避免 stale closure）──
  const loadMore = useCallback(
    async (direction: "forward" | "backward") => {
      if (isLoadingRef.current || !novelId || !enabled) return;

      // 从 ref 读取最新 chapters
      const currentChapters = chaptersRef.current;
      const loaded = currentChapters.filter((ch) => ch.content);
      if (loaded.length === 0) return;

      const container = containerRef.current;
      if (!container) return;

      isLoadingRef.current = true;
      setIsLoadingMore(true);

      try {
        if (direction === "forward") {
          const lastLoaded = loaded[loaded.length - 1];
          const startIndex = lastLoaded.index + 1;
          if (startIndex >= currentChapters.length) {
            isLoadingRef.current = false;
            setIsLoadingMore(false);
            return;
          }

          const newChapters = await loadChapters(novelId, startIndex, LOAD_BATCH);
          if (newChapters.length > 0) addChapters(newChapters);
          isLoadingRef.current = false;
          setIsLoadingMore(false);
        } else {
          const firstLoaded = loaded[0];
          const startIndex = Math.max(0, firstLoaded.index - LOAD_BATCH);
          if (startIndex >= firstLoaded.index) {
            isLoadingRef.current = false;
            setIsLoadingMore(false);
            return;
          }

          const oldScrollHeight = container.scrollHeight;
          const oldScrollTop = container.scrollTop;

          const newChapters = await loadChapters(novelId, startIndex, LOAD_BATCH);
          if (newChapters.length > 0) {
            addChapters(newChapters);
            // 双层 rAF 确保 DOM 更新完成后再补偿，补偿后才解锁
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const newScrollHeight = container.scrollHeight;
                container.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
                // 补偿完成后再解锁，避免哨兵仍在检测区导致循环加载
                isLoadingRef.current = false;
                setIsLoadingMore(false);
              });
            });
          } else {
            isLoadingRef.current = false;
            setIsLoadingMore(false);
          }
        }
      } catch (err) {
        console.error("[ContinuousScroll] Failed to load chapters:", err);
        isLoadingRef.current = false;
        setIsLoadingMore(false);
      }
    },
    [novelId, enabled, addChapters]
  );

  // ── 滚动到指定章节（可选章节内偏移量）────────────────────
  const scrollToChapter = useCallback(
    (chapterId: string, chapterOffset?: number) => {
      const container = containerRef.current;
      if (!container) return;

      const applyScroll = (el: Element) => {
        if (chapterOffset !== undefined) {
          // 用 getBoundingClientRect 计算精确位置（不依赖 offsetParent）
          const elRect = el.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          const relativeTop = elRect.top - containerRect.top + container.scrollTop;
          container.scrollTop = relativeTop + chapterOffset;
        } else {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      };

      const target = container.querySelector(
        `.chapter-section[data-chapter-id="${chapterId}"]`
      );
      if (target) {
        applyScroll(target);
      } else {
        const chapterIndex = chapterIndexMap.get(chapterId);
        if (chapterIndex === undefined) return;

        const startIndex = Math.max(0, chapterIndex - 5);
        loadChapters(novelId, startIndex, LOAD_BATCH + 5).then((loaded) => {
          if (loaded.length > 0) {
            addChapters(loaded);
            // 轮询等待 React 渲染完成（addChapters 触发的状态更新可能需要多帧）
            let attempts = 0;
            const poll = () => {
              const el = containerRef.current?.querySelector(
                `.chapter-section[data-chapter-id="${chapterId}"]`
              );
              if (el) {
                applyScroll(el);
              } else if (attempts < 30) {
                attempts++;
                requestAnimationFrame(poll);
              }
            };
            requestAnimationFrame(poll);
          }
        });
      }
    },
    [novelId, chapterIndexMap, addChapters]
  );

  // ── 位置恢复：当小说变化或 chapters 从空到非空时恢复阅读位置 ─────────
  const prevNovelIdRef = useRef(novelId);
  const prevEnabledRef = useRef(enabled);
  const prevChaptersLenRef = useRef(0);
  const hasRestoredRef = useRef(false);
  // 用 ref 锁定恢复目标，防止 IO 改变 selectedChapterId 后 effect 重新计算目标
  const restoreTargetRef = useRef<{ chapterId: string; offset?: number } | null>(null);
  // 用 ref 存储 scrollToChapter，避免 effect 依赖它（否则 addChapters 会重建它导致 effect 重运行清除定时器）
  const scrollToChapterRef = useRef(scrollToChapter);
  scrollToChapterRef.current = scrollToChapter;

  useEffect(() => {
    if (!enabled || !novelId) {
      prevNovelIdRef.current = novelId;
      prevEnabledRef.current = enabled;
      prevChaptersLenRef.current = 0;
      hasRestoredRef.current = false;
      restoreTargetRef.current = null;
      isRestoringIORef.current = false;
      return;
    }

    const prevNovelId = prevNovelIdRef.current;
    const prevEnabled = prevEnabledRef.current;
    const prevLen = prevChaptersLenRef.current;
    const curLen = chapters.length;
    prevNovelIdRef.current = novelId;
    prevEnabledRef.current = enabled;
    prevChaptersLenRef.current = curLen;

    // 小说变化、从翻页切到滚动、或 chapters 从空到非空 = 需要恢复
    const novelChanged = prevNovelId !== novelId;
    const modeChanged = !prevEnabled && enabled;
    const justEntered = prevLen === 0 && curLen > 0;
    if (novelChanged || modeChanged || justEntered) {
      hasRestoredRef.current = false;
      restoreTargetRef.current = null;
    }

    // 已恢复或无章节可恢复
    if (hasRestoredRef.current || curLen === 0) return;

    // 首次进入此 effect 分支时锁定恢复目标（不随 prop 变化）
    if (!restoreTargetRef.current) {
      const targetChapterId = initialChapterId && chapterIndexMap.has(initialChapterId)
        ? initialChapterId
        : chapters[0]?.id;
      if (!targetChapterId) return;
      restoreTargetRef.current = { chapterId: targetChapterId, offset: initialChapterOffset };
    }

    const { chapterId: targetChapterId, offset: targetOffset } = restoreTargetRef.current;

    // 延迟恢复，确保 DOM 已更新
    isRestoringIORef.current = true; // 抑制 IO 回调
    const timer = setTimeout(() => {
      // 如果已被 suppressIO 标记为已恢复，跳过（用户主动导航了）
      // 注意：不重置 isRestoringIORef，由 suppressIO 的 release 函数负责
      if (hasRestoredRef.current) return;
      hasRestoredRef.current = true;
      restoreTargetRef.current = null;
      scrollToChapterRef.current(targetChapterId, targetOffset);
      // 恢复完成后解锁 IO（延迟足够让 scrollTop 生效）
      setTimeout(() => { isRestoringIORef.current = false; }, 500);
    }, 100);

    // cleanup 不重置 isRestoringIORef，防止 IO 在恢复间隙触发
    return () => { clearTimeout(timer); };
  }, [novelId, enabled, chapters, initialChapterId, initialChapterOffset]);

  // ── IntersectionObserver：章节检测（带去重）────────────────────
  const onChapterChangeRef = useRef(onChapterChange);
  onChapterChangeRef.current = onChapterChange;
  const lastDetectedChapterRef = useRef<string | null>(null);
  // 恢复期间抑制 IO 回调，防止挂载时检测到错误章节
  const isRestoringIORef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container || loadedChapters.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (isRestoringIORef.current) return; // 恢复期间忽略
        // 只取第一个进入视口的章节标记（避免多个同时触发）
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const chapterId = entry.target.getAttribute("data-chapter-id");
            if (chapterId && chapterId !== lastDetectedChapterRef.current) {
              lastDetectedChapterRef.current = chapterId;
              onChapterChangeRef.current(chapterId);
            }
            break; // 只处理第一个
          }
        }
      },
      {
        root: container,
        rootMargin: "-5% 0px -85% 0px", // 检测顶部 5%-15% 区域
        threshold: 0,
      }
    );

    const markers = container.querySelectorAll(".chapter-section[data-chapter-id]");
    markers.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [loadedChapters, enabled]);

  // ── IntersectionObserver：边缘加载（使用 React ref 哨兵）──────
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    const topSentinel = topSentinelRef.current;
    const bottomSentinel = bottomSentinelRef.current;
    if (!container || !topSentinel || !bottomSentinel) return;
    if (loadedChapters.length === 0) return;

    const edgeObserver = new IntersectionObserver(
      (entries) => {
        if (isRestoringIORef.current) return; // 恢复/抑制期间忽略
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === topSentinel) {
            loadMore("backward");
          } else if (entry.target === bottomSentinel) {
            loadMore("forward");
          }
        }
      },
      { root: container, rootMargin: "200px 0px 400px 0px", threshold: 0 }
    );

    edgeObserver.observe(topSentinel);
    edgeObserver.observe(bottomSentinel);

    return () => edgeObserver.disconnect();
  }, [loadedChapters, loadMore, enabled]);

  // ── 临时抑制 IO 回调（同时标记恢复完成，防止恢复 effect 干扰）──
  const suppressIO = useCallback(() => {
    isRestoringIORef.current = true;
    hasRestoredRef.current = true;
    restoreTargetRef.current = null;
    return () => { isRestoringIORef.current = false; };
  }, []);

  return { containerRef, topSentinelRef, bottomSentinelRef, loadedChapters, scrollToChapter, isLoadingMore, suppressIO };
}
