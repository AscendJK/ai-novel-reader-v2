/**
 * Kokoro TTS 引擎（替换 ZipVoice）
 * 基于 sherpa-onnx 1.13.6 WASM，浏览器端离线推理
 * 推理在 Worker 线程，不阻塞 UI
 * 模型：Kokoro multi-lang v1.0 fp32（53 音色，中文 sid 45-52）
 * 注意：v1.0 int8 模型在 1.13.6 wasm 上生成全 NaN（无声），必须用 fp32。
 * fp32 推理 RTF≈5-8（int8 约 2.7），单次生成字数建议 ≤60 字。
 */

import { isCacheReady, getCachedFiles, downloadAndCache, stripCachePrefix } from "./tts-cache";
import { apiFetch } from "@/lib/api-client";

// ── 模型配置 ───────────────────────────────────────────────
// Kokoro 中文音色（sid 45-52，官方 v1.0 voices.bin 映射）：
// 45-48 女声（晓北/晓妮/晓晓/晓伊），49-52 男声（云健/云希/云夏/云扬）
export const ZH_VOICES: Record<string, { name: string; gender: string }> = {
  "45": { name: "女声 晓北", gender: "female" },
  "46": { name: "女声 晓妮", gender: "female" },
  "47": { name: "女声 晓晓", gender: "female" },
  "48": { name: "女声 晓伊", gender: "female" },
  "49": { name: "男声 云健", gender: "male" },
  "50": { name: "男声 云希", gender: "male" },
  "51": { name: "男声 云夏", gender: "male" },
  "52": { name: "男声 云扬", gender: "male" },
};

const DEFAULT_VOICE = "45";
const SAMPLE_RATE = 24000;
const GENERATE_TIMEOUT_MS = 120000;

// ── 状态 ───────────────────────────────────────────────────

