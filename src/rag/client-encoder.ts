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

// Module-level reference to original fetch
const _originalFetch = globalThis.fetch;

// Intercept fetch to route HuggingFace model requests through backend proxy
function proxiedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  // Intercept HuggingFace model file requests (both Xenova/xxx and plain xxx)
  const hfPattern = /https?:\/\/huggingface\.co\/([^/]+(?:\/[^/]+)?)\/resolve\/main\/.+/;
  const match = url.match(hfPattern);
  if (match) {
    const serverUrl = getServerUrl();
    if (serverUrl) {
      const pathAfterHost = url.split("huggingface.co/")[1];
      const proxyUrl = `${serverUrl}/api/rag/model-proxy/${pathAfterHost}`;
      ragLog(`[client-encoder] 代理: ${url} → ${proxyUrl}`);
      return _originalFetch(proxyUrl, init);
    }
  }

  return _originalFetch(input, init);
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

    // Install fetch interceptor
    globalThis.fetch = proxiedFetch;

    ragLog(`[client-encoder] 加载模型: ${modelPath}`);
    try {
      const extractor = await pipeline("feature-extraction", modelPath);
      encoderCache.set(engine, extractor);
      ragLog(`[client-encoder] 模型就绪: ${modelPath}`);
      return extractor;
    } finally {
      // Restore original fetch
      globalThis.fetch = _originalFetch;
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
