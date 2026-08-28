import type { SyncData } from "./types";
import type { SummaryItem } from "@/stores/summary-store";
import { sharedDB, getUserDB } from "@/db/database";
import { useAPIStore } from "@/stores/api-store";
import { useNovelStore } from "@/stores/novel-store";
import { userKey } from "@/lib/user-utils";

// 每批同步的最大记录数
const BATCH_SIZE = 50;

/** Gather user data for sync push (no novels/chapters — those are server-side) */
export async function gatherChanges(lastSyncTime: number): Promise<Partial<SyncData>> {
  const udb = getUserDB();

  // Incremental: use index queries instead of full table scan + filter
  const filteredSummaries = lastSyncTime > 0
    ? await udb.summaries.where("updatedAt").above(lastSyncTime).toArray()
    : await udb.summaries.toArray();

  const filteredNotes = lastSyncTime > 0
    ? await udb.notes.where("updatedAt").above(lastSyncTime).toArray()
    : await udb.notes.toArray();

  // maps/graphs: filter by updatedAt, include soft-deleted (deletions must propagate)
  const mapQuery = lastSyncTime > 0
    ? udb.maps.where("updatedAt").above(lastSyncTime)
    : udb.maps.toCollection();
  const maps = await mapQuery.limit(BATCH_SIZE).toArray();

  const graphQuery = lastSyncTime > 0
    ? udb.graphs.where("updatedAt").above(lastSyncTime)
    : udb.graphs.toCollection();
  const graphs = await graphQuery.limit(BATCH_SIZE).toArray();

  // 分批：只取前 BATCH_SIZE 条记录
  const summaries = filteredSummaries.slice(0, BATCH_SIZE);
  const notes = filteredNotes.slice(0, BATCH_SIZE);

  // 如果有更多数据，记录日志
  if (filteredSummaries.length > BATCH_SIZE) {
    console.log(`[sync] summaries batch: ${summaries.length}/${filteredSummaries.length}`);
  }
  if (filteredNotes.length > BATCH_SIZE) {
    console.log(`[sync] notes batch: ${notes.length}/${filteredNotes.length}`);
  }
  if (maps.length === BATCH_SIZE) {
    console.log(`[sync] maps batch: ${maps.length}+ (可能还有更多)`);
  }
  if (graphs.length === BATCH_SIZE) {
    console.log(`[sync] graphs batch: ${graphs.length}+ (可能还有更多)`);
  }

  // Gather settings (RAG) — never sync API keys, character graphs moved to UserDB
  const settings: Record<string, unknown> = {};
  try {
    const allSettings = await sharedDB.settings.toArray();
    for (const s of allSettings) {
      if (s.key.startsWith("api-providers:") || s.key.startsWith("api-active-provider:")) continue;
      // character-graph 已迁移到 UserDB.graphs，不再通过 settings 同步
      if (s.key.startsWith("character-graph:")) continue;
      settings[s.key] = s.value;
    }
  } catch (e) { console.warn("[sync] 读取 settings 失败:", e); }

  // Reading progress (per-user keys)
  let readingPositions = {};
  let lastOpened = {};
  try {
    readingPositions = JSON.parse(localStorage.getItem(userKey("novel-reader-positions")) || "{}");
    lastOpened = JSON.parse(localStorage.getItem(userKey("novel-reader-last-opened")) || "{}");
  } catch (e) { console.warn("[sync] 读取阅读进度失败:", e); }

  // 调试日志
  console.log("[sync] gatherChanges:", {
    summaries: summaries.length,
    notes: notes.length,
    maps: maps.length,
    graphs: graphs.length,
    settings: Object.keys(settings).length,
  });

  return {
    summaries: summaries.map((s) => ({ ...s, type: s.type as SummaryItem["type"] })),
    notes,
    maps,
    graphs,
    settings,
    progress: { readingPositions, lastOpened },
  };
}

/**
 * 检查是否还有更多数据需要同步
 * 优化：只加载 BATCH_SIZE + 1 条记录判断是否超过，不加载全表
 */
export async function hasMoreChanges(lastSyncTime: number): Promise<boolean> {
  const udb = getUserDB();
  const limit = BATCH_SIZE + 1;

  // Summaries/notes: use count query (efficient)
  const summaryCount = lastSyncTime > 0
    ? await udb.summaries.where("updatedAt").above(lastSyncTime).count()
    : await udb.summaries.count();
  if (summaryCount > BATCH_SIZE) return true;

  const noteCount = lastSyncTime > 0
    ? await udb.notes.where("updatedAt").above(lastSyncTime).count()
    : await udb.notes.count();
  if (noteCount > BATCH_SIZE) return true;

  // Maps/graphs: include soft-deleted records (deletions must propagate)
  const mapQuery = lastSyncTime > 0
    ? udb.maps.where("updatedAt").above(lastSyncTime)
    : udb.maps.toCollection();
  const mapSample = await mapQuery.limit(limit).toArray();
  if (mapSample.length > BATCH_SIZE) return true;

  const graphQuery = lastSyncTime > 0
    ? udb.graphs.where("updatedAt").above(lastSyncTime)
    : udb.graphs.toCollection();
  const graphSample = await graphQuery.limit(limit).toArray();
  if (graphSample.length > BATCH_SIZE) return true;

  return false;
}

