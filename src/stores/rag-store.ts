import { create } from "zustand";
import type { EngineId } from "@/rag/engines";

// Migration: old short engine IDs → new full Xenova paths
const ENGINE_ID_MIGRATION: Record<string, string> = {
  "bge-small-zh": "Xenova/bge-small-zh-v1.5",
  "gte-small": "Xenova/gte-small",
};

function loadPref(): EngineId {
  try {
    const stored = localStorage.getItem("novel-reader-rag-engine");
    if (stored && stored.length > 0) {
      // Migrate old short keys to new full paths
      const migrated = ENGINE_ID_MIGRATION[stored] || stored;
      if (migrated !== stored) {
        localStorage.setItem("novel-reader-rag-engine", migrated);
      }
      return migrated;
    }
  } catch { /* ignore */ }
  return "Xenova/bge-small-zh-v1.5";
}

function loadSavedModels(): { key: string; name: string; size: string }[] {
  try {
    const stored = localStorage.getItem("novel-reader-rag-custom-models");
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

function saveModels(models: { key: string; name: string; size: string }[]) {
  try {
    localStorage.setItem("novel-reader-rag-custom-models", JSON.stringify(models));
  } catch { /* ignore */ }
}

function loadCacheSize(): number {
  try {
    const v = parseInt(localStorage.getItem("novel-reader-rag-cache-mb") || "", 10);
    return (v >= 100 && v <= 500) ? v : 100;
  } catch { return 100; }
}

export interface TopKTier { maxChunks: number; topK: number; }

const DEFAULT_TOPK_TIERS: TopKTier[] = [
  { maxChunks: 200, topK: 15 },
  { maxChunks: 1000, topK: 30 },
  { maxChunks: 5000, topK: 50 },
  { maxChunks: Infinity, topK: 80 },
];
const DEFAULT_TOPK = 30;

function loadTopKConfig(): { default: number; tiers: TopKTier[] } {
  try {
    const stored = localStorage.getItem("novel-reader-topk-config");
    if (stored) {
      const parsed = JSON.parse(stored);
      if (typeof parsed.default === "number" && Array.isArray(parsed.tiers)) {
        const tiers = parsed.tiers.map((t: TopKTier) => ({
          ...t,
          maxChunks: t.maxChunks === 0 ? Infinity : t.maxChunks,
        }));
        tiers.sort((a: TopKTier, b: TopKTier) => a.maxChunks - b.maxChunks);
        return { default: parsed.default, tiers };
      }
    }
  } catch { /* ignore */ }
  return { default: DEFAULT_TOPK, tiers: DEFAULT_TOPK_TIERS };
}

function saveTopKConfig(config: { default: number; tiers: TopKTier[] }) {
  try {
    const serializable = {
      ...config,
      tiers: config.tiers.map((t) => ({ ...t, maxChunks: t.maxChunks === Infinity ? 0 : t.maxChunks })),
    };
    localStorage.setItem("novel-reader-topk-config", JSON.stringify(serializable));
  } catch { /* ignore */ }
}

// ── Downloaded models tracking ──

function loadDownloadedModels(): Set<string> {
  try {
    const stored = localStorage.getItem("novel-reader-downloaded-models");
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch { return new Set(); }
}

function saveDownloadedModels(models: Set<string>) {
  try { localStorage.setItem("novel-reader-downloaded-models", JSON.stringify([...models])); } catch { /* ignore */ }
}

// ── State interface ──

interface RAGState {
  engine: EngineId;
  savedCustomModels: { key: string; name: string; size: string }[];
  downloadedModels: Set<string>;  // models downloaded and cached in browser
  currentDownload: string | null; // modelKey currently being downloaded, null if idle
  downloadProgress: string;       // progress text e.g. "tokenizer 0.5/2.1MB (24%)"
  cacheSizeMB: number;
  ragCacheSizeBytes: number;
  cachedKeys: Set<string>;
  lruKeys: Set<string>;
  indexLoadingKeys: Set<string>;
  topKDefault: number;
  topKTiers: TopKTier[];
  setEngine: (e: EngineId, name?: string, size?: string) => void;
  setSavedCustomModels: (models: { key: string; name: string; size: string }[]) => void;
  removeSavedModel: (key: string) => void;
  setCacheSizeMB: (size: number) => void;
  updateRagCacheSize: (bytes: number) => void;
  addCachedKey: (key: string) => void;
  removeCachedKey: (key: string) => void;
  hasCachedKey: (key: string) => boolean;
  addLruKey: (key: string) => void;
  removeLruKey: (key: string) => void;
  addIndexLoadingKey: (key: string) => void;
  removeIndexLoadingKey: (key: string) => void;
  setCurrentDownload: (modelKey: string | null) => void;
  setDownloadProgress: (progress: string) => void;
  addDownloadedModel: (modelKey: string) => void;
  removeDownloadedModel: (modelKey: string) => void;
  isModelDownloaded: (modelKey: string) => boolean;
  setTopKDefault: (val: number) => void;
  setTopKTiers: (tiers: TopKTier[]) => void;
  resetTopKConfig: () => void;
  getTopK: (chunkCount: number) => number;
}

const _topKConfig = loadTopKConfig();

export const useRAGStore = create<RAGState>((set, get) => ({
  engine: loadPref(),
  savedCustomModels: loadSavedModels(),
  downloadedModels: loadDownloadedModels(),
  currentDownload: null,
  downloadProgress: "",
  cacheSizeMB: loadCacheSize(),
  ragCacheSizeBytes: 0,
  cachedKeys: new Set<string>(),
  lruKeys: new Set<string>(),
  indexLoadingKeys: new Set<string>(),
  topKDefault: _topKConfig.default,
  topKTiers: _topKConfig.tiers,

  setEngine: (engine, name, size) => {
    try { localStorage.setItem("novel-reader-rag-engine", engine); } catch { /* ignore */ }
    if (name && engine.includes("/")) {
      const models = get().savedCustomModels;
      if (!models.some((m) => m.key === engine)) {
        const updated = [...models, { key: engine, name, size: size || "?" }];
        saveModels(updated);
        set({ engine, savedCustomModels: updated });
        return;
      }
    }
    set({ engine });
  },

  setSavedCustomModels: (models) => {
    saveModels(models);
    set({ savedCustomModels: models });
  },

  removeSavedModel: (key) => {
    const updated = get().savedCustomModels.filter((m) => m.key !== key);
    saveModels(updated);
    set({ savedCustomModels: updated });
  },

  setCacheSizeMB: (size) => {
    const clamped = Math.max(100, Math.min(500, size));
    try { localStorage.setItem("novel-reader-rag-cache-mb", String(clamped)); } catch { /* ignore */ }
    set({ cacheSizeMB: clamped });
  },

  updateRagCacheSize: (bytes) => set({ ragCacheSizeBytes: bytes }),

  addCachedKey: (key) => {
    const current = get().cachedKeys;
    if (current.has(key)) return; // Already exists, skip
    const next = new Set(current);
    next.add(key);
    set({ cachedKeys: next });
  },

  removeCachedKey: (key) => {
    const current = get().cachedKeys;
    if (!current.has(key)) return; // Already absent, skip
    const next = new Set(current);
    next.delete(key);
    set({ cachedKeys: next });
  },

  hasCachedKey: (key) => get().cachedKeys.has(key),

  addLruKey: (key) => {
    const current = get().lruKeys;
    if (current.has(key)) return;
    const next = new Set(current);
    next.add(key);
    set({ lruKeys: next });
  },

  removeLruKey: (key) => {
    const current = get().lruKeys;
    if (!current.has(key)) return;
    const next = new Set(current);
    next.delete(key);
    set({ lruKeys: next });
  },

  addIndexLoadingKey: (key) => {
    const current = get().indexLoadingKeys;
    if (current.has(key)) return;
    const next = new Set(current);
    next.add(key);
    set({ indexLoadingKeys: next });
  },

  removeIndexLoadingKey: (key) => {
    const current = get().indexLoadingKeys;
    if (!current.has(key)) return;
    const next = new Set(current);
    next.delete(key);
    set({ indexLoadingKeys: next });
  },

  setCurrentDownload: (modelKey) => set({ currentDownload: modelKey }),
  setDownloadProgress: (progress) => set({ downloadProgress: progress }),

  addDownloadedModel: (modelKey) => {
    const current = get().downloadedModels;
    if (current.has(modelKey)) return;
    const next = new Set(current);
    next.add(modelKey);
    saveDownloadedModels(next);
    set({ downloadedModels: next });
  },

  removeDownloadedModel: (modelKey) => {
    const current = get().downloadedModels;
    if (!current.has(modelKey)) return;
    const next = new Set(current);
    next.delete(modelKey);
    saveDownloadedModels(next);
    set({ downloadedModels: next });
  },

  isModelDownloaded: (modelKey) => get().downloadedModels.has(modelKey),

  setTopKDefault: (val) => {
    const clamped = Math.max(1, Math.min(200, Math.round(val)));
    const config = { default: clamped, tiers: get().topKTiers };
    saveTopKConfig(config);
    set({ topKDefault: clamped });
  },

  setTopKTiers: (tiers) => {
    const config = { default: get().topKDefault, tiers };
    saveTopKConfig(config);
    set({ topKTiers: tiers });
  },

  resetTopKConfig: () => {
    saveTopKConfig({ default: DEFAULT_TOPK, tiers: DEFAULT_TOPK_TIERS });
    set({ topKDefault: DEFAULT_TOPK, topKTiers: DEFAULT_TOPK_TIERS });
  },

  getTopK: (chunkCount) => {
    const { topKTiers, topKDefault } = get();
    for (const tier of topKTiers) {
      if (chunkCount <= tier.maxChunks) return tier.topK;
    }
    return topKDefault;
  },
}));
