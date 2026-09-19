import type { SyncData } from "./types";
import type { SummaryItem } from "@/stores/summary-store";
import type { Collection, Table } from "dexie";
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
  /**
   * 下一批的收集起点。**必须保守**：取"本批被截断的那些表"各自批内最大
   * updatedAt 的最小值。若改用四表并集的最大值（曾经的实现），只要有一张表的
   * 一条新记录时间戳更大，游标就会越过其他表尚未推送的积压，且水位随后提交
   * → 那些记录永久不再上行。宁可重复推几条（服务端 upsert 幂等），也不能漏。
   * 没有任何表被截断时，它就是本批真实最大值。
   */
  maxUpdatedAt: number;
}

/** Gather user data for sync push (no novels/chapters — those are server-side) */
export async function gatherChanges(
  lastSyncTime: number,
  excludeIds?: ReadonlySet<string>
): Promise<GatherResult> {
  const udb = getUserDB();

  // 一律按 updatedAt 升序取"游标之上最旧的若干条"。游标语义（拿批内最大
  // updatedAt 当下一批起点）只有在时间序下才成立；旧实现在 lastSyncTime===0
  // 时走 toCollection()（主键序），而 id 是随机 UUID → 每批实际是随机取样，
  // 起点却按批内最大值往前跳，未被抽到的记录就永久不再同步。
  // 用 aboveOrEqual（而非严格 above）：游标停在时间戳平局边界时，== 游标的
  // 未推送记录仍要能被取到（靠 excludeIds 排除已推送的那部分）。
  // 每张表都多取 1 条用于精确判断 hasMore（limit(BATCH_SIZE) 无法区分
  // "恰好 50 条"与"还有更多"），也避免把整表载入内存。
  const pending = async <T extends { id: string; updatedAt: number }>(
    table: Table<T, string>
  ): Promise<T[]> => {
    const q: Collection<T, string> = lastSyncTime > 0
      ? table.where("updatedAt").aboveOrEqual(lastSyncTime)
      : table.orderBy("updatedAt");
    const filtered = excludeIds ? q.and((r) => !excludeIds.has(r.id)) : q;
    return filtered.limit(BATCH_SIZE + 1).toArray();
  };

  const summariesAll = await pending(udb.summaries);
  const notesAll = await pending(udb.notes);
  const mapsAll = await pending(udb.maps);
  const graphsAll = await pending(udb.graphs);

  // 分批：只取前 BATCH_SIZE 条记录
  const summaries = summariesAll.slice(0, BATCH_SIZE);
  const notes = notesAll.slice(0, BATCH_SIZE);
  const maps = mapsAll.slice(0, BATCH_SIZE);
  const graphs = graphsAll.slice(0, BATCH_SIZE);

  const summariesHasMore = summariesAll.length > BATCH_SIZE;
  const notesHasMore = notesAll.length > BATCH_SIZE;
  const mapsHasMore = mapsAll.length > BATCH_SIZE;
  const graphsHasMore = graphsAll.length > BATCH_SIZE;
  const hasMore = summariesHasMore || notesHasMore || mapsHasMore || graphsHasMore;

  // 如果有更多数据，记录日志
  if (summariesHasMore) {
    console.log(`[sync] summaries batch: ${summaries.length}/${summariesAll.length - 1}+`);
  }
  if (notesHasMore) {
    console.log(`[sync] notes batch: ${notes.length}/${notesAll.length - 1}+`);
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

  // 保守游标：见 GatherResult.maxUpdatedAt 的注释
  const maxOf = (rows: { updatedAt?: number }[]) =>
    rows.reduce((m, r) => Math.max(m, Number(r.updatedAt) || 0), 0);
  const batchMaxUpdatedAt = Math.max(
    maxOf(summaries), maxOf(notes), maxOf(maps), maxOf(graphs)
  );
  const truncatedTableMaxes = [
    { hasMore: summariesHasMore, max: maxOf(summaries) },
    { hasMore: notesHasMore, max: maxOf(notes) },
    { hasMore: mapsHasMore, max: maxOf(maps) },
    { hasMore: graphsHasMore, max: maxOf(graphs) },
  ].filter((t) => t.hasMore).map((t) => t.max);
  const nextFloor = truncatedTableMaxes.length
    ? Math.min(...truncatedTableMaxes)
    : batchMaxUpdatedAt;

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
    maxUpdatedAt: nextFloor,
  };
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
