/**
 * Client-side query encoder using Transformers.js.
 * Models are downloaded via backend proxy (bypasses CORS).
 */

import { ragLog } from "@/lib/logger";
import { resolveModelKey } from "./engines";
import { getServerUrl } from "@/lib/api-client";

// Resolve engine ID to the model key Transformers.js expects
function toModelPath(engine: string): string {
  const key = resolveModelKey(engine);
  if (key.startsWith("Xenova/")) return key;
  if (key === "bge-small-zh") return "Xenova/bge-small-zh-v1.5";
  if (key === "gte-small") return "Xenova/gte-small";
  return key;
}

const encoderCache = new Map<string, any>();
let encoderLock: Promise<void> = Promise.resolve();

// Intercept fetch to route HuggingFace model requests through backend proxy
function createProxiedFetch(originalFetch: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // Intercept HuggingFace model file requests
    const hfPattern = /https?:\/\/huggingface\.co\/(Xenova\/[^/]+\/resolve\/main\/.+)/;
    const match = url.match(hfPattern);
    if (match) {
      const serverUrl = getServerUrl();
      if (serverUrl) {
        const proxyUrl = `${serverUrl}/api/rag/model-proxy/${match[1]}`;
        ragLog(`[client-encoder] 代理: ${url} → ${proxyUrl}`);
        return originalFetch(proxyUrl, init);
      }
    }

    return originalFetch(input, init);
  };
}

async function getEncoder(engine: string): Promise<any> {
  const cached = encoderCache.get(engine);
  if (cached) return cached;

  const prev = encoderLock;
  let releaseLock!: () => void;
  encoderLock = new Promise<void>((r) => { releaseLock = r; });
  await prev;

  try {
    const cachedNow = encoderCache.get(engine);
    if (cachedNow) return cachedNow;

    const modelPath = toModelPath(engine);
    const transformers = await import("@xenova/transformers");
    const { env, pipeline } = transformers;

    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    // Don't set remoteHost — let Transformers.js use default HuggingFace URL
    // The fetch interceptor will route requests through the backend proxy

    // Install fetch interceptor
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createProxiedFetch(originalFetch);

    ragLog(`[client-encoder] 加载模型: ${modelPath}`);
    try {
      const extractor = await pipeline("feature-extraction", modelPath);
      encoderCache.set(engine, extractor);
      ragLog(`[client-encoder] 模型就绪: ${modelPath}`);
      return extractor;
    } finally {
      // Restore original fetch
      globalThis.fetch = originalFetch;
    }
  } finally {
    releaseLock();
  }
}

export async function encodeQuery(text: string, engine: string): Promise<Float32Array | null> {
  try {
    const extractor = await getEncoder(engine);
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  } catch (e) {
    ragLog(`[client-encoder] 编码失败: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
