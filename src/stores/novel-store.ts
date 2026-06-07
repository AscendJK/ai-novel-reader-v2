import { create } from "zustand";
import type { Novel } from "@/parsers/types";
import { syncClient } from "@/sync/sync-client";
import { userKey } from "@/lib/user-utils";

interface ReadPosition { chapterId: string; chapterIndex: number }

interface NovelState {
  currentNovel: Novel | null;
  novels: Novel[];
  selectedChapterId: string | null;
  readingPositions: Record<string, ReadPosition>;
  setCurrentNovel: (novel: Novel | null) => void;
  setSelectedChapter: (chapterId: string | null) => void;
  addNovel: (novel: Novel) => void;
  removeNovel: (novelId: string) => void;
  getReadingPosition: (novelId: string) => ReadPosition | null;
  saveReadingPosition: (novelId: string, chapterId: string, chapterIndex: number) => void;
  addChapters: (chapters: Novel["chapters"]) => void;
}

function loadPositions(): Record<string, ReadPosition> {
  try {
    return JSON.parse(localStorage.getItem(userKey("novel-reader-positions")) || "{}");
  } catch { return {}; }
}

function savePositions(positions: Record<string, ReadPosition>) {
  try { localStorage.setItem(userKey("novel-reader-positions"), JSON.stringify(positions)); } catch { /* ignore */ }
}

export function getLastOpenedTimes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(userKey("novel-reader-last-opened")) || "{}");
  } catch { return {}; }
}

export const useNovelStore = create<NovelState>((set, get) => ({
  currentNovel: null,
  novels: [],
  selectedChapterId: null,
  readingPositions: loadPositions(),

  setCurrentNovel: (novel) => {
    if (novel) {
      const pos = get().readingPositions[novel.id];
      const chapter = pos
        ? novel.chapters.find((c) => c.id === pos.chapterId)
        : null;
      const selectedId = chapter?.id ?? novel.chapters[0]?.id ?? null;
      const selectedIdx = chapter
        ? novel.chapters.findIndex((c) => c.id === chapter.id)
        : 0;
      const positions = {
        ...get().readingPositions,
        [novel.id]: { chapterId: selectedId, chapterIndex: selectedIdx >= 0 ? selectedIdx : 0 },
      };
      savePositions(positions);
      try {
        const opened = getLastOpenedTimes();
        opened[novel.id] = Date.now();
        localStorage.setItem(userKey("novel-reader-last-opened"), JSON.stringify(opened));
      } catch { /* ignore */ }
      set({
        currentNovel: novel,
        selectedChapterId: selectedId,
        readingPositions: positions,
      });
    } else {
      set({ currentNovel: null, selectedChapterId: null });
    }
  },

  setSelectedChapter: (chapterId) => {
    const { currentNovel } = get();
    if (currentNovel && chapterId) {
      const idx = currentNovel.chapters.findIndex((c) => c.id === chapterId);
      const positions = {
        ...get().readingPositions,
        [currentNovel.id]: { chapterId, chapterIndex: idx >= 0 ? idx : 0 },
      };
      savePositions(positions);
      set({ selectedChapterId: chapterId, readingPositions: positions });
      syncClient.pushNow();
    } else {
      set({ selectedChapterId: chapterId });
    }
  },

  addNovel: (novel) => set((s) => {
    if (s.novels.some((n) => n.id === novel.id)) return s;
    return { novels: [...s.novels, novel] };
  }),

  removeNovel: (novelId) =>
    set((s) => {
      const positions = { ...s.readingPositions };
      delete positions[novelId];
      savePositions(positions);
      return {
        novels: s.novels.filter((n) => n.id !== novelId),
        currentNovel: s.currentNovel?.id === novelId ? null : s.currentNovel,
        readingPositions: positions,
      };
    }),

  getReadingPosition: (novelId) => get().readingPositions[novelId] || null,

  saveReadingPosition: (novelId, chapterId, chapterIndex) => {
    const positions = { ...get().readingPositions, [novelId]: { chapterId, chapterIndex } };
    savePositions(positions);
    set({ readingPositions: positions });
  },

  addChapters: (chapters) => {
    const { currentNovel } = get();
    if (!currentNovel) return;

    // 创建章节映射（id -> 章节）
    const chapterMap = new Map(currentNovel.chapters.map(c => [c.id, c]));

    // 更新或添加章节
    for (const ch of chapters) {
      const existing = chapterMap.get(ch.id);
      if (existing) {
        // 更新现有章节（保留标题，更新内容）
        chapterMap.set(ch.id, { ...existing, content: ch.content });
      } else {
        // 添加新章节
        chapterMap.set(ch.id, ch);
      }
    }

    // 转换为数组并排序
    const mergedChapters = Array.from(chapterMap.values())
      .sort((a, b) => a.index - b.index);

    set({
      currentNovel: {
        ...currentNovel,
        chapters: mergedChapters,
      },
    });
  },
}));
