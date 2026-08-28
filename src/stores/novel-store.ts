import { create } from "zustand";
import type { Novel } from "@/parsers/types";
import { userKey } from "@/lib/user-utils";

interface ReadPosition { chapterId: string; chapterIndex: number; scrollTop?: number; /** 章节内偏移量（像素），相对于章节元素顶部 */ chapterOffset?: number; /** 同步冲突解决时间戳 */ updatedAt?: number }

// Shallow equality helper for Zustand selectors
export function shallow<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

interface NovelState {
  currentNovel: Novel | null;
  novels: Novel[];
  selectedChapterId: string | null;
  readingPositions: Record<string, ReadPosition>;
  lastOpenedVersion: number; // 每次打开小说时递增，用于书架排序响应
  setCurrentNovel: (novel: Novel | null) => void;
  setSelectedChapter: (chapterId: string | null, scrollTop?: number) => void;
  addNovel: (novel: Novel) => void;
  removeNovel: (novelId: string) => void;
  getReadingPosition: (novelId: string) => ReadPosition | null;
  saveReadingPosition: (novelId: string, chapterId: string, chapterIndex: number, scrollTop?: number, chapterOffset?: number) => void;
  saveScrollTop: (scrollTop: number, chapterOffset?: number) => void;
  addChapters: (chapters: Novel["chapters"]) => void;
  /**
   * 从 localStorage 重新加载阅读进度（登录/切换用户后调用）。
   *
   * 背景：readingPositions 只在模块加载时从 localStorage 读一次，而 localStorage
   * 的 key 带用户名后缀（userKey）。应用启动时（未登录）读到的是无后缀 key →
   * 空对象；登录完成后没有代码重新加载 → 打开小说时查不到进度 → 回到第一章。
   * 离线重登时 syncOnce 失败、没有服务器数据合并，问题必然复现。
   * 此方法在登录/切换用户后重新读取当前用户的进度，覆盖在线/离线两种场景。
   */
  reloadReadingPositions: () => void;
}

function loadPositions(): Record<string, ReadPosition> {
  try {
    return JSON.parse(localStorage.getItem(userKey("novel-reader-positions")) || "{}");
  } catch (e) {
    console.debug("[novel-store] 读取阅读位置失败:", e instanceof Error ? e.message : e);
    return {};
  }
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
  lastOpenedVersion: 0,

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
      // 仅在“纯定位”场景保留已有时间戳：有进度且能匹配到章节（打开同一进度）
      // 时，不刷新 updatedAt，避免把“打开动作”当作比实际阅读更晚的进度推送。
      // 其余情况（无进度、或进度章节已失效）视为章节变化，刷新时间戳。
      const pureReposition = !!(pos && chapter);
      const positions = {
        ...get().readingPositions,
        [novel.id]: {
          chapterId: selectedId,
          chapterIndex: selectedIdx >= 0 ? selectedIdx : 0,
          // 保留已有的滚动位置
          scrollTop: pos?.scrollTop,
          chapterOffset: pos?.chapterOffset,
          updatedAt: pureReposition ? pos?.updatedAt ?? Date.now() : Date.now(),
        },
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
        lastOpenedVersion: get().lastOpenedVersion + 1,
      });
    } else {
      set({ currentNovel: null, selectedChapterId: null });
    }
  },

  setSelectedChapter: (chapterId, scrollTop) => {
    const { currentNovel } = get();
    if (currentNovel && chapterId) {
      const idx = currentNovel.chapters.findIndex((c) => c.id === chapterId);
      const existingPos = get().readingPositions[currentNovel.id];
      const positions = {
        ...get().readingPositions,
        [currentNovel.id]: {
          chapterId,
          chapterIndex: idx >= 0 ? idx : 0,
          scrollTop: scrollTop !== undefined ? scrollTop : existingPos?.scrollTop,
          chapterOffset: existingPos?.chapterOffset,
          updatedAt: Date.now(),
        },
      };
      savePositions(positions);
      set({ selectedChapterId: chapterId, readingPositions: positions });
      // 不在这里调用 pushNow()，位置数据由 saveScrollTop 每 3 秒自动同步
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

  saveReadingPosition: (novelId, chapterId, chapterIndex, scrollTop, chapterOffset?) => {
    const existingPos = get().readingPositions[novelId];
    const newScrollTop = scrollTop !== undefined ? scrollTop : existingPos?.scrollTop;
    const newChapterOffset = chapterOffset !== undefined ? chapterOffset : existingPos?.chapterOffset;
    // Skip update if nothing changed
    if (existingPos && existingPos.chapterId === chapterId && existingPos.chapterIndex === chapterIndex
        && existingPos.scrollTop === newScrollTop && existingPos.chapterOffset === newChapterOffset) return;
    const positions = {
      ...get().readingPositions,
      [novelId]: {
        chapterId,
        chapterIndex,
        scrollTop: newScrollTop,
        chapterOffset: newChapterOffset,
        updatedAt: Date.now(),
      },
    };
    savePositions(positions);
    set({ readingPositions: positions });
  },

  saveScrollTop: (scrollTop, chapterOffset) => {
    const { currentNovel, readingPositions } = get();
    if (!currentNovel) return;
    const existingPos = readingPositions[currentNovel.id];
    if (!existingPos) return;
    const newChapterOffset = chapterOffset ?? existingPos.chapterOffset;
    // Skip update if nothing changed
    if (existingPos.scrollTop === scrollTop && existingPos.chapterOffset === newChapterOffset) return;
    const positions = {
      ...readingPositions,
      [currentNovel.id]: { ...existingPos, scrollTop, chapterOffset: newChapterOffset },
    };
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

  reloadReadingPositions: () => {
    const loaded = loadPositions();
    const current = get().readingPositions;
    // 按 updatedAt 合并，而不是让 store 无条件覆盖 loaded：
    // 修复技术债——若 store 中残留旧进度（早于服务器拉取的新数据），
    // 直接展开会用旧值覆盖刚同步的服务器进度。改为保留 updatedAt 更新的
    // 一方，并保留各自独有字段（scrollTop, chapterOffset）。
    const merged = { ...loaded };
    for (const [novelId, pos] of Object.entries(current)) {
      const loadedPos = loaded[novelId];
      if (!loadedPos || (pos.updatedAt || 0) >= (loadedPos.updatedAt || 0)) {
        merged[novelId] = { ...loadedPos, ...pos };
      }
    }
    set({ readingPositions: merged });
  },
}));
