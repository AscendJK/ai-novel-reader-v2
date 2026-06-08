import type { SyncData } from "./types";
import { sharedDB, getUserDB } from "@/db/database";
import { useAPIStore } from "@/stores/api-store";
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

  // maps/graphs: filter by updatedAt and exclude soft-deleted, limit to BATCH_SIZE
  const mapQuery = lastSyncTime > 0
    ? udb.maps.where("updatedAt").above(lastSyncTime)
    : udb.maps.toCollection();
  const maps = await mapQuery.filter((m) => !m.deleted).limit(BATCH_SIZE).toArray();

  const graphQuery = lastSyncTime > 0
    ? udb.graphs.where("updatedAt").above(lastSyncTime)
    : udb.graphs.toCollection();
  const graphs = await graphQuery.filter((g) => !g.deleted).limit(BATCH_SIZE).toArray();

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
  } catch { /* ignore */ }

  // Reading progress (per-user keys)
  let readingPositions = {};
  let lastOpened = {};
  try {
    readingPositions = JSON.parse(localStorage.getItem(userKey("novel-reader-positions")) || "{}");
    lastOpened = JSON.parse(localStorage.getItem(userKey("novel-reader-last-opened")) || "{}");
  } catch { /* ignore */ }

  // 调试日志
  console.log("[sync] gatherChanges:", {
    summaries: summaries.length,
    notes: notes.length,
    maps: maps.length,
    graphs: graphs.length,
    settings: Object.keys(settings).length,
  });

  return {
    summaries,
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

  // Maps/graphs: load only first BATCH_SIZE+1 non-deleted records
  const mapQuery = lastSyncTime > 0
    ? udb.maps.where("updatedAt").above(lastSyncTime)
    : udb.maps.toCollection();
  const mapSample = await mapQuery.filter((m) => !m.deleted).limit(limit).toArray();
  if (mapSample.length > BATCH_SIZE) return true;

  const graphQuery = lastSyncTime > 0
    ? udb.graphs.where("updatedAt").above(lastSyncTime)
    : udb.graphs.toCollection();
  const graphSample = await graphQuery.filter((g) => !g.deleted).limit(limit).toArray();
  if (graphSample.length > BATCH_SIZE) return true;

  return false;
}

/** Apply server data to local storage (after sync pull) */
export async function applyServerData(data: SyncData): Promise<void> {
  const udb = getUserDB();

  // Summaries — conflict resolution by updatedAt
  if (data.summaries?.length) {
    await udb.transaction("rw", udb.summaries, async () => {
      for (const s of data.summaries) {
        const existing = await udb.summaries.get(s.id);
        if (!existing || (s.updatedAt || 0) >= (existing.updatedAt || 0)) {
          await udb.summaries.put(s);
        }
      }
    });
  }

  // Notes — conflict resolution by updatedAt
  if (data.notes?.length) {
    await udb.transaction("rw", udb.notes, async () => {
      for (const n of data.notes) {
        const existing = await udb.notes.get(n.id);
        if (!existing || (n.updatedAt || 0) >= (existing.updatedAt || 0)) {
          await udb.notes.put(n);
        }
      }
    });
  }

  // Maps — conflict resolution by updatedAt
  if (data.maps?.length) {
    await udb.transaction("rw", udb.maps, async () => {
      for (const m of data.maps) {
        const existing = await udb.maps.get(m.id);
        if (!existing || (m.updatedAt || 0) >= (existing.updatedAt || 0)) {
          await udb.maps.put(m);
        }
      }
    });
  }

  // Graphs — conflict resolution by updatedAt (per-user isolation)
  if (data.graphs?.length) {
    await udb.transaction("rw", udb.graphs, async () => {
      for (const g of data.graphs) {
        const existing = await udb.graphs.get(g.id);
        if (!existing || (g.updatedAt || 0) >= (existing.updatedAt || 0)) {
          await udb.graphs.put(g);
        }
      }
    });
  }

  // Settings (shared database) — prefix with username for isolation
  if (data.settings) {
    const username = localStorage.getItem("sync-username");
    for (const [key, value] of Object.entries(data.settings)) {
      if (value !== null && value !== undefined) {
        // API provider settings already have username in key; others need prefix
        const needsPrefix = !key.startsWith("api-providers:") && !key.startsWith("api-active-provider:");
        const storeKey = needsPrefix && username ? `${key}:${username}` : key;
        await sharedDB.settings.put({ key: storeKey, value });
      }
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
      }
      if (data.progress.lastOpened) {
        const existing = JSON.parse(localStorage.getItem(userKey("novel-reader-last-opened")) || "{}");
        localStorage.setItem(userKey("novel-reader-last-opened"),
          JSON.stringify({ ...existing, ...data.progress.lastOpened }));
      }
    } catch { /* ignore */ }
  }
}
