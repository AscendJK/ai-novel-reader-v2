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
  /** 内部缓存版本号，每次修改 summaries 时递增 */
  _cacheVersion: number;
  /** 缓存存储（移至 store 内，避免 HMR 时重置） */
  _novelCache: CacheEntry<SummaryItem[]> | null;
  _chapterCache: CacheEntry<SummaryItem[]> | null;
  _globalCache: CacheEntry<SummaryItem[]> | null;
  addSummary: (summary: SummaryItem) => void;
  setSummaries: (summaries: SummaryItem[] | ((prev: SummaryItem[]) => SummaryItem[])) => void;
  setGenerating: (generating: boolean) => void;
  setProgress: (progress: { current: number; total: number } | null) => void;
  getSummariesByChapter: (chapterId: string) => SummaryItem[];
  getSummariesByNovel: (novelId: string) => SummaryItem[];
  getGlobalSummaries: () => SummaryItem[];
}

export const useSummaryStore = create<SummaryState>((set, get) => ({
  summaries: [],
  isGenerating: false,
  generateProgress: null,
  _cacheVersion: 0,
  _novelCache: null,
  _chapterCache: null,
  _globalCache: null,

  addSummary: (summary) =>
    set((s) => {
      const filtered = s.summaries.filter(
        (item) =>
          !(
            item.novelId === summary.novelId &&
            item.chapterId === summary.chapterId &&
            item.type === summary.type
          )
      );
      return { summaries: [...filtered, summary], _cacheVersion: s._cacheVersion + 1 };
    }),

  setSummaries: (summaries) => set((s) => ({
    _cacheVersion: s._cacheVersion + 1,
    summaries: typeof summaries === "function" ? summaries(s.summaries) : summaries,
  })),

  setGenerating: (generating) => set({ isGenerating: generating }),

  setProgress: (progress) => set({ generateProgress: progress }),

  getSummariesByChapter: (chapterId) => {
    const state = get();
    if (state._chapterCache && state._chapterCache.version === state._cacheVersion && state._chapterCache.key === chapterId) {
      return state._chapterCache.result;
    }
    const result = state.summaries.filter((s) => s.chapterId === chapterId);
    set({ _chapterCache: { version: state._cacheVersion, key: chapterId, result } });
    return result;
  },

  getSummariesByNovel: (novelId) => {
    const state = get();
    if (state._novelCache && state._novelCache.version === state._cacheVersion && state._novelCache.key === novelId) {
      return state._novelCache.result;
    }
    const result = state.summaries.filter((s) => s.novelId === novelId);
    set({ _novelCache: { version: state._cacheVersion, key: novelId, result } });
    return result;
  },

  getGlobalSummaries: () => {
    const state = get();
    if (state._globalCache && state._globalCache.version === state._cacheVersion) {
      return state._globalCache.result;
    }
    const result = state.summaries.filter(
      (s) => s.type === "global" || s.type === "timeline" || s.type === "characters"
    );
    set({ _globalCache: { version: state._cacheVersion, key: "global", result } });
    return result;
  },
}));

export type { SummaryItem };
