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

  setSummaries: (summaries) => set((s) => ({
    summaries: typeof summaries === "function" ? summaries(s.summaries) : summaries,
  })),

  setGenerating: (generating) => set({ isGenerating: generating }),

  setProgress: (progress) => set({ generateProgress: progress }),

  getSummariesByChapter: (chapterId) => {
    return get().summaries.filter((s) => s.chapterId === chapterId);
  },

  getSummariesByNovel: (novelId) => {
    return get().summaries.filter((s) => s.novelId === novelId);
  },

  getGlobalSummaries: () => {
    return get().summaries.filter(
      (s) => s.type === "global" || s.type === "timeline" || s.type === "characters"
    );
  },
}));

export type { SummaryItem };
