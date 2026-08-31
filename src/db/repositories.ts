import { sharedDB, getUserDB, deleteUserDB } from "./database";
import type { Table } from "dexie";
import type { Novel, NovelMeta } from "@/parsers/types";
import type { SummaryItem } from "@/stores/summary-store";
import type { ChapterRecord, MapRecord, GraphRecord } from "./database";
import { useRAGStore } from "@/stores/rag-store";
import { clearCache } from "@/rag/index";
import { withQuotaRetry } from "@/lib/quota-guard";
import type { GraphData } from "@/hooks/useSummarizer";

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
      // 分批写入以防止 IndexedDB 事务超时（每批 500 条）
      // 配额不足时自动降级清理并重试（bulkPut 同 id 覆盖，重试安全）
      const BATCH_SIZE = 500;
      for (let i = 0; i < chapterRecords.length; i += BATCH_SIZE) {
        const batch = chapterRecords.slice(i, i + BATCH_SIZE);
        await withQuotaRetry(async () => {
          await db.chapters.bulkPut(batch);
        });
      }
    });
  } catch (e) {
    console.error("saveNovel failed:", e);
  }
}

export async function loadNovel(novelId: string, chapterIndex?: number, loadAllContent?: boolean): Promise<Novel | null> {
  const db = getUserDB();
  try {
    const record = await db.novels.get(novelId);
    if (!record) return null;

    const allChapterRecords = (await db.chapters.where("novelId").equals(novelId).sortBy("index"))
      .filter((ch) => !ch.deleted);
    const totalCount = allChapterRecords.length;

    // 确定需要加载内容的章节范围
    let chaptersToLoad = allChapterRecords;
    if (loadAllContent === false) {
      // 显式不要内容：加载全部标题，content 为空（用于只需章节目录的场景）
      chaptersToLoad = [];
    } else if (!loadAllContent && chapterIndex !== undefined && totalCount > 21) {
      // 懒加载：只加载当前章节及前后各10章的内容
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
      .and((ch) => ch.index === chapterIndex && !ch.deleted)
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
      .and((ch) => ch.index >= startIndex && ch.index < startIndex + count && !ch.deleted)
      .sortBy("index");
    return chapters;
  } catch (e) {
    console.error("loadChapters failed:", e);
    return [];
  }
}

/** 判断错误是否为 Dexie 数据库已关闭错误 */
function isDatabaseClosedError(e: unknown): boolean {
  return !!(e && typeof e === "object" && (e as { name?: string }).name === "DatabaseClosedError");
}

export async function loadAllNovelMeta(): Promise<NovelMeta[]> {
  const db = getUserDB();
  try {
    const records = await db.novels.orderBy("createdAt").reverse().toArray();
    // 共享事务 + 并行查询：所有 count 在单个事务内并发执行，避免 N 次串行事务开销
    const countMap = new Map<string, number>();
    await db.transaction("r", db.chapters, async (tx) => {
      const counts = await Promise.all(
        records.map((r) => tx.chapters.where("novelId").equals(r.id).count())
      );
      records.forEach((r, i) => countMap.set(r.id, counts[i]));
    });
    return records.map((r) => ({
      id: r.id, title: r.title, author: r.author,
      fileName: r.fileName, fileFormat: r.fileFormat,
      totalChars: r.totalChars, chapterCount: countMap.get(r.id) || 0,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    }));
  } catch (e) {
    // 数据库被并发关闭（如切换用户/重新登录导致 setCurrentUser 关闭旧实例）：
    // 获取当前实例重试一次，避免书架加载失败返回空列表
    if (isDatabaseClosedError(e)) {
      const db2 = getUserDB();
      if (db2 !== db) return await loadAllNovelMeta();
    }
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
      const chapterRecords = (await db.chapters
        .where("novelId")
        .equals(record.id)
        .sortBy("index")).filter((ch) => !ch.deleted);
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
    // 数据库被并发关闭时重试一次（与 loadAllNovelMeta 相同的兜底）
    if (isDatabaseClosedError(e)) {
      const db2 = getUserDB();
      if (db2 !== db) return await loadAllNovels();
    }
    console.error("loadAllNovels failed:", e);
    return [];
  }
}

export async function deleteNovel(novelId: string): Promise<void> {
  const udb = getUserDB();
  try {
    // Dexie TS 重载最多支持 4 表参数，运行时支持更多，用类型断言绕过
    await (udb.transaction as (...args: unknown[]) => Promise<void>)("rw", udb.chapters, udb.summaries, udb.notes, udb.novels, udb.graphs, udb.maps, async () => {
      // Soft-delete chapters so sync stays consistent with summaries/soft-deleted data
      const now = Date.now();
      const novelChapters = await udb.chapters.where("novelId").equals(novelId).toArray();
      for (const ch of novelChapters) {
        if (!ch.deleted) await udb.chapters.put({ ...ch, deleted: now });
      }
      // Soft-delete summaries, notes, graphs, and maps so sync propagates the deletion
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
    // Clean up shared data (ragCache + in-memory indexCache)
    const cacheEntries = await sharedDB.ragCache.where("novelId").equals(novelId).toArray();
    for (const entry of cacheEntries) {
      await sharedDB.ragCache.delete(entry.id);
      useRAGStore.getState().removeCachedKey(entry.id);
    }
    try {
      clearCache(novelId);
    } catch { /* ignore import errors */ }

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
      // 清理 TTS 朗读断点（若指向被删小说；该键为全局键，仅匹配 novelId 时删除）
      try {
        const ttsPosRaw = localStorage.getItem("novel-reader-tts-position");
        if (ttsPosRaw) {
          const ttsPos = JSON.parse(ttsPosRaw);
          if (ttsPos.novelId === novelId) localStorage.removeItem("novel-reader-tts-position");
        }
      } catch { /* 忽略损坏数据 */ }
    } catch (e) { console.warn("[deleteNovel] cleanup error:", e); }
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
    const db = getUserDB();
    const all = await db.summaries.where("novelId").equals(novelId).sortBy("createdAt");
    // SummaryRecord.type 是 string，运行时实际存储的是字面量联合类型值，安全断言
    return all.filter((s) => !s.deleted) as (SummaryItem & { novelId: string })[];
  } catch (e) {
    // 数据库被并发关闭时重试一次（与 loadAllNovelMeta 相同的兜底）
    if (isDatabaseClosedError(e)) {
      const db2 = getUserDB();
      if (db2) return await loadSummaries(novelId);
    }
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

/** 清洗旧的/不规范的图谱数据，避免渲染时访问 undefined.length 崩溃 */
function sanitizeGraphData(data: unknown): GraphData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.nodes) || (d.nodes as unknown[]).length === 0) return null;
  // 过滤出含 id 的对象，并断言为 GraphData 的节点类型
  const nodes = (d.nodes as unknown[]).filter(
    (n): n is GraphData["nodes"][number] =>
      !!n && typeof n === "object" && typeof (n as { id?: unknown }).id === "string"
  );
  if (nodes.length === 0) return null;
  return {
    nodes,
    edges: Array.isArray(d.edges) ? (d.edges as GraphData["edges"]) : [],
  };
}

/** 清洗旧的/不规范的地图数据，避免渲染时访问 undefined.length 崩溃 */
function sanitizeMapData(data: unknown): MapData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  return {
    layers: Array.isArray(d.layers) ? (d.layers as MapData["layers"]) : [],
    places: Array.isArray(d.places) ? (d.places as MapData["places"]) : [],
    regions: Array.isArray(d.regions) ? (d.regions as MapData["regions"]) : [],
    forces: Array.isArray(d.forces) ? (d.forces as MapData["forces"]) : [],
  };
}

