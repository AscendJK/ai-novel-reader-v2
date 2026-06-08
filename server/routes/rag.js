/**
 * RAG 相关路由
 */

import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { authNovel } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { buildIndex, getProgress, getIndexData, getStatuses, getAllStatuses } from "../rag-builder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();

// ── RAG: Cached pipeline for test/encode endpoints ────────

const _cachedPipes = new Map(); // modelKey → pipeline

const ENGINE_MODEL_MAP = {
  "Xenova/bge-small-zh-v1.5": "Xenova/bge-small-zh-v1.5",
  "Xenova/gte-small": "Xenova/gte-small",
  "Xenova/multilingual-e5-small": "Xenova/multilingual-e5-small",
  "Xenova/all-MiniLM-L6-v2": "Xenova/all-MiniLM-L6-v2",
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2": "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
};

function resolveModelKey(engine) {
  if (ENGINE_MODEL_MAP[engine]) return ENGINE_MODEL_MAP[engine];
  if (engine && engine.includes("/")) return engine;
  return "Xenova/bge-small-zh-v1.5";
}

async function getEncodePipeline(engine) {
  const modelKey = resolveModelKey(engine);
  if (_cachedPipes.has(modelKey)) return _cachedPipes.get(modelKey);
  const { pipeline, env } = await import("@xenova/transformers");
  env.allowRemoteModels = true;
  env.cacheDir = path.resolve(__dirname, "../data/models-cache");
  // Read mirror config
  try {
    const configPath = path.resolve(__dirname, "../data/rag-config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.mirrorHost) env.remoteHost = config.mirrorHost;
    }
  } catch { /* ignore */ }
  if (!env.remoteHost) env.remoteHost = process.env.HF_MIRROR || "https://hf-mirror.com/";
  const pipe = await pipeline("feature-extraction", modelKey);
  _cachedPipes.set(modelKey, pipe);
  return pipe;
}

// ── RAG: Quick test endpoint ──────────────────────────────

router.get("/test", rateLimit(5), async (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const engine = req.query.engine || "Xenova/bge-small-zh-v1.5";
    const t0 = Date.now();
    const pipe = await getEncodePipeline(engine);
    const result = await pipe(["测试文本"], { pooling: "mean", normalize: true });
    const arr = await result.tolist();
    res.json({ ok: true, dim: arr[0]?.length, time: Date.now() - t0, engine });
  } catch (e) {
    console.error("[rag] test error:", e);
    res.status(500).json({ error: "测试失败" });
  }
});

// ── RAG Index API ──────────────────────────────────────────

// POST /api/rag/encode — encode query text (single small batch, max 20 texts)
router.post("/encode", rateLimit(30), async (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const { texts, engine } = req.body;
    if (!texts?.length) return res.status(400).json({ error: "texts required" });
    if (texts.length > 20) return res.status(400).json({ error: "单次最多编码 20 条文本" });
    if (texts.some((t) => typeof t !== "string" || t.length > 10000)) {
      return res.status(400).json({ error: "文本过长或格式错误" });
    }
    const pipe = await getEncodePipeline(engine);
    const result = await pipe(texts, { pooling: "mean", normalize: true });
    const vectors = await result.tolist();
    res.json({ vectors });
  } catch (e) {
    console.error("[rag] encode error:", e);
    res.status(500).json({ error: "编码失败" });
  }
});

// GET /api/rag/statuses?ids=a,b,c&engine=bge-small-zh
router.get("/statuses", (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const ids = (req.query.ids || "").split(",").filter(Boolean);
    const engine = req.query.engine || "Xenova/bge-small-zh-v1.5";
    res.json(getStatuses(ids, engine));
  } catch (e) {
    console.error("[rag] statuses error:", e);
    res.status(500).json({ error: "查询失败" });
  }
});

// GET /api/rag/statuses/all?ids=a,b,c — all engines' statuses
router.get("/statuses/all", (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const ids = (req.query.ids || "").split(",").filter(Boolean);
    res.json(getAllStatuses(ids));
  } catch (e) {
    console.error("[rag] all statuses error:", e);
    res.status(500).json({ error: "查询失败" });
  }
});

// GET /api/rag/:novelId/status?engine=bge-small-zh
router.get("/:novelId/status", (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const engine = req.query.engine || "Xenova/bge-small-zh-v1.5";
    const progress = getProgress(req.params.novelId, engine);
    res.json(progress);
  } catch (e) {
    console.error("[rag] status error:", e);
    res.status(500).json({ error: "查询失败" });
  }
});

