/**
 * useSearch hook - 语义搜索逻辑
 * 从 SummaryPanel.tsx 中提取
 */

import { useState, useCallback, useRef } from "react";
import { buildIndex, retrieveRelevantWithDetails } from "@/rag/index";
import { isEmbeddingEngine } from "@/rag/engines";
import { useRAGStore } from "@/stores/rag-store";
import { loadNovel } from "@/db/repositories";

interface UseSearchOptions {
  /** 小说 ID */
  novelId: string;
  /** 章节列表 */
  chapters: { id: string; title: string; content: string }[];
}

interface SearchResult {
  content: string;
  score: number;
}

interface UseSearchReturn {
  /** 搜索查询 */
  searchQuery: string;
  /** 设置搜索查询 */
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  /** 搜索结果 */
  searchResults: SearchResult[];
  /** 使用的搜索引擎 */
  searchEngine: string;
  /** 是否正在搜索 */
  searchLoading: boolean;
  /** 搜索错误 */
  searchError: string | null;
  /** 执行搜索 */
  handleSearch: () => Promise<void>;
  /** 清除搜索结果 */
  clearSearch: () => void;
}

export function useSearch({
  novelId,
  chapters,
}: UseSearchOptions): UseSearchReturn {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchEngine, setSearchEngine] = useState<string>("none");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const engine = useRAGStore((s) => s.engine);
  const abortRef = useRef<AbortController | null>(null);

  // 执行搜索（取消上一次未完成的搜索）
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    // 取消上一次搜索
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSearchLoading(true);
    setSearchError(null);

    try {
      let searchEngine = engine;
      if (isEmbeddingEngine(searchEngine)) {
        try {
          await buildIndex(novelId, chapters, searchEngine, undefined, { cacheOnly: true });
        } catch {
          searchEngine = "tfidf";
        }
      }

      if (searchEngine === "tfidf") {
        let buildChapters = chapters;
        const hasEmptyContent = chapters.some(ch => !ch.content);
        if (hasEmptyContent) {
          const fullNovel = await loadNovel(novelId, undefined, true);
          if (fullNovel) buildChapters = fullNovel.chapters;
        }
        await buildIndex(novelId, buildChapters, "tfidf");
      }

      if (controller.signal.aborted) return; // 已被新搜索取消
      // 取消信号一路带进检索：只丢结果不停工，等于白烧一次查询编码
      const detail = await retrieveRelevantWithDetails(novelId, searchQuery.trim(), 10, searchEngine, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return; // 结果已过期
      setSearchResults(detail.results);
      setSearchEngine(detail.engine);
    } catch (e) {
      if (controller.signal.aborted) return; // 取消的搜索不显示错误
      setSearchError(e instanceof Error ? e.message : "搜索失败");
    } finally {
      if (!controller.signal.aborted) setSearchLoading(false);
    }
  }, [searchQuery, novelId, chapters, engine]);

  // 清空不只是抹干界面：在飞的那一趟必须一起掐掉，否则它回来会把上一本的结果铺上去
  const clearSearch = useCallback(() => {
    abortRef.current?.abort();
    setSearchQuery("");
    setSearchResults([]);
    setSearchEngine("none");
    setSearchError(null);
    // 被掐掉那趟的 finally 只关"没被取消的"转圈，这一笔得替它做
    setSearchLoading(false);
  }, []);

  return {
    searchQuery,
    setSearchQuery,
    searchResults,
    searchEngine,
    searchLoading,
    searchError,
    handleSearch,
    clearSearch,
  };
}
