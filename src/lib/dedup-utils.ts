/**
 * 去重相关的工具函数
 * 消除 AppLayout.tsx 中的重复去重逻辑
 */

interface SummaryLike {
  novelId: string;
  chapterId: string;
  type: string;
  updatedAt?: number;
  createdAt?: number;
}

/**
 * 对 summaries 进行去重
 * 使用 novelId + chapterId + type 作为去重 key
 * 保留 updatedAt 最大的记录
 *
 * @param summaries 需要去重的 summaries 数组
 * @returns 去重后的 summaries 数组
 */
export function dedupSummaries<T extends SummaryLike>(summaries: T[]): T[] {
  const deduped = new Map<string, T>();
  for (const item of summaries) {
    const key = `${item.novelId}|${item.chapterId}|${item.type}`;
    const existing = deduped.get(key);
    if (!existing || (item.updatedAt || item.createdAt || 0) > (existing.updatedAt || existing.createdAt || 0)) {
      deduped.set(key, item);
    }
  }
  return Array.from(deduped.values());
}

/**
 * 对 notes 进行去重
 * 使用 id 作为去重 key（notes 的 id 是唯一的）
 * 保留 updatedAt 最大的记录
 *
 * @param notes 需要去重的 notes 数组
 * @returns 去重后的 notes 数组
 */
export function dedupNotes<T extends { id: string; updatedAt?: number; createdAt?: number }>(notes: T[]): T[] {
  const deduped = new Map<string, T>();
  for (const item of notes) {
    const existing = deduped.get(item.id);
    if (!existing || (item.updatedAt || item.createdAt || 0) > (existing.updatedAt || existing.createdAt || 0)) {
      deduped.set(item.id, item);
    }
  }
  return Array.from(deduped.values());
}
