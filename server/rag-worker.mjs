import { parentPort, workerData } from "node:worker_threads";
import { pipeline, env } from "@xenova/transformers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMirrorHost, runEmbeddingBatches } from "./lib/rag-worker-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { chunks, batchSize, modelKey = "Xenova/bge-small-zh-v1.5" } = workerData;

env.allowRemoteModels = true;
env.cacheDir = path.resolve(__dirname, "data/models-cache");
// Check proxy cache first (frontend downloads cache here)
env.localModelPath = path.resolve(__dirname, "data/models-cache");

// Read mirror config from file, fallback to environment variable, then default
env.remoteHost = resolveMirrorHost({
  configPath: path.resolve(__dirname, "data/rag-config.json"),
  envHost: process.env.HF_MIRROR,
});
console.log(`[rag-worker] 使用镜像源: ${env.remoteHost}`);

async function run() {
  // Report model download phase
  parentPort.postMessage({ type: "downloading", model: modelKey });
  const pipe = await pipeline("feature-extraction", modelKey);
  const { vectors, dim } = await runEmbeddingBatches({
    chunks,
    batchSize,
    embed: async (texts) => {
      const result = await pipe(texts, { pooling: "mean", normalize: true });
      return await result.tolist();
    },
    onProgress: (msg) => parentPort.postMessage(msg),
  });
  parentPort.postMessage({ type: "done", vectors, dim });
}

run().catch((e) => parentPort.postMessage({ type: "error", error: e.message || String(e) }));