let ttsWorkers: Worker[] = [];          // Worker 池（每 worker 独立 wasm 实例，并行推理）
let workerBusy: boolean[] = [];         // 各 worker 是否忙（同一时刻每 worker 1 个任务）
let taskQueue: Task[] = [];             // 等待空闲 worker 的任务队列（FIFO）
let workerPoolSize = 1;                 // 目标池大小（1-3，每个约 400-500MB 内存）
let modelLoaded = false;
let disposed = false;
let loadingPromise: Promise<void> | null = null;
let nextRequestId = 0;
const pendingRequests = new Map<number, { resolve: (audio: Float32Array) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
// 当前等待 worker ready 的 resolve/reject（供 onerror 快速失败，避免卡 10 分钟超时）
let readyWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;

interface Task {
  id: number;
  text: string;
  sid: number;
  speed: number;
}

/**
 * 设置浏览器推理并行 Worker 数（1-3）。
 * 仅在模型未加载时生效（下次朗读应用）；已加载时需 resetWorker 后重建。
 * 内存提醒：每个 Worker 独立加载模型，约占用 400-500MB。
 */
export function setWorkerPoolSize(n: number): void {
  workerPoolSize = Math.max(1, Math.min(3, Math.round(n) || 1));
}

export function getWorkerPoolSize(): number {
  return workerPoolSize;
}

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

/**
 * 清洗 TTS 输入文本：删除/替换词表（lexicon）中不存在的装饰性符号，
 * 避免 worker 打印大量 "Ignore OOV" 警告。
 * 与 text-preprocess.prepareTextForTTS 的清洗语义保持一致：
 * 引号/书名号/破折号 → 逗号（保留停顿感），省略号/杂项 → 空格。
 * 保留句读标点（，。！？；：、）——它们用于韵律控制且在词表中。
 */
export function normalizeText(text: string): string {
  return text
    // 中文/英文引号：词表无此字符，替换为逗号（与 prepareTextForTTS 一致，保留停顿）
    .replace(/[“”‘’"']/g, "，")
    // 书名号、括号类装饰符号 → 逗号（保留停顿）；英文方括号 [] 删除（行内装饰）
    .replace(/[《》〈〉「」『』【】〔〕]/g, "，")
    .replace(/[[\]]/g, "")
    // 省略号/间隔号/波浪线等 → 空格（保留停顿感）；破折号 → 逗号（与 prepareTextForTTS 一致）
    .replace(/[…·・〜～~]/g, " ")
    .replace(/[—–]/g, "，")
    // 杂项符号：竖线、下划线、星号、反引号、反斜杠等
    .replace(/[|_`*\\^]/g, " ")
    // emoji 等装饰符号（词表无此字符）；u 标志按码点匹配，
    // eslint 的 no-misleading-character-class 对 emoji 组合字符误报，此处按码点替换是预期行为
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")
    // 连续标点清理：标点后紧跟的逗号删除（如 "：，" → "："，"。，" → "。"），
    // 避免引号替换产生双标点朗读停顿异常
    .replace(/([，。！？；：、])(\s*，)+/g, "$1")
    // 压缩连续空白（含全角空格 U+3000）
    .replace(/\s+/g, " ")
    .trim();
}

// ── Worker 生命周期 ────────────────────────────────────────

/** 创建第 index 个 worker（blob URL，兼容 COEP 限制），绑定消息处理 */
async function createWorker(index: number): Promise<Worker> {
  const base = import.meta.env.BASE_URL || "/";
  const workerUrl = base + "sherpa-tts/sherpa-onnx-tts.worker.js";
  // 用 fetch + blob URL 创建 worker：
  // crossOriginIsolated（COEP）页面下，直接 new Worker(文件 URL) 会被
  // Chrome 以 ERR_BLOCKED_BY_RESPONSE 拒绝（worker 脚本的 COEP 检查），
  // 即使脚本同源且带 CORP 头也会失败；blob URL 继承页面 origin，可正常加载。
  // worker.js 内部已有 WrappedURL 处理 blob base（new URL(".", import.meta.url)）。
  const resp = await fetch(workerUrl);
  if (!resp.ok) throw new Error(`Worker 脚本下载失败: ${resp.status}`);
  const code = await resp.text();
  const blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
  const worker = new Worker(blobUrl);
  worker.onmessage = (e) => handleWorkerMessage(e, index);
  worker.onerror = (e) => {
    // 完整诊断信息：message 为空通常表示脚本 fetch 失败（404/CSP/COEP/网络）
    const detail = {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      error: e.error ? String(e.error) : null,
      crossOriginIsolated: typeof window !== "undefined" ? window.crossOriginIsolated : undefined,
      hasSAB: typeof SharedArrayBuffer !== "undefined",
    };
    const msg = e.message || e.error?.message || `Worker 加载失败 (${e.filename || "?"}:${e.lineno || "?"})`;
    console.error(`[TTS Worker #${index}] error:`, msg, detail);
    modelLoaded = false;
    // 快速失败当前等待 ready 的流程（loadModel 会自动重试）
    const waiter = readyWaiter;
    readyWaiter = null;
    if (waiter) waiter.reject(new Error(msg));
    for (const [, p] of pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error(msg));
    }
    pendingRequests.clear();
    taskQueue = [];
  };
  return worker;
}

/** worker 空闲回调：分配下一个排队任务 */
function onWorkerIdle(index: number): void {
  workerBusy[index] = false;
  const next = taskQueue.shift();
  if (next) dispatchTask(next);
}

/** 调度：找空闲 worker 分配任务；无空闲则入队等待 */
function dispatchTask(task: Task): void {
  const idx = workerBusy.findIndex((b) => !b);
  if (idx === -1 || idx >= ttsWorkers.length) {
    taskQueue.push(task);
    return;
  }
  workerBusy[idx] = true;
  ttsWorkers[idx].postMessage({ type: "generate", id: task.id, text: task.text, sid: task.sid, speed: task.speed });
}

/**
 * 初始化第 index 个 Worker（创建 + 发送 init 含文件数据，等待 ready）。
 * files 会被 slice 拷贝后 transfer（零拷贝传输，原 buffer 保留可复用）。
 * 串行调用（一次一个），避免多 worker 同时加载造成内存峰值叠加。
 */
async function initWorker(files: Map<string, ArrayBuffer>, index: number): Promise<void> {
  const w = await createWorker(index);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      readyWaiter = null;
      w.removeEventListener("message", handler);
      try { w.terminate(); } catch { /* worker 可能已终止 */ }
      ttsWorkers[index] = undefined as unknown as Worker;
      modelLoaded = false;
      reject(new Error("模型加载超时（10分钟）"));
    }, 600000);
    const handler = (e: MessageEvent) => {
      if (e.data.type === "sherpa-onnx-tts-ready") {
        clearTimeout(timeout);
        w.removeEventListener("message", handler);
        readyWaiter = null;
        modelLoaded = true;
        resolve();
      } else if (e.data.type === "error") {
        clearTimeout(timeout);
        w.removeEventListener("message", handler);
        readyWaiter = null;
        try { w.terminate(); } catch { /* worker 可能已终止 */ }
        ttsWorkers[index] = undefined as unknown as Worker;
        modelLoaded = false;
        reject(new Error(e.data.message));
      }
    };
    readyWaiter = { resolve, reject };
    w.addEventListener("message", handler);

    // 构造 files 对象，用 transfer 传输大文件（零拷贝）。
    // 注意：slice(0) 拷贝一份，避免重试时原 buffer 已被 detach。
    // 缓存 key 带 kokoro-v1/ 前缀，传给 worker 时还原为短文件名
    const filesObj: Record<string, ArrayBuffer> = {};
    const transferables: ArrayBuffer[] = [];
    for (const [key, value] of files) {
      const copy = value.slice(0);
      filesObj[stripCachePrefix(key)] = copy;
      transferables.push(copy);
    }
    // 传递页面 origin 和模型基础路径给 Worker
    w.postMessage({
      type: "init",
      files: filesObj,
      pageOrigin: window.location.origin,
      modelBase: "/api/rag/tts/model",
    }, transferables);
  });
}

