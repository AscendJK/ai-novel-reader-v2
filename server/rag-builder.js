import * as db from "./database.js";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BATCH_SIZE = 8;
const CHUNK_SIZE = 500;
const OVERLAP = 100;

const buildProgress = new Map(); // key: "novelId-engine" → { status, current, total }
const MIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes minimum
const MAX_TIMEOUT_MS = 120 * 60 * 1000; // 120 minutes maximum
// Configure via env or admin API: RAG_TIMEOUT_PER_CHUNK_MS (default 400ms, i.e. ~0.4s per chunk)
let perChunkMs = Math.max(50, parseInt(process.env.RAG_TIMEOUT_PER_CHUNK_MS || "400", 10));

export function getTimeoutConfig() {
  return { perChunkMs, minMs: MIN_TIMEOUT_MS, maxMs: MAX_TIMEOUT_MS };
}

export function setPerChunkTimeout(ms) {
  perChunkMs = Math.max(50, Math.min(10000, parseInt(ms, 10) || 400));
  return perChunkMs;
}

// Periodically prune completed/errored entries from buildProgress
setInterval(() => {
  for (const [key, val] of buildProgress) {
    if (val.status === "ready" || val.status === "error") {
      buildProgress.delete(key);
    }
  }
}, 60_000);

// 启动恢复：构建中途进程重启/被杀会把 rag_indices 留在 'building' 状态——书架
// 永久显示"构建中"且重建按钮被禁用。启动时重置为 error，用户可手动重建
// （buildIndex 对非 ready 状态允许重新入队）。
try {
  const r = db.db.prepare("UPDATE rag_indices SET status = 'error', error_msg = '服务器重启时构建被中断，请重新构建' WHERE status = 'building'").run();
  if (r.changes > 0) console.warn(`[rag-builder] 启动恢复：${r.changes} 个中断的构建已标记为 error`);
} catch { /* 表尚未创建（全新库）时忽略 */ }

// Build queue: serial processing
const queue = [];
let running = false;

import { resolveModelKey } from "./lib/engine-config.js";

// ── Public API ──

const MAX_QUEUE = 10;

/**
 * 章节指纹：数量 + 正文总字数 + 标题总字数。
 * 用一条 SQL 在 SQLite 内部算，不把正文搬进 Node 内存。
 */
