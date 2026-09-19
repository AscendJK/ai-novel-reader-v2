import type { SyncData } from "./types";
import type { SummaryItem } from "@/stores/summary-store";
import { sharedDB, getUserDB } from "@/db/database";
import { useAPIStore } from "@/stores/api-store";
import { useNovelStore } from "@/stores/novel-store";
import { userKey } from "@/lib/user-utils";

// 每批同步的最大记录数
const BATCH_SIZE = 50;

/** gatherChanges 的返回：data 之外附带分批元信息（推进增量收集游标用） */
export interface GatherResult {
  data: Partial<SyncData>;
  /** 按同一过滤条件，本批之后是否还有更多记录 */
  hasMore: boolean;
  /** 本批记录的最大 updatedAt（本地时钟），作为下一批收集起点 */
  maxUpdatedAt: number;
}

/** Gather user data for sync push (no novels/chapters — those are server-side) */
export async function gatherChanges(
  lastSyncTime: number,
  excludeIds?: ReadonlySet<string>
): Promise<GatherResult> {
  const udb = getUserDB();

  // Incremental: use index queries instead of full table scan + filter。
  // 用 aboveOrEqual（而非严格 above）：分页游标停在时间戳平局的边界时，
  // == 游标的未推送记录仍要能被取到（靠 excludeIds 排除已推送的那部分）
  const summariesQuery = lastSyncTime > 0
    ? udb.summaries.where("updatedAt").aboveOrEqual(lastSyncTime)
    : udb.summaries.toCollection();
  const filteredSummaries = await (excludeIds
    ? summariesQuery.and((s) => !excludeIds.has(s.id))
    : summariesQuery).toArray();

  const notesQuery = lastSyncTime > 0
    ? udb.notes.where("updatedAt").aboveOrEqual(lastSyncTime)
    : udb.notes.toCollection();
  const filteredNotes = await (excludeIds
    ? notesQuery.and((n) => !excludeIds.has(n.id))
    : notesQuery).toArray();

  // maps/graphs: filter by updatedAt, include soft-deleted (deletions must propagate)
  // 多取 1 条用于精确判断 hasMore（limit(BATCH_SIZE) 无法区分"恰好 50"与"还有更多"）
  const mapQuery = lastSyncTime > 0
    ? udb.maps.where("updatedAt").aboveOrEqual(lastSyncTime)
    : udb.maps.toCollection();
  const mapsAll = await (excludeIds
    ? mapQuery.and((m) => !excludeIds.has(m.id))
    : mapQuery).limit(BATCH_SIZE + 1).toArray();

  const graphQuery = lastSyncTime > 0
    ? udb.graphs.where("updatedAt").aboveOrEqual(lastSyncTime)
    : udb.graphs.toCollection();
  const graphsAll = await (excludeIds
    ? graphQuery.and((g) => !excludeIds.has(g.id))
    : graphQuery).limit(BATCH_SIZE + 1).toArray();

  // 分批：只取前 BATCH_SIZE 条记录
  const summaries = filteredSummaries.slice(0, BATCH_SIZE);
  const notes = filteredNotes.slice(0, BATCH_SIZE);
  const maps = mapsAll.slice(0, BATCH_SIZE);
  const graphs = graphsAll.slice(0, BATCH_SIZE);

  const summariesHasMore = filteredSummaries.length > BATCH_SIZE;
  const notesHasMore = filteredNotes.length > BATCH_SIZE;
  const mapsHasMore = mapsAll.length > BATCH_SIZE;
  const graphsHasMore = graphsAll.length > BATCH_SIZE;
  const hasMore = summariesHasMore || notesHasMore || mapsHasMore || graphsHasMore;

  // 如果有更多数据，记录日志
  if (summariesHasMore) {
    console.log(`[sync] summaries batch: ${summaries.length}/${filteredSummaries.length}`);
  }
  if (notesHasMore) {
    console.log(`[sync] notes batch: ${notes.length}/${filteredNotes.length}`);
  }
  if (mapsHasMore) {
    console.log(`[sync] maps batch: ${maps.length}+ (可能还有更多)`);
  }
  if (graphsHasMore) {
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

  // 本批最大 updatedAt（本地时钟）：调用方据此推进增量收集游标
  const maxUpdatedAt = Math.max(
    0,
    ...summaries.map((s) => s.updatedAt || 0),
    ...notes.map((n) => n.updatedAt || 0),
    ...maps.map((m) => m.updatedAt || 0),
    ...graphs.map((g) => g.updatedAt || 0),
  );

  return {
    data: {
      summaries: summaries.map((s) => ({ ...s, type: s.type as SummaryItem["type"] })),
      notes,
      maps,
      graphs,
      settings,
      progress: { readingPositions, lastOpened },
    },
    hasMore,
    maxUpdatedAt,
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
        const merged = { ...existing };
        for (const [novelId, serverPos] of Object.entries(data.progress.readingPositions)) {
          const existingPos = existing[novelId];
          if (!existingPos || (serverPos.updatedAt || 0) >= (existingPos.updatedAt || 0)) {
            // 服务器数据更新，但保留本地独有字段（scrollTop, chapterOffset）
            merged[novelId] = { ...existingPos, ...serverPos };
          }
        }
        localStorage.setItem(userKey("novel-reader-positions"), JSON.stringify(merged));
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
