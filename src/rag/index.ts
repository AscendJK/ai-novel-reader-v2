import { Retriever, type Chunk } from "./retriever";
import { EmbeddingRetriever, onLRUEvict, lruAdd, lruDelete, type EmbeddingProgress } from "./embedding-retriever";
import type { EngineId } from "./engines";
import { isEmbeddingEngine } from "./engines";
import { ragLog } from "@/lib/logger";
import { sharedDB as db } from "@/db/database";
import { useRAGStore } from "@/stores/rag-store";
import { updateRagCacheSize } from "./rag-cache-utils";
import { normalizeChunks } from "./chunk-utils";

export { updateRagCacheSize } from "./rag-cache-utils";
export { normalizeChunks } from "./chunk-utils";

interface IndexEntry {
  novelId: string;
  engine: EngineId;
  retriever: Retriever;
  embedding?: EmbeddingRetriever;
  chunks: Chunk[];
  buildTime?: number;
}

// Key: "${novelId}-${engine}" — supports multiple engines per novel
const indexCache = new Map<string, IndexEntry>();
const buildingNow = new Set<string>();

// LRU eviction only clears memory. IndexedDB is managed by its own quota.
onLRUEvict((evictedKey) => {
  const entry = indexCache.get(evictedKey);
  if (entry?.embedding) {
    entry.embedding.dispose();
    indexCache.delete(evictedKey);
  }
  useRAGStore.getState().removeLruKey(evictedKey);
  ragLog(`内存 LRU 淘汰: ${evictedKey}`);
});

export type { EmbeddingRetriever, EmbeddingProgress };

export async function buildIndex(
  novelId: string,
  chapters: { title: string; content: string }[],
  engine: EngineId = "tfidf",
  onProgress?: (msg: string) => void,
  options?: { cacheOnly?: boolean }
): Promise<Retriever | EmbeddingRetriever> {
  const cacheKey = `${novelId}-${engine}`;
  const existing = indexCache.get(cacheKey);
  if (existing) {
    return isEmbeddingEngine(engine) ? existing.embedding! : existing.retriever;
  }

  // Check IndexedDB cache first (no lock needed for read-only operations)
  if (isEmbeddingEngine(engine)) {
    try {
      const cached = await db.ragCache.get(cacheKey);
      if (cached && cached.vectorsBuffer && cached.dim > 0 && cached.chunks?.length > 0) {
        // 验证数据完整性
        const expectedBytes = cached.chunkCount * cached.dim * 4;
        if (cached.vectorsBuffer.byteLength !== expectedBytes) {
          ragLog(`缓存数据损坏: 期望 ${expectedBytes} 字节, 实际 ${cached.vectorsBuffer.byteLength} 字节`);
          await db.ragCache.delete(cacheKey);
          return null;
        }

        const chunks = normalizeChunks(cached.chunks);
        const caller = new Error().stack?.split('\n').slice(1, 4).map(s => s.trim()).join(' <- ') || 'unknown';
        ragLog(`从缓存加载索引: ${chunks.length}片段 · ${cached.dim}维 (调用者: ${caller})`);

        // 零拷贝创建 EmbeddingRetriever
        const emb = EmbeddingRetriever.fromArrayBuffer(cached.vectorsBuffer, chunks, cached.dim, engine);

        useRAGStore.getState().addCachedKey(cacheKey);
        lruAdd(cacheKey, emb.vectors, chunks, cached.dim);
        const entry: IndexEntry = { novelId, engine, retriever: new Retriever(chunks), embedding: emb, chunks, buildTime: 0 };
        indexCache.set(cacheKey, entry);
        return emb;
      }
    } catch (e) { ragLog(`缓存加载异常: ${e}`); }
  }

  // cacheOnly: only read from cache, don't trigger a build
  if (options?.cacheOnly) throw new Error("索引未缓存，需要先构建");

  // Lock: prevent concurrent builds for the same key
  if (buildingNow.has(cacheKey)) {
    ragLog(`索引正在构建中, 跳过重复请求`);
    throw new Error("Build already in progress");
  }
  buildingNow.add(cacheKey);

  try {
    onProgress?.("正在分割文本...");
    const chunks: Chunk[] = [];
    const chunkSize = 500;
    const overlap = 100;
    for (let ci = 0; ci < chapters.length; ci++) {
      const ch = chapters[ci];
      let start = 0;
      const { content } = ch;
      while (start < content.length) {
        const end = Math.min(start + chunkSize, content.length);
        const text = content.slice(start, end).trim();
        if (text) {
          chunks.push({ id: `${novelId}-${chunks.length}`, content: `[${ch.title}] ${text}`, chapterIndex: ci });
        }
        start += chunkSize - overlap;
      }
    }

    const t0 = Date.now();
    ragLog(`开始构建索引: ${chunks.length}片段 · 引擎: ${engine}`);

    if (isEmbeddingEngine(engine)) {
      onProgress?.("正在加载嵌入模型...");
      ragLog(`加载嵌入模型: ${engine}...`);
      const emb = new EmbeddingRetriever(engine);
      await emb.init(novelId, chunks, (p: EmbeddingProgress) => {
        if (p.phase === "encoding" && p.current != null && p.total != null) {
          onProgress?.(`正在编码文本 (${p.current}/${p.total})...`);
        } else if (p.phase === "done") {
          onProgress?.("编码完成");
        }
      });
      ragLog(`编码完成: ${chunks.length}片段 · ${(Date.now() - t0) / 1000}s`);

      const entry: IndexEntry = { novelId, engine, retriever: new Retriever(chunks), embedding: emb, chunks, buildTime: Date.now() - t0 };
      indexCache.set(cacheKey, entry);
      return emb;
    } else {
      const retriever = new Retriever(chunks);
      ragLog(`TF-IDF 索引就绪: ${chunks.length}片段 · ${(Date.now() - t0)}ms`);
      const entry: IndexEntry = { novelId, engine, retriever, chunks, buildTime: Date.now() - t0 };
      indexCache.set(cacheKey, entry);
      return retriever;
    }
  } finally {
    buildingNow.delete(cacheKey);
  }
}

