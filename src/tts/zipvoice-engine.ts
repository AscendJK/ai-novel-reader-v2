/**
 * ZipVoice TTS 引擎
 * 基于 sherpa-onnx WASM，浏览器端离线推理
 * 推理在 Worker 线程，不阻塞 UI
 */

import { isCacheReady, getCachedFiles, downloadAndCache } from "./tts-cache";
import { apiFetch } from "@/lib/api-client";

// ── 模型配置 ───────────────────────────────────────────────
// 中文语音列表（ZipVoice 音色）
export const ZH_VOICES: Record<string, { name: string; gender: string }> = {
  "0": { name: "音色 0（女声）", gender: "female" },
  "1": { name: "音色 1（女声）", gender: "female" },
  "2": { name: "音色 2（女声）", gender: "female" },
  "3": { name: "音色 3（女声）", gender: "female" },
  "4": { name: "音色 4（女声）", gender: "female" },
  "5": { name: "音色 5（男声）", gender: "male" },
  "6": { name: "音色 6（男声）", gender: "male" },
  "7": { name: "音色 7（男声）", gender: "male" },
  "8": { name: "音色 8（男声）", gender: "male" },
  "9": { name: "音色 9（男声）", gender: "male" },
};

const DEFAULT_VOICE = "0";
const SAMPLE_RATE = 24000;
const GENERATE_TIMEOUT_MS = 120000;

// ── 状态 ───────────────────────────────────────────────────

