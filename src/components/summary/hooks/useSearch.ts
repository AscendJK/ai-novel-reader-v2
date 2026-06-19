/**
 * useSearch hook - 语义搜索逻辑
 * 从 SummaryPanel.tsx 中提取
 */

import { useState, useCallback } from "react";
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

  // 执行搜索
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchError(null);

    try {
      // 确保索引已加载到内存
      let searchEngine = engine;
      if (isEmbeddingEngine(searchEngine)) {
        try {
          await buildIndex(novelId, chapters, searchEngine, undefined, { cacheOnly: true });
        } catch {
          // 索引未缓存，降级为 TF-IDF
          searchEngine = "tfidf";
        }
      }

      // 如果是 TF-IDF，需要构建索引
      if (searchEngine === "tfidf") {
        // 检查章节内容是否完整（懒加载可能导致大部分章节内容为空）
        let buildChapters = chapters;
        const hasEmptyContent = chapters.some(ch => !ch.content);
        if (hasEmptyContent) {
          const fullNovel = await loadNovel(novelId, undefined, true);
          if (fullNovel) {
            buildChapters = fullNovel.chapters;
          }
        }
        await buildIndex(novelId, buildChapters, "tfidf");
      }

      // 执行搜索
      const detail = await retrieveRelevantWithDetails(novelId, searchQuery.trim(), 10, searchEngine);
      setSearchResults(detail.results);
      setSearchEngine(detail.engine);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "搜索失败");
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery, novelId, chapters, engine]);

  // 清除搜索结果
  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchEngine("none");
    setSearchError(null);
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
