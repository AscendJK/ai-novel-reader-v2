/**
 * Client-side query encoder using Transformers.js.
 * Loads ONNX model from local public/models/ for offline embedding.
 */

import { ragLog } from "@/lib/logger";
import { resolveModelKey } from "./engines";
import { getRemoteHost } from "./model-loader";

const BUILTIN = "/models/builtin/";
const CUSTOM = "/models/custom/";

// Determine if an engine uses custom (user-downloaded) model files
function isCustomEngine(engine: string): boolean {
  return engine.includes("/") && !engine.startsWith("bge-") && !engine.startsWith("gte-");
}

// Resolve engine ID to the model key Transformers.js expects
function toModelPath(engine: string): string {
  const key = resolveModelKey(engine);
  if (key.startsWith("Xenova/")) return key;
  if (key === "bge-small-zh") return "Xenova/bge-small-zh-v1.5";
  if (key === "gte-small") return "Xenova/gte-small";
  return key;
}

const encoderCache = new Map<string, any>();
// Serialize encoder initialization to avoid env.localModelPath race condition
let encoderLock: Promise<void> = Promise.resolve();

async function getEncoder(engine: string): Promise<any> {
  const cached = encoderCache.get(engine);
  if (cached) return cached;

  // Queue this init behind any in-flight init
  const prev = encoderLock;
  let releaseLock!: () => void;
  encoderLock = new Promise<void>((r) => { releaseLock = r; });
  await prev;

  try {
    // Check cache again — another init may have loaded this engine while we waited
    const cachedNow = encoderCache.get(engine);
    if (cachedNow) return cachedNow;

    const modelPath = toModelPath(engine);
    const transformers = await import("@xenova/transformers");
    const { env, pipeline } = transformers;
    // Set correct base path for local files
    env.localModelPath = isCustomEngine(engine) ? CUSTOM : BUILTIN;
    // Allow network requests so service worker can intercept and serve from cache
    env.allowRemoteModels = true;
    // Enable browser cache so Transformers.js can use cached responses
    env.useBrowserCache = true;
    // Use configured mirror for HuggingFace
    env.remoteHost = getRemoteHost();
    ragLog(`[client-encoder] 加载模型: ${modelPath} (路径: ${env.localModelPath}, 镜像: ${env.remoteHost})`);
    const extractor = await pipeline("feature-extraction", modelPath);
    encoderCache.set(engine, extractor);
    ragLog(`[client-encoder] 模型就绪: ${modelPath}`);
    return extractor;
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
