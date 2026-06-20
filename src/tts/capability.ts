/**
 * TTS 浏览器能力检测
 * 检测 WebGPU 支持、模型文件状态
 */

export interface TTSCapability {
  /** 推理设备 */
  device: "webgpu" | "wasm";
  /** 推荐的模型文件名 */
  modelFile: string;
  /** 模型体积（字节） */
  modelSize: number;
  /** 人类可读的描述 */
  detail: string;
  /** 是否支持 */
  supported: boolean;
}

/**
 * 检测浏览器 WebGPU 支持情况
 */
export async function detectTTSCapability(): Promise<TTSCapability> {
  // 检测 WebGPU
  try {
    if (typeof navigator !== "undefined" && "gpu" in navigator) {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter) {
        const name = adapter.name || "";
        return {
          device: "webgpu",
          modelFile: "model_q8f16.onnx",
          modelSize: 86 * 1024 * 1024,
          detail: `WebGPU 可用${name ? ` (${name})` : ""}`,
          supported: true,
        };
      }
    }
  } catch {
    // WebGPU 不可用，降级
  }

  // 降级 WASM
  return {
    device: "wasm",
    modelFile: "model_quantized.onnx",
    modelSize: 92 * 1024 * 1024,
    detail: "WebGPU 不可用，使用 CPU 推理（较慢）",
    supported: true,
  };
}

/**
 * 获取推荐的浏览器升级建议
 */
export function getWebGPUBrowserHint(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Chrome/") && !ua.includes("Edg/")) {
    const match = ua.match(/Chrome\/(\d+)/);
    if (match && parseInt(match[1]) < 113) {
      return "Chrome 113+ 支持 WebGPU，建议升级浏览器";
    }
  }
  if (ua.includes("Edg/")) {
    const match = ua.match(/Edg\/(\d+)/);
    if (match && parseInt(match[1]) < 113) {
      return "Edge 113+ 支持 WebGPU，建议升级浏览器";
    }
  }
  if (ua.includes("Firefox/")) {
    return "Firefox 暂不支持 WebGPU，建议使用 Chrome/Edge";
  }
  return "";
}
