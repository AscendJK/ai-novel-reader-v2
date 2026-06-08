/**
 * Model loader — unified download from HuggingFace (or mirror).
 * No more builtin/custom distinction. All models downloaded on demand.
 */

import { resolveModelKey } from "./engines";
import { useRAGStore } from "@/stores/rag-store";
import { broadcast } from "@/lib/broadcast";
import { getServerUrl } from "@/lib/api-client";

// Mirror configuration
const HF_MIRROR_KEY = "novel-reader-hf-mirror";

// Built-in mirror options (direct, may have CORS issues from GitHub Pages)
const DIRECT_MIRRORS: Record<string, string> = {
  "huggingface": "https://huggingface.co/",
  "hf-mirror": "https://hf-mirror.com/",
};

export function getMirrorId(): string {
  try { return localStorage.getItem(HF_MIRROR_KEY) || "backend-proxy"; } catch { return "backend-proxy"; }
}

export function setMirrorId(id: string): void {
  try { localStorage.setItem(HF_MIRROR_KEY, id); } catch { /* ignore */ }
}

/**
 * Get the remote host URL for model downloads.
 * - "backend-proxy": uses the user's backend server as proxy (bypasses CORS)
 * - "huggingface" / "hf-mirror": direct download (may have CORS issues)
 */
export function getRemoteHost(): string {
  const mirrorId = getMirrorId();
  if (mirrorId === "backend-proxy") {
    const serverUrl = getServerUrl();
    if (serverUrl) return `${serverUrl}/api/rag/model-proxy/`;
    // Fallback to hf-mirror if no server configured
    return DIRECT_MIRRORS["hf-mirror"];
  }
  return DIRECT_MIRRORS[mirrorId] || DIRECT_MIRRORS["hf-mirror"];
}

export function getMirrorOptions(): { id: string; name: string; url: string }[] {
  const serverUrl = getServerUrl();
  const options: { id: string; name: string; url: string }[] = [];
  if (serverUrl) {
    options.push({ id: "backend-proxy", name: "后端代理（推荐）", url: `${serverUrl}/api/rag/model-proxy/` });
  }
  options.push(
    { id: "huggingface", name: "HuggingFace（官方）", url: "https://huggingface.co" },
    { id: "hf-mirror", name: "hf-mirror（国内镜像）", url: "https://hf-mirror.com" },
  );
  return options;
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

export const ALL_ENGINES: EngineInfo[] = [
  {
    key: "bge-small-zh",
    modelKey: "Xenova/bge-small-zh-v1.5",
    name: "BGE Small ZH",
    size: "~26 MB",
    description: "中文语义检索，精度高，推荐中文小说使用",
    url: "https://huggingface.co/Xenova/bge-small-zh-v1.5",
  },
  {
    key: "gte-small",
    modelKey: "Xenova/gte-small",
    name: "GTE Small",
    size: "~34 MB",
    description: "中英文均衡，阿里通义实验室出品",
    url: "https://huggingface.co/Xenova/gte-small",
  },
  {
    key: "multilingual-e5-small",
    modelKey: "Xenova/multilingual-e5-small",
    name: "Multilingual E5 Small",
    size: "~120 MB",
    description: "微软多语言模型，100+语言，中英文兼顾",
    url: "https://huggingface.co/Xenova/multilingual-e5-small",
  },
  {
    key: "all-MiniLM-L6-v2",
    modelKey: "Xenova/all-MiniLM-L6-v2",
    name: "All-MiniLM-L6-v2",
    size: "~23 MB",
    description: "英文最佳轻量模型，体积小速度快",
    url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2",
  },
  {
    key: "multilingual-MiniLM-L12-v2",
    modelKey: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    name: "Multilingual MiniLM L12",
    size: "~120 MB",
    description: "50+语言深度语义理解，多语言场景最强",
    url: "https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  },
];

// ── Download queue (one at a time) ──

let downloadQueue: Array<{ modelKey: string; resolve: (ok: boolean) => void }> = [];
let isDownloading = false;

/**
 * Download a model from HuggingFace Hub. One at a time — if another download
 * is in progress, the request is queued.
 *
 * @returns true if download succeeded, false if failed
 */
export async function downloadModel(modelKey: string): Promise<boolean> {
  const store = useRAGStore.getState();

  // Already downloaded
  if (store.isModelDownloaded(modelKey)) return true;

  // Another download in progress — queue or reject
  if (isDownloading) {
    if (store.currentDownload === modelKey) return false; // already downloading this one
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
      env.useBrowserCache = true;
      env.remoteHost = getRemoteHost();
      console.log(`[model-loader] 镜像源: ${env.remoteHost}`);

      // Download tokenizer
      store.setDownloadProgress("下载 tokenizer...");
      await AutoTokenizer.from_pretrained(modelKey, {
        progress_callback: (data: any) => {
          if (data.status === "progress" && data.file) {
            const loaded = data.loaded || 0;
            const total = data.total || 0;
            const pct = total > 0 ? Math.round(loaded / total * 100) : 0;
            const loadedMB = (loaded / 1024 / 1024).toFixed(1);
            const totalMB = total > 0 ? (total / 1024 / 1024).toFixed(0) : "?";
            store.setDownloadProgress(`tokenizer ${loadedMB}/${totalMB}MB (${pct}%)`);
          }
        },
      });

      // Download model
      store.setDownloadProgress("下载模型...");
      await AutoModel.from_pretrained(modelKey, {
        progress_callback: (data: any) => {
          if (data.status === "progress" && data.file) {
            const loaded = data.loaded || 0;
            const total = data.total || 0;
            const pct = total > 0 ? Math.round(loaded / total * 100) : 0;
            const loadedMB = (loaded / 1024 / 1024).toFixed(1);
            const totalMB = total > 0 ? (total / 1024 / 1024).toFixed(0) : "?";
            store.setDownloadProgress(`model ${loadedMB}/${totalMB}MB (${pct}%)`);
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
      console.warn(`[model-loader] 下载失败 (${attempt}/${maxRetries}):`, e);
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
 * Check if a model is downloaded.
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
    env.useBrowserCache = true;
    env.remoteHost = getRemoteHost();
    console.log("[model-loader] 初始化完成，镜像源:", env.remoteHost);
  } catch (e) {
    console.error("[model-loader] 初始化失败:", e);
  }
}
