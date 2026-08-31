/**
 * 浏览器配额（QuotaExceededError）自动兜底降级链
 *
 * 当 IndexedDB 写入因存储空间不足失败时，按安全等级依次释放空间后重试：
 * 1. RAG 索引配额淘汰（只清可重建的索引缓存）
 * 2. TTS 孤儿文件清理（下载中断 / 废弃版本残留）
 * 3. 删除非当前使用、非默认的嵌入模型缓存
 *
 * 设计：
 * - 使用动态 import 避免与清理目标模块产生循环依赖
 * - 每次降级后通过 navigator.storage.estimate() 验证是否真的释放了空间
 * - 最多重试 MAX_RETRIES 次，仍失败则抛出原始错误
 */

const MAX_RETRIES = 3;

/** 判断错误是否为浏览器存储配额超限 */
export function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const name = (e as { name?: string }).name || "";
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

async function currentUsage(): Promise<number | null> {
  try {
    const est = await navigator.storage.estimate();
    return est.usage ?? null;
  } catch { return null; }
}

/** 降级链各步骤（按安全等级从低到高） */
const FALLBACK_STEPS: Array<() => Promise<void>> = [
  // 1. RAG 索引配额淘汰：只清超出配额的最旧/最少用索引（可重新构建）
  async () => {
    const m = await import("@/rag/rag-cache-utils");
    await m.enforceIndexedDBQuota();
  },
  // 2. TTS 孤儿文件：下载中断 / 废弃版本残留（不影响当前必需文件）
  async () => {
    const m = await import("@/tts/tts-cache");
    await m.cleanupOrphanFiles();
  },
  // 3. 非激活嵌入模型：删除非当前使用、非默认的模型缓存（按需重新下载）
  async () => {
    const m = await import("@/rag/model-loader");
    await m.deleteNonActiveEmbeddingModels();
  },
];

/**
 * 依次执行降级链，返回是否检测到空间释放
 */
async function runFallbackChain(): Promise<boolean> {
  for (const step of FALLBACK_STEPS) {
    const before = await currentUsage();
    try {
      await step();
    } catch { /* 单步失败继续下一步 */ }
    const after = await currentUsage();
    // 无法测量时假定有效（由 MAX_RETRIES 兜底防止死循环）
    if (before === null || after === null || after < before) return true;
  }
  return false;
}

/**
 * 包裹一个 IndexedDB 写操作，遇到配额不足时自动降级清理并重试。
 *
 * @example
 * await withQuotaRetry(() => db.ragCache.put(record));
 */
export async function withQuotaRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isQuotaError(e)) throw e; // 非配额错误直接抛
      if (attempt >= MAX_RETRIES) break;
      const freed = await runFallbackChain();
      if (!freed) break; // 降级链没有释放任何空间，重试无意义
      console.warn(`[quota-guard] 配额不足，已执行降级清理，重试写入 (${attempt + 1}/${MAX_RETRIES})`);
    }
  }
  throw lastError;
}
