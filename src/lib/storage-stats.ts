/**
 * 浏览器存储统计模块
 *
 * 汇总各分类占用（IndexedDB / Cache Storage / localStorage），
 * 供设置页「存储管理」面板展示与清理。
 *
 * 分类：
 * - user-data      小说数据（章节全文、总结、笔记、图谱、地图，按用户隔离）
 * - rag-index      RAG 向量索引缓存（sharedDB.ragCache）
 * - tts-cache      TTS 语音模型与引擎（tts-cache 库，约 380MB）
 * - embedding-models 嵌入模型（Cache Storage: transformers-cache）
 * - pwa-cache      应用静态资源（Cache Storage: workbox-*）
 * - config         localStorage + 共享设置（阅读进度、API 配置等）
 */

import { sharedDB, getUserDB } from "@/db/database";
import { computeRagCacheSize } from "@/rag/rag-cache-utils";
import { computeTTSCacheSize } from "@/tts/tts-cache";
import { getTransformersCacheInfo } from "@/rag/model-loader";

export interface StorageCategory {
  id: string;
  label: string;
  description: string;
  bytes: number;
  /** 额外说明（条目数等） */
  detail?: string;
  /** 是否可清理（有对应清理动作） */
  cleanable: boolean;
}

export interface StorageBreakdown {
  /** 浏览器已用空间（estimate，含本站点全部数据） */
  usage: number;
  /** 浏览器配额 */
  quota: number;
  /** estimate 是否可用 */
  support: boolean;
  categories: StorageCategory[];
  /** 统计耗时（ms） */
  elapsed: number;
}

/** 估算每个用户库记录条目的固定开销（id + 索引 + 元数据） */
const RECORD_OVERHEAD = 300;

/** 统计当前用户库（小说数据）占用 */
async function computeUserDBStats(): Promise<{ bytes: number; detail: string }> {
  try {
    if (!localStorage.getItem("sync-username")) return { bytes: 0, detail: "未登录" };
    const db = getUserDB();

    // 章节全文是主体：游标流式累加 content 长度（不一次性加载全部）
    let chapterBytes = 0;
    let chapterCount = 0;
    await db.chapters.each((ch) => {
      chapterBytes += ((ch.content?.length || 0) * 2) + RECORD_OVERHEAD;
      chapterCount++;
    });

    let summaryBytes = 0;
    let summaryCount = 0;
    await db.summaries.each((s) => {
      summaryBytes += ((s.content?.length || 0) * 2) + RECORD_OVERHEAD + 200;
      summaryCount++;
    });

    let noteBytes = 0;
    let noteCount = 0;
    await db.notes.each((n) => {
      noteBytes += ((n.content?.length || 0) * 2) + RECORD_OVERHEAD + 200;
      noteCount++;
    });

    // maps / graphs 为单条 JSON 记录，直接读取估算
    let mapBytes = 0;
    for (const m of await db.maps.toArray()) {
      mapBytes += JSON.stringify(m.data ?? {}).length * 2 + RECORD_OVERHEAD;
    }
    let graphBytes = 0;
    for (const g of await db.graphs.toArray()) {
      graphBytes += JSON.stringify(g.data ?? {}).length * 2 + RECORD_OVERHEAD;
    }

    const novelCount = await db.novels.count();
    const total = chapterBytes + summaryBytes + noteBytes + mapBytes + graphBytes + novelCount * RECORD_OVERHEAD;

    return {
      bytes: total,
      detail: `${novelCount} 本小说 · ${chapterCount} 章 · ${summaryCount} 条总结 · ${noteCount} 条笔记`,
    };
  } catch {
    return { bytes: 0, detail: "未登录" };
  }
}

/** 统计共享设置（sharedDB.settings）占用 */
async function computeSharedSettingsSize(): Promise<number> {
  try {
    let bytes = 0;
    await sharedDB.settings.each((s) => {
      bytes += s.key.length * 2 + JSON.stringify(s.value ?? {}).length * 2;
    });
    return bytes;
  } catch { return 0; }
}

