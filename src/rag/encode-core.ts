/**
 * Transformers.js feature-extraction 纯逻辑核心。
 *
 * 与平台(主线程 / Web Worker)无关：serverUrl 由调用方注入，
 * 从而可以在主线程(从 localStorage 读取)与 Worker(通过消息传递)复用同一实现。
 */

import { ragLog } from "@/lib/logger";
import { resolveModelKey } from "./engines";

// Resolve engine ID to the model key Transformers.js expects
function toModelPath(engine: string): string {
  return resolveModelKey(engine);
}

const MAX_ENCODERS = 2; // 最多缓存 2 个编码器模型，避免内存泄漏

export type PoolingOption = "none" | "mean" | "cls";
export interface FeatureExtractor {
  (text: string, options?: { pooling?: PoolingOption; normalize?: boolean }): Promise<{ data: unknown }>;
  dispose?: () => Promise<void>;
}

const encoderCache = new Map<string, FeatureExtractor>();
let encoderLock: Promise<void> = Promise.resolve();

function touchEncoderCache(key: string) {
  const val = encoderCache.get(key);
  if (val) {
    encoderCache.delete(key);
    encoderCache.set(key, val);
  }
  while (encoderCache.size > MAX_ENCODERS) {
    const oldest = encoderCache.keys().next().value;
    if (oldest) {
      const evicted = encoderCache.get(oldest);
      encoderCache.delete(oldest);
      // 释放旧模型的内存
      if (evicted?.dispose) evicted.dispose().catch(() => {});
    }
  }
}

async function getEncoder(engine: string, serverUrl: string): Promise<FeatureExtractor> {
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

    // 通过 remoteHost 让 transformers.js 直接请求后端代理（绕过 CORS）
    if (serverUrl) {
      env.remoteHost = `${serverUrl}/api/rag/model-proxy`;
    }

    ragLog(`[encode] 加载模型: ${modelPath}${globalThis.constructor?.name === "WorkerGlobalScope" ? " (worker)" : ""}`);
    const extractor = await pipeline("feature-extraction", modelPath);
    encoderCache.set(engine, extractor);
    touchEncoderCache(engine);
    ragLog(`[encode] 模型就绪: ${modelPath}`);
    return extractor;
  } finally {
    releaseLock();
  }
}

/**
 * 编码单个文本，返回维度一致的 Float32Array；失败返回 null。
 * @param serverUrl 当前环境下 transformers 使用的后端代理地址；Worker 中由主线程传入。
 */
export async function encodeQueryCore(text: string, engine: string, serverUrl: string): Promise<Float32Array | null> {
  try {
    const extractor = await getEncoder(engine, serverUrl);
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data as Float32Array | number[]);
  } catch (e) {
    ragLog(`[encode-core] 编码失败: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}