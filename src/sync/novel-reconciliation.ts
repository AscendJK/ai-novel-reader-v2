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
