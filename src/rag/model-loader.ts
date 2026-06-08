/**
 * Local model loader — two directories:
 *   builtin/  — included in Git, ships with the project (bge-small-zh, gte-small)
 *   custom/   — user-downloaded models, NOT in Git
 */

import { ENGINES, resolveModelKey } from "./engines";

// GitHub Pages 部署时 base path 为 /ai-novel-reader-v2/，需要拼接
const BASE = import.meta.env.BASE_URL || "/";
const BUILTIN = BASE + "models/builtin/";
const CUSTOM = BASE + "models/custom/";

const ONNX_EXPECTED = "model_quantized.onnx";

/** Known embedding model architectures supported by Transformers.js */
const EMBEDDING_MODEL_TYPES = new Set([
  "bert", "distilbert", "albert", "roberta", "xlm-roberta",
  "nomic_bert", "mpnet", "mobilebert", "squeezebert",
  "electra", "deberta", "deberta-v2",
]);

// ── File status for downloadable models ──────────────────────────

export interface FileStatus {
  config: boolean;
  tokenizer: boolean;
  tokenizerConfig: boolean;
  onnx: boolean;
  complete: boolean;
  modelType?: string;
  typeWarning?: string;
}

/** Check if the 4 required files exist for a model in custom/ */
export async function checkFileStatus(modelKey: string): Promise<FileStatus> {
  const base = CUSTOM + modelKey + "/";
  const nc = { cache: "no-cache" as RequestCache };
  const status: FileStatus = { config: false, tokenizer: false, tokenizerConfig: false, onnx: false, complete: false };

  async function probe(file: string): Promise<boolean> {
    try {
      const r = await fetch(base + file, { method: "HEAD", ...nc });
      console.log(`[model-status] ${base}${file} → ${r.status} ${r.headers.get("Content-Type") || ""}`);
      if (!r.ok) return false;
      const ct = r.headers.get("Content-Type") || "";
      return !ct.includes("text/html");
    } catch (e) { console.warn(`[model-status] ${base}${file} → fetch failed:`, e); return false; }
  }

  [status.config, status.tokenizer, status.tokenizerConfig] = await Promise.all([
    probe("config.json"),
    probe("tokenizer.json"),
    probe("tokenizer_config.json"),
  ]);

  // Check ONNX file
  try {
    const r = await fetch(base + "onnx/" + ONNX_EXPECTED, { method: "HEAD", ...nc });
    if (r.ok) {
      const ct = r.headers.get("Content-Type") || "";
      const cl = r.headers.get("Content-Length");
      if (!ct.includes("text/html") && (!cl || parseInt(cl, 10) >= 100000)) {
        status.onnx = true;
      }
    }
  } catch { /* not found */ }

  status.complete = status.config && status.tokenizer && status.tokenizerConfig && status.onnx;

  // Read model_type from config if present
  if (status.config) {
    try {
      const resp = await fetch(base + "config.json", { ...nc });
      if (resp.ok) {
        const cfg = await resp.json();
        status.modelType = cfg.model_type;
        if (status.modelType && !EMBEDDING_MODEL_TYPES.has(status.modelType)) {
          status.typeWarning = `model_type "${status.modelType}" 可能不是嵌入模型`;
        }
      }
    } catch { /* not critical */ }
  }

  return status;
}

// ── Downloadable (recommended) models ────────────────────────────

export interface DownloadableModel {
  name: string;
  modelKey: string;
  size: string;
  description: string;
  url: string;
}

