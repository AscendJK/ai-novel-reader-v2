/**
 * Model loader — 统一从后端代理下载模型。
 * 前端不再直连 HuggingFace / hf-mirror；所有模型文件通过后端
 * /api/rag/model-proxy 拉取，后端负责磁盘缓存与镜像回源
 * （配置/环境变量 → hf-mirror → HuggingFace）。
 */

import { useRAGStore } from "@/stores/rag-store";
import { broadcast } from "@/lib/broadcast";
import { getServerUrl } from "@/lib/api-client";

/**
 * 获取后端模型代理地址。仅支持后端代理一种来源。
 * 未配置服务器地址时返回空串（调用方应直接失败，不再回退直连镜像）。
 */
export function getRemoteHost(): string {
  const serverUrl = getServerUrl();
  return serverUrl ? `${serverUrl}/api/rag/model-proxy/` : "";
}

/**
 * 获取前端模型下载源信息（仅后端代理一种来源）。
 * 模型统一通过后端 /api/rag/model-proxy 拉取，后端负责缓存与镜像回源。
 */
export function getMirrorOptions(): { id: string; name: string; url: string }[] {
  const serverUrl = getServerUrl();
  if (serverUrl) {
    return [{ id: "backend-proxy", name: "后端代理", url: `${serverUrl}/api/rag/model-proxy/` }];
  }
  return [{ id: "backend-proxy", name: "后端代理", url: "" }];
}

// ── Engine list (unified, no builtin/custom distinction) ──

export interface EngineInfo {
  key: string;
  modelKey: string;
  name: string;
  size: string;
  description: string;
  url: string;
}