export function chapterFingerprint(novelId) {
  const r = db.db.prepare(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(LENGTH(content)), 0) AS chars,
           COALESCE(SUM(LENGTH(title)), 0) AS tchars
    FROM chapters WHERE novel_id = ?
  `).get(novelId);
  return `${r.n}:${r.chars}:${r.tchars}`;
}

/** Add a novel to the build queue */
export function buildIndex(novelId, engine = "Xenova/bge-small-zh-v1.5") {
  const key = `${novelId}-${engine}`;

  // Check DB status
  const existing = db.db.prepare("SELECT status, chunk_count, dim, source_fingerprint FROM rag_indices WHERE novel_id = ? AND engine = ?").get(novelId, engine);
  if (existing && existing.status === "ready") {
    const fingerprint = chapterFingerprint(novelId);
    if (existing.source_fingerprint === fingerprint) {
      return { status: "ready", chunkCount: existing.chunk_count, dim: existing.dim };
    }
    // 正文已经变了（重传/改章）：旧向量和现在的文字不再对应，留着会把错误的
    // 检索结果一路发给用户，而且永远不会自愈（round 2 R-09）
    console.log(`[rag] 章节指纹变化，索引作废重建: ${key} ${existing.source_fingerprint ?? "NULL"} → ${fingerprint}`);
    db.db.prepare("DELETE FROM rag_indices WHERE novel_id = ? AND engine = ?").run(novelId, engine);
  }

  // Don't allow duplicate
  if (buildProgress.has(key)) return { ...buildProgress.get(key), queuePosition: queue.length + (running ? 1 : 0) };
  if (queue.some(t => t.key === key)) {
    const pos = queue.findIndex(t => t.key === key) + 1 + (running ? 1 : 0);
    return { status: "queued", queuePosition: pos };
  }

  // Check queue limit (include currently running task)
  const total = queue.length + (running ? 1 : 0);
  if (total >= MAX_QUEUE) return { status: "busy", message: "服务器繁忙，请稍后再试" };

  const pos = total + 1;
  buildProgress.set(key, { status: "queued", current: 0, total: 0, queuePosition: pos });
  queue.push({ novelId, engine, key });
  console.log(`[rag] queued: ${key} (position ${pos}, queue: ${queue.length})`);

  processQueue();

  return { status: "queued", queuePosition: pos };
}

export function getQueueLength() {
  return queue.length + (running ? 1 : 0);
}

function processQueue() {
  if (running || queue.length === 0) return;
  running = true;
  const task = queue.shift();

  buildProgress.set(task.key, { status: "building", current: 0, total: 0 });
  console.log(`[rag] starting: ${task.key} (queue: ${queue.length})`);

  _doBuild(task.novelId, task.engine, task.key)
    .catch(e => {
      const errMsg = e?.stack || e?.message || String(e);
      console.error(`[rag] build failed for ${task.key}:`, errMsg);
      try {
        db.db.prepare("UPDATE rag_indices SET status = 'error', error_msg = ? WHERE novel_id = ? AND engine = ?")
          .run(String(e?.message || e), task.novelId, task.engine);
      } catch (dbErr) { console.error("[rag] DB error:", dbErr); }
      buildProgress.set(task.key, { status: "error", error: String(e?.message || e) });
    })
    .finally(() => {
      running = false;
      processQueue(); // next
    });
}

/** Get all engines' build statuses for multiple novels */
export function getAllStatuses(novelIds) {
  const result = {};
  for (const nid of novelIds) {
    const rows = db.db.prepare("SELECT engine, status, chunk_count, build_time, error_msg, dim FROM rag_indices WHERE novel_id = ?").all(nid);
    const engines = {};
    for (const r of rows) {
      engines[r.engine] = { status: r.status, chunkCount: r.chunk_count, buildTime: r.build_time, error: r.error_msg, dim: r.dim };
    }
    // In-progress builds from memory always override DB status
    for (const [key, mem] of buildProgress) {
      if (key.startsWith(nid + "-")) {
        const eng = key.slice(nid.length + 1);
        const pos = queue.findIndex(t => t.key === key);
        engines[eng] = { ...mem, queuePosition: pos >= 0 ? pos + 1 + (running ? 1 : 0) : 0 };
      }
    }
    result[nid] = engines;
  }
  return result;
}

/** Get build statuses for multiple novels */
export function getStatuses(novelIds, engine = "Xenova/bge-small-zh-v1.5") {
  const result = {};
  for (const nid of novelIds) {
    const key = `${nid}-${engine}`;
    const mem = buildProgress.get(key);
    if (mem) {
      const pos = queue.findIndex(t => t.key === key);
      result[nid] = { ...mem, queuePosition: pos >= 0 ? pos + 1 + (running ? 1 : 0) : 0 };
      continue;
    }
    const dbRow = db.db.prepare("SELECT status, chunk_count, build_time, error_msg, dim FROM rag_indices WHERE novel_id = ? AND engine = ?").get(nid, engine);
    result[nid] = dbRow ? { status: dbRow.status, chunkCount: dbRow.chunk_count, buildTime: dbRow.build_time, error: dbRow.error_msg, dim: dbRow.dim } : { status: "none" };
  }
  return result;
}

/** Get single build progress */
export function getProgress(novelId, engine = "Xenova/bge-small-zh-v1.5") {
  const key = `${novelId}-${engine}`;
  const mem = buildProgress.get(key);
  if (mem) {
    // 动态计算 queuePosition（只对 queued 状态有效）
    if (mem.status === "queued") {
      const pos = queue.findIndex(t => t.key === key);
      return { ...mem, queuePosition: pos >= 0 ? pos + 1 + (running ? 1 : 0) : 0 };
    }
    return mem;
  }
  const dbRow = db.db.prepare("SELECT status, chunk_count, build_time, error_msg, dim FROM rag_indices WHERE novel_id = ? AND engine = ?").get(novelId, engine);
  return dbRow ? { status: dbRow.status, chunkCount: dbRow.chunk_count, buildTime: dbRow.build_time, error: dbRow.error_msg, dim: dbRow.dim } : { status: "none" };
}

export function getIndexData(novelId, engine = "Xenova/bge-small-zh-v1.5") {
  return db.db.prepare(
    "SELECT chunks_json, vectors_blob, dim, chunk_count FROM rag_indices WHERE novel_id = ? AND engine = ? AND status = 'ready'"
  ).get(novelId, engine) || null;
}

// ── Internal ──

async function _doBuild(novelId, engine, key) {
  console.log(`[rag] _doBuild: ${key} (modelKey: ${resolveModelKey(engine)})`);
  const chapters = db.db.prepare("SELECT title, content FROM chapters WHERE novel_id = ? ORDER BY index_num").all(novelId);
  console.log(`[rag] chapters: ${chapters.length}`);
  if (!chapters.length) throw new Error("No chapters found");
  // 本次索引对应的正文指纹（与 chunk 同一时刻取样）。构建期间正文又被改写的话，
  // 存下的指纹与结果不符 → 下次构建请求会判定为已变化并重建，方向是安全的。
  const fingerprint = chapterFingerprint(novelId);

  // Chunk（包含 chapterIndex 用于范围过滤）
  const chunks = [];
  for (let ci = 0; ci < chapters.length; ci++) {
    const ch = chapters[ci];
    let start = 0;
    while (start < ch.content.length) {
      const end = Math.min(start + CHUNK_SIZE, ch.content.length);
      const text = ch.content.slice(start, end).trim();
      if (text.replace(/\s/g, "").length >= 10) {
        chunks.push({
          content: `[${ch.title}] ${text}`,
          chapterIndex: ci,  // 0-based 章节索引
        });
      }
      start += CHUNK_SIZE - OVERLAP;
    }
  }

  // 空章节/损坏内容检查：所有 chunk 都太短时直接报错，避免构建无用索引
  if (chunks.length === 0) {
    const msg = "小说内容为空或所有章节内容过短（不足 10 字符），无法构建索引";
    buildProgress.set(key, { status: "error", error: msg });
    db.db.prepare("UPDATE rag_indices SET status = 'error', error_msg = ? WHERE novel_id = ? AND engine = ?")
      .run(msg, novelId, engine);
    throw new Error(msg);
  }

  buildProgress.set(key, { status: "building", current: 0, total: chunks.length });
  db.db.prepare("INSERT OR REPLACE INTO rag_indices (novel_id, engine, status, chunks_json, chunk_count, source_fingerprint) VALUES (?, ?, 'building', ?, ?, ?)")
    .run(novelId, engine, JSON.stringify(chunks), chunks.length, fingerprint);

  // Encode in Worker Thread with dynamic timeout (~0.3s per chunk, min 10min, max 60min)
  const modelKey = resolveModelKey(engine);
  const t0 = Date.now();
  const workerTimeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, chunks.length * perChunkMs));
  console.log(`[rag] building ${key}: ${chunks.length} chunks, timeout ${Math.round(workerTimeoutMs / 60000)}min`);
  const vectors = await new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "rag-worker.mjs");
    const worker = new Worker(workerPath, {
      workerData: { chunks, batchSize: BATCH_SIZE, modelKey },
    });

    const timeout = setTimeout(() => {
      worker.terminate();
      const mins = Math.round(workerTimeoutMs / 60000);
      reject(new Error(`编码超时（超过 ${mins} 分钟）`));
    }, workerTimeoutMs);

    worker.on("message", (msg) => {
      if (msg.type === "downloading") {
        buildProgress.set(key, { status: "downloading", current: 0, total: 0, message: `下载模型: ${msg.model}` });
      } else if (msg.type === "progress") {
        buildProgress.set(key, { status: "encoding", current: msg.current, total: msg.total });
      } else if (msg.type === "done") {
        clearTimeout(timeout);
        resolve(msg.vectors.map((row) => new Float32Array(row)));
      } else if (msg.type === "error") {
        clearTimeout(timeout);
        reject(new Error(msg.error));
      }
    });
    worker.on("error", (e) => { clearTimeout(timeout); reject(e); });
    worker.on("exit", (code) => {
      if (code !== 0) { clearTimeout(timeout); reject(new Error(`Worker 异常退出 (code ${code})`)); }
    });
  });

  const dim = vectors[0]?.length || 0;
  // 落库前自校验：曾经写出过 dim=0 / 向量数与 chunk 数不符的 ready 行——客户端
  // 每次都抛错却被告知"无法连接服务器"，而 ready 状态让服务端不再重建（R-28）
  if (!dim || vectors.length !== chunks.length) {
    const msg = `索引结果不完整（向量 ${vectors.length} 条 / 应为 ${chunks.length} 条，维度 ${dim}），请重新构建`;
    console.error(`[rag] ${key}: ${msg}`);
    db.db.prepare("UPDATE rag_indices SET status = 'error', error_msg = ? WHERE novel_id = ? AND engine = ?")
      .run(msg, novelId, engine);
    buildProgress.set(key, { status: "error", error: msg });
    throw new Error(msg);
  }
  const totalFloats = vectors.length * dim;
  const buf = new Float32Array(totalFloats);
  for (let i = 0; i < vectors.length; i++) buf.set(vectors[i], i * dim);

  db.db.prepare("UPDATE rag_indices SET status = 'ready', vectors_blob = ?, dim = ?, chunk_count = ?, build_time = ?, source_fingerprint = ?, error_msg = NULL WHERE novel_id = ? AND engine = ?")
    .run(Buffer.from(buf.buffer), dim, chunks.length, Date.now() - t0, fingerprint, novelId, engine);

  buildProgress.set(key, { status: "ready", current: chunks.length, total: chunks.length, chunkCount: chunks.length });
  console.log(`[rag] done: ${key} ${chunks.length} chunks ${dim}d ${Date.now() - t0}ms`);

  // Prune from memory after a short delay so frontend can poll the "ready" status
  setTimeout(() => {
    buildProgress.delete(key);
    console.log(`[rag] pruned from memory: ${key}`);
  }, 10_000);
}
