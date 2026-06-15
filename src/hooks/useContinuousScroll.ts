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
}

interface UseContinuousScrollReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  loadedChapters: Chapter[];
  scrollToChapter: (chapterId: string) => void;
  isLoadingMore: boolean;
}

const LOAD_BATCH = 10; // 每次加载章节数
const TOP_THRESHOLD = 200; // 距顶部多少 px 触发加载
const BOTTOM_THRESHOLD = 400; // 距底部多少 px 触发加载

/**
 * 连续滚动 hook：管理多章节在一个滚动容器中的懒加载、章节检测、滚动定位。
 */
export function useContinuousScroll({
  novelId,
  chapters,
  onChapterChange,
}: UseContinuousScrollOptions): UseContinuousScrollReturn {
  const containerRef = useRef<HTMLDivElement>(null);
  const { addChapters } = useNovelStore();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const isLoadingRef = useRef(false);

  // 已加载内容的章节（content 非空）
  const loadedChapters = useMemo(
    () => chapters.filter((ch) => ch.content),
    [chapters]
  );

  // 所有章节的索引映射（用于快速查找）
  const chapterIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    chapters.forEach((ch) => map.set(ch.id, ch.index));
    return map;
  }, [chapters]);

  // ── 加载更多章节 ──────────────────────────────────────────────
  const loadMore = useCallback(
    async (direction: "forward" | "backward") => {
      if (isLoadingRef.current || !novelId) return;
      if (loadedChapters.length === 0) return;

      const container = containerRef.current;
      if (!container) return;

      isLoadingRef.current = true;
      setIsLoadingMore(true);

      try {
        if (direction === "forward") {
          // 向后加载：从最后一个已加载章节之后开始
          const lastLoaded = loadedChapters[loadedChapters.length - 1];
          const startIndex = lastLoaded.index + 1;
          if (startIndex >= chapters.length) return; // 已经是最后一章

          const loaded = await loadChapters(novelId, startIndex, LOAD_BATCH);
          if (loaded.length > 0) {
            addChapters(loaded);
          }
        } else {
          // 向前加载：从第一个已加载章节之前开始
          const firstLoaded = loadedChapters[0];
          const startIndex = Math.max(0, firstLoaded.index - LOAD_BATCH);
          if (startIndex >= firstLoaded.index) return; // 已经是第一章

          // 保存滚动位置
          const oldScrollHeight = container.scrollHeight;
          const oldScrollTop = container.scrollTop;

          const loaded = await loadChapters(novelId, startIndex, LOAD_BATCH);
          if (loaded.length > 0) {
            addChapters(loaded);

            // 补偿滚动位置：新内容插入到顶部，需要调整 scrollTop
            // 使用 rAF 等待 DOM 更新
            requestAnimationFrame(() => {
              const newScrollHeight = container.scrollHeight;
              const heightDiff = newScrollHeight - oldScrollHeight;
              container.scrollTop = oldScrollTop + heightDiff;
            });
          }
        }
      } catch (err) {
        console.error("[ContinuousScroll] Failed to load chapters:", err);
      } finally {
        isLoadingRef.current = false;
        setIsLoadingMore(false);
      }
    },
    [novelId, loadedChapters, chapters.length, addChapters]
  );

  // ── 滚动到指定章节 ────────────────────────────────────────────
  const scrollToChapter = useCallback(
    (chapterId: string) => {
      const container = containerRef.current;
      if (!container) return;

      const target = container.querySelector(
        `[data-chapter-id="${chapterId}"]`
      );
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        // 章节未加载，先加载再滚动
        const chapterIndex = chapterIndexMap.get(chapterId);
        if (chapterIndex === undefined) return;

        const startIndex = Math.max(0, chapterIndex - 5);
        loadChapters(novelId, startIndex, LOAD_BATCH + 5).then((loaded) => {
          if (loaded.length > 0) {
            addChapters(loaded);
            // 等待渲染后滚动
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const el = containerRef.current?.querySelector(
                  `[data-chapter-id="${chapterId}"]`
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

  // ── IntersectionObserver：章节检测 ────────────────────────────
  const onChapterChangeRef = useRef(onChapterChange);
  onChapterChangeRef.current = onChapterChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || loadedChapters.length === 0) return;

    // 观测每个章节标记元素
    const observer = new IntersectionObserver(
      (entries) => {
        // 找到进入视口的章节标记
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const chapterId = entry.target.getAttribute("data-chapter-id");
            if (chapterId) {
              onChapterChangeRef.current(chapterId);
            }
          }
        }
      },
      {
        root: container,
        rootMargin: "-10% 0px -80% 0px", // 只检测顶部 10% 区域
        threshold: 0,
      }
    );

    // 观测所有章节标记
    const markers = container.querySelectorAll("[data-chapter-id]");
    markers.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [loadedChapters]);

  // ── IntersectionObserver：边缘加载 ────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container || loadedChapters.length === 0) return;

    // 创建顶部哨兵
    const topSentinel = document.createElement("div");
    topSentinel.style.height = "1px";
    topSentinel.style.width = "100%";
    if (container.firstChild) {
      container.insertBefore(topSentinel, container.firstChild);
    }

    // 创建底部哨兵
    const bottomSentinel = document.createElement("div");
    bottomSentinel.style.height = "1px";
    bottomSentinel.style.width = "100%";
    container.appendChild(bottomSentinel);

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
      {
        root: container,
        rootMargin: `${TOP_THRESHOLD}px 0px ${BOTTOM_THRESHOLD}px 0px`,
        threshold: 0,
      }
    );

    edgeObserver.observe(topSentinel);
    edgeObserver.observe(bottomSentinel);

    return () => {
      edgeObserver.disconnect();
      topSentinel.remove();
      bottomSentinel.remove();
    };
  }, [loadedChapters, loadMore]);

  return { containerRef, loadedChapters, scrollToChapter, isLoadingMore };
}
