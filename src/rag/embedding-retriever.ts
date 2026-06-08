import type { Chunk } from "./retriever";
import { ragLog } from "@/lib/logger";
import { sharedDB as db } from "@/db/database";
import { useRAGStore } from "@/stores/rag-store";
import { useBuildStore } from "@/stores/build-store";
import { apiFetch } from "@/lib/api-client";
import { encodeQuery } from "./client-encoder";
import { enforceIndexedDBQuota, updateAccessTime } from "./rag-cache-utils";
import { buildAndPollRAGIndex, downloadAndCacheIndex } from "./build-index";

export type BGEProgress = EmbeddingProgress;
export type BGERetrieverData = EmbeddingRetrieverData;

export interface EmbeddingProgress { phase: "loading" | "encoding" | "done"; current?: number; total?: number; }
export interface EmbeddingRetrieverData { vectors: number[][]; chunks: Chunk[]; dim: number; }

const LRU_CACHE = new Map<string, { vectors: Float32Array[]; chunks: Chunk[]; dim: number; size: number }>();
let cacheTotalSize = 0;

const evictListeners: Set<(key: string) => void> = new Set();
export function onLRUEvict(fn: (key: string) => void) { evictListeners.add(fn); return () => evictListeners.delete(fn); }

/** Add an entry to the LRU memory cache and evict if over limit */
export function lruAdd(key: string, vectors: Float32Array[], chunks: Chunk[], dim: number) {
  const size = vectors.length * dim * 4;
  // Remove old entry if exists
  const old = LRU_CACHE.get(key);
  if (old) cacheTotalSize -= old.size;
  LRU_CACHE.set(key, { vectors, chunks, dim, size });
  cacheTotalSize += size;
  try { useRAGStore.getState().addLruKey(key); } catch { /* ignore */ }
  evictLRU();
}

/** Remove a specific entry from LRU cache */
export function lruDelete(key: string) {
  const entry = LRU_CACHE.get(key);
  if (entry) {
    cacheTotalSize -= entry.size;
    LRU_CACHE.delete(key);
  }
}

/** Check if key exists in LRU cache */
export function lruHas(key: string): boolean {
  return LRU_CACHE.has(key);
}

// Memory LRU is fixed at 100MB. IndexedDB capacity is managed separately.
const MEMORY_CACHE_LIMIT_MB = 100;
function getMaxCacheMB() { return MEMORY_CACHE_LIMIT_MB; }

function evictLRU() {
  const max = getMaxCacheMB() * 1024 * 1024;
  while (cacheTotalSize > max) {
    const firstKey = LRU_CACHE.keys().next().value;
    if (!firstKey) break;
    const entry = LRU_CACHE.get(firstKey)!;
    cacheTotalSize -= entry.size;
    LRU_CACHE.delete(firstKey);
    ragLog(`LRU 淘汰: ${firstKey}, 释放 ${(entry.size / 1024 / 1024).toFixed(1)}MB`);
    for (const fn of evictListeners) fn(firstKey);
  }
}

export class EmbeddingRetriever {
  private vectors: Float32Array[] = [];
  private chunks: Chunk[] = [];
  private dim = 0;
  private engine: string;

  constructor(engine: string = "Xenova/bge-small-zh-v1.5") {
    this.engine = engine;
  }

  get chunkCount() { return this.chunks.length; }
  get vectorDim() { return this.dim; }

  toData(): EmbeddingRetrieverData {
    return { vectors: this.vectors.map((v) => Array.from(v)), chunks: this.chunks, dim: this.dim };
  }

  static fromData(data: EmbeddingRetrieverData, engine: string = "Xenova/bge-small-zh-v1.5"): EmbeddingRetriever {
    const r = new EmbeddingRetriever(engine);
    r.vectors = data.vectors.map((v) => new Float32Array(v));
    r.chunks = data.chunks;
    r.dim = data.dim;
    return r;
  }

  /**
   * 从 ArrayBuffer 零拷贝创建实例
   * 使用 Float32Array.subarray 创建视图，不复制数据
   */
  static fromArrayBuffer(buffer: ArrayBuffer, chunks: Chunk[], dim: number, engine: string = "Xenova/bge-small-zh-v1.5"): EmbeddingRetriever {
    const r = new EmbeddingRetriever(engine);
    r.loadFromBuffer(buffer, chunks, dim);
    return r;
  }

  /**
   * 从 ArrayBuffer 零拷贝加载数据到当前实例
   * 使用 Float32Array.subarray 创建视图，不复制数据
   */
  loadFromBuffer(buffer: ArrayBuffer, chunks: Chunk[], dim: number): void {
    const f32 = new Float32Array(buffer);
    this.vectors = Array.from({ length: chunks.length }, (_, i) => f32.subarray(i * dim, (i + 1) * dim));
    this.chunks = chunks;
    this.dim = dim;
  }

