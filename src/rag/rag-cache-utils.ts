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

/** Compute total size of all ragCache entries in bytes (流式计算，避免全表加载) */
export async function computeRagCacheSize(): Promise<number> {
  try {
    let total = 0;
    await db.ragCache.each((entry) => {
      if (entry.vectorsBuffer && entry.dim && entry.chunkCount) {
        total += entry.chunkCount * entry.dim * 4;
        if (entry.chunks && entry.chunks.length > 0) {
          total += entry.chunks.reduce((sum, c) => sum + (c.content?.length || 0) * 2, 0);
        }
        if (entry.extraData) {
          total += entry.extraData.length * 2;
        }
      }
    });
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
    } catch (e) { console.warn("[rag] 淘汰监听器执行失败:", e); }
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

/** 淘汰决策只需要的那几个字段——绝不携带 vectorsBuffer/chunks */
interface CacheMeta {
  id: string;
  novelId: string;
  engine: string;
  size: number;
  createdAt: number;
  lastAccessed?: number;
  accessCount?: number;
}

/** 与 computeRagCacheSize 同口径：向量 + 文本 chunk + extraData */
function entrySizeOf(entry: { vectorsBuffer?: ArrayBuffer; dim?: number; chunkCount?: number; chunks?: { content?: string }[]; extraData?: string }): number {
  if (!entry.vectorsBuffer || !entry.dim || !entry.chunkCount) return 0;
  let size = entry.chunkCount * entry.dim * 4;
  if (entry.chunks?.length) {
    size += entry.chunks.reduce((sum, c) => sum + (c.content?.length || 0) * 2, 0);
  }
  if (entry.extraData) size += entry.extraData.length * 2;
  return size;
}

/**
 * 只取元数据的候选清单。
 *
 * 旧实现在**每淘汰一条**都执行一次 `db.ragCache.toArray()`：那会把整表（含
 * vectorsBuffer 与 chunks 全文）反序列化进内存，N 条 = N 次全表载入 —— 配额
 * 上限 500MB 时必然把标签页打死（round 2 R-08）。each() 逐条读取、读完即释放，
 * 峰值只有"最大单条"。
 */
async function collectCacheMeta(protectNovelIds: ReadonlySet<string>): Promise<CacheMeta[]> {
  const out: CacheMeta[] = [];
  await db.ragCache.each((entry) => {
    if (protectNovelIds.has(entry.novelId)) return;
    out.push({
      id: entry.id,
      novelId: entry.novelId,
      engine: entry.engine,
      size: entrySizeOf(entry),
      createdAt: entry.createdAt,
      lastAccessed: entry.lastAccessed,
      accessCount: entry.accessCount,
    });
  });
  return out;
}

/**
 * 按淘汰分数从高到低删除，直到腾出 needFree 字节或清单耗尽。
 *
 * 分数相同（或缺字段的坏条目 size=0）也要继续删：旧实现靠 `freed === 0` 退出，
 * 一条 size 算不出来的坏记录会让整个淘汰流程原地停下，缓存就此只增不减。
 */
async function evictToFree(needFree: number, extraProtect: Iterable<string> = []): Promise<{ freed: number; evicted: EvictedEntry[] }> {
  const protect = new Set<string>();
  for (const id of extraProtect) if (id) protect.add(id);
  const currentNovelId = getCurrentNovelId();
  if (currentNovelId) protect.add(currentNovelId);

  const candidates = (await collectCacheMeta(protect))
    .map((m) => ({ m, score: getEvictionScore(m) }))
    .sort((a, b) => b.score - a.score);

  let freed = 0;
  const evicted: EvictedEntry[] = [];
  for (const { m } of candidates) {
    if (freed >= needFree) break;
    try {
      await db.ragCache.delete(m.id);
    } catch (e) {
      console.warn("[rag] 淘汰写入失败，跳过该条:", m.id, e);
      continue;
    }
    useRAGStore.getState().removeCachedKey(m.id);
    freed += m.size;
    evicted.push({ id: m.id, novelId: m.novelId, engine: m.engine, size: m.size });
  }
  return { freed, evicted };
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
    // 用 where().modify() 而不是 get + put：后者会把整条记录（含 vectorsBuffer，
    // 大索引几十 MB）为了两个计数字段重写一遍，更要命的是它和 ensureCacheSpace 的
    // delete 竞态——淘汰先落地、这里迟到的 put 会把已删条目整份复活，而 store 那边
    // 早已登记"已淘汰"，于是内存记账与磁盘不一致，留下一条本轮 LRU 管不到的幽灵条目。
    await db.ragCache
      .where("id")
      .equals(`${novelId}-${engine}`)
      .modify((entry: { lastAccessed?: number; accessCount?: number }) => {
        entry.lastAccessed = Date.now();
        entry.accessCount = (entry.accessCount || 0) + 1;
      });
  } catch (e) { console.warn("[rag] 更新访问时间失败:", e); }
}

// ============================================================
// 预检查缓存空间
// ============================================================

/**
 * 确保有足够的缓存空间
 * @param requiredBytes 需要的字节数
 * @param protectNovelIds 额外不许淘汰的小说（默认只有"当前正在读的那本"）
 * @returns 是否成功腾出空间
 */
export async function ensureCacheSpace(requiredBytes: number, protectNovelIds?: Iterable<string>): Promise<boolean> {
  const limitBytes = useRAGStore.getState().cacheSizeMB * 1024 * 1024;
  const currentSize = await computeRagCacheSize();
  const available = limitBytes - currentSize;

  // 如果空间足够，直接返回
  if (available >= requiredBytes) return true;

  // 需要腾出的空间
  const needFree = requiredBytes - available;

  const { freed, evicted } = await evictToFree(needFree, protectNovelIds);

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
 * @param protectNovelIds 刚下载完的目标书也要保护，否则它会立刻被自己触发的
 *   淘汰清掉（round 2 R-26）
 */
export async function enforceIndexedDBQuota(protectNovelIds?: Iterable<string>) {
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

    const { freed, evicted } = await evictToFree(currentSize - limitBytes, protectNovelIds);
    currentSize -= freed;
    useRAGStore.getState().updateRagCacheSize(Math.max(0, currentSize));

    // 通知用户
    notifyEviction(evicted);

    if (currentSize > limitBytes) {
      // 无法完全达标：存在单条索引超过配额，或所有条目都是保护条目（当前小说）
      // 此时删除任意条目都无济于事，保留现状并提示用户
      console.warn(
        `[rag] 索引缓存 ${(currentSize / 1024 / 1024).toFixed(1)}MB 仍超过配额 ` +
        `${(limitBytes / 1024 / 1024).toFixed(0)}MB：存在单条索引过大或全部为保护条目。` +
        `可在设置页调大「索引缓存上限」`
      );
    }
  } finally {
    release();
  }
}
