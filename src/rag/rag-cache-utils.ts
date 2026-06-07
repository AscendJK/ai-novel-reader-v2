/**
 * RAG 缓存管理工具
 * 负责 IndexedDB 缓存的大小计算、配额淘汰、空间预检查
 */

import { sharedDB as db } from "@/db/database";
import { useRAGStore } from "@/stores/rag-store";
import { ragLog } from "@/lib/logger";

// ============================================================
// 缓存大小计算
// ============================================================

/** Compute total size of all ragCache entries in bytes (vectors only) */
export async function computeRagCacheSize(): Promise<number> {
  try {
    const all = await db.ragCache.toArray();
    let total = 0;
    for (const entry of all) {
      if (entry.vectorsBuffer && entry.dim && entry.chunkCount) {
        // 向量数据大小
        total += entry.chunkCount * entry.dim * 4;
        // chunks 数据大小（估算）
        if (entry.chunks && entry.chunks.length > 0) {
          const chunksSize = entry.chunks.reduce((sum, c) => sum + (c.content?.length || 0) * 2, 0);
          total += chunksSize;
        }
      }
    }
    return total;
  } catch { return 0; }
}

/** Update the ragCache size in the store */
export async function updateRagCacheSize() {
  const bytes = await computeRagCacheSize();
  useRAGStore.getState().updateRagCacheSize(bytes);
}

// ============================================================
// 淘汰通知
// ============================================================

/** 被淘汰的小说信息 */
interface EvictedEntry {
  id: string;
  novelId: string;
  engine: string;
  size: number;
}

/** 淘汰事件监听器 */
type EvictionListener = (evicted: EvictedEntry[]) => void;
const evictionListeners: Set<EvictionListener> = new Set();

/**
 * 监听淘汰事件
 * @returns 取消监听的函数
 */
export function onCacheEviction(listener: EvictionListener): () => void {
  evictionListeners.add(listener);
  return () => evictionListeners.delete(listener);
}

/** 触发淘汰通知 */
function notifyEviction(evicted: EvictedEntry[]) {
  if (evicted.length === 0) return;

  const totalMB = evicted.reduce((sum, e) => sum + e.size, 0) / 1024 / 1024;
  ragLog(`缓存淘汰: ${evicted.length} 个索引, 释放 ${totalMB.toFixed(1)}MB`);

  for (const listener of evictionListeners) {
    try {
      listener(evicted);
    } catch { /* ignore */ }
  }
}

// ============================================================
// 智能淘汰策略
// ============================================================

/**
 * 计算淘汰分数（分数越高越应该被淘汰）
 * 策略：综合考虑创建时间和访问频率
 */
function getEvictionScore(entry: { createdAt: number; lastAccessed?: number; accessCount?: number }): number {
  const now = Date.now();
  const age = now - (entry.createdAt || 0);
  const lastAccess = now - (entry.lastAccessed || entry.createdAt || 0);
  const accessCount = entry.accessCount || 0;

  // 分数 = 年龄权重 * 0.4 + 最后访问权重 * 0.4 + 访问次数权重 * 0.2
  const ageScore = age / (24 * 60 * 60 * 1000);  // 天数
  const lastAccessScore = lastAccess / (24 * 60 * 60 * 1000);  // 天数
  const accessScore = 1 / (accessCount + 1);  // 访问次数越少分数越高

  return ageScore * 0.4 + lastAccessScore * 0.4 + accessScore * 0.2;
}

/**
 * 淘汰最应该被删除的缓存条目
 * @param skipNovelId 要跳过的小说 ID（保护当前使用的小说）
 * @returns 淘汰的信息和释放的字节数
 */
