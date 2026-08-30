/**
 * RAG 相关路由
 */

import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { authNovel, requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { buildIndex, getProgress, getIndexData, getStatuses, getAllStatuses } from "../rag-builder.js";
import { resolveModelKey } from "../lib/engine-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();

// ── RAG: Cached pipeline for test/encode endpoints ────────

const _cachedPipes = new Map(); // modelKey → pipeline
const MAX_CACHED_PIPES = 3;

async function getEncodePipeline(engine) {
  const modelKey = resolveModelKey(engine);
  if (_cachedPipes.has(modelKey)) {
    // 移到末尾（最近使用）
    const val = _cachedPipes.get(modelKey);
    _cachedPipes.delete(modelKey);
    _cachedPipes.set(modelKey, val);
    return val;
  }
  const { pipeline, env } = await import("@xenova/transformers");
  env.allowRemoteModels = true;
  env.cacheDir = path.resolve(__dirname, "../data/models-cache");
  // 依次尝试镜像源：磁盘缓存（cacheDir）未命中时 → 配置/环境变量 → hf-mirror → HuggingFace
  let lastErr = null;
  for (const host of getMirrorHosts()) {
    env.remoteHost = host;
    try {
      const pipe = await pipeline("feature-extraction", modelKey);
      _cachedPipes.set(modelKey, pipe);
      // LRU 淘汰：超过上限时移除最久未使用的
      while (_cachedPipes.size > MAX_CACHED_PIPES) {
        const oldest = _cachedPipes.keys().next().value;
        if (oldest) _cachedPipes.delete(oldest);
      }
      return pipe;
    } catch (e) {
      lastErr = e;
      console.warn(`[rag] 从 ${host} 加载模型失败，尝试下一镜像: ${e.message}`);
    }
  }
  throw lastErr || new Error("模型加载失败：所有镜像均不可用");
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

// GET /api/rag/tts/status — 检查 TTS 资源是否就绪
// ⚠️ 必须声明在 /:novelId/status 通配路由之前：
// 否则 /api/rag/tts/status 会被 /:novelId/status（novelId="tts"）匹配，
// 触发 authNovel 校验返回 401，导致前端预加载永远拿不到状态。
// （实际定义在下方 tts 资源区，含服务端推理可用性）

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
    const ids = (req.query.ids || "").split(",").filter(Boolean).slice(0, 100);
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
    const ids = (req.query.ids || "").split(",").filter(Boolean).slice(0, 100);
    res.json(getAllStatuses(ids));
  } catch (e) {
    console.error("[rag] all statuses error:", e);
    res.status(500).json({ error: "查询失败" });
  }
});

// ⚠️ TTS 路由必须声明在 /:novelId/status 通配路由之前：
// 否则 /api/rag/tts/status 会被 /:novelId/status（novelId="tts"）匹配，
// 触发 authNovel 校验返回 401，导致前端拿不到状态。

// GET /api/rag/tts/status — 检查 TTS 资源是否就绪（含服务端推理可用性）
router.get("/tts/status", async (req, res) => {
  const wasmExists = fs.existsSync(path.join(TTS_WASM_CACHE, "sherpa-onnx-wasm-main-tts.wasm"));
  const modelExists = fs.existsSync(path.join(TTS_MODEL_CACHE, "model.onnx"));
  // 服务端推理可用性（不触发下载，仅探测）
  let serverInference = { supported: false, ready: false, reason: "" };
  try {
    serverInference = await checkServerInferenceReady();
  } catch (e) {
    serverInference = { supported: false, ready: false, reason: e.message };
  }
  res.json({
    wasmReady: wasmExists,
    modelReady: modelExists,
    vocoderReady: true,
    serverInference,
  });
});

// POST /api/rag/tts/synthesize — 服务端推理生成音频（WAV）
router.post("/tts/synthesize", requireAuth, rateLimit(60), async (req, res) => {
  try {
    const { text, sid, speed } = req.body || {};
    if (!text || typeof text !== "string" || text.length === 0) {
      return res.status(400).json({ error: "text required" });
    }
    if (text.length > 2000) return res.status(400).json({ error: "单次最多 2000 字" });
    // 队列上限：防止大量前端同时朗读导致排队无限堆积
    if (pyQueue.size >= TTS_PY_QUEUE_LIMIT) {
      return res.status(503).json({ error: "服务器推理繁忙，请稍后再试" });
    }
    const s = Math.max(0.4, Math.min(3.5, Number(speed) || 1.0));
    const voiceId = Number.isInteger(Number(sid)) ? Math.max(0, Math.min(102, Number(sid))) : 45;

    const result = await pyGenerate(text, voiceId, s, req.username);
    const wavBuf = Buffer.from(result.wavBase64, "base64");
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", wavBuf.length);
    res.setHeader("Cache-Control", "no-cache");
    res.send(wavBuf);
  } catch (e) {
    console.error("[tts-py] synthesize error:", e.message);
    res.status(500).json({ error: "服务端推理失败: " + e.message });
  }
});