export async function loadMap(novelId: string): Promise<{ data: MapData | null; updatedAt?: number }> {
  try {
    const db = getUserDB();
    const record = await db.maps.get(novelId);
    if (record && !record.deleted) {
      const data = sanitizeMapData(record.data);
      return { data, updatedAt: record.updatedAt };
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
      const data = sanitizeGraphData(record.data);
      return { data, updatedAt: record.updatedAt };
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
const GC_BATCH_SIZE = 100; // 每批删除条数（防止大库一次性全量加载阻塞主线程）

/** 让出主线程（微任务 + 宏任务），避免 GC 长任务卡顿 UI */
function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 分批收集过期软删除记录（游标流式，不一次性加载全表） */
async function collectExpired<T extends { id: string; deleted?: number }>(
  table: Table<T, string>,
  cutoff: number,
): Promise<T[]> {
  const expired: T[] = [];
  await table.each((rec) => {
    if (rec.deleted && rec.deleted < cutoff) expired.push(rec);
  });
  return expired;
}

export async function cleanupDeletedRecords() {
  // 多标签页互斥：同一浏览器多个标签页同时 GC 可能重复删除（有事务保护但浪费）
  // navigator.locks 不可用（旧浏览器）时退化为直接执行
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    try {
      await navigator.locks.request("novel-reader-gc", { ifAvailable: true }, async (lock) => {
        if (!lock) return; // 其他标签页正在 GC，本页跳过
        await doCleanupDeletedRecords();
      });
      return;
    } catch { /* 锁不可用时退化为直接执行 */ }
  }
  await doCleanupDeletedRecords();
}

async function doCleanupDeletedRecords() {
  let db;
  try {
    db = getUserDB();
  } catch { return; } // 未登录时无用户库，跳过
  const cutoff = Date.now() - GC_MAX_AGE_MS;
  try {
    // 分批收集（游标流式，不一次性加载全表到内存）
    const [oldChapters, oldSummaries, oldNotes, oldGraphs, oldMaps] = await Promise.all([
      collectExpired(db.chapters, cutoff),
      collectExpired(db.summaries, cutoff),
      collectExpired(db.notes, cutoff),
      collectExpired(db.graphs, cutoff),
      collectExpired(db.maps, cutoff),
    ]);
    let cCount = 0, sCount = 0, nCount = 0, gCount = 0, mCount = 0;

    // 分批删除，每批之间让出主线程
    const deleteInBatches = async <T extends { id: string }>(records: T[], table: Table<T, string>): Promise<number> => {
      let count = 0;
      for (let i = 0; i < records.length; i += GC_BATCH_SIZE) {
        const batch = records.slice(i, i + GC_BATCH_SIZE);
        await table.bulkDelete(batch.map((r) => r.id));
        count += batch.length;
        await yieldToMainThread();
      }
      return count;
    };

    cCount = await deleteInBatches(oldChapters, db.chapters);
    sCount = await deleteInBatches(oldSummaries, db.summaries);
    nCount = await deleteInBatches(oldNotes, db.notes);
    gCount = await deleteInBatches(oldGraphs, db.graphs);
    mCount = await deleteInBatches(oldMaps, db.maps);
    if (cCount || sCount || nCount || gCount || mCount) console.log(`[gc] cleaned ${cCount} chapters, ${sCount} summaries, ${nCount} notes, ${gCount} graphs, ${mCount} maps`);
  } catch (e) { console.error("[gc] cleanupDeletedRecords failed:", e); }
}

// ── Local user management ──

const LOCAL_USERS_KEY = "novel-reader-local-users";

/** Get all usernames that have been used on this device */
export function getLocalUsers(): string[] {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || "[]");
  } catch (e) {
    console.debug("[repositories] 读取本地用户列表失败:", e instanceof Error ? e.message : e);
    return [];
  }
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
  // 1. 删除前先获取用户的 novelId 列表
  const deletedUserNovelIds: string[] = [];
  try {
    const dbName = `ai-novel-reader-${username}`;
    const req = indexedDB.open(dbName);
    const novels: { id: string }[] = await new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("novels", "readonly");
        const store = tx.objectStore("novels");
        const getAll = store.getAll();
        getAll.onsuccess = () => { resolve(getAll.result || []); db.close(); };
        getAll.onerror = () => { reject(getAll.error); db.close(); };
      };
      req.onerror = () => reject(req.error);
    });
    for (const novel of novels) {
      if (novel.id) {
        deletedUserNovelIds.push(novel.id);
        localStorage.removeItem(`map-data-${novel.id}`);
      }
    }
  } catch (e) { console.warn("[deleteUserData] 读取待删小说列表失败:", e); }

  // 2. 并行收集其他本地用户的 novelId，用于判断哪些 RAG 缓存可以安全删除
  const otherUsersNovelIds = new Set<string>();
  const otherUsers = getLocalUsers().filter((u) => u !== username);
  const readNovelIds = (dbName: string): Promise<string[]> =>
    new Promise((resolve) => {
      try {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("novels", "readonly");
          const store = tx.objectStore("novels");
          const getAll = store.getAll();
          getAll.onsuccess = () => {
            resolve((getAll.result || []).map((n: { id: string }) => n.id).filter(Boolean));
            db.close();
          };
          getAll.onerror = () => { resolve([]); db.close(); };
        };
        req.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
  const otherNovelIdArrays = await Promise.all(
    otherUsers.map((u) => readNovelIds(`ai-novel-reader-${u}`))
  );
  for (const ids of otherNovelIdArrays) {
    for (const id of ids) otherUsersNovelIds.add(id);
  }

  // 3. 删除用户专属 IndexedDB 数据库
  await deleteUserDB(username);

  // 4. 删除 sharedDB 中其他用户都没有的小说的 RAG 缓存
  try {
    const allCacheEntries = await sharedDB.ragCache.toArray();
    for (const entry of allCacheEntries) {
      if (deletedUserNovelIds.includes(entry.novelId) && !otherUsersNovelIds.has(entry.novelId)) {
        await sharedDB.ragCache.delete(entry.id);
      }
    }
  } catch (e) { console.warn("[deleteUserData] 删除 RAG 缓存失败:", e); }

  // 5. 删除用户专属 localStorage 数据
  const userKeys = [
    `novel-reader-positions:${username}`,
    `novel-reader-last-opened:${username}`,
    `novel-reader-last-sync-time:${username}`,
  ];
  for (const key of userKeys) {
    localStorage.removeItem(key);
  }

  // 6. 删除 sharedDB 中用户的 API 配置
  try {
    await Promise.all([
      sharedDB.settings.delete(`api-providers:${username}`),
      sharedDB.settings.delete(`api-active-provider:${username}`),
    ]);
  } catch (e) { console.warn("[deleteUserData] 删除 API 配置失败:", e); }

  // 7. 从本地用户列表移除
  removeLocalUser(username);
}