export const DOWNLOADABLE_MODELS: DownloadableModel[] = [
  {
    name: "Multilingual E5 Small",
    modelKey: "Xenova/multilingual-e5-small",
    size: "~120 MB",
    description: "微软多语言模型，100+语言，中英文兼顾",
    url: "https://huggingface.co/Xenova/multilingual-e5-small",
  },
  {
    name: "All-MiniLM-L6-v2",
    modelKey: "Xenova/all-MiniLM-L6-v2",
    size: "~23 MB",
    description: "英文最佳轻量模型，体积小速度快",
    url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2",
  },
  {
    name: "Multilingual MiniLM L12 v2",
    modelKey: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    size: "~120 MB",
    description: "50+语言深度语义理解，多语言场景最强",
    url: "https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  },
];

// ── Scan: check file status for all downloadable models ──────────

export interface ScannedModel extends DownloadableModel {
  fileStatus: FileStatus;
}

/** Check file status for all recommended downloadable models */
export async function scanCustomModels(): Promise<ScannedModel[]> {
  const results: ScannedModel[] = [];
  for (const m of DOWNLOADABLE_MODELS) {
    const fileStatus = await checkFileStatus(m.modelKey);
    results.push({ ...m, fileStatus });
  }
  return results;
}

// ── Builtin model status (for settings UI) ──────────────────────

export interface ModelStatus {
  available: boolean;
  onnxFiles: string[];
  renameWarning?: string;
  modelType?: string;
  typeWarning?: string;
}

export async function getBuiltinModelStatus(modelKey: string): Promise<ModelStatus> {
  const base = BUILTIN + modelKey + "/";
  const nc = { cache: "no-cache" as RequestCache };
  const missing: ModelStatus = { available: false, onnxFiles: [] };

  // Check required JSON files
  for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json"]) {
    try {
      const r = await fetch(base + file, { method: "HEAD", ...nc });
      if (!r.ok) return missing;
      const ct = r.headers.get("Content-Type") || "";
      if (ct.includes("text/html")) return missing;
    } catch { return missing; }
  }

  // Check ONNX
  let onnxFound = false;
  try {
    const r = await fetch(base + "onnx/" + ONNX_EXPECTED, { method: "HEAD", ...nc });
    if (r.ok) {
      const ct = r.headers.get("Content-Type") || "";
      if (!ct.includes("text/html")) onnxFound = true;
    }
  } catch (e) { console.warn(`[model-status] ${base}onnx/${ONNX_EXPECTED} → fetch failed:`, e); }
  if (!onnxFound) return missing;

  // Read model_type
  let modelType: string | undefined;
  let typeWarning: string | undefined;
  try {
    const r = await fetch(base + "config.json", { ...nc });
    if (r.ok) {
      const cfg = await r.json();
      modelType = cfg.model_type;
      if (modelType && !EMBEDDING_MODEL_TYPES.has(modelType)) {
        typeWarning = `model_type "${modelType}" 可能不是嵌入模型`;
      }
    }
  } catch { /* not critical */ }

  return { available: true, onnxFiles: [ONNX_EXPECTED], modelType, typeWarning };
}

export async function getBuiltinBGEStatus(): Promise<ModelStatus> {
  return getBuiltinModelStatus("Xenova/bge-small-zh-v1.5");
}

export async function getBuiltinGTEStatus(): Promise<ModelStatus> {
  return getBuiltinModelStatus("Xenova/gte-small");
}

// ── Backward compat exports ─────────────────────────────────────

export interface ModelEntry {
  modelKey: string;
  name: string;
  source: "builtin" | "custom";
  size: string;
  onnxFiles: string[];
  renameWarning?: string;
  modelType?: string;
  typeWarning?: string;
}

export interface RecommendedModel {
  name: string;
  modelKey: string;
  size: string;
  reason: string;
  url: string;
}

export const RECOMMENDED_MODELS: RecommendedModel[] = [
  ...DOWNLOADABLE_MODELS.map(m => ({
    name: m.name, modelKey: m.modelKey, size: m.size, reason: m.description, url: m.url,
  })),
];

// ── Transformers.js config ──────────────────────────────────────

let envReady: Promise<void> | null = null;

export function setupLocalModelLoader(): Promise<void> {
  if (!envReady) {
    envReady = import("@xenova/transformers")
      .then(({ env }) => {
        env.localModelPath = BUILTIN;
        // allowRemoteModels and useBrowserCache are set dynamically in getEncoder()
        // to support offline model loading via service worker cache
        console.log("[transformers] localModelPath set to:", env.localModelPath);
      })
      .catch((e) => { console.error("Failed to configure Transformers.js:", e); });
  }
  return envReady;
}

// ── Model cache status and download ─────────────────────────────

// Builtin model keys (shipped with the project in public/models/builtin/)
const BUILTIN_KEYS = new Set(["Xenova/bge-small-zh-v1.5", "Xenova/gte-small"]);