// POST /api/rag/tts/cancel — 取消当前用户所有排队中的服务端推理请求
// 前端停止朗读时调用，立即释放队列位置（其他用户无需等待作废请求生成完）。
router.post("/tts/cancel", requireAuth, (req, res) => {
  try {
    const cancelled = cancelPyRequests(req.username);
    res.json({ cancelled });
  } catch (e) {
    res.status(500).json({ error: "取消失败: " + e.message });
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

/**
 * 获取按优先级排列的镜像源列表（磁盘缓存命中后按此顺序回源下载）：
 * 1. 管理界面配置的 mirrorHost（rag-config.json，用户显式选择，最高优先）
 * 2. 环境变量 HF_MIRROR
 * 3. 默认国内镜像 hf-mirror.com
 * 4. HuggingFace 官方（最后兜底）
 */
function getMirrorHosts() {
  const hosts = [];
  const norm = (h) => (h.endsWith("/") ? h : h + "/");
  try {
    const configPath = path.resolve(__dirname, "../data/rag-config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.mirrorHost) hosts.push(norm(config.mirrorHost));
    }
  } catch { /* ignore */ }
  if (process.env.HF_MIRROR) hosts.push(norm(process.env.HF_MIRROR));
  hosts.push("https://hf-mirror.com/");
  hosts.push("https://huggingface.co/");
  return [...new Set(hosts)];
}

/** 兼容旧接口：返回第一个镜像（主要用于日志/兼容） */
function getMirrorHost() {
  return getMirrorHosts()[0] || "https://hf-mirror.com/";
}

// Normalize cache path: strip "resolve/main/" to match Transformers.js directory structure
// e.g., "Xenova/bge-small-zh-v1.5/resolve/main/config.json" → "Xenova/bge-small-zh-v1.5/config.json"
function toCachePath(subPath) {
  return subPath.replace(/\/resolve\/main\//, "/");
}

// GET /api/rag/model-proxy/{*path} — proxy model file from mirror
// Only allows Xenova/ and onnx-community/ model paths to prevent open proxy abuse
const VALID_MODEL_PATH = /^(Xenova|onnx-community)\/[^/]+\/resolve\/main\/.+/;

router.get("/model-proxy/{*path}", rateLimit(10), async (req, res) => {
  console.log(`[model-proxy] 请求: ${req.originalUrl}`);
  try {
    // Express 5 + path-to-regexp v8: {*path} returns an array of segments
    const subPath = Array.isArray(req.params.path) ? req.params.path.join("/") : req.params.path;
    if (!subPath || !VALID_MODEL_PATH.test(subPath)) {
      return res.status(400).json({ error: "invalid model path" });
    }

    const mirrorHost = getMirrorHost();
    const targetUrl = `${mirrorHost}${subPath}`;

    // Check local cache first (use normalized path for Transformers.js compatibility)
    const cachePath = path.join(MODEL_CACHE_DIR, toCachePath(subPath));
    // 防路径穿越：确保解析后的路径在缓存目录内
    const resolvedCachePath = path.resolve(cachePath);
    const resolvedModelDir = path.resolve(MODEL_CACHE_DIR);
    if (!resolvedCachePath.startsWith(resolvedModelDir + path.sep) && resolvedCachePath !== resolvedModelDir) {
      return res.status(400).json({ error: "invalid path" });
    }
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

    // 依次尝试镜像源下载：磁盘缓存未命中 → 配置/环境变量 → hf-mirror → HuggingFace
    let lastError = null;
    for (const mirrorHost of getMirrorHosts()) {
      const targetUrl = `${mirrorHost}${subPath}`;
      try {
        console.log(`[model-proxy] fetching: ${targetUrl}`);
        const response = await fetch(targetUrl, {
          headers: { "User-Agent": "ai-novel-reader" },
          redirect: "follow",
          signal: AbortSignal.timeout(120_000), // 2min timeout for large model downloads
        });

        if (!response.ok) {
          lastError = `upstream ${response.status} from ${mirrorHost}`;
          console.warn(`[model-proxy] ${mirrorHost} 返回 ${response.status}，尝试下一镜像`);
          continue;
        }

        // 成功：流式返回 + 写入磁盘缓存
        const contentType = response.headers.get("content-type") || "application/octet-stream";
        const contentLength = response.headers.get("content-length");
        res.setHeader("Content-Type", contentType);
        if (contentLength) res.setHeader("Content-Length", contentLength);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-cache");

        const buffer = Buffer.from(await response.arrayBuffer());
        res.send(buffer);

        // Cache to disk with normalized path (async, don't block response)
        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFile(cachePath, buffer, (err) => {
          if (err) console.warn(`[model-proxy] cache write failed: ${err.message}`);
          else console.log(`[model-proxy] cached: ${toCachePath(subPath)} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
        });
        return;
      } catch (e) {
        lastError = `${mirrorHost}: ${e.message}`;
        console.warn(`[model-proxy] ${mirrorHost} 请求失败，尝试下一镜像: ${e.message}`);
      }
    }
    console.error(`[model-proxy] 所有镜像均失败: ${lastError}`);
    return res.status(502).json({ error: `所有镜像均失败: ${lastError}` });
  } catch (e) {
    console.error("[model-proxy] error:", e);
    res.status(500).json({ error: "代理请求失败" });
  }
});

// ── TTS 资源代理 ──────────────────────────────────────────
// 优先从 Gitee 下载（国内快），备选 GitHub
// Gitee: 7z 分卷格式，需要 7z 解压
// GitHub: tar.bz2 格式，需要 tar 解压
// 下载后自动解压到服务器缓存，后续请求直接从缓存读取

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TTS_CACHE_DIR = path.resolve(__dirname, "../data/tts-cache");
const TTS_WASM_CACHE = path.join(TTS_CACHE_DIR, "wasm");
const TTS_MODEL_CACHE = path.join(TTS_CACHE_DIR, "model");
const TTS_TEMP_DIR = path.resolve(__dirname, "../data/tts-temp");

// ── 下载源配置 ──
// 方案4: 分离式标准部署 — 通用 WASM 运行时 + 独立模型文件
const TTS_RELEASE_TAG = "Kokoro_fp32_v1.0";
const SHERPA_VER = "v1.13.6";
// 分离式标准部署：WASM 运行时（精简 data 含 espeak-ng-data）+ 独立模型文件
// WASM 运行时文件名（用户上传到 Gitee 的实际名称）
const WASM_ARCHIVE_NAME = "sherpa-onnx-wasm-simd-1.13.6-kokoro-slim";
// 模型文件（Kokoro multi-lang v1.0 fp32：model.onnx/voices.bin/tokens/lexicon/fst/dict）
// ⚠️ 必须用 fp32 包：v1.0 int8 模型（model.int8.onnx）在 1.13.6 wasm 上
// 生成全 NaN 音频（听不到声音，已用 Node 探针复现）。
// 下载顺序：Gitee fp32 分卷（国内快）→ GitHub 官方 tts-models + 镜像（后备）
const MODEL_ARCHIVE_NAME = "kokoro-multi-lang-v1_0";

// Gitee（优先国内源；WASM 引擎 + fp32 模型分卷均放这里）
const GITEE_BASE = `https://gitee.com/kunji777/ai-novel-reader-v2/releases/download/${TTS_RELEASE_TAG}`;
const GITEE_WASM_PARTS = [`${WASM_ARCHIVE_NAME}.7z`];
// 模型：GitHub 官方 tts-models release（fp32 v1.0，349MB）
const GITHUB_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2";
// GitHub 加速镜像（国内直连 GitHub 下载大文件不稳/慢，依次尝试）
const GITHUB_MIRRORS = [
  "https://gh-proxy.com/",
  "https://gh.llkk.cc/",
];
// Gitee 模型分卷（fp32 v1.0，7z 压缩 322MB / 4 卷；国内下载快）
// ⚠️ 旧分卷内容是 int8（在 1.13.6 wasm 生成全 NaN 无声），已重新打包 fp32 上传
const GITEE_MODEL_PARTS = [
  "kokoro-multi-lang-v1_0.7z.001",
  "kokoro-multi-lang-v1_0.7z.002",
  "kokoro-multi-lang-v1_0.7z.003",
  "kokoro-multi-lang-v1_0.7z.004",
];

/** 校验文件名安全（防路径穿越） */
function sanitizeFilename(filename) {
  if (!filename || typeof filename !== "string") return null;
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) return null;
  if (filename.length > 255) return null;
  return filename;
}

function getTtsContentType(filename) {
  if (filename.endsWith(".wasm")) return "application/wasm";
  if (filename.endsWith(".js")) return "application/javascript";
  if (filename.endsWith(".mjs")) return "application/javascript";
  if (filename.endsWith(".data")) return "application/octet-stream";
  if (filename.endsWith(".onnx")) return "application/octet-stream";
  if (filename.endsWith(".txt")) return "text/plain";
  if (filename.endsWith(".lexicon")) return "text/plain";
  return "application/octet-stream";
}

// ── 压缩包校验 ────────────────────────────────────────────

/** 校验 7z 文件头（37 7A BC AF 27 1C） */
function isValid7z(buffer) {
  return buffer.length > 4 && buffer[0] === 0x37 && buffer[1] === 0x7A && buffer[2] === 0xBC && buffer[3] === 0xAF;
}

/** 校验 bzip2 文件头（BZ） */
function isValidBz2(buffer) {
  return buffer.length > 2 && buffer[0] === 0x42 && buffer[1] === 0x5A;
}

/** 校验 tar 文件（ustar magic） */
function isValidTar(buffer) {
  // tar 在 257 字节处有 "ustar" 标记
  if (buffer.length < 300) return false;
  const magic = buffer.slice(257, 262).toString();
  return magic === "ustar";
}

/** 校验 zip 文件头（PK） */
function isValidZip(buffer) {
  return buffer.length > 2 && buffer[0] === 0x50 && buffer[1] === 0x4B;
}

// ── 解压后文件校验 ────────────────────────────────────────

// ── 文件清单 ──
// WASM 引擎必须包含的文件及最小大小（精简包：无内嵌模型，data 只含 espeak-ng-data）
const WASM_REQUIRED_FILES = {
  "sherpa-onnx-wasm-main-tts.wasm": 1024 * 1024,  // 至少 1MB
  "sherpa-onnx-wasm-main-tts.js": 1024,            // 至少 1KB
  "sherpa-onnx-tts.js": 1024,
  "sherpa-onnx-wasm-main-tts.data": 1024 * 1024,   // espeak-ng-data 精简包（至少 1MB）
};

// 模型必须包含的文件及最小大小（Kokoro multi-lang v1.0 fp32）
const MODEL_REQUIRED_FILES = {
  "model.onnx": 1024 * 1024,       // 至少 1MB（fp32 310MB）
  "voices.bin": 1024 * 1024,        // 至少 1MB
  "tokens.txt": 100,                 // 至少 100 字节
  "lexicon-us-en.txt": 1024 * 1024,  // 至少 1MB
  "lexicon-zh.txt": 1024 * 1024,     // 至少 1MB
  "date-zh.fst": 1024,              // 中文日期规则 FST
  "number-zh.fst": 1024,            // 中文数字规则 FST
  "phone-zh.fst": 1024,             // 中文音素规则 FST
  // jieba 分词 dict（Kokoro dictDir 需要全部文件，含 pos_dict 子目录）
  "dict/jieba.dict.utf8": 1024 * 1024,
  "dict/hmm_model.utf8": 1024 * 256,
  "dict/idf.utf8": 1024 * 512,
  "dict/user.dict.utf8": 1024 * 128,
  "dict/stop_words.utf8": 1024,
  "dict/pos_dict/char_state_tab.utf8": 1024 * 128,
  "dict/pos_dict/prob_emit.utf8": 1024 * 512,
  "dict/pos_dict/prob_start.utf8": 1024,
  "dict/pos_dict/prob_trans.utf8": 1024 * 32,
};

/**
 * 校验解压后的文件完整性
 * @param {string} dir - 目标目录
 * @param {Object} requiredFiles - { 文件名: 最小字节数 }
 */
function validateExtractedFiles(dir, requiredFiles) {
  const missing = [];
  const tooSmall = [];

  for (const [filename, minSize] of Object.entries(requiredFiles)) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) {
      missing.push(filename);
    } else {
      const size = fs.statSync(filePath).size;
      if (size < minSize) {
        tooSmall.push(`${filename} (${(size / 1024).toFixed(0)}KB < ${(minSize / 1024).toFixed(0)}KB)`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`解压后缺少文件: ${missing.join(", ")}`);
  }
  if (tooSmall.length > 0) {
    throw new Error(`解压后文件异常（可能损坏）: ${tooSmall.join(", ")}`);
  }
}

// ── 下载和解压 ────────────────────────────────────────────

/**
 * 从 URL 下载文件（流式写入磁盘，带超时、大小校验、进度回调）
 */
async function downloadFile(url, destPath, minSize = 1024, onProgress, { signal } = {}) {
  console.log(`[tts-proxy] 下载: ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  // 如果外部提供了 abort signal，监听它
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const response = await fetch(url, { redirect: "follow", signal: controller.signal });
  clearTimeout(timeout);
  signal?.removeEventListener("abort", onAbort);
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`);

  const contentLength = parseInt(response.headers.get("content-length") || "0");
  const reader = response.body.getReader();
  const ws = fs.createWriteStream(destPath);
  let received = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ws.write(Buffer.from(value));
      received += value.length;
      if (onProgress && contentLength > 0) {
        onProgress(Math.round((received / contentLength) * 100));
      }
    }
    ws.end();
    await new Promise((resolve, reject) => { ws.on("finish", resolve); ws.on("error", reject); });
  } catch (e) {
    ws.destroy();
    // 下载中断/失败时删除残缺文件，避免后续 size 校验误判为有效缓存
    try { fs.unlinkSync(destPath); } catch {}
    throw e;
  }

  if (received < minSize) {
    throw new Error(`下载的文件太小 (${received} 字节)，可能不是有效文件`);
  }
  console.log(`[tts-proxy] 已下载: ${(received / 1024 / 1024).toFixed(1)} MB`);
}

/**
 * 从 Gitee 下载 7z 分卷 → 拼接 → 校验 → 解压 → 校验解压结果
 * @param {Function} onProgress - 进度回调 (step, detail)
 */
async function downloadFromGitee(partNames, archiveName, targetDir, requiredFiles, onProgress, { signal } = {}) {
  if (!fs.existsSync(TTS_TEMP_DIR)) fs.mkdirSync(TTS_TEMP_DIR, { recursive: true });
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const partPaths = [];
  const archivePath = path.join(TTS_TEMP_DIR, archiveName + ".7z");
  const extractedDir = path.join(TTS_TEMP_DIR, archiveName);

  try {
    // 1. 下载所有分卷
    for (let i = 0; i < partNames.length; i++) {
      if (signal?.aborted) throw new Error("下载已取消");
      const partName = partNames[i];
      const partPath = path.join(TTS_TEMP_DIR, partName);
      onProgress?.(`下载分卷 ${i+1}/${partNames.length}`, partName);
      await downloadFile(`${GITEE_BASE}/${partName}`, partPath, 1024 * 1024, (pct) => {
        onProgress?.(`下载分卷 ${i+1}/${partNames.length} ${pct}%`, partName);
      }, { signal });
      partPaths.push(partPath);
    }

    // 2. 拼接为完整 7z（流式写入）
    onProgress?.("拼接分卷", "合并为完整压缩包");
    const ws = fs.createWriteStream(archivePath);
    for (const p of partPaths) ws.write(fs.readFileSync(p));
    ws.end();
    await new Promise((resolve, reject) => { ws.on("finish", resolve); ws.on("error", reject); });

    // 3. 校验 7z 文件头
    onProgress?.("校验压缩包", "检查文件格式");
    const archiveBuffer = fs.readFileSync(archivePath);
    if (!isValid7z(archiveBuffer)) {
      throw new Error("拼接后的文件不是有效的 7z 格式（文件头校验失败）");
    }

    // 4. 解压到独立子目录（避免归档根目录模式与 TTS_TEMP_DIR 其他残留混淆）
    onProgress?.("解压中", "7z 解压...");
    const extractRoot = path.join(TTS_TEMP_DIR, archiveName + "-extract");
    try { fs.rmSync(extractRoot, { recursive: true }); } catch {}
    fs.mkdirSync(extractRoot, { recursive: true });
    try {
      await execFileAsync("7z", ["x", archivePath, `-o${extractRoot}`, "-y"], { timeout: 120000 });
    } catch (e) {
      if (e.code === "ENOENT") throw new Error("7z 未安装。请安装 7-Zip (Windows) 或 p7zip-full (Linux/macOS) 后重试。");
      throw new Error(`7z 解压失败: ${e.message}`);
    }

    // 5. 复制到目标目录（整体复制，dict/ 等子目录全部保留）
    onProgress?.("复制文件", "写入缓存目录");
    // 兼容两种归档结构：
    //   a) 归档内有单个顶层目录（archiveName/...）→ 复制该目录内容
    //   b) 文件直接在归档根目录 → 复制 extractRoot 全部内容
    let copySrc = extractRoot;
    const entries = fs.readdirSync(extractRoot);
    if (entries.length === 1) {
      const only = path.join(extractRoot, entries[0]);
      try { if (fs.statSync(only).isDirectory()) copySrc = only; } catch {}
    }
    fs.cpSync(copySrc, targetDir, { recursive: true });

    // 6. 校验解压后的文件
    onProgress?.("校验文件", "检查完整性");
    validateExtractedFiles(targetDir, requiredFiles);

    // 7. 清理临时文件
    onProgress?.("清理", "删除临时文件");
  } finally {
    for (const p of partPaths) { try { fs.unlinkSync(p); } catch {} }
    try { fs.unlinkSync(archivePath); } catch {}
    try { fs.rmSync(extractedDir, { recursive: true }); } catch {}
    try { fs.rmSync(extractRoot, { recursive: true }); } catch {}
  }
}

/**
 * 从 GitHub 下载 tar.bz2 → 校验 → 解压 → 校验解压结果
 */
async function downloadFromGitHubTar(url, archiveName, targetDir, requiredFiles, onProgress, { signal } = {}) {
  if (!fs.existsSync(TTS_TEMP_DIR)) fs.mkdirSync(TTS_TEMP_DIR, { recursive: true });
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const archivePath = path.join(TTS_TEMP_DIR, archiveName + ".tar.bz2");
  const extractedDir = path.join(TTS_TEMP_DIR, archiveName);

  try {
    onProgress?.("下载中 (GitHub)", "tar.bz2 格式");
    // 依次尝试官方直连 + 加速镜像（downloadFile 失败会清理残缺文件，重试安全）
    const urls = [url, ...GITHUB_MIRRORS.map((m) => m + url)];
    let lastErr = null;
    for (const u of urls) {
      if (signal?.aborted) throw new Error("下载已取消");
      try {
        await downloadFile(u, archivePath, 1024 * 1024, (pct) => {
          onProgress?.(`下载中 ${pct}% (GitHub)`, "tar.bz2 格式");
        }, { signal });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[tts-proxy] GitHub 下载失败 (${u}): ${e.message}，尝试下一个源`);
      }
    }
    if (lastErr) throw lastErr;

    onProgress?.("校验压缩包", "检查文件格式");
    const headerBuf = Buffer.alloc(4);
    const fd = fs.openSync(archivePath, "r");
    try { fs.readSync(fd, headerBuf, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (!isValidBz2(headerBuf)) {
      throw new Error("下载的文件不是有效的 bzip2 格式（文件头校验失败）");
    }

    onProgress?.("解压中", "tar.bz2 解压...");
    try {
      await execFileAsync("tar", ["xjf", archivePath, "-C", TTS_TEMP_DIR], { timeout: 120000 });
    } catch (e) {
      if (e.code === "ENOENT") throw new Error("tar 未安装。请安装 tar (Linux/macOS) 或 7-Zip (Windows) 后重试。");
      throw new Error(`tar 解压失败: ${e.message}`);
    }

    onProgress?.("复制文件", "写入缓存目录");
    if (!fs.existsSync(extractedDir)) {
      throw new Error(`解压后找不到目录: ${archiveName}`);
    }
    fs.cpSync(extractedDir, targetDir, { recursive: true });

    onProgress?.("校验文件", "检查完整性");
    validateExtractedFiles(targetDir, requiredFiles);
  } finally {
    try { fs.unlinkSync(archivePath); } catch {}
    try { fs.rmSync(extractedDir, { recursive: true }); } catch {}
  }
}

/**
 * 从 GitHub 下载 zip → 校验 → 解压 → 校验解压结果
 */
async function downloadFromGitHubZip(url, archiveName, targetDir, requiredFiles, onProgress, { signal } = {}) {
  if (!fs.existsSync(TTS_TEMP_DIR)) fs.mkdirSync(TTS_TEMP_DIR, { recursive: true });
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const archivePath = path.join(TTS_TEMP_DIR, archiveName + ".zip");
  const extractedDir = path.join(TTS_TEMP_DIR, archiveName);

  try {
    onProgress?.("下载中 (GitHub)", "zip 格式");
    await downloadFile(url, archivePath, 1024 * 1024, (pct) => {
      onProgress?.(`下载中 ${pct}% (GitHub)`, "zip 格式");
    }, { signal });

    onProgress?.("校验压缩包", "检查文件格式");
    const headerBuf = Buffer.alloc(2);
    const fd = fs.openSync(archivePath, "r");
    try { fs.readSync(fd, headerBuf, 0, 2, 0); } finally { fs.closeSync(fd); }
    if (!isValidZip(headerBuf)) {
      throw new Error("下载的文件不是有效的 zip 格式（文件头校验失败）");
    }

    onProgress?.("解压中", "zip 解压...");
    try {
      await execFileAsync("7z", ["x", archivePath, `-o${TTS_TEMP_DIR}`, "-y"], { timeout: 120000 });
    } catch (e) {
      if (e.code === "ENOENT") throw new Error("7z 未安装。请安装 7-Zip (Windows) 或 p7zip-full (Linux/macOS) 后重试。");
      throw new Error(`zip 解压失败: ${e.message}`);
    }

    onProgress?.("复制文件", "写入缓存目录");
    fs.cpSync(extractedDir, targetDir, { recursive: true });

    onProgress?.("校验文件", "检查完整性");
    validateExtractedFiles(targetDir, requiredFiles);
  } finally {
    try { fs.unlinkSync(archivePath); } catch {}
    try { fs.rmSync(extractedDir, { recursive: true }); } catch {}
  }
}

/**
 * 下载并解压资源（Gitee 优先，GitHub 备选，含完整校验）
 * @param {Function} onProgress - 进度回调 (step, detail)
 */
const MIN_DISK_SPACE_BYTES = 500 * 1024 * 1024; // 500MB

async function downloadAndExtract(giteeParts, githubUrl, archiveName, targetDir, requiredFiles, onProgress, { signal, force = false } = {}) {
  // L1 fix: 强制重新下载时清除缓存
  if (force && fs.existsSync(targetDir)) {
    console.log(`[tts-proxy] 强制重新下载，清除缓存: ${targetDir}`);
    try { fs.rmSync(targetDir, { recursive: true }); } catch {}
  }

  // 检查缓存
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    try {
      onProgress?.("校验缓存", "检查已有文件");
      validateExtractedFiles(targetDir, requiredFiles);
      onProgress?.("完成", "缓存有效");
      return;
    } catch (e) {
      console.warn(`[tts-proxy] 缓存校验失败，重新下载: ${e.message}`);
      try { fs.rmSync(targetDir, { recursive: true }); } catch {}
    }
  }

  // 清理不完整的缓存
  if (fs.existsSync(targetDir)) {
    try { fs.rmSync(targetDir, { recursive: true }); } catch {}
  }

  // L1 fix: 检查磁盘空间
  try {
    const stats = fs.statfsSync(TTS_CACHE_DIR);
    if (stats.available * stats.size < MIN_DISK_SPACE_BYTES) {
      throw new Error(`磁盘空间不足，需要至少 500MB，当前可用 ${Math.round(stats.available * stats.size / 1024 / 1024)}MB`);
    }
  } catch (e) {
    if (e.message.includes("磁盘空间")) throw e;
    // statfsSync 可能不可用（旧版 Node），跳过检查
    console.warn("[tts-proxy] 无法检查磁盘空间:", e.message);
  }

  // 优先 Gitee（仅当配置了分卷；模型包已切 GitHub 官方源，分卷为空时跳过）
  if (giteeParts && giteeParts.length > 0) {
    try {
      onProgress?.("开始下载", "尝试 Gitee（国内源）");
      await downloadFromGitee(giteeParts, archiveName, targetDir, requiredFiles, onProgress, { signal });
      onProgress?.("完成", "Gitee 下载成功");
      return;
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn(`[tts-proxy] Gitee 失败: ${e.message}，尝试 GitHub`);
      onProgress?.("Gitee 失败", e.message + "，切换 GitHub...");
      if (fs.existsSync(targetDir)) {
        try { fs.rmSync(targetDir, { recursive: true }); } catch {}
      }
    }
  }

  // 备选 GitHub（仅模型文件有 GitHub 可下载）
  if (githubUrl) {
    onProgress?.("开始下载", "尝试 GitHub（海外源）");
    await downloadFromGitHubTar(githubUrl, archiveName, targetDir, requiredFiles, onProgress, { signal });
    onProgress?.("完成", "GitHub 下载成功");
    return;
  }
  throw new Error("Gitee 下载失败，且无 GitHub 备选源。请检查 Gitee Release 文件。");
}

/** 确保 WASM 文件已缓存 */
let wasmReady = false;
let wasmReadyPromise = null;
let wasmLastFailure = 0;
export async function ensureWasmReady(onProgress, { signal, force = false } = {}) {
  if (force) { wasmReady = false; wasmReadyPromise = null; }
  if (wasmReady) return;
  if (wasmReadyPromise) return wasmReadyPromise;
  if (Date.now() - wasmLastFailure < 30000) throw new Error("上次下载失败，请 30 秒后重试");
  wasmReadyPromise = downloadAndExtract(
    GITEE_WASM_PARTS, null, WASM_ARCHIVE_NAME, TTS_WASM_CACHE, WASM_REQUIRED_FILES, onProgress, { signal, force }
  ).then(() => { wasmReady = true; })
   .catch((e) => { wasmLastFailure = Date.now(); wasmReadyPromise = null; throw e; });
  await wasmReadyPromise;
}

/** 确保模型文件已缓存 */
let modelReady = false;
let modelReadyPromise = null;
let modelLastFailure = 0;
export async function ensureModelReady(onProgress, { signal, force = false } = {}) {
  if (force) { modelReady = false; modelReadyPromise = null; }
  if (modelReady) return;
  if (modelReadyPromise) return modelReadyPromise;
  if (Date.now() - modelLastFailure < 30000) throw new Error("上次下载失败，请 30 秒后重试");
  modelReadyPromise = downloadAndExtract(
    GITEE_MODEL_PARTS, GITHUB_MODEL_URL, MODEL_ARCHIVE_NAME, TTS_MODEL_CACHE, MODEL_REQUIRED_FILES, onProgress, { signal, force }
  ).then(() => { modelReady = true; })
   .catch((e) => { modelLastFailure = Date.now(); modelReadyPromise = null; throw e; });
  await modelReadyPromise;
}

/**
 * 依次确保 TTS 资源（WASM + 模型）全部就绪
 * 供服务器启动时预加载和 /tts/prepare 复用；任一步失败会抛出该步错误，
 * 但内部各步自带缓存校验与 30 秒失败冷却，可安全重试
 */
export async function ensureTTSResources(onProgress, options = {}) {
  await ensureWasmReady(onProgress, options);
  await ensureModelReady(onProgress, options);
}

// ── 服务端推理（Python sherpa-onnx 原生多线程）────────────────
// 浏览器 wasm 单线程推理 RTF≈12-13（29 字要 69s），无法边听边推理；
// Python 原生 8 线程 RTF≈0.6（18 字只要 2.5s），生成比播放快 1.5 倍。
// 由 server/tts-worker.py 常驻进程提供，通过 stdin/stdout JSON 行通信。
const TTS_WORKER_PY = path.resolve(__dirname, "../tts-worker.py");
const TTS_PY_THREADS = 8;
const TTS_PY_START_TIMEOUT = 30000;   // 进程启动 + 模型加载超时（本地实测约 3s）
const TTS_PY_GEN_TIMEOUT = 180000;    // 单次生成超时（60 字 chunk 8 线程约 10s，预留余量）
const TTS_PY_QUEUE_LIMIT = 30;        // 排队上限：超过直接 503，防止多前端堆积拖垮所有人

let pyProc = null;            // Python 子进程
let pyReady = false;          // 是否收到 ready 消息
let pyStartPromise = null;    // 启动去重
let pyBuffer = "";            // stdout 行缓冲
let pyQueue = new Map();      // id → { resolve, reject, timer }
let pyNextId = 1;
let pyLastError = "";         // 上次失败原因（status 接口展示）
let pyCandidates = ["python", "python3", "py"]; // 依次探测可用的 Python 命令

/** 探测可用的 python 命令（缓存 60s：部署后装好 Python 无需重启即可生效） */
let _pyCmdCache = null;
let _pyCmdCacheAt = 0;
async function detectPythonCommand() {
  if (_pyCmdCache !== null && Date.now() - _pyCmdCacheAt < 60000) return _pyCmdCache;
  for (const cmd of pyCandidates) {
    try {
      const { stdout } = await execFileAsync(cmd, ["-c", "import sherpa_onnx; print('ok')"], { timeout: 15000, windowsHide: true });
      if (String(stdout).trim() === "ok") {
        _pyCmdCache = cmd;
        _pyCmdCacheAt = Date.now();
        return cmd;
      }
    } catch { /* 尝试下一个 */ }
  }
  _pyCmdCache = "";
  _pyCmdCacheAt = Date.now();
  return _pyCmdCache;
}

/** 检查服务端推理是否可用（Python + sherpa_onnx + 模型文件就绪）。
 *  ⚠️ 只检查文件存在性，绝不触发下载（ensureModelReady 会下载 350MB，
 *  status 轮询被设置页每 30s 调用，一旦误触发就违背"模型按需下载"）。 */
export async function checkServerInferenceReady() {
  const pyCmd = await detectPythonCommand();
  if (!pyCmd) return { supported: false, ready: false, reason: "服务器未安装 Python 或 sherpa-onnx（pip install sherpa-onnx）" };
  const modelExists = fs.existsSync(path.join(TTS_MODEL_CACHE, "model.onnx"));
  if (!modelExists) return { supported: true, ready: false, reason: "模型未下载（设置页启用服务端推理时自动下载）" };
  return { supported: true, ready: true, reason: "" };
}

/** 确保 Python 推理进程已启动（模型就绪 + 进程 ready） */
async function ensurePyProcess() {
  const pyCmd = await detectPythonCommand();
  if (!pyCmd) throw new Error("服务器未安装 Python 或 sherpa-onnx，无法使用服务端推理。请运行: pip install sherpa-onnx");
  if (pyProc && pyReady) return pyProc;
  if (pyStartPromise) return pyStartPromise;

  pyStartPromise = (async () => {
    // 先确保模型文件在服务器上就绪（懒下载：仅在启用服务端推理时触发）
    await ensureModelReady();
    if (pyProc && pyReady) return pyProc;

    pyReady = false;
    pyBuffer = "";
    pyProc = spawn(pyCmd, [TTS_WORKER_PY, TTS_MODEL_CACHE, String(TTS_PY_THREADS)], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    pyProc.stdout.on("data", (chunk) => {
      pyBuffer += chunk.toString("utf8");
      let idx;
      while ((idx = pyBuffer.indexOf("\n")) >= 0) {
        const line = pyBuffer.slice(0, idx).trim();
        pyBuffer = pyBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "ready") {
            pyReady = true;
            pyLastError = "";
            console.log(`[tts-py] 服务端推理就绪 (numSpeakers=${msg.numSpeakers})`);
          } else if (msg.type === "result") {
            const pending = pyQueue.get(msg.id);
            if (pending) {
              clearTimeout(pending.timer);
              pyQueue.delete(msg.id);
              pending.resolve(msg);
            }
          } else if (msg.type === "error") {
            const pending = pyQueue.get(msg.id);
            if (pending) {
              clearTimeout(pending.timer);
              pyQueue.delete(msg.id);
              pending.reject(new Error(msg.message));
            }
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    pyProc.stderr.on("data", (chunk) => {
      const s = String(chunk).trim();
      if (s) console.warn("[tts-py] stderr:", s.slice(0, 500));
    });
    pyProc.on("exit", (code) => {
      console.warn(`[tts-py] 进程退出 code=${code}`);
      pyProc = null;
      pyReady = false;
      pyStartPromise = null;
      // 未完成请求全部失败
      for (const [id, p] of pyQueue) {
        clearTimeout(p.timer);
        pyQueue.delete(id);
        p.reject(new Error("服务端推理进程已退出"));
      }
    });
    pyProc.on("error", (err) => {
      pyLastError = err.message;
      console.error("[tts-py] 进程错误:", err.message);
      pyProc = null;
      pyReady = false;
      pyStartPromise = null;
    });

    // 等待 ready（含模型加载，约 3s）
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (pyReady) { clearInterval(timer); resolve(); }
        else if (Date.now() - t0 > TTS_PY_START_TIMEOUT) {
          clearInterval(timer);
          reject(new Error(pyLastError || "服务端推理启动超时"));
        }
      }, 200);
    });
    return pyProc;
  })().catch((e) => {
    pyStartPromise = null;
    throw e;
  });

  return pyStartPromise;
}

/** 提交一次生成请求，返回 { sampleRate, wavBase64 }。
 *  username 用于取消协议：前端停止时按用户清掉排队中的请求。
 *  先入队（等待 Python 就绪期间也可被 cancel 取消），进程就绪后再写入 stdin。 */
async function pyGenerate(text, sid, speed, username = "") {
  const id = pyNextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pyQueue.has(id)) {
        pyQueue.delete(id);
        reject(new Error(`服务端推理超时（${TTS_PY_GEN_TIMEOUT / 1000}s）`));
      }
    }, TTS_PY_GEN_TIMEOUT);
    pyQueue.set(id, { resolve, reject, timer, username, started: false });
    // 异步等进程就绪后写入；期间被 cancel 移除则静默放弃（reject 已由 cancel 触发）
    (async () => {
      try {
        await ensurePyProcess();
        if (!pyQueue.has(id)) return; // 已被 cancel 取消
        pyQueue.get(id).started = true;
        pyProc.stdin.write(JSON.stringify({ id, text, sid, speed }) + "\n");
      } catch (e) {
        if (pyQueue.has(id)) {
          clearTimeout(timer);
          pyQueue.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    })();
  });
}

/** 取消某用户所有排队中的请求（前端停止朗读时调用）。
 *  - 未开始的请求：直接从队列移除，Python 不再生成（释放队列位置给其他用户）
 *  - 正在生成的请求：无法中断 Python，但结果返回时队列中已无该 id，自动丢弃
 *  ⚠️ 不依赖 pyReady：Python 启动窗口内（pyReady=false）也有排队中的请求需要取消。
 * 返回被取消的请求数。 */
export function cancelPyRequests(username) {
  if (!username) return 0;
  let cancelled = 0;
  for (const [id, p] of pyQueue) {
    if (p.username === username) {
      clearTimeout(p.timer);
      pyQueue.delete(id);
      p.reject(new Error("服务端推理已取消"));
      cancelled++;
    }
  }
  if (cancelled > 0) console.log(`[tts-py] 用户 ${username} 取消 ${cancelled} 个排队请求`);
  return cancelled;
}

/**
 * 辅助函数：流式发送文件（带错误处理）
 */
function serveFile(res, filePath, contentType) {
  const stat = fs.statSync(filePath);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", stat.size);
  // no-cache：文件内容可能随引擎/模型升级变化，浏览器 HTTP 强缓存（7 天）
  // 会导致升级后仍拿到旧文件（曾引发 ESM/classic 加载错误）。
  // 持久化由前端 IndexedDB 承担，这里只需每次重新验证。
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const stream = fs.createReadStream(filePath);
  stream.on("error", (err) => {
    console.error("[tts-proxy] stream error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "文件读取错误" });
    else res.end();
  });
  stream.pipe(res);
}

// GET /api/rag/tts/wasm/:filename — 获取 WASM 引擎文件
router.get("/tts/wasm/:filename", requireAuth, async (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: "无效的文件名" });
  const filePath = path.join(TTS_WASM_CACHE, filename);
  if (!filePath.startsWith(TTS_WASM_CACHE)) return res.status(400).json({ error: "无效的文件名" });

  try {
    await ensureWasmReady();
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file not found" });
    serveFile(res, filePath, getTtsContentType(filename));
  } catch (e) {
    console.error("[tts-proxy] wasm error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: "加载 WASM 失败: " + e.message });
  }
});

// GET /api/rag/tts/model/:filename — 获取模型文件（支持 dict/ 子路径）
router.get("/tts/model/:filename", requireAuth, async (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: "无效的文件名" });
  // 子路径（dict/...）在 Express 的 :filename 中会包含斜杠？不会——需要匹配两层
  const filePath = path.join(TTS_MODEL_CACHE, filename);
  if (!filePath.startsWith(TTS_MODEL_CACHE)) return res.status(400).json({ error: "无效的文件名" });

  try {
    await ensureModelReady();
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file not found" });
    serveFile(res, filePath, getTtsContentType(filename));
  } catch (e) {
    console.error("[tts-proxy] model error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: "加载模型失败: " + e.message });
  }
});

// GET /api/rag/tts/model/dict/:filename — 获取 jieba 分词词典（Kokoro dictDir）
router.get("/tts/model/dict/:filename", requireAuth, async (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: "无效的文件名" });
  const filePath = path.join(TTS_MODEL_CACHE, "dict", filename);
  if (!filePath.startsWith(path.join(TTS_MODEL_CACHE, "dict"))) return res.status(400).json({ error: "无效的文件名" });

  try {
    await ensureModelReady();
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file not found" });
    serveFile(res, filePath, "application/octet-stream");
  } catch (e) {
    console.error("[tts-proxy] dict error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: "加载 dict 失败: " + e.message });
  }
});

// GET /api/rag/tts/model/dict/pos_dict/:filename — 获取 jieba 词性标注词典
router.get("/tts/model/dict/pos_dict/:filename", requireAuth, async (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: "无效的文件名" });
  const filePath = path.join(TTS_MODEL_CACHE, "dict", "pos_dict", filename);
  if (!filePath.startsWith(path.join(TTS_MODEL_CACHE, "dict", "pos_dict"))) return res.status(400).json({ error: "无效的文件名" });

  try {
    await ensureModelReady();
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file not found" });
    serveFile(res, filePath, "application/octet-stream");
  } catch (e) {
    console.error("[tts-proxy] dict pos_dict error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: "加载 dict pos_dict 失败: " + e.message });
  }
});

// GET /api/rag/tts/prepare — SSE 端点，下载并准备 TTS 资源，实时推送进度
router.get("/tts/prepare", requireAuth, async (req, res) => {
  const force = req.query.force === "true";
  // SSE 头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  let clientDisconnected = false;
  const abortController = new AbortController();
  req.on("close", () => {
    clientDisconnected = true;
    abortController.abort();
  });

  function sendEvent(type, data) {
    if (clientDisconnected) return;
    try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {}
  }

  try {
    sendEvent("step", { step: "开始", detail: "检查 TTS 资源..." });

    // 准备 WASM
    sendEvent("step", { step: "WASM 引擎", detail: "检查中..." });
    await ensureWasmReady((step, detail) => {
      sendEvent("step", { step: `WASM: ${step}`, detail });
    }, { signal: abortController.signal, force });
    if (clientDisconnected) return;
    sendEvent("step", { step: "WASM 引擎", detail: "就绪 ✓" });

    // 准备模型
    sendEvent("step", { step: "语音模型", detail: "检查中..." });
    await ensureModelReady((step, detail) => {
      sendEvent("step", { step: `模型: ${step}`, detail });
    }, { signal: abortController.signal, force });
    if (clientDisconnected) return;
    sendEvent("step", { step: "语音模型", detail: "就绪 ✓" });

    sendEvent("done", { success: true });
  } catch (e) {
    if (!clientDisconnected) sendEvent("error", { message: e.message });
  }

  res.end();
});

export default router;