export function getRetriever(novelId: string, engine: string): Retriever | undefined {
  return indexCache.get(`${novelId}-${engine}`)?.retriever;
}

export function getEmbeddingMeta(novelId: string, engine: string) {
  const e = indexCache.get(`${novelId}-${engine}`);
  if (!e?.embedding) return null;
  return { chunkCount: e.embedding.chunkCount, dim: e.embedding.vectorDim, buildTime: e.buildTime };
}

export { getEmbeddingMeta as getBGEMeta };

export function clearCache(novelId?: string, engine?: string) {
  const store = useRAGStore.getState();
  if (novelId && engine) {
    // Clear specific novel+engine
    const key = `${novelId}-${engine}`;
    const entry = indexCache.get(key);
    if (entry) {
      entry.embedding?.dispose();
      lruDelete(key);
      indexCache.delete(key);
    }
    db.ragCache.delete(key).then(() => updateRagCacheSize()).catch((e) => console.warn("[rag] delete cache failed:", e));
    store.removeCachedKey(key);
    store.removeLruKey(key);
  } else if (novelId) {
    // Clear all engines for a novel
    const keysToDelete: string[] = [];
    for (const [key, entry] of indexCache) {
      if (entry.novelId === novelId) keysToDelete.push(key);
    }
    for (const key of keysToDelete) {
      const entry = indexCache.get(key);
      entry?.embedding?.dispose();
      lruDelete(key);
      indexCache.delete(key);
      store.removeCachedKey(key);
      store.removeLruKey(key);
    }
    db.ragCache.where("novelId").equals(novelId).delete().then(() => updateRagCacheSize()).catch((e) => console.warn("[rag] delete novel cache failed:", e));
  } else {
    // Clear everything
    for (const [key, entry] of indexCache) {
      entry.embedding?.dispose();
      lruDelete(key);
      store.removeCachedKey(key);
      store.removeLruKey(key);
    }
    indexCache.clear();
    db.ragCache.clear().then(() => store.updateRagCacheSize(0)).catch((e) => console.warn("[rag] clear cache failed:", e));
  }
}