// key === modelKey，与 engines.ts 的 ENGINES ID 完全一致
export const ALL_ENGINES: EngineInfo[] = [
  {
    key: "Xenova/bge-small-zh-v1.5",
    modelKey: "Xenova/bge-small-zh-v1.5",
    name: "BGE Small ZH",
    size: "~26 MB",
    description: "中文语义检索，精度高，推荐中文小说使用",
    url: "https://huggingface.co/Xenova/bge-small-zh-v1.5",
  },
  {
    key: "Xenova/gte-small",
    modelKey: "Xenova/gte-small",
    name: "GTE Small",
    size: "~34 MB",
    description: "中英文均衡，阿里通义实验室出品",
    url: "https://huggingface.co/Xenova/gte-small",
  },
  {
    key: "Xenova/multilingual-e5-small",
    modelKey: "Xenova/multilingual-e5-small",
    name: "Multilingual E5 Small",
    size: "~120 MB",
    description: "微软多语言模型，100+语言，中英文兼顾",
    url: "https://huggingface.co/Xenova/multilingual-e5-small",
  },
  {
    key: "Xenova/all-MiniLM-L6-v2",
    modelKey: "Xenova/all-MiniLM-L6-v2",
    name: "All-MiniLM-L6-v2",
    size: "~23 MB",
    description: "英文最佳轻量模型，体积小速度快",
    url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2",
  },
  {
    key: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    modelKey: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    name: "Multilingual MiniLM L12",
    size: "~120 MB",
    description: "50+语言深度语义理解，多语言场景最强",
    url: "https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  },
];

// ── Download queue (one at a time) ──

const downloadQueue: Array<{ modelKey: string; resolve: (ok: boolean) => void }> = [];
let isDownloading = false;
// Waiters for in-progress downloads: modelKey → resolve functions
const downloadWaiters = new Map<string, Array<(ok: boolean) => void>>();

/**
 * Download a model from HuggingFace Hub. One at a time — if another download
 * is in progress, the request is queued.
 *
 * @returns true if download succeeded, false if failed
 */
export async function downloadModel(modelKey: string): Promise<boolean> {
  const store = useRAGStore.getState();

  // Already downloaded
  if (store.isModelDownloaded(modelKey)) {
    console.log(`[model-loader] ${modelKey} 已下载，跳过`);
    return true;
  }

  // Another download in progress — queue or wait for same model
  if (isDownloading) {
    if (store.currentDownload === modelKey) {
      // Same model already downloading — wait for it to complete
      return new Promise((resolve) => {
        const waiters = downloadWaiters.get(modelKey) || [];
        waiters.push(resolve);
        downloadWaiters.set(modelKey, waiters);
      });
    }
    // Different model — queue it
    return new Promise((resolve) => {
      downloadQueue.push({ modelKey, resolve });
    });
  }

  isDownloading = true;
  store.setCurrentDownload(modelKey);
  store.setDownloadProgress("准备下载...");

  const maxRetries = 3;
  let success = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[model-loader] 下载模型 ${modelKey} (${attempt}/${maxRetries})`);
      store.setDownloadProgress(`下载中 (${attempt}/${maxRetries})...`);

      const transformers = await import("@xenova/transformers");
      const { AutoModel, AutoTokenizer, env } = transformers;

      env.allowRemoteModels = true;
      env.useBrowserCache = typeof caches !== 'undefined' && typeof caches.open === 'function';

      // 模型统一从后端代理拉取；未配置服务器地址时直接失败
      const serverUrl = getServerUrl();
      if (!serverUrl) {
        throw new Error("未配置服务器地址，无法从后端下载模型。请在设置中配置服务器地址。");
      }
      env.remoteHost = `${serverUrl}/api/rag/model-proxy`;
      console.log(`[model-loader] remoteHost=${env.remoteHost}`);

      // Download tokenizer
      store.setDownloadProgress("下载 tokenizer...");
      console.log(`[model-loader] 开始下载 tokenizer, remoteHost=${env.remoteHost}`);
      try {
        await AutoTokenizer.from_pretrained(modelKey, {
          progress_callback: (data: { status?: string; file?: string; loaded?: number; total?: number; error?: string }) => {
            if (data.status === "progress" && data.file) {
              const loaded = data.loaded || 0;
              const total = data.total || 0;
              if (total > 0 && loaded < total) {
                const loadedMB = (loaded / 1024 / 1024).toFixed(1);
                const totalMB = (total / 1024 / 1024).toFixed(0);
                store.setDownloadProgress(`tokenizer ${loadedMB}/${totalMB}MB`);
              } else if (total > 0 && loaded >= total) {
                store.setDownloadProgress("tokenizer ✓");
              }
            } else if (data.status === "done") {
              console.log(`[model-loader] tokenizer 下载完成: ${data.file}`);
            } else if (data.status === "error") {
              console.error(`[model-loader] tokenizer 下载错误: ${data.file} - ${data.error}`);
            }
          },
        });
      } catch (e) {
        console.error(`[model-loader] tokenizer 加载失败:`, e);
        throw e;
      }

      // Download model
      store.setDownloadProgress("下载模型...");
      await AutoModel.from_pretrained(modelKey, {
        progress_callback: (data: { status?: string; file?: string; loaded?: number; total?: number }) => {
          if (data.status === "progress" && data.file) {
            const loaded = data.loaded || 0;
            const total = data.total || 0;
            if (total > 0 && loaded < total) {
              const loadedMB = (loaded / 1024 / 1024).toFixed(1);
              const totalMB = (total / 1024 / 1024).toFixed(0);
              store.setDownloadProgress(`model ${loadedMB}/${totalMB}MB`);
            } else if (total > 0 && loaded >= total) {
              store.setDownloadProgress("model ✓");
            }
          }
        },
      });

      console.log(`[model-loader] 模型下载完成: ${modelKey}`);
      store.addDownloadedModel(modelKey);
      store.setDownloadProgress("下载完成");

      // Broadcast to other tabs
      try { broadcast.send("model-download-complete"); } catch { /* ignore */ }

      success = true;
      break;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[model-loader] 下载失败 (${attempt}/${maxRetries}): ${errMsg}`);
      // 尝试获取实际请求的 URL
      if (errMsg.includes("'") && errMsg.includes("404")) {
        console.error(`[model-loader] 请求可能被重定向到了不存在的路径，请检查后端是否运行`);
      }
      if (attempt < maxRetries) {
        store.setDownloadProgress(`下载失败，重试中 (${attempt}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }

  if (!success) {
    console.error(`[model-loader] 模型下载最终失败: ${modelKey}`);
    store.setDownloadProgress("下载失败");
  }

  // Resolve all waiters for this model
  const waiters = downloadWaiters.get(modelKey);
  if (waiters) {
    waiters.forEach((resolve) => resolve(success));
    downloadWaiters.delete(modelKey);
  }

  // Clear download state
  isDownloading = false;
  store.setCurrentDownload(null);
  store.setDownloadProgress("");

  // Process queue
  if (downloadQueue.length > 0) {
    const next = downloadQueue.shift()!;
    // Small delay before next download
    setTimeout(() => downloadModel(next.modelKey).then(next.resolve), 500);
  }

  return success;
}

/**
 * Wait for a model to be downloaded. Used by build-index to ensure model is ready.
 * If the model is not downloaded, starts the download and waits.
 */
export async function ensureModelReady(modelKey: string): Promise<boolean> {
  const store = useRAGStore.getState();
  if (store.isModelDownloaded(modelKey)) return true;

  // Start download and wait
  return downloadModel(modelKey);
}

/**
 * Check if a model is downloaded (checks localStorage).
 */
export function isModelDownloaded(modelKey: string): boolean {
  return useRAGStore.getState().isModelDownloaded(modelKey);
}

/**
 * Initialize Transformers.js environment.
 * Called once at app startup.
 */
export async function setupModelLoader(): Promise<void> {
  try {
    const transformers = await import("@xenova/transformers");
    const { env } = transformers;
    env.allowRemoteModels = true;
    env.useBrowserCache = typeof caches !== 'undefined' && typeof caches.open === 'function';
    env.allowLocalModels = false; // public/models 为空，不检查本地路径
    // 有 serverUrl 时设置 remoteHost，让 transformers.js 请求后端代理
    const serverUrl = getServerUrl();
    if (serverUrl) {
      env.remoteHost = `${serverUrl}/api/rag/model-proxy`;
    }
    console.log("[model-loader] 初始化完成");
  } catch (e) {
    console.error("[model-loader] 初始化失败:", e);
  }
}

// ── Transformers.js 模型缓存管理（Cache Storage: transformers-cache） ──

const TRANSFORMERS_CACHE_NAME = "transformers-cache";

/** 判断缓存请求 URL 是否属于某模型 */
function urlMatchesModel(url: string, modelKey: string): boolean {
  // URL 形如 ".../model-proxy/Xenova/bge-small-zh-v1.5/tokenizer.json" 或
  // "Xenova/bge-small-zh-v1.5/tokenizer.json"（transformers.js 缓存 key 为完整 URL）
  const norm = url.split("?")[0].replace(/\/+$/, "");
  return norm.includes(`/${modelKey}/`) || norm.endsWith(`/${modelKey}`);
}

async function openTransformersCache(): Promise<Cache | null> {
  try {
    if (typeof caches === "undefined") return null;
    return await caches.open(TRANSFORMERS_CACHE_NAME);
  } catch { return null; }
}

export interface TransformersCacheInfo {
  /** modelKey → { 文件数, 估算字节 } */
  modelFiles: Map<string, { count: number; bytes: number }>;
  /** 不属于任何已知模型的孤儿条目 */
  orphanCount: number;
  orphanBytes: number;
}

/**
 * 检测 transformers-cache 中实际缓存的模型文件
 * 用于与 localStorage 的 downloadedModels 标记比对（修复失同步）
 */
export async function getTransformersCacheInfo(): Promise<TransformersCacheInfo> {
  const info: TransformersCacheInfo = {
    modelFiles: new Map(),
    orphanCount: 0,
    orphanBytes: 0,
  };
  const cache = await openTransformersCache();
  if (!cache) return info;

  try {
    const requests = await cache.keys();
    const knownModels = new Set<string>([
      ...ALL_ENGINES.map((e) => e.modelKey),
      ...useRAGStore.getState().savedCustomModels.map((m) => m.key),
    ]);

    for (const req of requests) {
      const url = req.url;
      let matched: string | null = null;
      for (const key of knownModels) {
        if (urlMatchesModel(url, key)) { matched = key; break; }
      }
      let bytes = 0;
      const resp = await cache.match(req);
      if (resp) {
        const len = parseInt(resp.headers.get("content-length") || "0", 10);
        bytes = len > 0 ? len : 0;
      }
      if (matched) {
        const cur = info.modelFiles.get(matched) || { count: 0, bytes: 0 };
        cur.count++;
        cur.bytes += bytes;
        info.modelFiles.set(matched, cur);
      } else {
        info.orphanCount++;
        info.orphanBytes += bytes;
      }
    }
  } catch (e) { console.warn("[model-loader] 检测 transformers-cache 失败:", e); }
  return info;
}

/**
 * 删除某模型在 transformers-cache 中的所有缓存文件
 * @returns 删除的文件数
 */
export async function deleteModelCache(modelKey: string): Promise<number> {
  const cache = await openTransformersCache();
  if (!cache) return 0;
  try {
    const requests = await cache.keys();
    let removed = 0;
    for (const req of requests) {
      if (urlMatchesModel(req.url, modelKey)) {
        await cache.delete(req);
        removed++;
      }
    }
    if (removed > 0) {
      // 同步移除 localStorage 中的下载标记，避免失同步
      useRAGStore.getState().removeDownloadedModel(modelKey);
      console.log(`[model-loader] 已删除模型缓存: ${modelKey} (${removed} 个文件)`);
    }
    return removed;
  } catch (e) {
    console.warn(`[model-loader] 删除模型缓存失败: ${modelKey}`, e);
    return 0;
  }
}

/**
 * 校验 localStorage 的 downloadedModels 标记与 Cache Storage 实际内容是否一致。
 * 返回已标记下载但实际缓存丢失的模型 key 列表（自动修正标记）。
 */
export async function verifyDownloadedModels(): Promise<string[]> {
  const store = useRAGStore.getState();
  const marked = [...store.downloadedModels];
  if (marked.length === 0) return [];

  const info = await getTransformersCacheInfo();
  const stale: string[] = [];
  for (const key of marked) {
    const files = info.modelFiles.get(key);
    // 没有任何缓存文件 → 标记失效（模型文件被浏览器清理或从未真正下载）
    if (!files || files.count === 0) {
      stale.push(key);
      store.removeDownloadedModel(key);
    }
  }
  if (stale.length > 0) {
    console.warn(`[model-loader] 检测到 ${stale.length} 个模型标记与实际缓存不符，已移除标记:`, stale);
  }
  return stale;
}

/** 默认模型 key（降级清理时保留，避免核心功能失效） */
const DEFAULT_MODEL_KEY = "Xenova/bge-small-zh-v1.5";

/**
 * 删除所有非当前使用、非默认的嵌入模型缓存（配额不足时的激进降级）。
 * 保留：当前激活引擎 + 默认引擎（BGE Small ZH）。
 * @returns 删除的模型数
 */
export async function deleteNonActiveEmbeddingModels(): Promise<number> {
  const store = useRAGStore.getState();
  const activeKey = store.engine;
  let removed = 0;
  for (const key of [...store.downloadedModels]) {
    if (key === activeKey || key === DEFAULT_MODEL_KEY) continue;
    const n = await deleteModelCache(key);
    if (n > 0) removed++;
  }
  return removed;
}