  async init(
    novelId: string,
    _allChunks: Chunk[],
    onProgress?: (p: EmbeddingProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const memCacheKey = `${novelId}-${this.engine}`;

    // Check LRU memory cache first
    const memCached = LRU_CACHE.get(memCacheKey);
    if (memCached) {
      LRU_CACHE.delete(memCacheKey);
      LRU_CACHE.set(memCacheKey, memCached);
      this.vectors = memCached.vectors;
      this.chunks = memCached.chunks;
      this.dim = memCached.dim;
      onProgress?.({ phase: "done" });
      return;
    }

    onProgress?.({ phase: "loading" });

    // Check IndexedDB cache
    try {
      const cached = await db.ragCache.get(memCacheKey);
      if (cached && cached.vectorsBuffer && cached.dim > 0 && cached.chunks?.length > 0) {
        // 验证数据完整性
        const expectedBytes = cached.chunkCount * cached.dim * 4;
        if (cached.vectorsBuffer.byteLength !== expectedBytes) {
          ragLog(`缓存数据损坏: 期望 ${expectedBytes} 字节, 实际 ${cached.vectorsBuffer.byteLength} 字节`);
          await db.ragCache.delete(memCacheKey);
          return;
        }

        // 零拷贝加载
        this.loadFromBuffer(cached.vectorsBuffer, cached.chunks, cached.dim);
        useRAGStore.getState().addCachedKey(memCacheKey);
        lruAdd(memCacheKey, this.vectors, this.chunks, this.dim);
        // 更新访问记录（用于智能淘汰策略）
        updateAccessTime(novelId, this.engine);
        onProgress?.({ phase: "done" });
        return;
      }
    } catch { /* no cached index */ }

    // 检查服务器状态，触发构建并轮询
    ragLog("检查服务器索引状态...");
    const statusCheck = await apiFetch(`/api/rag/${novelId}/status?engine=${encodeURIComponent(this.engine)}`);
    const statusData = await statusCheck.json();

    // 如果服务器已有索引，直接下载
    if (statusData.status === "ready") {
      ragLog("服务器索引已就绪，下载中...");
      await downloadAndCacheIndex({ novelId, engine: this.engine, updateStore: false });
      // 从 IndexedDB 重新加载到内存
      const cached = await db.ragCache.get(memCacheKey);
      if (cached && cached.vectorsBuffer && cached.dim > 0 && cached.chunks?.length > 0) {
        this.loadFromBuffer(cached.vectorsBuffer, cached.chunks, cached.dim);
        useRAGStore.getState().addCachedKey(memCacheKey);
        lruAdd(memCacheKey, this.vectors, this.chunks, this.dim);
      }
      onProgress?.({ phase: "done" });
      return;
    }

    // 触发构建并轮询
    ragLog("触发服务器构建...");
    useBuildStore.getState().startBuild(novelId, this.engine);

    try {
      await buildAndPollRAGIndex({
        novelId,
        engine: this.engine,
        signal,
        onProgress: (progress) => {
          useBuildStore.getState().updateProgress(novelId, this.engine, {
            message: progress.message || "",
            current: progress.current || 0,
            total: progress.total || _allChunks.length,
            status: progress.status,
            queuePosition: progress.queuePosition,
          });
          if (progress.status === "loading" || progress.status === "building" || progress.status === "encoding") {
            onProgress?.({ phase: "encoding", current: progress.current || 0, total: progress.total || _allChunks.length });
          }
        },
      });

      useBuildStore.getState().finishBuild(novelId, this.engine);

      // 从 IndexedDB 加载到内存
      const cached = await db.ragCache.get(memCacheKey);
      if (cached && cached.vectorsBuffer && cached.dim > 0 && cached.chunks?.length > 0) {
        this.loadFromBuffer(cached.vectorsBuffer, cached.chunks, cached.dim);
        useRAGStore.getState().addCachedKey(memCacheKey);
        lruAdd(memCacheKey, this.vectors, this.chunks, this.dim);
      }
      onProgress?.({ phase: "done" });

    } catch (err) {
      const message = err instanceof Error ? err.message : "构建失败";
      useBuildStore.getState().failBuild(novelId, this.engine, message);
      throw err;
    }
  }

  async search(query: string, topK: number = 15): Promise<{ chunk: Chunk; score: number }[]> {
    if (this.vectors.length === 0) return [];
    let qVec: Float32Array | null = null;

    // Try server-side encoding first
    try {
      const resp = await apiFetch("/api/rag/encode", {
        method: "POST",
        body: JSON.stringify({ texts: [query], engine: this.engine }),
      });
      if (resp.ok) {
        const { vectors: [qArr] } = await resp.json();
        qVec = new Float32Array(qArr);
      }
    } catch {
      // Server offline — try client-side
    }

    // Fall back to client-side encoding (offline)
    if (!qVec) {
      ragLog("服务器编码不可用, 尝试浏览器端编码...");
      qVec = await encodeQuery(query, this.engine);
    }

    if (!qVec) {
      ragLog("查询编码失败, 返回空");
      return [];
    }

    // 验证向量维度
    if (qVec.length !== this.dim) {
      ragLog(`查询向量维度不匹配: 期望 ${this.dim}, 实际 ${qVec.length}`);
      return [];
    }

    const scores = this.vectors.map((v, i) => {
      let dot = 0;
      for (let j = 0; j < qVec!.length; j++) dot += qVec![j] * v[j];
      return { index: i, score: dot };
    });
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK).map((s) => ({ chunk: this.chunks[s.index], score: s.score }));
  }

  dispose() {
    this.vectors = [];
    this.chunks = [];
    this.dim = 0;
  }
}

export { EmbeddingRetriever as BGERetriever };
