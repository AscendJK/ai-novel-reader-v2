/**
 * 主线程侧 Worker 代理。
 *
 * 职责：
 * - 懒创建编码 Worker（首次真正需要离线编码时才 spawn）。
 * - 维护 id → pending 回调映射。
 * - 支持 AbortSignal 取消（取消时丢弃对应回调，不影响 Worker）。
 * - Worker/浏览器不支持时自动回退：调用方应 catch 后走主线程 encodeQuery。
 */

import { getServerUrl } from "@/lib/api-client";
import { ragLog } from "@/lib/logger";
import { encodeQuery } from "./client-encoder";

type EncodeResult =
  | { ok: true; data: Float32Array }
  | { ok: false; error: string };

interface Pending {
  resolve: (r: EncodeResult) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
}

let worker: Worker | null = null;
let workerFailed = false; // 一旦 Worker 创建/通信失败，本次会话不再尝试
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./encode.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data as { type?: string; id?: number; ok?: boolean; data?: unknown; error?: string };
    if (msg?.type !== "encode-result" || msg.id == null) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok && msg.data) {
      p.resolve({ ok: true, data: new Float32Array(msg.data as ArrayBuffer) });
    } else {
      p.resolve({ ok: false, error: msg.error || "encode failed" });
    }
  };
  worker.onerror = (ev) => {
    ragLog(`[encode-worker] 错误: ${ev.message}`);
    workerFailed = true;
    for (const [, p] of pending) p.reject(new Error("Worker error"));
    pending.clear();
  };
  return worker;
}

/**
 * 优先用 Worker 主线程编码；Worker 不可用或失败时回退主线程 encodeQuery。
 * 如果调用方需要确定是 worker 还是 fallback，可依赖返回值：null = 彻底失败。
 */
export async function encodeQueryWithWorker(text: string, engine: string, opts?: { signal?: AbortSignal }): Promise<Float32Array | null> {
  if (opts?.signal?.aborted) return null;
  if (!workerFailed) {
    try {
      const w = ensureWorker();
      const result = await new Promise<EncodeResult>((resolve, reject) => {
        const id = nextId++;
        const signal = opts?.signal;
        // 监听 AbortSignal：取消时立即拒绝 promise，避免悬空
        const onAbort = () => {
          pending.delete(id);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, { resolve, reject, signal });
        const serverUrl = getServerUrl();
        try {
          w.postMessage({ type: "main", id, text, engine, serverUrl });
        } catch (err) {
          signal?.removeEventListener("abort", onAbort);
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      if (result.ok) return result.data;
      throw new Error(result.error || "worker encode failed");
    } catch (err) {
      // Worker 不可用 → 永久降级，之后直接走主线程
      if (!workerFailed) {
        workerFailed = true;
      }
      try { worker?.terminate(); } catch { /* ignore */ }
      worker = null;
      ragLog(`Worker 编码失败, 降级主线程: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (opts?.signal?.aborted) return null;
  return encodeQuery(text, engine);
}