/** Get the base URL for a model's files */
export function getModelBasePath(modelKey: string): string {
  return (BUILTIN_KEYS.has(modelKey) ? BUILTIN : CUSTOM) + modelKey + "/";
}

const REQUIRED_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];

export interface ModelCacheStatus {
  cached: boolean;       // all files in browser cache
  totalFiles: number;
  cachedFiles: number;
  missingFiles: string[];
}

const MODEL_CACHE_NAME = "model-files-cache";

/** Check if all model files are in the browser Cache API */
export async function checkModelCacheStatus(modelKey: string): Promise<ModelCacheStatus> {
  const base = getModelBasePath(modelKey);
  let cachedCount = 0;
  const missing: string[] = [];

  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    for (const file of REQUIRED_FILES) {
      const url = base + file;
      const cached = await cache.match(url);
      if (cached) {
        cachedCount++;
      } else {
        missing.push(file);
      }
    }
  } catch { /* Cache API not available */ }

  return { cached: cachedCount === REQUIRED_FILES.length, totalFiles: REQUIRED_FILES.length, cachedFiles: cachedCount, missingFiles: missing };
}

/** Download model files from server into our Cache API */
export async function downloadModelToCache(modelKey: string, onProgress?: (file: string, loaded: number, total: number, speed?: number) => void): Promise<boolean> {
  const base = getModelBasePath(modelKey);
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    for (const file of REQUIRED_FILES) {
      const url = base + file;
      console.log(`[model-loader] downloading: ${url}`);
      const r = await fetch(url);
      if (!r.ok) {
        console.error(`[model-loader] download failed: ${file} → HTTP ${r.status}`);
        return false;
      }
      // Read with progress tracking
      // Content-Length is compressed size; if Content-Encoding is set, the actual decompressed size is larger
      const isCompressed = !!r.headers.get("Content-Encoding");
      const contentLength = isCompressed ? 0 : parseInt(r.headers.get("Content-Length") || "0", 10);
      const reader = r.body?.getReader();
      if (!reader) {
        // Fallback: no streaming support
        await cache.put(url, r.clone());
        await r.arrayBuffer();
        continue;
      }
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      const startTime = Date.now();
      let lastTime = startTime;
      let lastLoaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        // Calculate speed every ~500ms
        const now = Date.now();
        if (now - lastTime >= 500) {
          const elapsed = (now - lastTime) / 1000;
          const speed = (loaded - lastLoaded) / elapsed; // bytes per second
          onProgress?.(file, loaded, contentLength, speed);
          lastTime = now;
          lastLoaded = loaded;
        }
      }
      const body = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      // Strip compression headers since the cached body is decompressed
      const cacheHeaders = new Headers(r.headers);
      if (isCompressed) {
        cacheHeaders.delete("Content-Encoding");
        cacheHeaders.delete("Content-Length");
      }
      cacheHeaders.set("Content-Length", String(loaded));
      const response = new Response(body, { headers: cacheHeaders });
      await cache.put(url, response);
      console.log(`[model-loader] cached: ${file} (${(loaded / 1024 / 1024).toFixed(1)} MB)`);
    }
    return true;
  } catch (e) {
    console.error(`[model-loader] download error for ${modelKey}:`, e);
    return false;
  }
}

/**
 * Ensure model files are cached in the browser. Checks first, downloads if missing.
 * Reports progress via callback. Retries up to 3 times on failure.
 */
