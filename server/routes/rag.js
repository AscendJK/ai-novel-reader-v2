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
import { resolveModelKey, isAllowedEngine, allowedEngineList } from "../lib/engine-config.js";
import { cleanTtsText } from "../lib/tts-text-cleaner.mjs";
import { resolveMirrorHosts } from "../lib/model-mirrors.mjs";
import { isAllowedModelPath, resolveModelCachePath, toCachePath } from "../lib/model-paths.mjs";
import { dataPath } from "../lib/data-paths.mjs";
import { createTtsPyWorker } from "../lib/tts-py-worker.mjs";
import {
  isValid7z, isValidBz2, readHeadSync, checkExtractedFiles, checkDiskSpace, assertPartsInOrder,
} from "../lib/tts-archive-checks.mjs";
import { createDownloader } from "../lib/tts-download.mjs";
import { createResourceGate } from "../lib/tts-resource-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();

// ── RAG: Cached pipeline for test/encode endpoints ────────

const _cachedPipes = new Map(); // modelKey → pipeline
const _pipeLoading = new Map(); // modelKey → 加载中的 promise（单飞锁）
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
  // 单飞锁：并发未命中（多设备同时首次查询/客户端重试）共享同一次模型加载。
  // 无锁时每个请求各自实例化完整 ONNX pipeline（26-120MB/个），一波冷启动
  // 就能把内存推到 GB 级甚至 OOM 崩进程。
  const loading = _pipeLoading.get(modelKey);
  if (loading) return loading;
  const p = (async () => {
    const { pipeline, env } = await import("@xenova/transformers");
    env.allowRemoteModels = true;
    env.cacheDir = dataPath("models-cache");
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
  })();
  _pipeLoading.set(modelKey, p);
  try {
    return await p;
  } finally {
    _pipeLoading.delete(modelKey);
  }
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
    // 同 /build：白名单外引擎不能静默换成默认模型编码，否则查询向量与库内
    // 向量来自两个模型空间，相似度结果看似正常实则全错（round 2 R-29）
    const requestedEngine = engine || "Xenova/bge-small-zh-v1.5";
    if (!isAllowedEngine(requestedEngine)) {
      return res.status(400).json({ error: "不支持的嵌入引擎", engine: requestedEngine, allowed: allowedEngineList() });
    }
    const pipe = await getEncodePipeline(requestedEngine);
    const result = await pipe(texts, { pooling: "mean", normalize: true });
    const vectors = await result.tolist();
    res.json({ vectors, engine: requestedEngine, modelKey: resolveModelKey(requestedEngine) });
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
  // 服务端推理可用性（不触发下载，仅探测）；探测失败按"不支持"上报
  const serverInference = await checkServerInferenceReady()
    .catch((e) => ({ supported: false, ready: false, reason: e.message }));
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
    const { sid, speed } = req.body || {};
    const rawText = (req.body && typeof req.body.text === "string") ? req.body.text : "";
    const text = cleanTtsText(rawText);
    if (!text || text.length === 0) {
      return res.status(400).json({ error: "text required" });
    }
    if (text.length > 2000) return res.status(400).json({ error: "单次最多 2000 字" });
    // 队列上限：防止大量前端同时朗读导致排队无限堆积
    if (pyWorker.isQueueFull()) {
      return res.status(503).json({ error: "服务器推理繁忙，请稍后再试" });
    }
    const s = Math.max(0.4, Math.min(3.5, Number(speed) || 1.0));
    const voiceId = Number.isInteger(Number(sid)) ? Math.max(0, Math.min(102, Number(sid))) : 45;

    // 客户端断开（关页面/停止朗读/网络断）就把这条请求出队：否则 Python 仍会
    // 跑满最长 180s，把音频交给一个已经不存在的响应，还占着队列位。
    // ⚠️ 监听 res 而不是 req——Node 在"请求体读完"时就会 emit req 的 close，
    // 用 req 会把每一个正常请求刚进来就判定为断开、立刻出队。
    const pyRef = {};
    const onClientGone = () => {
      if (res.writableEnded) return;
      pyWorker.abortQueued(pyRef.id);
    };
    res.on("close", onClientGone);
    try {
      const result = await pyWorker.generate(text, voiceId, s, req.username, pyRef);
      const wavBuf = Buffer.from(result.wavBase64, "base64");
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Content-Length", wavBuf.length);
      res.setHeader("Cache-Control", "no-cache");
      res.send(wavBuf);
    } finally {
      res.removeListener("close", onClientGone);
    }
  } catch (e) {
    console.error("[tts-py] synthesize error:", e.message);
    if (!res.writableEnded) res.status(500).json({ error: "服务端推理失败: " + e.message });
  }
});