/** 统计 Cache Storage（transformers-cache / workbox-* / 其他）占用 */
async function computeCacheStorageStats(): Promise<{
  transformers: { bytes: number; count: number };
  pwa: { bytes: number; count: number };
  other: { bytes: number; count: number };
}> {
  const result = {
    transformers: { bytes: 0, count: 0 },
    pwa: { bytes: 0, count: 0 },
    other: { bytes: 0, count: 0 },
  };
  try {
    if (typeof caches === "undefined") return result;
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      let bytes = 0;
      // 优先用 content-length 头；缺失时最多读 5 个 body 估算（避免大模型全量读入内存）
      let bodyReads = 0;
      const MAX_BODY_READS = 5;
      for (const req of requests) {
        const resp = await cache.match(req);
        if (!resp) continue;
        const len = parseInt(resp.headers.get("content-length") || "0", 10);
        if (len > 0) { bytes += len; continue; }
        if (bodyReads < MAX_BODY_READS) {
          try {
            const buf = await resp.clone().arrayBuffer();
            bytes += buf.byteLength;
            bodyReads++;
          } catch { /* 读取失败跳过 */ }
        }
      }
      if (name === "transformers-cache") {
        result.transformers.bytes = bytes;
        result.transformers.count = requests.length;
      } else if (name.startsWith("workbox-")) {
        result.pwa.bytes = bytes;
        result.pwa.count = requests.length;
      } else {
        result.other.bytes += bytes;
        result.other.count += requests.length;
      }
    }
  } catch { /* Cache API 不可用时忽略 */ }
  return result;
}

/** 统计 localStorage 占用（UTF-16 编码估算） */
function computeLocalStorageSize(): number {
  try {
    let bytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      bytes += k.length * 2;
      const v = localStorage.getItem(k);
      if (v) bytes += v.length * 2;
    }
    return bytes;
  } catch { return 0; }
}

/**
 * 获取浏览器存储占用全览
 * 各分类独立统计互不影响，任一失败不影响整体结果
 */
export async function getStorageBreakdown(): Promise<StorageBreakdown> {
  const t0 = Date.now();

  const [userDB, ragBytes, ttsBytes, settingsBytes, cacheStats, lsBytes, estimate] = await Promise.all([
    computeUserDBStats(),
    computeRagCacheSize().catch(() => 0),
    computeTTSCacheSize().catch(() => 0),
    computeSharedSettingsSize(),
    computeCacheStorageStats(),
    Promise.resolve(computeLocalStorageSize()),
    (navigator.storage?.estimate?.() ?? Promise.resolve(null)).catch(() => null),
  ]);

  const categories: StorageCategory[] = [
    {
      id: "user-data",
      label: "小说数据",
      description: "章节全文、AI 总结、笔记、图谱、地图（按用户隔离）",
      bytes: userDB.bytes,
      detail: userDB.detail,
      cleanable: false,
    },
    {
      id: "rag-index",
      label: "RAG 索引缓存",
      description: "语义检索索引（向量 + 文本分块），超过配额自动淘汰",
      bytes: ragBytes,
      cleanable: true,
    },
    {
      id: "tts-cache",
      label: "TTS 语音模型",
      description: "Kokoro 离线模型与 WASM 引擎（浏览器推理用）",
      bytes: ttsBytes,
      cleanable: true,
    },
    {
      id: "embedding-models",
      label: "嵌入模型",
      description: "语义检索引擎模型文件（transformers-cache）",
      bytes: cacheStats.transformers.bytes,
      detail: `${cacheStats.transformers.count} 个文件`,
      cleanable: true,
    },
    {
      id: "pwa-cache",
      label: "应用静态资源",
      description: "PWA 预缓存（随版本更新自动清理）",
      bytes: cacheStats.pwa.bytes + cacheStats.other.bytes,
      detail: `${cacheStats.pwa.count + cacheStats.other.count} 个文件`,
      cleanable: false,
    },
    {
      id: "config",
      label: "配置与设置",
      description: "localStorage 与共享设置（阅读进度、API 配置、同步凭据等）",
      bytes: lsBytes + settingsBytes,
      cleanable: false,
    },
  ];

  return {
    usage: estimate?.usage || 0,
    quota: estimate?.quota || 0,
    support: !!estimate,
    categories,
    elapsed: Date.now() - t0,
  };
}

/** 格式化字节数 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 获取嵌入模型缓存信息（复用 model-loader 的检测） */
export async function getEmbeddingModelCacheInfo() {
  return getTransformersCacheInfo();
}
