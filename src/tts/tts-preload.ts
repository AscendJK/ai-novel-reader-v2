/**
 * ZipVoice 预加载
 * 登录后自动检测并拉取离线语音资源（WASM + 模型 + vocoder），
 * 避免用户首次使用时等待大量下载。
 *
 * 设计原则（所有边界情况）：
 * - 未登录：不执行任何操作
 * - 已缓存完整：幂等，直接返回（不重复下载 ~380MB）
 * - 服务器离线/未就绪：静默降级，绝不抛出异常影响登录/主流程
 * - 下载失败/中断：捕获并 warn，WebSpeech 引擎完全不受影响；
 *   下次登录/刷新时会再次检测（downloadAndCache 按文件粒度续传）
 * - 并发调用：模块级 Promise 单例，避免重复触发
 */

import { isCacheReady, downloadAndCache } from "./tts-cache";
import { prepareTTS, checkTTSCache } from "./zipvoice-engine";
import { isLoggedIn } from "@/lib/user-utils";

/** 预加载状态（供 UI 可选展示） */
export type TTSPreloadStatus =
  | "idle"        // 未触发
  | "checking"    // 检测中
  | "downloading" // 服务器就绪，浏览器拉取中
  | "ready"       // 已完成
  | "skipped"     // 跳过（未登录/服务器离线/未就绪）
  | "failed";     // 失败

let preloadPromise: Promise<TTSPreloadStatus> | null = null;
let lastStatus: TTSPreloadStatus = "idle";

export function getTTSPreloadStatus(): TTSPreloadStatus {
  return lastStatus;
}

function setStatus(s: TTSPreloadStatus): void {
  lastStatus = s;
}

/**
 * 登录后调用：检测 ZipVoice 资源，必要时拉取到 IndexedDB。
 * 任何情况下都不抛异常（登录/主流程绝不因语音预加载失败而中断）。
 */
export function preloadZipVoice(): Promise<TTSPreloadStatus> {
  // 并发保护：同一时刻只跑一次（幂等）
  if (preloadPromise) return preloadPromise;

  preloadPromise = (async (): Promise<TTSPreloadStatus> => {
    // 1. 未登录：跳过（TTS 下载接口需要鉴权）
    if (!isLoggedIn()) {
      setStatus("skipped");
      return "skipped";
    }

    // 2. 已缓存完整：直接返回
    setStatus("checking");
    try {
      const cached = await isCacheReady();
      if (cached) {
        setStatus("ready");
        return "ready";
      }
    } catch (e) {
      // IndexedDB 不可用（隐私模式等）：跳过，不影响使用
      console.warn("[tts-preload] IndexedDB 检测失败，跳过预加载:", e);
      setStatus("skipped");
      return "skipped";
    }

    // 3. 检查服务器资源状态
    try {
      const status = await checkTTSCache();
      // 服务器未就绪（还在下载或从未准备）：不主动触发重型 prepare，
      // 避免每个用户登录都触发服务器下载；返回跳过，稍后手动使用 ZipVoice
      // 时会走 loadModel 的完整流程
      if (!status.wasmReady || !status.modelReady) {
        console.warn(`[tts-preload] 服务器 TTS 资源未就绪 (wasm=${status.wasmReady}, model=${status.modelReady})，跳过预加载`);
        setStatus("skipped");
        return "skipped";
      }
    } catch (e) {
      // 服务器离线/未配置：静默跳过（WebSpeech 不受影响）
      console.warn("[tts-preload] 无法连接服务器检查 TTS 状态，跳过预加载:", e instanceof Error ? e.message : e);
      setStatus("skipped");
      return "skipped";
    }

    // 4. 触发服务器准备（幂等：服务器已就绪时秒回）+ 浏览器拉取到 IndexedDB
    try {
      setStatus("downloading");
      // prepareTTS 是 SSE，服务器资源已就绪时立即 done，不会重复下载
      await prepareTTS(() => { /* 进度可忽略，服务器通常已就绪 */ });
      await downloadAndCache((_file, loaded, total) => {
        // 进度回调：UI 可选展示（这里仅保留日志，避免刷屏）
        if (total > 0 && loaded === total) {
          console.log(`[tts-preload] ${_file} 已缓存 (${(total / 1048576).toFixed(1)}MB)`);
        }
      });
      setStatus("ready");
      return "ready";
    } catch (e) {
      console.warn("[tts-preload] ZipVoice 资源拉取失败（不影响 WebSpeech）:", e instanceof Error ? e.message : e);
      setStatus("failed");
      return "failed";
    }
  })().finally(() => {
    // 允许下次登录/刷新后重新触发（下载中断可续传）
    preloadPromise = null;
  });

  return preloadPromise;
}