// POST /api/rag/tts/debug — 回显服务端实际收到的文本（验收/定位编码问题）
// 若客户端发的是正常中文，但此处 repr 显示 \uFFFD 或错位汉字（如 GBK 解码
// 的 UTF-8 字节），即可确认编码链路损坏（乱读根因）；否则问题在前端发送方。
router.post("/tts/debug", requireAuth, (req, res) => {
  try {
    const rawText = (req.body && typeof req.body.text === "string") ? req.body.text : "";
    const cleaned = cleanTtsText(rawText);
    // 逐字符码点序列（\uXXXX），肉眼可辨乱码来源
    const codePoints = Array.from(rawText).map((ch) => {
      const cp = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
      return `U+${cp}`;
    });
    res.json({
      ok: true,
      received: rawText,
      receivedRepr: JSON.stringify(rawText),
      codePoints,
      afterClean: cleaned,
      afterCleanRepr: JSON.stringify(cleaned),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/rag/tts/cancel — 取消当前用户所有排队中的服务端推理请求
// 前端停止朗读时调用，立即释放队列位置（其他用户无需等待作废请求生成完）。
router.post("/tts/cancel", requireAuth, (req, res) => {
  try {
    const cancelled = pyWorker.cancelForUser(req.username);
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
    // 白名单外的引擎过去会被 resolveModelKey 静默换成默认模型建库，而客户端仍按
    // 自己那个引擎编码查询——两个模型空间的向量混算，只要维度相同就"看起来正常"
    // 而相似度彻底失真（round 2 R-29）。现在直接拒绝，让客户端走本地编码降级。
    if (!isAllowedEngine(engine)) {
      return res.status(400).json({ error: "不支持的嵌入引擎", engine, allowed: allowedEngineList() });
    }
    const result = buildIndex(req.params.novelId, engine);
    res.json({ ...result, engine, modelKey: resolveModelKey(engine) });
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

const MODEL_CACHE_DIR = dataPath("models-cache");

/**
 * 获取按优先级排列的镜像源列表（磁盘缓存命中后按此顺序回源下载）：
 * 1. 管理界面配置的 mirrorHost（rag-config.json，用户显式选择，最高优先）
 * 2. 环境变量 HF_MIRROR
 * 3. 默认国内镜像 hf-mirror.com
 * 4. HuggingFace 官方（最后兜底）
 */
function getMirrorHosts() {
  return resolveMirrorHosts({
    configPath: dataPath("rag-config.json"),
    envHost: process.env.HF_MIRROR,
  });
}

// GET /api/rag/model-proxy/{*path} — proxy model file from mirror
// 白名单与缓存路径判据在 server/lib/model-paths.mjs（有用例钉着，见那边注释）

router.get("/model-proxy/{*path}", rateLimit(10), async (req, res) => {
  console.log(`[model-proxy] 请求: ${req.originalUrl}`);
  try {
    // Express 5 + path-to-regexp v8: {*path} returns an array of segments
    const subPath = Array.isArray(req.params.path) ? req.params.path.join("/") : req.params.path;
    if (!isAllowedModelPath(subPath)) {
      return res.status(400).json({ error: "invalid model path" });
    }

    // Check local cache first (use normalized path for Transformers.js compatibility)
    // 防路径穿越：解析后仍在缓存目录内才继续，越界一律 400
    const cachePath = resolveModelCachePath({ modelDir: MODEL_CACHE_DIR, subPath });
    if (cachePath === null) {
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
      // 不设 Access-Control-Allow-Origin：交给 index.js 的 cors() 白名单统一决定，
      // 手写 "*" 会覆盖白名单且与 credentials:true 互斥
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
        // Access-Control-Allow-Origin 由 index.js 的 cors() 白名单负责，此处不覆盖
        res.setHeader("Cache-Control", "no-cache");

        const buffer = Buffer.from(await response.arrayBuffer());
        res.send(buffer);

        // Cache to disk with normalized path (async, don't block response)
        // 先写临时文件再 rename 原子替换：直接写目标文件时，并发请求会在写入
        // 中途命中 existsSync 读到半截文件；写盘中断留下的截断文件还会永久
        // 毒化该模型的磁盘缓存（无校验、无自愈）。
        // tmp 名带随机后缀：并发下载同一文件时固定 tmp 名仍会交叉写
        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        fs.writeFile(tmpPath, buffer, (err) => {
          if (err) {
            console.warn(`[model-proxy] cache write failed: ${err.message}`);
            try { fs.unlinkSync(tmpPath); } catch {}
            return;
          }
          try {
            fs.renameSync(tmpPath, cachePath);
            console.log(`[model-proxy] cached: ${toCachePath(subPath)} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
          } catch (e) {
            console.warn(`[model-proxy] cache rename failed: ${e.message}`);
            try { fs.unlinkSync(tmpPath); } catch {}
          }
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

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TTS_CACHE_DIR = dataPath("tts-cache");
const TTS_WASM_CACHE = path.join(TTS_CACHE_DIR, "wasm");
const TTS_MODEL_CACHE = path.join(TTS_CACHE_DIR, "model");
const TTS_TEMP_DIR = dataPath("tts-temp");

// 这个目录只是下载/解压的中转区，进程被强杀后里面全是半成品（模型包一次可达数百 MB，
// 实测本机就留着一个上次的 -extract 目录）。启动时清空一次，避免只增不减地吃磁盘。
try {
  if (fs.existsSync(TTS_TEMP_DIR)) {
    let removed = 0;
    for (const name of fs.readdirSync(TTS_TEMP_DIR)) {
      try { fs.rmSync(path.join(TTS_TEMP_DIR, name), { recursive: true, force: true }); removed++; } catch { /* 被占用，下次启动再清 */ }
    }
    if (removed) console.log(`[tts-proxy] 已清理中转目录 tts-temp（${removed} 项残留）`);
  }
} catch (e) {
  console.warn("[tts-proxy] 清理 tts-temp 失败:", e.message);
}

// ── 下载源配置 ──
// 方案4: 分离式标准部署 — 通用 WASM 运行时 + 独立模型文件
const TTS_RELEASE_TAG = "Kokoro_fp32_v1.0";
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

// ── 压缩包校验（判据在 lib/tts-archive-checks.mjs，那边有用例）──

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
 * 校验解压后的文件完整性（判定在 lib，IO 留在这里）
 * @param {string} dir - 目标目录
 * @param {Object} requiredFiles - { 文件名: 最小字节数 }
 */
function validateExtractedFiles(dir, requiredFiles) {
  return checkExtractedFiles(requiredFiles, (filename) => {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) return null;
    return fs.statSync(filePath).size;
  });
}

// ── 下载和解压 ────────────────────────────────────────────

/**
 * 从 URL 下载文件（流式写入磁盘，带超时、大小校验、进度回调）
 * 实现连同"响应头超时 + 响应体空闲看门狗 + 失败删残缺文件"这套判据都在
 * lib/tts-download.mjs——那里用假上游和真 socket 两头都锁过。
 */
const downloadFile = createDownloader();

/**
 * 从 Gitee 下载 7z 分卷 → 拼接 → 校验 → 解压 → 校验解压结果
 * @param {Function} onProgress - 进度回调 (step, detail)
 */
async function downloadFromGitee(partNames, archiveName, targetDir, requiredFiles, onProgress, { signal } = {}) {
  // 先验顺序再花钱：拼接是按数组顺序流式写入的，顺序错要等几百 MB 下完、7z 解压时才炸
  assertPartsInOrder(partNames);
  if (!fs.existsSync(TTS_TEMP_DIR)) fs.mkdirSync(TTS_TEMP_DIR, { recursive: true });
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const partPaths = [];
  const archivePath = path.join(TTS_TEMP_DIR, archiveName + ".7z");
  const extractedDir = path.join(TTS_TEMP_DIR, archiveName);
  // 解压根目录必须在 try 之外声明：finally 要清理它，而 try 块内的 const 在
  // finally 作用域不可见——引用它会抛 ReferenceError 并顶替 try 的正常返回
  const extractRoot = path.join(TTS_TEMP_DIR, archiveName + "-extract");

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

    // 3. 校验 7z 文件头（只读开头 6 字节：整包 readFileSync 会把 322MB 全塞进内存）
    onProgress?.("校验压缩包", "检查文件格式");
    if (!isValid7z(readHeadSync(archivePath, 6))) {
      throw new Error("拼接后的文件不是有效的 7z 格式（文件头校验失败）");
    }

    // 4. 解压到独立子目录（避免归档根目录模式与 TTS_TEMP_DIR 其他残留混淆）
    onProgress?.("解压中", "7z 解压...");
    try { fs.rmSync(extractRoot, { recursive: true }); } catch {}
    fs.mkdirSync(extractRoot, { recursive: true });
    try {
      await execFileAsync("7z", ["x", archivePath, `-o${extractRoot}`, "-y"], { timeout: 120000 });
    } catch (e) {
      if (e.code === "ENOENT") throw new Error("7z 未安装。请安装 7-Zip (Windows) 或 p7zip-full (Linux/macOS) 后重试。", { cause: e });
      throw new Error(`7z 解压失败: ${e.message}`, { cause: e });
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
    if (!isValidBz2(readHeadSync(archivePath, 4))) {
      throw new Error("下载的文件不是有效的 bzip2 格式（文件头校验失败）");
    }

    onProgress?.("解压中", "tar.bz2 解压...");
    try {
      await execFileAsync("tar", ["xjf", archivePath, "-C", TTS_TEMP_DIR], { timeout: 120000 });
    } catch (e) {
      if (e.code === "ENOENT") throw new Error("tar 未安装。请安装 tar (Linux/macOS) 或 7-Zip (Windows) 后重试。", { cause: e });
      throw new Error(`tar 解压失败: ${e.message}`, { cause: e });
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
 * 下载并解压资源（Gitee 优先，GitHub 备选，含完整校验）
 * @param {Function} onProgress - 进度回调 (step, detail)
 */
const MIN_DISK_SPACE_BYTES = 500 * 1024 * 1024; // 500MB

/**
 * 下载前的磁盘余量守卫（判据在 lib，那边有用例）
 */
function assertDiskSpace(dir) {
  return checkDiskSpace({ dir, minBytes: MIN_DISK_SPACE_BYTES, fsImpl: fs });
}

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
  assertDiskSpace(TTS_CACHE_DIR);

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

/**
 * 确保 WASM 文件已缓存。状态机（共享一趟下载 / 失败冷却 / force 不重叠）在
 * lib/tts-resource-gate.mjs——那里有用例，改坏了会有东西红。
 */
const wasmGate = createResourceGate({
  download: (onProgress, options) => downloadAndExtract(
    GITEE_WASM_PARTS, null, WASM_ARCHIVE_NAME, TTS_WASM_CACHE, WASM_REQUIRED_FILES, onProgress, options
  ),
});
export function ensureWasmReady(onProgress, options = {}) {
  return wasmGate.ensure(onProgress, options);
}

/** 确保模型文件已缓存（同上） */
const modelGate = createResourceGate({
  download: (onProgress, options) => downloadAndExtract(
    GITEE_MODEL_PARTS, GITHUB_MODEL_URL, MODEL_ARCHIVE_NAME, TTS_MODEL_CACHE, MODEL_REQUIRED_FILES, onProgress, options
  ),
});
export function ensureModelReady(onProgress, options = {}) {
  return modelGate.ensure(onProgress, options);
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
// 进程与队列的生命周期本身在 lib/tts-py-worker.mjs（那里才测得到子进程行为）。
const TTS_PY_QUEUE_LIMIT = 30;        // 排队上限：超过直接 503，防止多前端堆积拖垮所有人

const pyWorker = createTtsPyWorker({
  workerPy: path.resolve(__dirname, "../tts-worker.py"),
  modelCache: TTS_MODEL_CACHE,
  threads: 8,
  queueLimit: TTS_PY_QUEUE_LIMIT,
  ensureModelReady: () => ensureModelReady(),
});

/** 检查服务端推理是否可用（Python + sherpa_onnx + 模型文件就绪）。
 *  ⚠️ 只检查文件存在性，绝不触发下载（ensureModelReady 会下载 350MB，
 *  status 轮询被设置页每 30s 调用，一旦误触发就违背"模型按需下载"）。 */
export async function checkServerInferenceReady() {
  const pyCmd = await pyWorker.detectPythonCommand();
  if (!pyCmd) return { supported: false, ready: false, reason: "服务器未安装 Python 或 sherpa-onnx（pip install sherpa-onnx）" };
  const modelExists = fs.existsSync(path.join(TTS_MODEL_CACHE, "model.onnx"));
  if (!modelExists) return { supported: true, ready: false, reason: "模型未下载（设置页启用服务端推理时自动下载）" };
  return { supported: true, ready: true, reason: "" };
}

// ── 进程生命周期 ────────────────────────────────────────
// Python 推理进程占 ~925MB 内存，不应无限常驻：
//  - 空闲超时自动关闭：lib 内实现，默认 10 分钟无请求 → 优雅关闭，下次朗读懒启动（约 3s）
//  - 后端退出显式清理：立即 kill，不等当前生成完成 / stdin EOF
//  - 可用环境变量 TTS_PY_IDLE_SECONDS 覆盖（测试/部署调优用）
// 信号处理留在本文件：工厂内注册会随实例数堆积监听器。
// 后端退出（含 SIGINT/SIGTERM → process.exit → exit 事件）时立即终止 worker，
// 避免等待当前生成完成或 stdin EOF 才退出
process.on("exit", () => pyWorker.shutdown("server-exit"));
// 双保险：SIGINT/SIGTERM 时直接终止 worker（不依赖 index.js 的 process.exit 链路，
// 防止退出链路被改动后 Python 推理进程残留占内存/锁模型文件）
process.on("SIGINT", () => pyWorker.shutdown("server-sigint"));
process.on("SIGTERM", () => pyWorker.shutdown("server-sigterm"));
// Windows Ctrl+Break / 终端关闭时同样终止 worker（覆盖用户直接关窗口的退出路径）
process.on("SIGBREAK", () => pyWorker.shutdown("server-sigbreak"));
process.on("SIGHUP", () => pyWorker.shutdown("server-sighup"));

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
  // ACAO 由全局 cors() 白名单设置，这里不再手写 "*"
  res.flushHeaders();

  let clientDisconnected = false;
  const abortController = new AbortController();
  // ⚠️ 必须监听 res 而不是 req：Node 的 IncomingMessage 在"请求被读完"时就会
  // emit close（GET 无体 → 几乎立刻触发），拿它当"客户端断开"会让这条 SSE 在
  // 第一帧之前就自我判定为已断开，前端再也收不到进度事件（实测：同结构的
  // req.on("close") 会让响应永远不结束）。round 2 R-66。
  res.on("close", () => {
    if (res.writableEnded) return; // 正常写完，不是断开
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
