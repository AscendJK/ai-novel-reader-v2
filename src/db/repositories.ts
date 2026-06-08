import { sharedDB, getUserDB, deleteUserDB } from "./database";
import type { Novel, NovelMeta } from "@/parsers/types";
import type { SummaryItem } from "@/stores/summary-store";
import type { MapRecord, GraphRecord } from "./database";
import { useRAGStore } from "@/stores/rag-store";

export type { MapRecord, GraphRecord };

export async function saveNovel(novel: Novel): Promise<void> {
  const db = getUserDB();
  try {
    await db.transaction("rw", db.novels, db.chapters, async () => {
      await db.novels.put({
        id: novel.id,
        title: novel.title,
        author: novel.author,
        fileName: novel.fileName,
        fileFormat: novel.fileFormat,
        totalChars: novel.totalChars,
        createdAt: novel.createdAt,
        updatedAt: novel.updatedAt,
      });

      const chapterRecords = novel.chapters.map((ch) => ({
        id: ch.id,
        novelId: ch.novelId,
        index: ch.index,
        title: ch.title,
        content: ch.content,
        startOffset: ch.startOffset,
        endOffset: ch.endOffset,
      }));

      await db.chapters.where("novelId").equals(novel.id).delete();
      await db.chapters.bulkPut(chapterRecords);
    });
  } catch (e) {
    console.error("saveNovel failed:", e);
  }
}

export async function loadNovel(novelId: string, chapterIndex?: number): Promise<Novel | null> {
  const db = getUserDB();
  try {
    const record = await db.novels.get(novelId);
    if (!record) return null;

    const allChapterRecords = await db.chapters.where("novelId").equals(novelId).sortBy("index");
    const totalCount = allChapterRecords.length;

    // 如果指定了章节索引，只加载当前章节及前后各10章的内容
    let chaptersToLoad = allChapterRecords;
    if (chapterIndex !== undefined && totalCount > 21) {
      const start = Math.max(0, chapterIndex - 10);
      const end = Math.min(totalCount, chapterIndex + 11);
      chaptersToLoad = allChapterRecords.slice(start, end);
    }

    // 构建完整的章节目录（所有章节都有标题，但只有部分有内容）
    const loadedIndices = new Set(chaptersToLoad.map(ch => ch.index));
    const chapters = allChapterRecords.map((ch) => ({
      id: ch.id,
      novelId: ch.novelId,
      index: ch.index,
      title: ch.title,
      content: loadedIndices.has(ch.index) ? ch.content : "",  // 未加载的章节内容为空
      startOffset: ch.startOffset ?? 0,
      endOffset: ch.endOffset ?? ch.content.length,
    }));

    return {
      id: record.id, title: record.title, author: record.author,
      fileName: record.fileName, fileFormat: record.fileFormat,
      totalChars: record.totalChars, chapterCount: totalCount,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      chapters,
    };
  } catch (e) {
    console.error("loadNovel failed:", e);
    return null;
  }
}

/** 加载指定章节（用于懒加载） */
export async function loadChapter(novelId: string, chapterIndex: number): Promise<ChapterRecord | null> {
  const db = getUserDB();
  try {
    // Use index filter instead of loading all chapters
    const chapter = await db.chapters
      .where("novelId")
      .equals(novelId)
      .and((ch) => ch.index === chapterIndex)
      .first();
    return chapter || null;
  } catch (e) {
    console.error("loadChapter failed:", e);
    return null;
  }
}

/** 批量加载章节（用于懒加载） */
export async function loadChapters(novelId: string, startIndex: number, count: number): Promise<ChapterRecord[]> {
  const db = getUserDB();
  try {
    // Use index filter instead of loading all chapters
    const chapters = await db.chapters
      .where("novelId")
      .equals(novelId)
      .and((ch) => ch.index >= startIndex && ch.index < startIndex + count)
      .sortBy("index");
    return chapters;
  } catch (e) {
    console.error("loadChapters failed:", e);
    return [];
  }
}