/** Apply server data to local storage (after sync pull) */
export async function applyServerData(data: SyncData): Promise<void> {
  const udb = getUserDB();

  // Summaries — conflict resolution by updatedAt, merge to preserve local-only fields
  if (data.summaries?.length) {
    try {
      await udb.transaction("rw", udb.summaries, async () => {
        for (const s of data.summaries) {
          const existing = await udb.summaries.get(s.id);
          if (!existing || (s.updatedAt || 0) >= (existing.updatedAt || 0)) {
            await udb.summaries.put({ ...existing, ...s });
          }
        }
      });
    } catch (e) { console.error("[sync] applyServerData summaries failed:", e); }
  }

  // Notes — conflict resolution by updatedAt, merge to preserve local-only fields
  if (data.notes?.length) {
    try {
      await udb.transaction("rw", udb.notes, async () => {
        for (const n of data.notes) {
          const existing = await udb.notes.get(n.id);
          if (!existing || (n.updatedAt || 0) >= (existing.updatedAt || 0)) {
            await udb.notes.put({ ...existing, ...n });
          }
        }
      });
    } catch (e) { console.error("[sync] applyServerData notes failed:", e); }
  }

  // Maps — conflict resolution by updatedAt, merge to preserve local-only fields
  if (data.maps?.length) {
    try {
      await udb.transaction("rw", udb.maps, async () => {
        for (const m of data.maps) {
          const existing = await udb.maps.get(m.id);
          if (!existing || (m.updatedAt || 0) >= (existing.updatedAt || 0)) {
            await udb.maps.put({ ...existing, ...m });
          }
        }
      });
    } catch (e) { console.error("[sync] applyServerData maps failed:", e); }
  }

  // Graphs — conflict resolution by updatedAt (per-user isolation), merge to preserve local-only fields
  if (data.graphs?.length) {
    try {
      await udb.transaction("rw", udb.graphs, async () => {
        for (const g of data.graphs) {
          const existing = await udb.graphs.get(g.id);
          if (!existing || (g.updatedAt || 0) >= (existing.updatedAt || 0)) {
            await udb.graphs.put({ ...existing, ...g });
          }
        }
      });
    } catch (e) { console.error("[sync] applyServerData graphs failed:", e); }
  }

  // Settings (shared database) — prefix with username for isolation
  if (data.settings) {
    const username = localStorage.getItem("sync-username");
    const entries = Object.entries(data.settings).filter(([, v]) => v !== null && v !== undefined);
    if (entries.length > 0) {
      await sharedDB.transaction("rw", sharedDB.settings, async () => {
        for (const [key, value] of entries) {
          const alreadyPrefixed = username && key.endsWith(`:${username}`);
          const needsPrefix = !key.startsWith("api-providers:") && !key.startsWith("api-active-provider:") && !alreadyPrefixed;
          const storeKey = needsPrefix && username ? `${key}:${username}` : key;
          await sharedDB.settings.put({ key: storeKey, value });
        }
      });
    }
    try {
      await useAPIStore.getState().loadFromDB();
    } catch { /* ok */ }
  }

  // Progress (per-user localStorage)
  if (data.progress) {
    try {
      if (data.progress.readingPositions) {
        const existing = JSON.parse(localStorage.getItem(userKey("novel-reader-positions")) || "{}");
        localStorage.setItem(userKey("novel-reader-positions"),
          JSON.stringify({ ...existing, ...data.progress.readingPositions }));
        // 修复：服务器进度写入 localStorage 后，立即同步到 store，避免后续
        // setCurrentNovel/saveReadingPosition 因 store 无进度而回落第一章 0
        try {
          useNovelStore.getState().reloadReadingPositions();
        } catch (e) {
          console.warn("[sync] reloadReadingPositions failed:", e);
        }
      }
      if (data.progress.lastOpened) {
        const existing = JSON.parse(localStorage.getItem(userKey("novel-reader-last-opened")) || "{}");
        localStorage.setItem(userKey("novel-reader-last-opened"),
          JSON.stringify({ ...existing, ...data.progress.lastOpened }));
      }
    } catch (e) { console.warn("[sync] 应用阅读进度失败:", e); }
  }
}
