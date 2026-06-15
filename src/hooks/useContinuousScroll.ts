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
}

interface UseContinuousScrollReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  bottomSentinelRef: React.RefObject<HTMLDivElement | null>;
  loadedChapters: Chapter[];
  scrollToChapter: (chapterId: string) => void;
  isLoadingMore: boolean;
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
          if (startIndex >= currentChapters.length) return;

          const newChapters = await loadChapters(novelId, startIndex, LOAD_BATCH);
          if (newChapters.length > 0) addChapters(newChapters);
          // 前向加载立即解锁
          isLoadingRef.current = false;
          setIsLoadingMore(false);
        } else {
          const firstLoaded = loaded[0];
          const startIndex = Math.max(0, firstLoaded.index - LOAD_BATCH);
          if (startIndex >= firstLoaded.index) return;

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

  // ── 滚动到指定章节 ────────────────────────────────────────────
  const scrollToChapter = useCallback(
    (chapterId: string) => {
      const container = containerRef.current;
      if (!container) return;

      const target = container.querySelector(
        `.chapter-section[data-chapter-id="${chapterId}"]`
      );
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        const chapterIndex = chapterIndexMap.get(chapterId);
        if (chapterIndex === undefined) return;

        const startIndex = Math.max(0, chapterIndex - 5);
        loadChapters(novelId, startIndex, LOAD_BATCH + 5).then((loaded) => {
          if (loaded.length > 0) {
            addChapters(loaded);
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const el = containerRef.current?.querySelector(
                  `.chapter-section[data-chapter-id="${chapterId}"]`
                );
                el?.scrollIntoView({ behavior: "smooth", block: "start" });
              });
            });
          }
        });
      }
    },
    [novelId, chapterIndexMap, addChapters]
  );

  // ── IntersectionObserver：章节检测（带去重）────────────────────
  const onChapterChangeRef = useRef(onChapterChange);
  onChapterChangeRef.current = onChapterChange;
  const lastDetectedChapterRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container || loadedChapters.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
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

  return { containerRef, topSentinelRef, bottomSentinelRef, loadedChapters, scrollToChapter, isLoadingMore };
}