export async function ensureModelCached(
  engine: string,
  opts?: { onStatus?: (status: "downloading" | "cached" | "error", progress?: string) => void; maxRetries?: number }
): Promise<void> {
  if (!engine || engine === "tfidf") return;
  const modelKey = resolveModelKey(engine);
  if (!modelKey) return;
  const maxRetries = opts?.maxRetries ?? 3;

  try {
    const status = await checkModelCacheStatus(modelKey);
    if (status.cached) {
      console.log(`[model-loader] 引擎 ${engine} 模型已缓存`);
      opts?.onStatus?.("cached");
      return;
    }
  } catch { /* ignore */ }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[model-loader] 下载引擎 ${engine} 模型文件 (${attempt}/${maxRetries})...`);
      opts?.onStatus?.("downloading", `下载中 (${attempt}/${maxRetries})...`);
      const ok = await downloadModelToCache(modelKey, (file, loaded, total, speed) => {
        const loadedMB = (loaded / 1024 / 1024).toFixed(1);
        const speedMB = speed ? (speed / 1024 / 1024).toFixed(1) : null;
        const progress = total > 0
          ? `${loadedMB}/${(total / 1024 / 1024).toFixed(0)}MB (${Math.round(loaded / total * 100)}%)`
          : `${loadedMB}MB`;
        const speedStr = speedMB ? ` · ${speedMB}MB/s` : "";
        opts?.onStatus?.("downloading", `${file.split("/").pop()} ${progress}${speedStr}`);
      });
      if (ok) {
        console.log(`[model-loader] 引擎 ${engine} 模型下载成功`);
        opts?.onStatus?.("cached");
        return;
      }
      console.warn(`[model-loader] 引擎 ${engine} 模型下载失败 (${attempt}/${maxRetries})`);
    } catch (e) {
      console.warn(`[model-loader] 引擎 ${engine} 模型下载异常 (${attempt}/${maxRetries}):`, e);
    }
    // Wait before retry (exponential backoff)
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  console.error(`[model-loader] 引擎 ${engine} 模型下载最终失败`);
  opts?.onStatus?.("error", "下载失败");
}

/**
 * Download a model from HuggingFace Hub with progress tracking.
 * Uses Transformers.js AutoModel/AutoTokenizer with progress_callback.
 * After download, the model is cached in the browser for subsequent use.
 */
export async function downloadModelFromHuggingFace(
  modelKey: string,
  opts?: { onStatus?: (status: "downloading" | "cached" | "error", progress?: string) => void }
): Promise<boolean> {
  try {
    console.log(`[model-loader] 从 HuggingFace 下载模型: ${modelKey}`);
    opts?.onStatus?.("downloading", "正在加载 Transformers.js...");

    const transformers = await import("@xenova/transformers");
    const { AutoModel, AutoTokenizer, env } = transformers;

    // Configure for remote download
    env.allowRemoteModels = true;
    env.useBrowserCache = true;

    let lastProgress = "";

    // Download tokenizer
    opts?.onStatus?.("downloading", "下载 tokenizer...");
    console.log(`[model-loader] 下载 tokenizer: ${modelKey}`);
    await AutoTokenizer.from_pretrained(modelKey, {
      progress_callback: (data: any) => {
        if (data.status === "progress" && data.file) {
          const loaded = data.loaded || 0;
          const total = data.total || 0;
          const pct = total > 0 ? Math.round(loaded / total * 100) : 0;
          const loadedMB = (loaded / 1024 / 1024).toFixed(1);
          const totalMB = total > 0 ? (total / 1024 / 1024).toFixed(0) : "?";
          lastProgress = `tokenizer ${loadedMB}/${totalMB}MB (${pct}%)`;
          opts?.onStatus?.("downloading", lastProgress);
        }
      },
    });

    // Download model
    opts?.onStatus?.("downloading", "下载模型...");
    console.log(`[model-loader] 下载模型: ${modelKey}`);
    await AutoModel.from_pretrained(modelKey, {
      progress_callback: (data: any) => {
        if (data.status === "progress" && data.file) {
          const loaded = data.loaded || 0;
          const total = data.total || 0;
          const pct = total > 0 ? Math.round(loaded / total * 100) : 0;
          const loadedMB = (loaded / 1024 / 1024).toFixed(1);
          const totalMB = total > 0 ? (total / 1024 / 1024).toFixed(0) : "?";
          lastProgress = `model ${loadedMB}/${totalMB}MB (${pct}%)`;
          opts?.onStatus?.("downloading", lastProgress);
        }
      },
    });

    console.log(`[model-loader] 模型下载完成: ${modelKey}`);
    opts?.onStatus?.("cached");
    return true;
  } catch (e) {
    console.error(`[model-loader] HuggingFace 下载失败: ${modelKey}`, e);
    opts?.onStatus?.("error", "下载失败");
    return false;
  }
}