async function evictSmartestRagCacheEntry(skipNovelId?: string): Promise<{ freed: number; evicted?: EvictedEntry }> {
  try {
    const all = await db.ragCache.toArray();

    // 跳过当前使用的小说
    const candidates = skipNovelId
      ? all.filter(e => e.novelId !== skipNovelId)
      : all;

    if (candidates.length === 0) return { freed: 0 };

    // 按淘汰分数排序，淘汰分数最高的
    const scored = candidates.map(entry => ({
      entry,
      score: getEvictionScore(entry)
    }));
    scored.sort((a, b) => b.score - a.score);

    const toEvict = scored[0].entry;
    const size = toEvict.vectorsBuffer && toEvict.dim && toEvict.chunkCount
      ? toEvict.chunkCount * toEvict.dim * 4
      : 0;

    await db.ragCache.delete(toEvict.id);
    useRAGStore.getState().removeCachedKey(toEvict.id);

    return {
      freed: size,
      evicted: {
        id: toEvict.id,
        novelId: toEvict.novelId,
        engine: toEvict.engine,
        size,
      }
    };
  } catch {
    return { freed: 0 };
  }
}

// ============================================================
// 访问记录更新
// ============================================================

/**
 * 更新缓存条目的访问记录
 * 在使用索引时调用，用于智能淘汰策略
 */
export async function updateAccessTime(novelId: string, engine: string) {
  try {
    const cacheKey = `${novelId}-${engine}`;
    const entry = await db.ragCache.get(cacheKey);
    if (entry) {
      await db.ragCache.put({
        ...entry,
        lastAccessed: Date.now(),
        accessCount: (entry.accessCount || 0) + 1,
      });
    }
  } catch { /* ignore */ }
}

// ============================================================
// 预检查缓存空间
// ============================================================

/**
 * 确保有足够的缓存空间
 * @param requiredBytes 需要的字节数
 * @returns 是否成功腾出空间
 */
export async function ensureCacheSpace(requiredBytes: number): Promise<boolean> {
  const limitBytes = useRAGStore.getState().cacheSizeMB * 1024 * 1024;
  const currentSize = await computeRagCacheSize();
  const available = limitBytes - currentSize;

  // 如果空间足够，直接返回
  if (available >= requiredBytes) return true;

  // 需要腾出的空间
  const needFree = requiredBytes - available;

  // 尝试淘汰
  let freed = 0;
  const currentNovelId = getCurrentNovelId();
  const evicted: EvictedEntry[] = [];

  while (freed < needFree) {
    const result = await evictSmartestRagCacheEntry(currentNovelId);
    if (result.freed === 0) break;
    freed += result.freed;
    if (result.evicted) evicted.push(result.evicted);
  }

  // 通知用户
  notifyEviction(evicted);

  return freed >= needFree;
}

/**
 * 获取当前正在阅读的小说 ID
 * 用于保护当前小说的索引不被淘汰
 * 通过回调函数避免循环依赖
 */
let getCurrentNovelIdFn: (() => string | undefined) | null = null;

/**
 * 设置获取当前小说 ID 的函数
 * 应该在应用初始化时调用
 */
export function setCurrentNovelIdGetter(getter: () => string | undefined) {
  getCurrentNovelIdFn = getter;
}

function getCurrentNovelId(): string | undefined {
  return getCurrentNovelIdFn?.();
}

// ============================================================
// 配额淘汰（主入口）
// ============================================================

// Chain-of-promises lock: ensures only one eviction runs at a time,
// and each caller re-checks the quota after waiting.
let evictionChain: Promise<void> = Promise.resolve();

/**
 * 强制执行 IndexedDB 缓存大小限制
 * 淘汰最旧或最少使用的条目，直到大小符合限制
 */
export async function enforceIndexedDBQuota() {
  // Insert ourselves at the end of the chain
  const prev = evictionChain;
  let release!: () => void;
  evictionChain = new Promise<void>((r) => { release = r; });
  await prev;

  try {
    const limitBytes = useRAGStore.getState().cacheSizeMB * 1024 * 1024;
    let currentSize = await computeRagCacheSize();

    if (currentSize <= limitBytes) {
      useRAGStore.getState().updateRagCacheSize(currentSize);
      return;
    }

    const currentNovelId = getCurrentNovelId();
    const evicted: EvictedEntry[] = [];

    while (currentSize > limitBytes) {
      const result = await evictSmartestRagCacheEntry(currentNovelId);
      if (result.freed === 0) break;
      currentSize -= result.freed;
      if (result.evicted) evicted.push(result.evicted);
    }

    useRAGStore.getState().updateRagCacheSize(currentSize);

    // 通知用户
    notifyEviction(evicted);
  } finally {
    release();
  }
}
