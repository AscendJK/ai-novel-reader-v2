/**
 * Kokoro TTS 引擎
 * 直接使用 @huggingface/transformers 加载中文 Kokoro 模型
 * 绕过 kokoro-js 包的英文语音限制
 */

import { pipeline, env } from "@huggingface/transformers";
import { getMirrorId, getRemoteHost } from "@/rag/model-loader";

// 模型配置
const MODEL_ID = "onnx-community/Kokoro-82M-v1.1-zh-ONNX";
const SAMPLE_RATE = 24000;

/**
 * 配置模型下载源（复用 RAG 模型的镜像系统）
 */
function configureModelSource() {
  const mirrorId = getMirrorId();
  if (mirrorId === "backend-proxy") {
    // 后端代理模式：通过 fetch-proxy 拦截，不设置 remoteHost
    env.allowRemoteModels = true;
  } else {
    // 直连模式：设置 remoteHost 为镜像地址
    const host = getRemoteHost();
    if (host) {
      (env as any).remoteHost = host;
    }
    env.allowRemoteModels = true;
  }
}

// 中文语音列表
export const ZH_VOICES: Record<string, { name: string; gender: string }> = {
  zf_xiaobei: { name: "小贝（中文女声）", gender: "female" },
  zf_xiaoni: { name: "小妮（中文女声）", gender: "female" },
  zf_xiaoxiao: { name: "晓晓（中文女声）", gender: "female" },
  zf_xiaoyi: { name: "小艺（中文女声）", gender: "female" },
  zm_yunxi: { name: "云希（中文男声）", gender: "male" },
  zm_yunjian: { name: "云健（中文男声）", gender: "male" },
  zm_yunxia: { name: "云夏（中文男声）", gender: "male" },
  zm_yunyang: { name: "云扬（中文男声）", gender: "male" },
};

// 默认语音
const DEFAULT_VOICE = "zf_xiaobei";

// 缓存模型实例
let ttsPipeline: any = null;
let currentModelId: string | null = null;

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
 * 加载 Kokoro TTS 模型
 */
export async function loadKokoroModel(
  options?: {
    device?: "webgpu" | "wasm" | "auto";
    dtype?: string;
    onProgress?: (progress: number) => void;
  }
): Promise<void> {
  if (ttsPipeline && currentModelId === MODEL_ID) return;

  // 配置模型下载源（复用 RAG 镜像系统）
  configureModelSource();

  const device = options?.device === "auto"
    ? (await checkWebGPU()).supported ? "webgpu" : "wasm"
    : options?.device || "wasm";

  const dtype = options?.dtype || (device === "webgpu" ? "q8f16" : "q8");

  try {
    ttsPipeline = await pipeline("text-to-speech", MODEL_ID, {
      device,
      dtype,
      progress_callback: (progress: any) => {
        if (progress.status === "progress" && options?.onProgress) {
          options.onProgress(Math.round(progress.progress || 0));
        }
      },
    });
    currentModelId = MODEL_ID;
  } catch (err) {
    ttsPipeline = null;
    currentModelId = null;
    throw err;
  }
}

/**
 * 检查模型是否已加载
 */
export function isKokoroLoaded(): boolean {
  return ttsPipeline !== null && currentModelId === MODEL_ID;
}

/**
 * 生成单段文本的音频
 */
export async function generateAudio(
  text: string,
  options?: KokoroGenerateOptions
): Promise<KokoroAudioResult> {
  if (!ttsPipeline) {
    throw new Error("Kokoro 模型未加载，请先调用 loadKokoroModel()");
  }

  const voice = options?.voice || DEFAULT_VOICE;
  const speed = options?.speed || 1.0;

  try {
    const result = await ttsPipeline(text, {
      voice,
      speed,
    });

    // 提取音频数据
    const audio = result.audio?.data || result.audio;
    const sampleRate = result.sampling_rate || SAMPLE_RATE;

    return {
      audio: audio instanceof Float32Array ? audio : new Float32Array(audio),
      sampleRate,
    };
  } catch (err) {
    throw new Error(`Kokoro 音频生成失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 流式生成音频（分段）
 */
export async function* generateAudioStream(
  text: string,
  options?: KokoroGenerateOptions
): AsyncGenerator<KokoroAudioResult, void, unknown> {
  if (!ttsPipeline) {
    throw new Error("Kokoro 模型未加载，请先调用 loadKokoroModel()");
  }

  // 按句子分割文本
  const sentences = splitTextForTTS(text);

  for (const sentence of sentences) {
    if (sentence.trim().length === 0) continue;

    const result = await generateAudio(sentence, options);
    yield result;
  }
}

/**
 * 将文本分割为适合 TTS 的段落
 */
function splitTextForTTS(text: string): string[] {
  return text
    .split(/(?<=[。！？；\n])/)
    .map(s => s.trim())
    .filter(s => s.length >= 2);
}

/**
 * 释放模型资源
 */
export function disposeKokoro(): void {
  ttsPipeline = null;
  currentModelId = null;
}
