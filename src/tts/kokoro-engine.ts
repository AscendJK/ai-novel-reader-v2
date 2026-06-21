/**
 * Kokoro TTS 引擎
 * 基于 onnxruntime-web 直接推理（主线程 + setTimeout 让出 UI）
 * 主线程负责：文本预处理、token 编码、ONNX 推理、音频播放
 */

import * as ort from "onnxruntime-web";
import { getRemoteHost } from "@/rag/model-loader";
import { textToPhoneme } from "./text-to-phoneme";

// ── 模型配置 ───────────────────────────────────────────────
const MODEL_ID = "onnx-community/Kokoro-82M-v1.1-zh-ONNX";

// 中文语音列表
const ZH_FEMALE_IDS = [
  "zf_001","zf_002","zf_003","zf_004","zf_005","zf_006","zf_007","zf_008",
  "zf_017","zf_018","zf_019","zf_021","zf_022","zf_023","zf_024","zf_026",
  "zf_027","zf_028","zf_032","zf_036","zf_038","zf_039","zf_040","zf_042",
  "zf_043","zf_044","zf_046","zf_047","zf_048","zf_049","zf_051","zf_059",
  "zf_060","zf_067","zf_070","zf_071","zf_072","zf_073","zf_074","zf_075",
  "zf_076","zf_077","zf_078","zf_079","zf_083","zf_084","zf_085","zf_086",
  "zf_087","zf_088","zf_090","zf_092","zf_093","zf_094","zf_099",
];
const ZH_MALE_IDS = [
  "zm_009","zm_010","zm_011","zm_012","zm_013","zm_014","zm_015","zm_016",
  "zm_020","zm_025","zm_029","zm_030","zm_031","zm_033","zm_034","zm_035",
  "zm_037","zm_041","zm_045","zm_050","zm_052","zm_053","zm_054","zm_055",
  "zm_056","zm_057","zm_058","zm_061","zm_062","zm_063","zm_064","zm_065",
  "zm_066","zm_068","zm_069","zm_080","zm_081","zm_082","zm_089","zm_091",
  "zm_095","zm_096","zm_097","zm_098","zm_099","zm_100",
];

export const ZH_VOICES: Record<string, { name: string; gender: string }> = Object.fromEntries([
  ...ZH_FEMALE_IDS.map(id => [id, { name: `${id}（中文女声）`, gender: "female" }]),
  ...ZH_MALE_IDS.map(id => [id, { name: `${id}（中文男声）`, gender: "male" }]),
]);

const DEFAULT_VOICE = "zf_001";

// WASM 多线程：主线程内运行，内部 Worker 正常工作
ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;

// ── 状态 ───────────────────────────────────────────────────

interface SimpleTokenizer {
  vocab: Map<string, number>;
  allowedChars: Set<string>;
  encode(text: string): BigInt64Array;
}

let ttsSession: ort.InferenceSession | null = null;
let ttsTokenizer: SimpleTokenizer | null = null;
let currentModelId: string | null = null;
let voiceCache: Map<string, Float32Array> = new Map();
let modelBaseHost = "https://huggingface.co";
let loadingPromise: Promise<void> | null = null;

const MAX_TOKENS_PER_CHUNK = 50;

export interface KokoroGenerateOptions {
  voice?: string;
  speed?: number;
  onProgress?: (progress: number) => void;
}

// ── 分词器 ─────────────────────────────────────────────────

function createSimpleTokenizer(tokJson: any): SimpleTokenizer {
  const vocab = new Map<string, number>();
  for (const [token, id] of Object.entries(tokJson.model.vocab as Record<string, number>)) {
    vocab.set(token, id);
  }
  const regexStr: string = tokJson.normalizer.pattern.Regex;
  const allowedChars = new Set(Array.from(regexStr.slice(2, -1)));

  return {
    vocab,
    allowedChars,
    encode(text: string): BigInt64Array {
      const normalized = Array.from(text).filter(c => allowedChars.has(c)).join("");
      const ids: bigint[] = [];
      for (const ch of normalized) {
        const id = vocab.get(ch);
        if (id !== undefined && id > 0) ids.push(BigInt(id));
      }
      return BigInt64Array.from(ids);
    },
  };
}

