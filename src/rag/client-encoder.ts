/**
 * Client-side query encoder using Transformers.js.
 * Models are downloaded via backend proxy (bypasses CORS).
 */

import { ragLog } from "@/lib/logger";
import { resolveModelKey } from "./engines";
import { installFetchInterceptor, restoreFetch } from "./fetch-proxy";

// Resolve engine ID to the model key Transformers.js expects
function toModelPath(engine: string): string {
  return resolveModelKey(engine);
}

const encoderCache = new Map<string, any>();
let encoderLock: Promise<void> = Promise.resolve();

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
    installFetchInterceptor();

    ragLog(`[client-encoder] 加载模型: ${modelPath}`);
    try {
      const extractor = await pipeline("feature-extraction", modelPath);
      encoderCache.set(engine, extractor);
      ragLog(`[client-encoder] 模型就绪: ${modelPath}`);
      return extractor;
    } finally {
      restoreFetch();
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
