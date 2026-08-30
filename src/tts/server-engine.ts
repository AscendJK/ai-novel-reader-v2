/**
 * 服务端推理引擎（Kokoro，Python sherpa-onnx 原生多线程）
 * 服务器端 8 线程推理，RTF≈0.6（18 字约 2.5s），生成比播放快，可边听边推理。
 * 依赖：服务器已安装 Python + sherpa-onnx（pip install sherpa-onnx），
 * 模型首次启用时懒下载到服务器（不占用浏览器带宽/存储）。
 * 与浏览器推理（zipvoice-engine）共用同一套音色/语速参数。
 */

import { apiFetch } from "@/lib/api-client";
import { normalizeText } from "./zipvoice-engine";

export interface ServerInferenceStatus {
  supported: boolean;   // 服务器 Python + sherpa-onnx 可用
  ready: boolean;       // 模型已就绪（可立即生成）
  reason: string;       // 不可用/未就绪原因
}

/** 检查服务端推理可用性（不触发下载） */
export async function checkServerInference(): Promise<ServerInferenceStatus> {
  try {
    const res = await apiFetch("/api/rag/tts/status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const si = data.serverInference;
    if (si && typeof si.supported === "boolean") {
      return { supported: si.supported, ready: si.ready, reason: si.reason || "" };
    }
    // 旧后端无 serverInference 字段：视为不支持
    return { supported: false, ready: false, reason: "服务器版本过旧，不支持服务端推理" };
  } catch (e) {
    return { supported: false, ready: false, reason: e instanceof Error ? e.message : "无法连接服务器" };
  }
}

/** 解析 16-bit PCM WAV → Float32Array */
function decodeWav(arrayBuf: ArrayBuffer): { samples: Float32Array; sampleRate: number } {
  if (arrayBuf.byteLength < 44) throw new Error("WAV 解析失败：文件过短");
  const dv = new DataView(arrayBuf);
  // 校验 RIFF/WAVE 头 + fmt 块（格式变更时立即报错，避免静默解析出错误音频）
  const riff = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  const wave = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if (riff !== "RIFF" || wave !== "WAVE") throw new Error("WAV 解析失败：非法 RIFF/WAVE 头");
  const audioFormat = dv.getUint16(20, true);
  const channels = dv.getUint16(22, true);
  const sampleRate = dv.getUint32(24, true);
  if (audioFormat !== 1) throw new Error(`WAV 解析失败：不支持的编码格式 ${audioFormat}（仅支持 PCM）`);
  if (channels !== 1) throw new Error(`WAV 解析失败：不支持的声道数 ${channels}（仅支持单声道）`);
  if (sampleRate <= 0) throw new Error("WAV 解析失败：非法采样率");
  // 定位 data chunk（标准 WAV：fmt 后可能跟扩展，搜索 "data"）
  let dataOffset = 12;
  let dataSize = 0;
  while (dataOffset + 8 <= arrayBuf.byteLength) {
    const chunkId = String.fromCharCode(
      dv.getUint8(dataOffset), dv.getUint8(dataOffset + 1),
      dv.getUint8(dataOffset + 2), dv.getUint8(dataOffset + 3),
    );
    const chunkSize = dv.getUint32(dataOffset + 4, true);
    if (chunkId === "data") {
      dataSize = chunkSize;
      dataOffset += 8;
      break;
    }
    dataOffset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataSize === 0) throw new Error("WAV 解析失败：未找到 data chunk");
  const numSamples = Math.floor(Math.min(dataSize, arrayBuf.byteLength - dataOffset) / 2);
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = dv.getInt16(dataOffset + i * 2, true) / 32768;
  }
  return { samples, sampleRate };
}

/** 服务端推理生成一段音频（同步请求，返回 Float32Array） */
export async function synthesizeServer(
  text: string,
  options?: { voice?: string; speed?: number },
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const cleanText = normalizeText(text);
  if (!cleanText) throw new Error("文本为空");
  const voiceId = parseInt(options?.voice || "45", 10);
  const sid = Number.isNaN(voiceId) ? 45 : voiceId;

  const t0 = performance.now();
  console.log(`[TTS-server] 请求生成: ${cleanText.length} 字, sid=${sid}, speed=${options?.speed ?? 1.0}`);
  const res = await apiFetch("/api/rag/tts/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: cleanText, sid, speed: options?.speed ?? 1.0 }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* 非 JSON */ }
    throw new Error(msg);
  }
  const arrayBuf = await res.arrayBuffer();
  const { samples, sampleRate } = decodeWav(arrayBuf);
  console.log(`[TTS-server] 生成完成: ${samples.length} samples ≈ ${(samples.length / sampleRate).toFixed(1)}s 音频, 耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return { samples, sampleRate };
}

/**
 * 取消当前用户所有排队中的服务端推理请求（停止朗读时调用）。
 * 服务器立即释放队列位置（其他用户无需等待作废请求生成完）。
 * fire-and-forget：网络失败静默，不影响停止流程。
 */
export async function cancelServerInference(): Promise<void> {
  try {
    await apiFetch("/api/rag/tts/cancel", { method: "POST" });
  } catch {
    /* 静默：取消失败不影响本地停止 */
  }
}
