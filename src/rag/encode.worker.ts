/**
 * RAG query 编码 Worker。
 *
 * 把最重的「transformers.js 模型加载 + 推理」移到独立线程，
 * 主线程只负责通过代理接收编码结果，避免长文章离线检索时阻塞 UI。
 *
 * 消息协议：
 *   → { type: "encode", id, text, engine, serverUrl }
 *   ← { type: "encode-result", id, ok: true, data: Float32Array }
 *   ← { type: "encode-result", id, ok: false, error: string }
 * serverUrl 由主线程从 localStorage 读取后传入（Worker 无法访问 localStorage）。
 */

import { encodeQueryCore } from "./encode-core";

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; id?: number; text?: string; engine?: string; serverUrl?: string };
  if (msg?.type !== "main") return;
  const id = msg.id;
  const text = msg.text ?? "";
  const engine = msg.engine ?? "";
  const serverUrl = msg.serverUrl ?? "";
  const post = (payload: Record<string, unknown>) => {
    try { (self as unknown as Worker).postMessage(payload); } catch { /* 忽略 */ }
  };
  encodeQueryCore(text, engine, serverUrl)
    .then((vec) => {
      if (!vec) { post({ type: "encode-result", id, ok: false, error: "encoding returned null" }); return; }
      // 转 ArrayBuffer 可 transfer，避免结构拷贝
      const tvec = vec as Float32Array & { buffer: ArrayBuffer };
      post({ type: "encode-result", id, ok: true, data: new Float32Array(tvec.buffer.slice(0)), dim: vec.length });
    })
    .catch((err: unknown) => {
      post({ type: "encode-result", id, ok: false, error: err instanceof Error ? err.message : String(err) });
    });
};