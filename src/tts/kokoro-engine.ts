/**
 * Kokoro TTS 引擎
 * 基于 onnxruntime-web + @huggingface/transformers tokenizer 手动推理
 * 完全绕开 pipeline/AutoModel 的架构检测，避免 style_text_to_speech_2 降级警告
 */

import { AutoTokenizer, env } from "@huggingface/transformers";
import * as ort from "onnxruntime-web";
import { getRemoteHost } from "@/rag/model-loader";

// 模型配置
const MODEL_ID = "onnx-community/Kokoro-82M-v1.1-zh-ONNX";
const SAMPLE_RATE = 24000;

/**
 * 配置模型下载源（复用 RAG 模型的镜像系统）
 * backend-proxy: 通过用户本地服务器代理（绕过 CORS）
 * hf-mirror: 国内镜像直连
 * huggingface: 官方源直连
 */
function configureModelSource(): string {
  const host = getRemoteHost().replace(/\/+$/, "");
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  // 让 transformers.js 的 AutoTokenizer 等也走镜像/代理下载
  (env as any).remoteHost = host;
  return host;
}

// 中文语音列表（从 onnx-community/Kokoro-82M-v1.1-zh-ONNX voices 目录）
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

// 默认语音
const DEFAULT_VOICE = "zf_001";

// 缓存
let ttsSession: ort.InferenceSession | null = null;
let ttsTokenizer: any = null;
let currentModelId: string | null = null;
let voiceCache: Map<string, Float32Array> = new Map();
let modelBaseHost = "https://huggingface.co";
let loadingPromise: Promise<void> | null = null; // 防止并发加载

export interface KokoroGenerateOptions {
  voice?: string;
  speed?: number;
  onProgress?: (progress: number) => void;
}

export interface KokoroAudioResult {
  audio: Float32Array;
  sampleRate: number;
}

/**
 * 检查 WebGPU 支持
 */
export async function checkWebGPU(): Promise<{ supported: boolean; detail: string }> {
  try {
    if (typeof navigator !== "undefined" && "gpu" in navigator) {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter) {
        return {
          supported: true,
          detail: `WebGPU 可用${adapter.name ? ` (${adapter.name})` : ""}`,
        };
      }
    }
  } catch { /* fall through */ }
  return { supported: false, detail: "WebGPU 不可用，使用 WASM（CPU 推理）" };
}

/**
 * 下载文件并返回 ArrayBuffer
 */
async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败: ${url} (${response.status})`);
  return response.arrayBuffer();
}

/**
 * 加载语音数据（从 HuggingFace voices 目录）
 */
async function loadVoice(voiceId: string): Promise<Float32Array> {
  if (voiceCache.has(voiceId)) return voiceCache.get(voiceId)!;

  const url = `${modelBaseHost}/${MODEL_ID}/resolve/main/voices/${voiceId}.bin`;
  const buffer = await fetchArrayBuffer(url);
  const voice = new Float32Array(buffer);
  voiceCache.set(voiceId, voice);
  return voice;
}

/**
 * 加载 Kokoro TTS 模型（使用 onnxruntime-web 直接加载，绕过 transformers.js 架构检测）
 */
export async function loadKokoroModel(
  options?: {
    device?: "webgpu" | "wasm" | "auto";
    dtype?: string;
    onProgress?: (progress: number) => void;
  }
): Promise<void> {
  if (ttsSession && ttsTokenizer && currentModelId === MODEL_ID) return;

  // 防止并发加载：如果已在加载中，等待同一次加载完成
  if (loadingPromise) return loadingPromise;

  // 配置模型下载源
  modelBaseHost = configureModelSource();

  const device = options?.device === "auto"
    ? (await checkWebGPU()).supported ? "webgpu" : "wasm"
    : options?.device || "wasm";

  const dtype = options?.dtype || (device === "webgpu" ? "fp16" : "quantized");
  const modelFile = `model_${dtype}.onnx`;
  const modelUrl = `${modelBaseHost}/${MODEL_ID}/resolve/main/onnx/${modelFile}`;

  options?.onProgress?.(10);

  loadingPromise = (async () => {
    try {
      // 并行加载 tokenizer 和模型
      const [tokenizer, modelBuffer] = await Promise.all([
        AutoTokenizer.from_pretrained(MODEL_ID),
        fetchArrayBuffer(modelUrl),
      ]);

      options?.onProgress?.(80);

      // 配置 ONNX Runtime（WASM 多线程加速）
      ort.env.wasm.numThreads = navigator.hardwareConcurrency || 4;

      // 直接创建 ONNX 推理会话（绕过 transformers.js 架构检测）
      const session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: [device === "webgpu" ? "webgpu" : "wasm"],
      });

      ttsSession = session;
      ttsTokenizer = tokenizer;
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

/**
 * 检查模型是否已加载
 */
export function isKokoroLoaded(): boolean {
  return ttsSession !== null && ttsTokenizer !== null && currentModelId === MODEL_ID;
}

/**
 * 生成单段文本的音频
 */
export async function generateAudio(
  text: string,
  options?: KokoroGenerateOptions
): Promise<KokoroAudioResult> {
  if (!ttsSession || !ttsTokenizer) {
    throw new Error("Kokoro 模型未加载，请先调用 loadKokoroModel()");
  }

  const voiceId = options?.voice || DEFAULT_VOICE;
  const speed = options?.speed ?? 1.0;

  try {
    // 1. 分词：文本 → token IDs（tokenizer 返回 BigInt64Array，直接传给 ONNX int64）
    const { input_ids } = ttsTokenizer(text, { truncation: true });
    const tokenData = input_ids.data instanceof BigInt64Array
      ? input_ids.data
      : BigInt64Array.from(Array.from(input_ids.data as ArrayLike<number>, n => BigInt(n)));
    const tokenLength = tokenData.length;

    // 2. 加载语音风格向量
    const voiceData = await loadVoice(voiceId);

    // 3. 计算 style 偏移（基于 token 数量，与 kokoro-js 一致）
    const tokenCount = tokenLength - 2; // 去掉首尾 special tokens
    const styleIndex = 256 * Math.min(Math.max(tokenCount, 0), 509);
    const styleEnd = Math.min(styleIndex + 256, voiceData.length);
    let styleVector = voiceData.slice(styleIndex, styleEnd);
    // 如果切片不足 256 个元素，用零填充
    if (styleVector.length < 256) {
      const padded = new Float32Array(256);
      padded.set(styleVector);
      styleVector = padded;
    }

    // 4. 构造 ONNX 输入张量
    const inputs: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", tokenData, [1, tokenLength]),
      style: new ort.Tensor("float32", styleVector, [1, 256]),
      speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
    };

    // 5. 执行推理
    const results = await ttsSession.run(inputs);
    const waveform = results.waveform || Object.values(results)[0];
    const audioData = waveform.data instanceof Float32Array
      ? waveform.data
      : new Float32Array(waveform.data as ArrayLike<number>);

    return {
      audio: audioData,
      sampleRate: SAMPLE_RATE,
    };
  } catch (err) {
    throw new Error(`Kokoro 音频生成失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 释放模型资源
 */
export function disposeKokoro(): void {
  // InferenceSession 在浏览器端无需显式释放，置 null 让 GC 回收 WASM 内存
  ttsSession = null;
  ttsTokenizer = null;
  currentModelId = null;
  voiceCache.clear();
}
