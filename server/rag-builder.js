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

// Build queue: serial processing
const queue = [];
let running = false;

// ── Engine to model key mapping ──

const ENGINE_MODEL_MAP = {
  "bge-small-zh": "Xenova/bge-small-zh-v1.5",
  "gte-small": "Xenova/gte-small",
  "multilingual-e5-small": "Xenova/multilingual-e5-small",
  "all-MiniLM-L6-v2": "Xenova/all-MiniLM-L6-v2",
  "multilingual-MiniLM-L12-v2": "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
};

function resolveModelKey(engine) {
  if (ENGINE_MODEL_MAP[engine]) return ENGINE_MODEL_MAP[engine];
  if (engine && engine.includes("/")) return engine;
  return "Xenova/bge-small-zh-v1.5";
}

// ── Public API ──

const MAX_QUEUE = 10;

/** Add a novel to the build queue */
export function buildIndex(novelId, engine = "bge-small-zh") {
  const key = `${novelId}-${engine}`;

  // Check DB status
  const existing = db.db.prepare("SELECT status, chunk_count, dim FROM rag_indices WHERE novel_id = ? AND engine = ?").get(novelId, engine);
  if (existing && existing.status === "ready") return { status: "ready", chunkCount: existing.chunk_count, dim: existing.dim };

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
export function getStatuses(novelIds, engine = "bge-small-zh") {
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
export function getProgress(novelId, engine = "bge-small-zh") {
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

export function getIndexData(novelId, engine = "bge-small-zh") {
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

  buildProgress.set(key, { status: "building", current: 0, total: chunks.length });
  db.db.prepare("INSERT OR REPLACE INTO rag_indices (novel_id, engine, status, chunks_json, chunk_count) VALUES (?, ?, 'building', ?, ?)")
    .run(novelId, engine, JSON.stringify(chunks), chunks.length);

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
  const totalFloats = vectors.length * dim;
  const buf = new Float32Array(totalFloats);
  for (let i = 0; i < vectors.length; i++) buf.set(vectors[i], i * dim);

  db.db.prepare("UPDATE rag_indices SET status = 'ready', vectors_blob = ?, dim = ?, chunk_count = ?, build_time = ? WHERE novel_id = ? AND engine = ?")
    .run(Buffer.from(buf.buffer), dim, chunks.length, Date.now() - t0, novelId, engine);

  buildProgress.set(key, { status: "ready", current: chunks.length, total: chunks.length, chunkCount: chunks.length });
  console.log(`[rag] done: ${key} ${chunks.length} chunks ${dim}d ${Date.now() - t0}ms`);

  // Prune from memory after a short delay so frontend can poll the "ready" status
  setTimeout(() => {
    buildProgress.delete(key);
    console.log(`[rag] pruned from memory: ${key}`);
  }, 10_000);
}
