import { parentPort, workerData } from "node:worker_threads";
import { pipeline, env } from "@xenova/transformers";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { chunks, batchSize, modelKey = "Xenova/bge-small-zh-v1.5" } = workerData;

env.allowRemoteModels = true;
env.cacheDir = path.resolve(__dirname, "data/models-cache");

// Read mirror config from file, fallback to environment variable, then default
function getMirrorHost() {
  try {
    const configPath = path.resolve(__dirname, "data/rag-config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.mirrorHost) return config.mirrorHost;
    }
  } catch { /* ignore */ }
  return process.env.HF_MIRROR || "https://hf-mirror.com/";
}

env.remoteHost = getMirrorHost();
console.log(`[rag-worker] 使用镜像源: ${env.remoteHost}`);

async function run() {
  // Report model download phase
  parentPort.postMessage({ type: "downloading", model: modelKey });
  const pipe = await pipeline("feature-extraction", modelKey);
  const totalBatches = Math.ceil(chunks.length / batchSize);
  const vectors = [];
  let dim = 0;

  for (let b = 0; b < totalBatches; b++) {
    const batch = chunks.slice(b * batchSize, Math.min((b + 1) * batchSize, chunks.length));
    // 提取 content 字段（chunks 可能是字符串或对象）
    const texts = batch.map(c => typeof c === "string" ? c : c.content);
    const result = await pipe(texts, { pooling: "mean", normalize: true });
    const arr = await result.tolist();
    for (const row of arr) vectors.push(row);
    dim = vectors[0]?.length || dim;
    parentPort.postMessage({
      type: "progress",
      current: Math.min((b + 1) * batchSize, chunks.length),
      total: chunks.length,
    });
    await new Promise((resolve) => setImmediate(resolve));
  }

  parentPort.postMessage({ type: "done", vectors, dim });
}

run().catch((e) => parentPort.postMessage({ type: "error", error: e.message || String(e) }));