export async function loadAllNovelMeta(): Promise<NovelMeta[]> {
  const db = getUserDB();
  try {
    const records = await db.novels.orderBy("createdAt").reverse().toArray();
    // Use count queries per novel instead of loading all chapters
    const countMap = new Map<string, number>();
    for (const r of records) {
      const count = await db.chapters.where("novelId").equals(r.id).count();
      countMap.set(r.id, count);
    }
    return records.map((r) => ({
      id: r.id, title: r.title, author: r.author,
      fileName: r.fileName, fileFormat: r.fileFormat,
      totalChars: r.totalChars, chapterCount: countMap.get(r.id) || 0,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    }));
  } catch (e) {
    console.error("loadAllNovelMeta failed:", e);
    return [];
  }
}

export async function loadAllNovels(): Promise<Novel[]> {
  const db = getUserDB();
  try {
    const records = await db.novels.orderBy("createdAt").reverse().toArray();
    // Load chapters per novel instead of all at once
    return await Promise.all(records.map(async (record) => {
      const chapterRecords = await db.chapters
        .where("novelId")
        .equals(record.id)
        .sortBy("index");
      return {
        id: record.id, title: record.title, author: record.author,
        fileName: record.fileName, fileFormat: record.fileFormat,
        totalChars: record.totalChars, chapterCount: chapterRecords.length,
        createdAt: record.createdAt, updatedAt: record.updatedAt,
        chapters: chapterRecords.map((ch) => ({
          id: ch.id, novelId: ch.novelId, index: ch.index,
          title: ch.title, content: ch.content,
          startOffset: ch.startOffset ?? 0, endOffset: ch.endOffset ?? ch.content.length,
        })),
      };
    }));
  } catch (e) {
    console.error("loadAllNovels failed:", e);
    return [];
  }
}

export async function deleteNovel(novelId: string): Promise<void> {
  const udb = getUserDB();
  try {
    await udb.transaction("rw", udb.chapters, udb.summaries, udb.notes, udb.novels, udb.graphs, udb.maps, async () => {
      await udb.chapters.where("novelId").equals(novelId).delete();
      // Soft-delete summaries, notes, graphs, and maps so sync propagates the deletion
      const now = Date.now();
      const novelSummaries = await udb.summaries.where("novelId").equals(novelId).toArray();
      for (const s of novelSummaries) {
        if (!s.deleted) await udb.summaries.put({ ...s, deleted: now, updatedAt: now });
      }
      const novelNotes = await udb.notes.where("novelId").equals(novelId).toArray();
      for (const n of novelNotes) {
        if (!n.deleted) await udb.notes.put({ ...n, deleted: now, updatedAt: now });
      }
      const novelGraphs = await udb.graphs.where("novelId").equals(novelId).toArray();
      for (const g of novelGraphs) {
        if (!g.deleted) await udb.graphs.put({ ...g, deleted: now, updatedAt: now });
      }
      const novelMaps = await udb.maps.where("novelId").equals(novelId).toArray();
      for (const m of novelMaps) {
        if (!m.deleted) await udb.maps.put({ ...m, deleted: now, updatedAt: now });
      }
      await udb.novels.delete(novelId);
    });
    // Clean up shared data (ragCache)
    const cacheEntries = await sharedDB.ragCache.where("novelId").equals(novelId).toArray();
    for (const entry of cacheEntries) {
      await sharedDB.ragCache.delete(entry.id);
      useRAGStore.getState().removeCachedKey(entry.id);
    }

    try {
      const user = localStorage.getItem("sync-username");
      const posKey = user ? `novel-reader-positions:${user}` : "novel-reader-positions";
      const stored = localStorage.getItem(posKey);
      if (stored) {
        const positions = JSON.parse(stored);
        delete positions[novelId];
        localStorage.setItem(posKey, JSON.stringify(positions));
      }
      const openedKey = user ? `novel-reader-last-opened:${user}` : "novel-reader-last-opened";
      const opened = localStorage.getItem(openedKey);
      if (opened) {
        const map = JSON.parse(opened);
        delete map[novelId];
        localStorage.setItem(openedKey, JSON.stringify(map));
      }
    } catch { /* ignore */ }
  } catch (e) {
    console.error("deleteNovel failed:", e);
  }
}