let ttsWorker: Worker | null = null;
let modelLoaded = false;
let disposed = false;
let loadingPromise: Promise<void> | null = null;
let nextRequestId = 0;
const pendingRequests = new Map<number, { resolve: (audio: Float32Array) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

export interface ZipVoiceGenerateOptions {
  voice?: string;
  speed?: number;
  onProgress?: (progress: number) => void;
}

export interface ZipVoiceAudioResult {
  audio: Float32Array;
  sampleRate: number;
}

export function isModelLoaded(): boolean {
  return modelLoaded && !disposed;
}

// ── Worker 生命周期 ────────────────────────────────────────

function getWorker(): Worker {
  if (!ttsWorker) {
    const base = import.meta.env.BASE_URL || "/";
    ttsWorker = new Worker(new URL(base + "sherpa-tts/sherpa-onnx-tts.worker.js", window.location.origin));
    ttsWorker.onmessage = handleWorkerMessage;
    ttsWorker.onerror = (e) => {
      const msg = e.message || e.error?.message || `Worker 加载失败 (${e.filename || "?"}:${e.lineno || "?"})`;
      console.error("[TTS Worker] error:", msg, e);
      modelLoaded = false;
      for (const [, p] of pendingRequests) {
        clearTimeout(p.timer);
        p.reject(new Error(msg));
      }
      pendingRequests.clear();
    };
  }
  return ttsWorker;
}

function handleWorkerMessage(e: MessageEvent): void {
  const msg = e.data;

  if (msg.type === "sherpa-onnx-tts-ready") {
    modelLoaded = true;
    disposed = false;
    console.log("[TTS] ZipVoice ready, modelType:", msg.modelType, "numSpeakers:", msg.numSpeakers);
  } else if (msg.type === "sherpa-onnx-tts-result") {
    // C4 fix: 用 requestId 精确匹配，而非取第一个
    const id = msg.id;
    if (id !== undefined && pendingRequests.has(id)) {
      const pending = pendingRequests.get(id)!;
      pendingRequests.delete(id);
      clearTimeout(pending.timer);
      const samples = msg.samples instanceof Float32Array
        ? msg.samples
        : new Float32Array(msg.samples);
      pending.resolve(samples);
    } else {
      // 降级：旧版 Worker 可能不回传 id，取第一个
      const firstKey = pendingRequests.keys().next().value;
      if (firstKey !== undefined) {
        const pending = pendingRequests.get(firstKey)!;
        pendingRequests.delete(firstKey);
        clearTimeout(pending.timer);
        const samples = msg.samples instanceof Float32Array
          ? msg.samples
          : new Float32Array(msg.samples);
        pending.resolve(samples);
      }
    }
  } else if (msg.type === "sherpa-onnx-tts-generation-progress") {
    // progress callback
  } else if (msg.type === "error") {
    console.error("[TTS Worker] error:", msg.message);
    // C5 fix: 初始化失败时重置 modelLoaded
    if (msg.message?.includes("初始化")) {
      modelLoaded = false;
    }
    const id = msg.id;
    if (id !== undefined && pendingRequests.has(id)) {
      const pending = pendingRequests.get(id)!;
      pendingRequests.delete(id);
      clearTimeout(pending.timer);
      pending?.reject(new Error(msg.message));
    } else {
      const firstKey = pendingRequests.keys().next().value;
      if (firstKey !== undefined) {
        const pending = pendingRequests.get(firstKey)!;
        pendingRequests.delete(firstKey);
        clearTimeout(pending.timer);
        pending?.reject(new Error(msg.message));
      }
    }
  }
}

// ── 资源准备（下载 + 解压）────────────────────────────────

/**
 * 通过 fetch + SSE 流式获取服务器准备进度
 * 使用 apiFetch 替代 EventSource，以支持 Authorization header
 */
export async function prepareTTS(onStep: (step: string, detail: string) => void): Promise<void> {
  const res = await apiFetch("/api/rag/tts/prepare");
  if (!res.ok) {
    throw new Error(`服务器返回 ${res.status}: ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("响应 body 为空");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    // 按 SSE 格式解析：每条消息以 \n\n 分隔
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // 最后一个可能不完整，留到下次

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        switch (data.type) {
          case "step":
            onStep(data.step, data.detail);
            break;
          case "done":
            return; // 完成
          case "error":
            throw new Error(data.message);
        }
      } catch (e) {
        if (e instanceof Error && e.message !== "服务器连接失败") throw e;
      }
    }
  }
}

/**
 * 检查 TTS 资源是否就绪
 */
export async function checkTTSCache(): Promise<{ wasmReady: boolean; modelReady: boolean }> {
  const res = await fetch("/api/rag/tts/status");
  return res.json();
}

// ── 模型加载 ───────────────────────────────────────────────

export async function loadModel(
  options?: { onProgress?: (progress: number) => void }
): Promise<void> {
  if (modelLoaded && !disposed) return;
  if (loadingPromise) return loadingPromise;

  disposed = false;

  loadingPromise = (async () => {
    try {
      // 1. 检查 IndexedDB 缓存
      options?.onProgress?.(5);
      let cached = await isCacheReady();

      if (!cached) {
        // 2. 服务器端准备（下载 + 解压）
        options?.onProgress?.(10);
        await prepareTTS((step, detail) => {
          console.log(`[TTS] ${step}: ${detail}`);
        });
        options?.onProgress?.(40);

        // 3. 从服务器下载文件并缓存到 IndexedDB
        await downloadAndCache((_filename, loaded, total) => {
          if (total > 0) {
            const pct = Math.round((loaded / total) * 100);
            options?.onProgress?.(40 + Math.round(pct * 0.4));
          }
        });
        options?.onProgress?.(80);
      } else {
        options?.onProgress?.(80);
      }

      // 4. 从 IndexedDB 读取文件数据
      const files = await getCachedFiles();
      console.log("[TTS] 从 IndexedDB 加载", files.size, "个文件");

      // 5. 创建 Worker 并发送文件数据
      const w = getWorker();
      options?.onProgress?.(85);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          w.terminate();
          ttsWorker = null;
          modelLoaded = false;
          reject(new Error("模型加载超时（10分钟）"));
        }, 600000);
        const handler = (e: MessageEvent) => {
          if (e.data.type === "sherpa-onnx-tts-ready") {
            clearTimeout(timeout);
            w.removeEventListener("message", handler);
            modelLoaded = true;
            resolve();
          } else if (e.data.type === "error") {
            clearTimeout(timeout);
            w.removeEventListener("message", handler);
            w.terminate();
            ttsWorker = null;
            modelLoaded = false;
            reject(new Error(e.data.message));
          }
        };
        w.addEventListener("message", handler);

        // 构造 files 对象，用 transfer 传输大文件（零拷贝）
        const filesObj: Record<string, ArrayBuffer> = {};
        const transferables: ArrayBuffer[] = [];
        for (const [key, value] of files) {
          filesObj[key] = value;
          transferables.push(value);
        }
        // 传递页面 origin 和模型基础路径给 Worker
        w.postMessage({
          type: "init",
          files: filesObj,
          pageOrigin: window.location.origin,
          modelBase: "/api/rag/tts/model",
        }, transferables);
      });

      options?.onProgress?.(100);
    } catch (err) {
      modelLoaded = false;
      throw err;
    } finally {
      loadingPromise = null;
    }
  })();

  await loadingPromise;
}

// ── 音频生成 ───────────────────────────────────────────────

export async function generateAudio(
  text: string,
  options?: ZipVoiceGenerateOptions,
  onChunk?: (audio: Float32Array) => Promise<void> | void
): Promise<void> {
  if (disposed) throw new Error("TTS 已释放");
  if (!modelLoaded) {
    throw new Error("ZipVoice 模型未加载，请先调用 loadModel()");
  }

  const speed = options?.speed ?? 1.0;
  const voiceId = options?.voice || DEFAULT_VOICE;
  const sid = parseInt(voiceId, 10) || 0;

  const id = nextRequestId++;
  const audio = await new Promise<Float32Array>((resolve, reject) => {
    // H5 fix: 生成超时
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("音频生成超时"));
    }, GENERATE_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timer });
    getWorker().postMessage({ type: "generate", id, text, sid, speed });
  });

  await onChunk?.(audio);
}

/**
 * 生成完整音频（供预览使用）
 */
export async function generateAudioFull(
  text: string,
  options?: ZipVoiceGenerateOptions
): Promise<ZipVoiceAudioResult> {
  if (disposed) throw new Error("TTS 已释放");
  if (!modelLoaded) {
    throw new Error("ZipVoice 模型未加载，请先调用 loadModel()");
  }

  const speed = options?.speed ?? 1.0;
  const voiceId = options?.voice || DEFAULT_VOICE;
  const sid = parseInt(voiceId, 10) || 0;

  const id = nextRequestId++;
  const audio = await new Promise<Float32Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("音频生成超时"));
    }, GENERATE_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timer });
    getWorker().postMessage({ type: "generate", id, text, sid, speed });
  });

  return { audio, sampleRate: SAMPLE_RATE };
}

// ── 释放 ───────────────────────────────────────────────────

export function dispose(): void {
  disposed = true;
  modelLoaded = false;
  if (ttsWorker) {
    ttsWorker.postMessage({ type: "dispose" });
    ttsWorker.terminate();
    ttsWorker = null;
  }
  // H7 fix: 清理 loadingPromise，避免 stale rejected promise
  loadingPromise = null;
  for (const [, p] of pendingRequests) {
    clearTimeout(p.timer);
    p.reject(new Error("TTS disposed"));
  }
  pendingRequests.clear();
}