/** 将 token 数组按音节边界切分，每段不超过 maxTokens */
function splitTokensBySyllable(tokens: BigInt64Array, maxTokens: number): BigInt64Array[] {
  if (tokens.length <= maxTokens) return [tokens];
  const result: BigInt64Array[] = [];
  let start = 0;
  const TONE_IDS = new Set([BigInt(169), BigInt(170), BigInt(171), BigInt(172), BigInt(173)]);
  while (start < tokens.length) {
    let end = Math.min(start + maxTokens, tokens.length);
    if (end < tokens.length) {
      while (end > start + 1 && !TONE_IDS.has(tokens[end - 1])) end--;
      if (end === start + 1) end = Math.min(start + maxTokens, tokens.length);
    }
    result.push(tokens.slice(start, end));
    start = end;
  }
  return result;
}

/** 让出主线程 */
function yieldToMain(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

// ── WebGPU 检测 ───────────────────────────────────────────

export async function checkWebGPU(): Promise<{ supported: boolean; detail: string }> {
  try {
    if (typeof navigator !== "undefined" && "gpu" in navigator) {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter) {
        return { supported: true, detail: `WebGPU 可用${adapter.name ? ` (${adapter.name})` : ""}` };
      }
    }
  } catch { /* fall through */ }
  return { supported: false, detail: "WebGPU 不可用，使用 WASM（CPU 推理）" };
}

export function isKokoroLoaded(): boolean {
  return ttsSession !== null && ttsTokenizer !== null && currentModelId === MODEL_ID;
}