function handleWorkerMessage(e: MessageEvent, workerIndex: number): void {
  const msg = e.data;

  if (msg.type === "sherpa-onnx-tts-ready") {
    modelLoaded = true;
    disposed = false;
    console.log(`[TTS] Kokoro ready #${workerIndex}, modelType:`, msg.modelType, "numSpeakers:", msg.numSpeakers);
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
    onWorkerIdle(workerIndex); // 该 worker 空闲，派发排队任务
  } else if (msg.type === "sherpa-onnx-tts-generation-progress") {
    // progress callback
  } else if (msg.type === "error") {
    console.error(`[TTS Worker #${workerIndex}] error:`, msg.message);
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
    onWorkerIdle(workerIndex); // 失败也释放 worker
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
 * 必须用 apiFetch（带服务器地址 + 鉴权头），裸 fetch 相对路径
 * 在 GitHub Pages 上会解析到静态站点域名下导致 404。
 */
export async function checkTTSCache(): Promise<{ wasmReady: boolean; modelReady: boolean; vocoderReady: boolean }> {
  const res = await apiFetch("/api/rag/tts/status");
  if (!res.ok) throw new Error(`检查 TTS 状态失败: HTTP ${res.status}`);
  const data = await res.json();
  // 兼容旧后端（无 vocoderReady 字段时按就绪处理，避免误拦）
  return { wasmReady: !!data.wasmReady, modelReady: !!data.modelReady, vocoderReady: data.vocoderReady !== false };
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
      const cached = await isCacheReady();

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

      // 5. 创建 Worker 池（串行 init，避免多 worker 同时加载造成内存峰值叠加）并发送文件数据
      options?.onProgress?.(85);
      const targetSize = Math.max(1, Math.min(workerPoolSize, 3));
      ttsWorkers = new Array(targetSize) as Worker[];
      workerBusy = new Array(targetSize).fill(false);
      taskQueue = [];
      let initError: Error | null = null;
      for (let idx = 0; idx < targetSize; idx++) {
        let ok = false;
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
          try {
            await initWorker(files, idx);
            initError = null;
            ok = true;
          } catch (err) {
            initError = err instanceof Error ? err : new Error(String(err));
            console.warn(`[TTS] Worker #${idx} 初始化失败（第 ${attempt} 次），${attempt < 2 ? "自动重试" : "放弃"}: ${initError.message}`);
            try { ttsWorkers[idx]?.terminate(); } catch { /* worker 可能已终止 */ }
            ttsWorkers[idx] = undefined as unknown as Worker;
            modelLoaded = false;
          }
        }
        if (!ok) break;
      }
      if (initError) throw initError;
      console.log(`[TTS] Worker 池就绪（${targetSize} 个并行推理）`);

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
    throw new Error("Kokoro 模型未加载，请先调用 loadModel()");
  }

  const cleanText = normalizeText(text);
  const speed = options?.speed ?? 1.0;
  const voiceId = options?.voice || DEFAULT_VOICE;
  const sid = parseInt(voiceId, 10) || 0;

  const id = nextRequestId++;
  const t0 = performance.now();
  // 动态超时：Kokoro fp32 wasm 单线程推理本地实测 RTF≈5-8（每字约 1.5-2s），
  // 慢设备（无 SIMD/低配 CPU）可达更高。每字预留 6s，下限 120s。
  const timeoutMs = Math.max(GENERATE_TIMEOUT_MS, cleanText.length * 6000);
  console.log(`[TTS] 请求生成 #${id}: ${cleanText.length} 字, voice=${voiceId}(sid=${sid}), speed=${speed}, 超时 ${(timeoutMs / 1000).toFixed(0)}s, 池=${ttsWorkers.length}`);
  // zipvoice 无逐步进度回调，用时间推进展示生成进度（每 10s 一条）
  const progressTimer = setInterval(() => {
    console.log(`[TTS] ⏳ 生成中 #${id}: 已等待 ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  }, 10000);
  let audio: Float32Array;
  try {
    audio = await new Promise<Float32Array>((resolve, reject) => {
      // H5 fix: 生成超时（动态：短文本下限 120s，长文本按每字 4s 预留）
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        console.warn(`[TTS] 生成超时 #${id}: ${((performance.now() - t0) / 1000).toFixed(1)}s 未返回，已放弃该 chunk`);
        reject(new Error("音频生成超时"));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      dispatchTask({ id, text: cleanText, sid, speed }); // 池调度：空闲 worker 立即处理，否则排队
    });
  } finally {
    clearInterval(progressTimer);
  }
  console.log(`[TTS] 生成完成 #${id}: ${audio.length} samples ≈ ${(audio.length / SAMPLE_RATE).toFixed(1)}s 音频, 耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);

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
    throw new Error("Kokoro 模型未加载，请先调用 loadModel()");
  }

  const cleanText = normalizeText(text);
  const speed = options?.speed ?? 1.0;
  const voiceId = options?.voice || DEFAULT_VOICE;
  const sid = parseInt(voiceId, 10) || 0;

  const id = nextRequestId++;
  const t0 = performance.now();
  // 与 generateAudio 一致：动态超时（每字最多 6s，下限 120s）
  const timeoutMs = Math.max(GENERATE_TIMEOUT_MS, cleanText.length * 6000);
  console.log(`[TTS] 请求生成(完整预览) #${id}: ${cleanText.length} 字, voice=${voiceId}(sid=${sid}), speed=${speed}, 超时 ${(timeoutMs / 1000).toFixed(0)}s`);
  // zipvoice 无逐步进度回调，用时间推进展示生成进度（每 10s 一条）
  const progressTimer = setInterval(() => {
    console.log(`[TTS] ⏳ 生成中(完整预览) #${id}: 已等待 ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  }, 10000);
  let audio: Float32Array;
  try {
    audio = await new Promise<Float32Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        console.warn(`[TTS] 生成超时(完整预览) #${id}: ${((performance.now() - t0) / 1000).toFixed(1)}s 未返回`);
        reject(new Error("音频生成超时"));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      dispatchTask({ id, text: cleanText, sid, speed }); // 池调度（预览同样走池，占用 1 个 worker）
    });
  } finally {
    clearInterval(progressTimer);
  }
  console.log(`[TTS] 生成完成(完整预览) #${id}: ${audio.length} samples ≈ ${(audio.length / SAMPLE_RATE).toFixed(1)}s 音频, 耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  return { audio, sampleRate: SAMPLE_RATE };
}

// ── 释放 ───────────────────────────────────────────────────

/**
 * 中断所有进行中的生成并销毁当前 worker（停止朗读时调用）。
 * sherpa-onnx wasm 推理是同步阻塞的，无法取消单次推理，
 * 只能 terminate worker 立即中断 CPU 占用；结果也不会再回来。
 * 下次朗读会重新初始化 worker（模型文件来自缓存，约 3-5 秒）。
 */
export function resetWorker(): void {
  modelLoaded = false;
  loadingPromise = null;
  readyWaiter = null;
  for (const w of ttsWorkers) {
    if (w) {
      try { w.terminate(); } catch { /* 已销毁的 worker 忽略 */ }
    }
  }
  ttsWorkers = [];
  workerBusy = [];
  taskQueue = [];
  for (const [, p] of pendingRequests) {
    clearTimeout(p.timer);
    p.reject(new Error("已停止"));
  }
  pendingRequests.clear();
}

export function dispose(): void {
  disposed = true;
  resetWorker();
}
