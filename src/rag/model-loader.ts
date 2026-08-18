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
