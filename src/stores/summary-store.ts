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

// Cache for filtered summaries to avoid creating new arrays on every getter call
let _summariesVersion = 0;
let _novelCache: { version: number; novelId: string; result: SummaryItem[] } | null = null;
let _chapterCache: { version: number; chapterId: string; result: SummaryItem[] } | null = null;
let _globalCache: { version: number; result: SummaryItem[] } | null = null;

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

export const useSummaryStore = create<SummaryState>((set, get) => ({
  summaries: [],
  isGenerating: false,
  generateProgress: null,

  addSummary: (summary) =>
    set((s) => {
      _summariesVersion++;
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
    _summariesVersion++;
    return {
      summaries: typeof summaries === "function" ? summaries(s.summaries) : summaries,
    };
  }),

  setGenerating: (generating) => set({ isGenerating: generating }),

  setProgress: (progress) => set({ generateProgress: progress }),

  getSummariesByChapter: (chapterId) => {
    if (_chapterCache && _chapterCache.version === _summariesVersion && _chapterCache.chapterId === chapterId) {
      return _chapterCache.result;
    }
    const result = get().summaries.filter((s) => s.chapterId === chapterId);
    _chapterCache = { version: _summariesVersion, chapterId, result };
    return result;
  },

  getSummariesByNovel: (novelId) => {
    if (_novelCache && _novelCache.version === _summariesVersion && _novelCache.novelId === novelId) {
      return _novelCache.result;
    }
    const result = get().summaries.filter((s) => s.novelId === novelId);
    _novelCache = { version: _summariesVersion, novelId, result };
    return result;
  },

  getGlobalSummaries: () => {
    if (_globalCache && _globalCache.version === _summariesVersion) {
      return _globalCache.result;
    }
    const result = get().summaries.filter(
      (s) => s.type === "global" || s.type === "timeline" || s.type === "characters"
    );
    _globalCache = { version: _summariesVersion, result };
    return result;
  },
}));

export type { SummaryItem };
