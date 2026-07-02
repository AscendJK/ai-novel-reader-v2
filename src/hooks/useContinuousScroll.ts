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
  const addChapters = useNovelStore((s) => s.addChapters);
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

  // ── 章节检测相关 refs（声明在恢复 effect 之前，确保可用）──
  const onChapterChangeRef = useRef(onChapterChange);
  onChapterChangeRef.current = onChapterChange;
  const lastDetectedChapterRef = useRef<string | null>(null);
  // 恢复/导航期间抑制检测，防止中间状态更新目录
  const suppressChapterDetectionRef = useRef(false);
  // 抑制解除后的主动检测回调（由章节检测 effect 设置，恢复/suppressIO 调用）
  const triggerDetectionRef = useRef<(() => void) | null>(null);

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
      suppressChapterDetectionRef.current = false;
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
    suppressChapterDetectionRef.current = true; // 抑制滚动检测，防止恢复过程中的中间状态
    const timer = setTimeout(() => {
      // 如果已被 suppressIO 标记为已恢复，跳过（用户主动导航了）
      if (hasRestoredRef.current) return;
      hasRestoredRef.current = true;
      restoreTargetRef.current = null;
      scrollToChapterRef.current(targetChapterId, targetOffset);
      // 恢复完成后解锁检测，并主动触发一次（延迟足够让 scrollTop 生效）
      setTimeout(() => {
        suppressChapterDetectionRef.current = false;
        triggerDetectionRef.current?.();
      }, 500);
    }, 100);

    // cleanup：清除外层 timer，并无条件重置 suppress ref
    // 即使内层 setTimeout 已经启动，cleanup 也会重置 ref，防止永久锁定
    return () => {
      clearTimeout(timer);
      suppressChapterDetectionRef.current = false;
    };
  }, [novelId, enabled, chapters, initialChapterId, initialChapterOffset]);

  // ── 章节检测（scroll 事件 + requestAnimationFrame 节流）────────────
  // 用 scroll 事件替代 IntersectionObserver，彻底消除"已在视口不触发"的时序问题

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    let rafId = 0;
    let frameCount = 0;
    // 缓存章节 DOM 元素，避免每帧 querySelectorAll
    let cachedMarkers: Element[] = [];
    let markerCount = 0;

    const refreshMarkers = () => {
      const markers = container.querySelectorAll(".chapter-section[data-chapter-id]");
      cachedMarkers = Array.from(markers);
      markerCount = cachedMarkers.length;
    };

    const detectCurrentChapter = () => {
      if (suppressChapterDetectionRef.current) return;
      if (container.childElementCount !== markerCount) {
        refreshMarkers();
      }
      if (markerCount === 0) return;

      const containerRect = container.getBoundingClientRect();
      const zoneTop = containerRect.top + containerRect.height * 0.05;
      const zoneBottom = containerRect.top + containerRect.height * 0.15;

      // 找到当前章节在 markers 中的索引（二分查找）
      const lastId = lastDetectedChapterRef.current;
      let currentIdx = -1;
      if (lastId) {
        let lo = 0, hi = markerCount - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (cachedMarkers[mid].getAttribute("data-chapter-id") === lastId) { currentIdx = mid; break; }
          // 用 getBoundingClientRect 做不了二分，改用线性但只检查 id
          if (cachedMarkers[mid].getAttribute("data-chapter-id")! < lastId) lo = mid + 1; else hi = mid - 1;
        }
        // fallback：线性查找 id
        if (currentIdx === -1) {
          for (let i = 0; i < markerCount; i++) {
            if (cachedMarkers[i].getAttribute("data-chapter-id") === lastId) { currentIdx = i; break; }
          }
        }
      }

      // 只检查当前章节和前后各 1 个（共最多 3 个 getBoundingClientRect）
      const checkStart = Math.max(0, (currentIdx === -1 ? 0 : currentIdx) - 1);
      const checkEnd = Math.min(markerCount - 1, (currentIdx === -1 ? 0 : currentIdx) + 1);

      // 先检查检测区内
      for (let i = checkStart; i <= checkEnd; i++) {
        const el = cachedMarkers[i];
        const rect = el.getBoundingClientRect();
        if (rect.top >= zoneTop && rect.top <= zoneBottom) {
          const chapterId = el.getAttribute("data-chapter-id");
          if (chapterId && chapterId !== lastDetectedChapterRef.current) {
            lastDetectedChapterRef.current = chapterId;
            onChapterChangeRef.current(chapterId);
          }
          return;
        }
      }

      // 检测区内没有，找检测区上方最近的（只检查相邻 3 个）
      let closestId: string | null = null;
      let closestDist = Infinity;
      for (let i = checkStart; i <= checkEnd; i++) {
        const el = cachedMarkers[i];
        const rect = el.getBoundingClientRect();
        const dist = zoneTop - rect.top;
        if (dist >= 0 && dist < closestDist) {
          closestDist = dist;
          closestId = el.getAttribute("data-chapter-id");
        }
      }
      if (!closestId && markerCount > 0) {
        closestId = cachedMarkers[0].getAttribute("data-chapter-id");
      }
      if (closestId && closestId !== lastDetectedChapterRef.current) {
        lastDetectedChapterRef.current = closestId;
        onChapterChangeRef.current(closestId);
      }
    };

    const handleScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        frameCount++;
        // 每 3 帧检测一次，降低 getBoundingClientRect 调用频率
        if (frameCount % 3 === 0) {
          detectCurrentChapter();
        }
      });
    };

    // 暴露主动检测函数，供恢复/suppressIO 解锁后调用
    triggerDetectionRef.current = () => requestAnimationFrame(detectCurrentChapter);

    container.addEventListener("scroll", handleScroll, { passive: true });

    // 初始缓存章节元素
    refreshMarkers();
    triggerDetectionRef.current();

    return () => {
      container.removeEventListener("scroll", handleScroll);
      cancelAnimationFrame(rafId);
      triggerDetectionRef.current = null;
      cachedMarkers = [];
      markerCount = 0;
    };
  }, [chapters.length, enabled]);

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
        if (suppressChapterDetectionRef.current) return; // 恢复/抑制期间忽略
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
  }, [chapters.length, loadMore, enabled]);

  // ── 临时抑制章节检测和边缘加载（目录点击等场景）──
  const suppressIO = useCallback(() => {
    suppressChapterDetectionRef.current = true;
    hasRestoredRef.current = true;
    restoreTargetRef.current = null;
    return () => {
      suppressChapterDetectionRef.current = false;
      triggerDetectionRef.current?.();
    };
  }, []);

  return { containerRef, topSentinelRef, bottomSentinelRef, loadedChapters, scrollToChapter, isLoadingMore, suppressIO };
}