// ── 下载辅助 ───────────────────────────────────────────────

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败: ${url} (${response.status})`);
  return response.arrayBuffer();
}

async function loadVoice(voiceId: string): Promise<Float32Array> {
  if (voiceCache.has(voiceId)) return voiceCache.get(voiceId)!;
  const url = `${modelBaseHost}/${MODEL_ID}/resolve/main/voices/${voiceId}.bin`;
  const buffer = await fetchArrayBuffer(url);
  const voice = new Float32Array(buffer);
  voiceCache.set(voiceId, voice);
  return voice;
}

// ── 模型加载 ───────────────────────────────────────────────

export async function loadKokoroModel(
  options?: {
    device?: "webgpu" | "wasm" | "auto";
    dtype?: string;
    onProgress?: (progress: number) => void;
  }
): Promise<void> {
  if (ttsSession && ttsTokenizer && currentModelId === MODEL_ID) return;
  if (loadingPromise) return loadingPromise;

  modelBaseHost = getRemoteHost().replace(/\/+$/, "");

  const dtype = options?.dtype || "quantized";
  const modelUrl = `${modelBaseHost}/${MODEL_ID}/resolve/main/onnx/model_${dtype}.onnx`;
  const tokenizerUrl = `${modelBaseHost}/${MODEL_ID}/resolve/main/tokenizer.json`;

  options?.onProgress?.(10);

  loadingPromise = (async () => {
    try {
      // 1. 下载文件（网络 I/O，不阻塞 UI）
      options?.onProgress?.(15);
      const [tokJsonBuffer, modelBuffer] = await Promise.all([
        fetchArrayBuffer(tokenizerUrl),
        fetchArrayBuffer(modelUrl),
      ]);
      options?.onProgress?.(50);
      await yieldToMain();

      // 2. 创建分词器
      const tokJson = JSON.parse(new TextDecoder().decode(tokJsonBuffer));
      ttsTokenizer = createSimpleTokenizer(tokJson);

      // 3. 创建 ONNX session（最耗时，~几秒，前后让出主线程）
      options?.onProgress?.(70);
      await yieldToMain();

      const device = options?.device || "auto";
      const providers = device === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
      let session: ort.InferenceSession | null = null;
      for (const provider of providers) {
        try {
          session = await ort.InferenceSession.create(modelBuffer, {
            executionProviders: [provider],
          });
          console.log("[TTS] session 创建成功, provider:", provider);
          break;
        } catch (err) {
          console.warn("[TTS] provider", provider, "失败:", err instanceof Error ? err.message : String(err));
        }
      }
      if (!session) throw new Error("所有 ONNX 后端都不可用");

      await yieldToMain();
      ttsSession = session;
      currentModelId = MODEL_ID;

      options?.onProgress?.(100);
    } catch (err) {
      ttsSession = null;
      ttsTokenizer = null;
      currentModelId = null;
      throw err;
    } finally {
      loadingPromise = null;
    }
  })();

  await loadingPromise;
}

// ── 推理 ───────────────────────────────────────────────────

async function runInference(contentTokens: BigInt64Array, voiceData: Float32Array, speed: number): Promise<Float32Array> {
  // BOS/EOS（ID 1/2，不是 tokenizer 的 $/ID 0，ID 0 会导致静音）
  const tokenData = new BigInt64Array(contentTokens.length + 2);
  tokenData[0] = BigInt(1);
  tokenData.set(contentTokens, 1);
  tokenData[contentTokens.length + 1] = BigInt(2);
  const tokenLength = tokenData.length;

  // style vector
  const tokenCount = tokenLength - 2;
  const styleIndex = 256 * Math.min(Math.max(tokenCount, 0), 509);
  const styleEnd = Math.min(styleIndex + 256, voiceData.length);
  let styleVector = voiceData.slice(styleIndex, styleEnd);
  if (styleVector.length < 256) {
    const padded = new Float32Array(256);
    padded.set(styleVector);
    styleVector = padded;
  }

  // 输入张量
  const names = ttsSession!.inputNames as readonly string[];
  const inputs: Record<string, ort.Tensor> = {};
  inputs[names[0]] = new ort.Tensor("int64", tokenData, [1, tokenLength]);
  inputs[names[1]] = new ort.Tensor("float32", styleVector, [1, 256]);
  inputs[names[2]] = new ort.Tensor("float32", new Float32Array([speed]), [1]);

  // 推理
  const results = await ttsSession!.run(inputs);
  const waveform = results[Object.keys(results)[0]];
  return waveform.data instanceof Float32Array
    ? waveform.data
    : new Float32Array(waveform.data as ArrayLike<number>);
}

// ── 音频生成（流式：逐段推理 + 回调）────────────────────────

export async function generateAudio(
  text: string,
  options?: KokoroGenerateOptions,
  onChunk?: (audio: Float32Array) => Promise<void> | void
): Promise<void> {
  if (!ttsSession || !ttsTokenizer) {
    throw new Error("Kokoro 模型未加载，请先调用 loadKokoroModel()");
  }

  const voiceId = options?.voice || DEFAULT_VOICE;
  const speed = options?.speed ?? 1.0;

  // 1. 编码 + 分段
  const phonemes = textToPhoneme(text);
  const contentTokens = ttsTokenizer.encode(phonemes);
  const chunks = splitTokensBySyllable(contentTokens, MAX_TOKENS_PER_CHUNK);

  // 2. 加载语音数据
  const voiceData = await loadVoice(voiceId);

  // 3. 逐段推理，每段之间让出主线程
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await yieldToMain();
    const audio = await runInference(chunks[i], voiceData, speed);
    await onChunk?.(audio);
  }
}

// ── 释放 ───────────────────────────────────────────────────

export function disposeKokoro(): void {
  ttsSession = null;
  ttsTokenizer = null;
  currentModelId = null;
  voiceCache.clear();
}