export async function saveSummary(summary: SummaryItem & { novelId: string }): Promise<void> {
  try {
    await getUserDB().summaries.put({
      id: summary.id, novelId: summary.novelId,
      chapterId: summary.chapterId, chapterTitle: summary.chapterTitle,
      content: summary.content, tokensUsed: summary.tokensUsed,
      createdAt: summary.createdAt, updatedAt: summary.updatedAt, type: summary.type,
      usedFallback: summary.usedFallback, deleted: summary.deleted,
    });
  } catch (e) {
    console.error("saveSummary failed:", e);
  }
}

export async function loadSummaries(novelId: string): Promise<(SummaryItem & { novelId: string })[]> {
  try {
    const all = await getUserDB().summaries.where("novelId").equals(novelId).sortBy("createdAt");
    return all.filter((s) => !s.deleted);
  } catch (e) {
    console.error("loadSummaries failed:", e);
    return [];
  }
}

export async function saveSetting(key: string, value: unknown): Promise<void> {
  try {
    await sharedDB.settings.put({ key, value });
  } catch (e) {
    console.error("saveSetting failed:", e);
  }
}

export async function loadSetting<T>(key: string): Promise<T | null> {
  try {
    const record = await sharedDB.settings.get(key);
    return record ? (record.value as T) : null;
  } catch (e) {
    console.error("loadSetting failed:", e);
    return null;
  }
}

// ── notes ───────────────────────────────────────────────────────────

export interface NoteItem {
  id: string;
  novelId: string;
  chapterId: string;
  chapterTitle: string;
  content: string;
  source: "user" | "ai";
  sourceLabel: string;
  createdAt: number;
  updatedAt: number;
  deleted?: number;
}

export async function saveNote(note: NoteItem): Promise<void> {
  try { await getUserDB().notes.put({ ...note }); }
  catch (e) { console.error("saveNote failed:", e); }
}

export async function loadNotes(novelId: string): Promise<NoteItem[]> {
  try {
    const all = await getUserDB().notes.where("novelId").equals(novelId).reverse().sortBy("createdAt");
    return all.filter((n) => !n.deleted);
  }
  catch (e) { console.error("loadNotes failed:", e); return []; }
}

export async function loadAllNotes(): Promise<NoteItem[]> {
  try {
    const all = await getUserDB().notes.orderBy("createdAt").reverse().toArray();
    return all.filter((n) => !n.deleted);
  }
  catch (e) { console.error("loadAllNotes failed:", e); return []; }
}

export async function deleteNote(noteId: string): Promise<void> {
  try {
    const db = getUserDB();
    const note = await db.notes.get(noteId);
    if (note) {
      await db.notes.put({ ...note, deleted: Date.now(), updatedAt: Date.now() });
    }
  } catch (e) { console.error("deleteNote failed:", e); }
}

/** Delete all notes for a given novel+chapter combination */
export async function deleteNotesByChapter(novelId: string, chapterId: string): Promise<void> {
  try {
    const db = getUserDB();
    const notes = await db.notes.where({ novelId, chapterId }).toArray();
    const now = Date.now();
    for (const n of notes) {
      if (!n.deleted) await db.notes.put({ ...n, deleted: now, updatedAt: now });
    }
  } catch (e) { console.error("deleteNotesByChapter failed:", e); }
}

// ── Maps ───────────────────────────────────────────────────────────

import type { MapData } from "@/agents/types";