export async function retrieveRelevant(
  novelId: string,
  query: string,
  topK?: number,
  engine?: string
): Promise<string> {
  const effectiveEngine = engine || useRAGStore.getState().engine;
  const entry = indexCache.get(`${novelId}-${effectiveEngine}`);
  if (!entry) return "";

  const k = topK ?? useRAGStore.getState().getTopK(entry.chunks.length);

  if (isEmbeddingEngine(entry.engine) && entry.embedding) {
    const results = await entry.embedding.search(query, k);
    if (results.length > 0) {
      return results.map((r) => `[相关度: ${r.score.toFixed(3)}] ${r.chunk.content}`).join("\n\n---\n\n");
    }
    // Embedding search returned empty — fall back to TF-IDF
    ragLog("向量检索为空, 降级为 TF-IDF");
  }

  const results = entry.retriever.search(query, k);
  return results
    .map((r) => {
      const chunk = entry.chunks.find((c) => c.id === r.id);
      return chunk?.content || "";
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export async function retrieveRelevantWithDetails(
  novelId: string,
  query: string,
  topK?: number,
  engine?: string
): Promise<{ text: string; results: { content: string; score: number }[]; engine: string }> {
  const effectiveEngine = engine || useRAGStore.getState().engine;
  const entry = indexCache.get(`${novelId}-${effectiveEngine}`);
  if (!entry) return { text: "", results: [], engine: "none" };

  const k = topK ?? useRAGStore.getState().getTopK(entry.chunks.length);

  if (isEmbeddingEngine(entry.engine) && entry.embedding) {
    const results = await entry.embedding.search(query, k);
    if (results.length > 0) {
      return {
        engine: entry.engine,
        text: results.map((r) => `[相关度: ${r.score.toFixed(3)}] ${r.chunk.content}`).join("\n\n---\n\n"),
        results: results.map((r) => ({ content: r.chunk.content, score: r.score })),
      };
    }
    // Embedding search returned empty (server offline for encoding) — fall back to TF-IDF
    ragLog("向量检索为空, 降级为 TF-IDF");
  }

  const results = entry.retriever.search(query, k);
  const mapped = results
    .map((r) => {
      const chunk = entry.chunks.find((c) => c.id === r.id);
      return chunk ? { content: chunk.content, score: r.score } : null;
    })
    .filter(Boolean) as { content: string; score: number }[];
  return {
    engine: "tfidf",
    text: mapped.map((r) => `[TF-IDF] ${r.content}`).join("\n\n---\n\n"),
    results: mapped,
  };
}

/**
 * Retrieve relevant text filtered by chapter range (0-based inclusive).
 * Chunks without chapterIndex are included (backward compatibility).
 */
export async function retrieveRelevantForRange(
  novelId: string,
  query: string,
  fromChapter: number,
  toChapter: number,
  topK?: number,
  engine?: string
): Promise<{ text: string; results: { content: string; score: number }[]; engine: string }> {
  const effectiveEngine = engine || useRAGStore.getState().engine;
  const entry = indexCache.get(`${novelId}-${effectiveEngine}`);
  if (!entry) return { text: "", results: [], engine: "none" };

  const k = topK ?? useRAGStore.getState().getTopK(entry.chunks.length);
  const inRange = (ci?: number) => ci === undefined || (ci >= fromChapter && ci <= toChapter);

  if (isEmbeddingEngine(entry.engine) && entry.embedding) {
    const allResults = await entry.embedding.search(query, k * 3); // fetch extra to compensate for filtering
    const results = allResults.filter((r) => inRange(r.chunk.chapterIndex)).slice(0, k);
    if (results.length > 0) {
      return {
        engine: entry.engine,
        text: results.map((r) => `[相关度: ${r.score.toFixed(3)}] ${r.chunk.content}`).join("\n\n---\n\n"),
        results: results.map((r) => ({ content: r.chunk.content, score: r.score })),
      };
    }
    ragLog("向量检索为空, 降级为 TF-IDF");
  }

  const allResults = entry.retriever.search(query, k * 3);
  const mapped = allResults
    .map((r) => {
      const chunk = entry.chunks.find((c) => c.id === r.id);
      if (!chunk || !inRange(chunk.chapterIndex)) return null;
      return { content: chunk.content, score: r.score };
    })
    .filter(Boolean) as { content: string; score: number }[];
  return {
    engine: "tfidf",
    text: mapped.slice(0, k).map((r) => `[TF-IDF] ${r.content}`).join("\n\n---\n\n"),
    results: mapped.slice(0, k),
  };
}
