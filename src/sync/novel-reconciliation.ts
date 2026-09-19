/**
 * 小说本地/服务器一致性决策（纯函数，可测试）
 *
 * 历史教训：syncJoinedNovels 曾因"服务器 joined=false + join 失败"而
 * deleteNovel 软删本地小说，导致离线/闪断场景下章节目录全部丢失且不会
 * 重新下载。此处收敛所有"是否下载/是否删除"的决策，统一为保守策略：
 * 本地数据是用户的资产，任何自动流程都不得删除；缺失/损坏时从服务器
 * 恢复。
 */

import type { NovelRecord, ChapterRecord } from "@/db/database";
import type { Table } from "dexie";

/**
 * 判断是否需要（重新）下载该小说的章节。
 *
 * @param existing      本地 novel 记录（无则为 null）
 * @param localChapters 本地章节记录（可能为空数组）
 * @returns true 表示需要从服务器下载章节
 *
 * 规则：
 * - 本地无 novel 记录 → 需要下载（首次从服务器拉取）
 * - 本地有记录但章节为空 / 全部被软删（deleted 标记）→ 需要下载（自愈恢复，
 *   覆盖写入会物理清除 deleted 标记）
 * - 本地有记录且存在至少一个未软删章节 → 不需要下载
 */
export function shouldDownloadNovel(
  existing: NovelRecord | null | undefined,
  localChapters: ChapterRecord[] | null | undefined
): boolean {
  if (!existing) return true;
  const chapters = localChapters ?? [];
  return !chapters.some((c) => !c.deleted);
}

/**
 * 判断本地小说副本是否应被删除。
 *
 * 保守策略：永远返回 false。本地小说只能由用户在书架上显式删除；
 * 任何自动同步流程（join 恢复、服务器列表对比、网络异常）都不得删除
 * 本地副本——删除会导致章节目录/摘要/笔记/地图/图谱丢失且不会自动恢复。
 */
export function shouldDeleteLocalNovel(): boolean {
  return false;
}

/**
 * 认亲（本地 novelId → 服务器 novelId）时迁移 maps / graphs 行。
 *
 * 这两张表的客户端主键**就是 novelId**，所以只改 novelId 字段而不动 id 会造成：
 *   - loadMap/loadGraph 按 get(novelId) 取新键 → 落空，整本书的地图与人物图谱
 *     在界面上"消失"（数据其实还在旧键下）；
 *   - 旧键行仍带着已不存在的 novelId 每次同步重复上行，在服务端留下孤儿行。
 * summaries/notes 的主键是各自的 UUID，不受影响，只需改 novelId/chapterId。
 *
 * 同名键折叠（>1 行）在正常数据里不会发生；真发生时保留最后写入的那条并告警。
 */
export async function rekeyNovelOwnedRows<T extends { id: string; novelId: string }>(
  table: Table<T, string>,
  rows: T[],
  newNovelId: string,
  label: string
): Promise<void> {
  if (rows.length === 0) return;
  if (rows.length > 1) {
    console.warn(`[sync] ${label} 认亲重键时发现 ${rows.length} 行（正常应为 1 行），折叠保留最后一条`);
  }
  for (const row of rows) await table.delete(row.id);
  const winner = rows[rows.length - 1];
  await table.put({ ...winner, id: newNovelId, novelId: newNovelId });
}
