import { create } from "zustand";

interface SummaryItem {
  id: string;
  novelId: string;
  chapterId: string;
  chapterTitle: string;
  content: string;
  tokensUsed: number;
  createdAt: number;
  updatedAt: number;
  type: "chapter" | "global" | "timeline" | "characters";
  usedFallback?: boolean;
  deleted?: number;
}

/** 缓存条目 */
interface CacheEntry<T> {
  version: number;
  key: string;
  result: T;
}

interface SummaryState {
  summaries: SummaryItem[];
  isGenerating: boolean;
  generateProgress: { current: number; total: number } | null;
  addSummary: (summary: SummaryItem) => void;
  setSummaries: (summaries: SummaryItem[] | ((prev: SummaryItem[]) => SummaryItem[])) => void;
  setGenerating: (generating: boolean) => void;
  setProgress: (progress: { current: number; total: number } | null) => void;
  getSummariesByChapter: (chapterId: string) => SummaryItem[];
  getSummariesByNovel: (novelId: string) => SummaryItem[];
  getGlobalSummaries: () => SummaryItem[];
}

/**
 * 纯内存查询缓存（非响应式）。
 * 这些缓存仅用于避免重复 filter，不参与 React 渲染；
 * 必须放在 store 状态之外，否则在渲染期间调用 getter 触发 set()
 * 会导致 React 报 "Cannot update a component while rendering"。
 */
let _cacheVersion = 0;
let _novelCache: CacheEntry<SummaryItem[]> | null = null;
let _chapterCache: CacheEntry<SummaryItem[]> | null = null;
let _globalCache: CacheEntry<SummaryItem[]> | null = null;

export const useSummaryStore = create<SummaryState>((set, get) => ({
  summaries: [],
  isGenerating: false,
  generateProgress: null,

  addSummary: (summary) =>
    set((s) => {
      _cacheVersion += 1;
      const filtered = s.summaries.filter(
        (item) =>
          !(
            item.novelId === summary.novelId &&
            item.chapterId === summary.chapterId &&
            item.type === summary.type
          )
      );
      return { summaries: [...filtered, summary] };
    }),

  setSummaries: (summaries) => set((s) => {
    _cacheVersion += 1;
    return { summaries: typeof summaries === "function" ? summaries(s.summaries) : summaries };
  }),

  setGenerating: (generating) => set({ isGenerating: generating }),

  setProgress: (progress) => set({ generateProgress: progress }),

  getSummariesByChapter: (chapterId) => {
    const state = get();
    if (_chapterCache && _chapterCache.version === _cacheVersion && _chapterCache.key === chapterId) {
      return _chapterCache.result;
    }
    const result = state.summaries.filter((s) => s.chapterId === chapterId);
    _chapterCache = { version: _cacheVersion, key: chapterId, result };
    return result;
  },

  getSummariesByNovel: (novelId) => {
    const state = get();
    if (_novelCache && _novelCache.version === _cacheVersion && _novelCache.key === novelId) {
      return _novelCache.result;
    }
    const result = state.summaries.filter((s) => s.novelId === novelId);
    _novelCache = { version: _cacheVersion, key: novelId, result };
    return result;
  },

  getGlobalSummaries: () => {
    const state = get();
    if (_globalCache && _globalCache.version === _cacheVersion) {
      return _globalCache.result;
    }
    const result = state.summaries.filter(
      (s) => s.type === "global" || s.type === "timeline" || s.type === "characters"
    );
    _globalCache = { version: _cacheVersion, key: "global", result };
    return result;
  },
}));

export type { SummaryItem };
