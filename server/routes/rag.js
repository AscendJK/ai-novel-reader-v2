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
// Only allows Xenova/ and onnx-community/ model paths to prevent open proxy abuse
const VALID_MODEL_PATH = /^(Xenova|onnx-community)\/[^/]+\/resolve\/main\/.+/;

router.get("/model-proxy/{*path}", async (req, res) => {
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

// ── TTS 资源代理 ──────────────────────────────────────────
// 优先从 Gitee 下载（国内快），备选 GitHub
// Gitee: 7z 分卷格式，需要 7z 解压
// GitHub: tar.bz2 格式，需要 tar 解压
// 下载后自动解压到服务器缓存，后续请求直接从缓存读取

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TTS_CACHE_DIR = path.resolve(__dirname, "../data/tts-cache");
const TTS_WASM_CACHE = path.join(TTS_CACHE_DIR, "wasm");
const TTS_MODEL_CACHE = path.join(TTS_CACHE_DIR, "model");
const TTS_TEMP_DIR = path.resolve(__dirname, "../data/tts-temp");

// ── 下载源配置 ──
// 方案4: 分离式标准部署 — 通用 WASM 运行时 + 独立模型文件
const TTS_RELEASE_TAG = "tts-zipvoice-v1.0";
const SHERPA_VER = "v1.13.3";
// 通用 TTS WASM 运行时（无内置模型/音色/vocoder）
const WASM_ARCHIVE_NAME = "sherpa-onnx-wasm-simd-tts";
// 模型文件（encoder/decoder/tokens/lexicon）
const MODEL_ARCHIVE_NAME = "sherpa-onnx-zipvoice-distill-int8-zh-en-emilia";

// Gitee（国内优先）：7z 分卷
const GITEE_BASE = `https://gitee.com/kunji777/ai-novel-reader-v2/releases/download/${TTS_RELEASE_TAG}`;
const GITEE_WASM_PARTS = [`${WASM_ARCHIVE_NAME}.7z.001`, `${WASM_ARCHIVE_NAME}.7z.002`, `${WASM_ARCHIVE_NAME}.7z.003`];
const GITEE_MODEL_PARTS = [`${MODEL_ARCHIVE_NAME}.7z.001`, `${MODEL_ARCHIVE_NAME}.7z.002`];

// GitHub（备选）：直接下载，来自 sherpa-onnx 官方 Release
const SHERPA_RELEASE_BASE = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_VER}`;
const GITHUB_WASM_URL = `${SHERPA_RELEASE_BASE}/${WASM_ARCHIVE_NAME}.zip`;
const GITHUB_MODEL_URL = `${SHERPA_RELEASE_BASE}/zipvoice-distill-int8-zh-en.tar.bz2`;

// Vocoder 模型（独立下载，Gitee 优先，GitHub 备用）
// 官方仅有 22kHz 通用版，ZipVoice 兼容
const VOCODER_FILENAME = "vocos-22khz-univ.onnx";
const GITEE_VOCODER_URL = `${GITEE_BASE}/${VOCODER_FILENAME}`;
const GITHUB_VOCODER_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-22khz-univ.onnx";

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

// WASM 引擎必须包含的文件及最小大小
const WASM_REQUIRED_FILES = {
  "sherpa-onnx-wasm-main-tts.wasm": 1024 * 1024,  // 至少 1MB
  "sherpa-onnx-wasm-main-tts.js": 1024,            // 至少 1KB
  "sherpa-onnx-tts.js": 1024,
};

// 模型必须包含的文件及最小大小
const MODEL_REQUIRED_FILES = {
  "decoder.int8.onnx": 1024 * 1024,  // 至少 1MB
  "encoder.int8.onnx": 1024 * 1024,  // 至少 1MB
  "tokens.txt": 100,                  // 至少 100 字节
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

    // 4. 解压
    onProgress?.("解压中", "7z 解压...");
    try {
      await execFileAsync("7z", ["x", archivePath, `-o${TTS_TEMP_DIR}`, "-y"], { timeout: 120000 });
    } catch (e) {
      if (e.code === "ENOENT") throw new Error("7z 未安装。请安装 7-Zip (Windows) 或 p7zip-full (Linux/macOS) 后重试。");
      throw new Error(`7z 解压失败: ${e.message}`);
    }

    // 5. 复制到目标目录
    onProgress?.("复制文件", "写入缓存目录");
    if (!fs.existsSync(extractedDir)) {
      throw new Error(`解压后找不到目录: ${archiveName}`);
    }
    fs.cpSync(extractedDir, targetDir, { recursive: true });

    // 6. 校验解压后的文件
    onProgress?.("校验文件", "检查完整性");
    validateExtractedFiles(targetDir, requiredFiles);

    // 7. 清理临时文件
    onProgress?.("清理", "删除临时文件");
  } finally {
    for (const p of partPaths) { try { fs.unlinkSync(p); } catch {} }
    try { fs.unlinkSync(archivePath); } catch {}
    try { fs.rmSync(extractedDir, { recursive: true }); } catch {}
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
    await downloadFile(url, archivePath, 1024 * 1024, (pct) => {
      onProgress?.(`下载中 ${pct}% (GitHub)`, "tar.bz2 格式");
    }, { signal });

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

  // 优先 Gitee
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

  // 备选 GitHub：WASM 用 zip，模型用 tar.bz2
  onProgress?.("开始下载", "尝试 GitHub（海外源）");
  if (requiredFiles === WASM_REQUIRED_FILES) {
    await downloadFromGitHubZip(githubUrl, archiveName, targetDir, requiredFiles, onProgress, { signal });
  } else {
    await downloadFromGitHubTar(githubUrl, archiveName, targetDir, requiredFiles, onProgress, { signal });
  }
  onProgress?.("完成", "GitHub 下载成功");
}

/** 确保 WASM 文件已缓存 */
let wasmReady = false;
let wasmReadyPromise = null;
let wasmLastFailure = 0;
async function ensureWasmReady(onProgress, { signal, force = false } = {}) {
  if (force) { wasmReady = false; wasmReadyPromise = null; }
  if (wasmReady) return;
  if (wasmReadyPromise) return wasmReadyPromise;
  if (Date.now() - wasmLastFailure < 30000) throw new Error("上次下载失败，请 30 秒后重试");
  wasmReadyPromise = downloadAndExtract(
    GITEE_WASM_PARTS, GITHUB_WASM_URL, WASM_ARCHIVE_NAME, TTS_WASM_CACHE, WASM_REQUIRED_FILES, onProgress, { signal, force }
  ).then(() => { wasmReady = true; })
   .catch((e) => { wasmLastFailure = Date.now(); wasmReadyPromise = null; throw e; });
  await wasmReadyPromise;
}

/** 确保 vocoder 文件已缓存 */
let vocoderReady = false;
let vocoderReadyPromise = null;
async function ensureVocoderReady(onProgress, { signal } = {}) {
  if (vocoderReady) return;
  if (vocoderReadyPromise) return vocoderReadyPromise;
  const vocoderPath = path.join(TTS_MODEL_CACHE, VOCODER_FILENAME);
  if (fs.existsSync(vocoderPath) && fs.statSync(vocoderPath).size > 100000) {
    vocoderReady = true;
    return;
  }
  // Gitee 优先，GitHub 备用
  vocoderReadyPromise = (async () => {
    onProgress?.(0);
    try {
      await downloadFile(GITEE_VOCODER_URL, vocoderPath, 100000, onProgress, { signal });
    } catch (e) {
      console.warn(`[tts-proxy] Gitee vocoder 失败: ${e.message}，尝试 GitHub`);
      await downloadFile(GITHUB_VOCODER_URL, vocoderPath, 100000, onProgress, { signal });
    }
    vocoderReady = true;
  })().catch((e) => { vocoderReadyPromise = null; throw e; });
  await vocoderReadyPromise;
}

/** 确保模型文件已缓存 */
let modelReady = false;
let modelReadyPromise = null;
let modelLastFailure = 0;
async function ensureModelReady(onProgress, { signal, force = false } = {}) {
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
 * 辅助函数：流式发送文件（带错误处理）
 */
function serveFile(res, filePath, contentType) {
  const stat = fs.statSync(filePath);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "public, max-age=604800");
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
router.get("/tts/wasm/:filename", async (req, res) => {
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

// GET /api/rag/tts/model/:filename — 获取模型文件
router.get("/tts/model/:filename", async (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: "无效的文件名" });
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

// GET /api/rag/tts/model/espeak-ng-data/:filename — 获取 espeak 数据文件
router.get("/tts/model/espeak-ng-data/:filename", async (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: "无效的文件名" });
  const filePath = path.join(TTS_MODEL_CACHE, "espeak-ng-data", filename);
  if (!filePath.startsWith(path.join(TTS_MODEL_CACHE, "espeak-ng-data"))) return res.status(400).json({ error: "无效的文件名" });

  try {
    await ensureModelReady();
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file not found" });
    serveFile(res, filePath, "application/octet-stream");
  } catch (e) {
    console.error("[tts-proxy] espeak error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: "加载 espeak 数据失败: " + e.message });
  }
});

// GET /api/rag/tts/model/vocoder/:filename — 获取 vocoder 模型
router.get("/tts/model/vocoder/:filename", async (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: "无效的文件名" });
  if (filename !== VOCODER_FILENAME) return res.status(404).json({ error: "file not found" });
  const filePath = path.join(TTS_MODEL_CACHE, filename);

  try {
    await ensureVocoderReady();
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file not found" });
    serveFile(res, filePath, "application/octet-stream");
  } catch (e) {
    console.error("[tts-proxy] vocoder error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: "加载 vocoder 失败: " + e.message });
  }
});

// GET /api/rag/tts/model/test_wavs/:filename — 获取参考音频文件
router.get("/tts/model/test_wavs/:filename", async (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  if (!filename) return res.status(400).json({ error: "无效的文件名" });
  const filePath = path.join(TTS_MODEL_CACHE, "test_wavs", filename);
  if (!filePath.startsWith(path.join(TTS_MODEL_CACHE, "test_wavs"))) return res.status(400).json({ error: "无效的文件名" });

  try {
    await ensureModelReady();
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "file not found" });
    serveFile(res, filePath, "audio/wav");
  } catch (e) {
    console.error("[tts-proxy] test_wavs error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: "加载参考音频失败: " + e.message });
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

    // 准备 vocoder
    sendEvent("step", { step: "Vocoder", detail: "下载中..." });
    await ensureVocoderReady((step, detail) => {
      sendEvent("step", { step: `Vocoder: ${step}`, detail });
    }, { signal: abortController.signal, force });
    if (clientDisconnected) return;
    sendEvent("step", { step: "Vocoder", detail: "就绪 ✓" });

    sendEvent("done", { success: true });
  } catch (e) {
    if (!clientDisconnected) sendEvent("error", { message: e.message });
  }

  res.end();
});

// GET /api/rag/tts/status — 检查 TTS 资源是否就绪
router.get("/tts/status", (req, res) => {
  const wasmExists = fs.existsSync(path.join(TTS_WASM_CACHE, "sherpa-onnx-wasm-main-tts.wasm"));
  const modelExists = fs.existsSync(path.join(TTS_MODEL_CACHE, "decoder.int8.onnx"));
  res.json({ wasmReady: wasmExists, modelReady: modelExists });
});

export default router;