export async function saveMap(novelId: string, data: MapData): Promise<void> {
  try {
    const db = getUserDB();
    const now = Date.now();
    const existing = await db.maps.get(novelId);
    await db.maps.put({
      id: novelId,
      novelId,
      data,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
  } catch (e) {
    console.error("saveMap failed:", e);
  }
}

export async function loadMap(novelId: string): Promise<{ data: MapData | null; updatedAt?: number }> {
  try {
    const db = getUserDB();
    const record = await db.maps.get(novelId);
    if (record && !record.deleted) {
      return { data: record.data as MapData, updatedAt: record.updatedAt };
    }
    return { data: null };
  } catch (e) {
    console.error("loadMap failed:", e);
    return { data: null };
  }
}

export async function deleteMap(novelId: string): Promise<void> {
  try {
    const db = getUserDB();
    const record = await db.maps.get(novelId);
    if (record) {
      await db.maps.put({ ...record, deleted: Date.now(), updatedAt: Date.now() });
    }
  } catch (e) {
    console.error("deleteMap failed:", e);
  }
}

// ── Graphs (character graph, per-user) ──

import type { GraphData } from "@/hooks/useSummarizer";

export async function saveGraph(novelId: string, data: GraphData): Promise<void> {
  try {
    const db = getUserDB();
    const now = Date.now();
    const existing = await db.graphs.get(novelId);
    await db.graphs.put({
      id: novelId,
      novelId,
      data,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
  } catch (e) {
    console.error("saveGraph failed:", e);
  }
}

export async function loadGraph(novelId: string): Promise<{ data: GraphData | null; updatedAt?: number }> {
  try {
    const db = getUserDB();
    const record = await db.graphs.get(novelId);
    if (record && !record.deleted) {
      return { data: record.data as GraphData, updatedAt: record.updatedAt };
    }
    return { data: null };
  } catch (e) {
    console.error("loadGraph failed:", e);
    return { data: null };
  }
}

export async function deleteGraph(novelId: string): Promise<void> {
  try {
    const db = getUserDB();
    const record = await db.graphs.get(novelId);
    if (record) {
      await db.graphs.put({ ...record, deleted: Date.now(), updatedAt: Date.now() });
    }
  } catch (e) {
    console.error("deleteGraph failed:", e);
  }
}

// ── Garbage collection for soft-deleted records ──

const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function cleanupDeletedRecords() {
  const db = getUserDB();
  const cutoff = Date.now() - GC_MAX_AGE_MS;
  try {
    const oldSummaries = await db.summaries.where("deleted").above(0).toArray();
    const oldNotes = await db.notes.where("deleted").above(0).toArray();
    const oldGraphs = await db.graphs.where("deleted").above(0).toArray();
    let sCount = 0, nCount = 0, gCount = 0;
    for (const s of oldSummaries) {
      if ((s.updatedAt || 0) < cutoff) { await db.summaries.delete(s.id); sCount++; }
    }
    for (const n of oldNotes) {
      if ((n.updatedAt || 0) < cutoff) { await db.notes.delete(n.id); nCount++; }
    }
    for (const g of oldGraphs) {
      if ((g.updatedAt || 0) < cutoff) { await db.graphs.delete(g.id); gCount++; }
    }
    if (sCount || nCount || gCount) console.log(`[gc] cleaned ${sCount} summaries, ${nCount} notes, ${gCount} graphs`);
  } catch (e) { console.error("[gc] cleanupDeletedRecords failed:", e); }
}

// ── Local user management ──

const LOCAL_USERS_KEY = "novel-reader-local-users";

/** Get all usernames that have been used on this device */
export function getLocalUsers(): string[] {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || "[]");
  } catch { return []; }
}

/** Add a username to the local users list */
export function addLocalUser(username: string) {
  const users = getLocalUsers();
  if (!users.includes(username)) {
    users.push(username);
    localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users));
  }
}

/** Remove a username from the local users list */
export function removeLocalUser(username: string) {
  const users = getLocalUsers().filter((u) => u !== username);
  localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users));
}

/** Delete a user's entire database and remove from local users list */
export async function deleteUserData(username: string) {
  await deleteUserDB(username);
  removeLocalUser(username);
}