// POST /api/rag/:novelId/build — trigger async build
router.post("/:novelId/build", rateLimit(5), (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const engine = req.body?.engine || "Xenova/bge-small-zh-v1.5";
    const result = buildIndex(req.params.novelId, engine);
    res.json(result);
  } catch (e) {
    console.error("[rag] build error:", e);
    res.status(500).json({ error: "构建失败" });
  }
});

// GET /api/rag/:novelId/index?engine=bge-small-zh — download built index (binary)
router.get("/:novelId/index", (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const engine = req.query.engine || "Xenova/bge-small-zh-v1.5";
    const data = getIndexData(req.params.novelId, engine);
    if (!data) return res.status(404).json({ error: "索引未构建" });

    // 返回二进制格式：chunks JSON + vectors ArrayBuffer
    const chunksBuf = Buffer.from(data.chunks_json, "utf-8");
    const headerBuf = Buffer.alloc(12);
    headerBuf.writeUInt32LE(chunksBuf.length, 0);   // chunks JSON 长度
    headerBuf.writeUInt32LE(data.dim, 4);            // 向量维度
    headerBuf.writeUInt32LE(data.chunk_count, 8);    // chunk 数量

    // 合并为单个二进制响应
    const binary = Buffer.concat([headerBuf, chunksBuf, data.vectors_blob]);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", binary.length);
    res.send(binary);
  } catch (e) {
    console.error("[rag] get index error:", e);
    res.status(500).json({ error: "获取索引失败" });
  }
});

// ── Model Proxy ────────────────────────────────────────────
// Proxies model file requests to HuggingFace mirror (bypasses browser CORS)

const MODEL_CACHE_DIR = path.resolve(__dirname, "../data/models-cache");

function getMirrorHost() {
  let host = process.env.HF_MIRROR || "https://hf-mirror.com/";
  try {
    const configPath = path.resolve(__dirname, "../data/rag-config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.mirrorHost) host = config.mirrorHost;
    }
  } catch { /* ignore */ }
  // Normalize trailing slash
  return host.endsWith("/") ? host : host + "/";
}

// Normalize cache path: strip "resolve/main/" to match Transformers.js directory structure
// e.g., "Xenova/bge-small-zh-v1.5/resolve/main/config.json" → "Xenova/bge-small-zh-v1.5/config.json"
function toCachePath(subPath) {
  return subPath.replace(/\/resolve\/main\//, "/");
}

// GET /api/rag/model-proxy/{*path} — proxy model file from mirror
router.get("/model-proxy/{*path}", async (req, res) => {
  try {
    // Express 5 + path-to-regexp v8: {*path} returns an array of segments
    const subPath = Array.isArray(req.params.path) ? req.params.path.join("/") : req.params.path;
    if (!subPath) return res.status(400).json({ error: "path required" });

    const mirrorHost = getMirrorHost();
    const targetUrl = `${mirrorHost}${subPath}`;

    // Check local cache first (use normalized path for Transformers.js compatibility)
    const cachePath = path.join(MODEL_CACHE_DIR, toCachePath(subPath));
    if (fs.existsSync(cachePath)) {
      console.log(`[model-proxy] cache hit: ${toCachePath(subPath)}`);
      const data = fs.readFileSync(cachePath);
      const ext = path.extname(subPath);
      const contentType = ext === ".json" ? "application/json"
        : ext === ".onnx" ? "application/octet-stream"
        : ext === ".txt" || ext === ".proto" ? "text/plain"
        : "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", data.length);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-cache");
      return res.send(data);
    }

    // Fetch from mirror
    console.log(`[model-proxy] fetching: ${targetUrl}`);
    const response = await fetch(targetUrl, {
      headers: { "User-Agent": "ai-novel-reader" },
      redirect: "follow",
    });

    if (!response.ok) {
      console.error(`[model-proxy] upstream error: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ error: `upstream error: ${response.status}` });
    }

    // Stream response to client
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const contentLength = response.headers.get("content-length");
    res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");

    // Read body and send
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);

    // Cache to disk with normalized path (async, don't block response)
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFile(cachePath, buffer, (err) => {
      if (err) console.warn(`[model-proxy] cache write failed: ${err.message}`);
      else console.log(`[model-proxy] cached: ${toCachePath(subPath)} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
    });
  } catch (e) {
    console.error("[model-proxy] error:", e);
    res.status(500).json({ error: "代理请求失败" });
  }
});

export default router;
