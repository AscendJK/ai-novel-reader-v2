/**
 * tts-preload 预加载逻辑测试
 * 覆盖所有边界：未登录 / 已缓存 / 服务器离线 / 服务器未就绪 / 下载成功 / 下载失败 / 并发单例
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { preloadZipVoice, getTTSPreloadStatus } from "../tts-preload";

// mock tts-cache
vi.mock("../tts-cache", () => ({
  isCacheReady: vi.fn(),
  downloadAndCache: vi.fn(),
}));

// mock zipvoice-engine
vi.mock("../zipvoice-engine", () => ({
  prepareTTS: vi.fn(),
  checkTTSCache: vi.fn(),
}));

// mock user-utils
vi.mock("@/lib/user-utils", () => ({
  isLoggedIn: vi.fn(),
}));

import { isCacheReady, downloadAndCache } from "../tts-cache";
import { prepareTTS, checkTTSCache } from "../zipvoice-engine";
import { isLoggedIn } from "@/lib/user-utils";

const mockIsLoggedIn = vi.mocked(isLoggedIn);
const mockIsCacheReady = vi.mocked(isCacheReady);
const mockDownloadAndCache = vi.mocked(downloadAndCache);
const mockPrepareTTS = vi.mocked(prepareTTS);
const mockCheckTTSCache = vi.mocked(checkTTSCache);

describe("preloadZipVoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsLoggedIn.mockReturnValue(true);
    mockIsCacheReady.mockResolvedValue(false);
    mockDownloadAndCache.mockResolvedValue(new Map());
    mockPrepareTTS.mockResolvedValue(undefined);
    mockCheckTTSCache.mockResolvedValue({ wasmReady: true, modelReady: true, vocoderReady: true });
  });

  // 每个测试结束等待单例 Promise 完全结算，避免泄漏到下一个测试
  afterEach(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("未登录时跳过（不做任何网络/缓存操作）", async () => {
    mockIsLoggedIn.mockReturnValue(false);
    const status = await preloadZipVoice();
    expect(status).toBe("skipped");
    expect(mockIsCacheReady).not.toHaveBeenCalled();
    expect(mockCheckTTSCache).not.toHaveBeenCalled();
  });

  it("已缓存完整时直接返回 ready（幂等，不重复下载）", async () => {
    mockIsCacheReady.mockResolvedValue(true);
    const status = await preloadZipVoice();
    expect(status).toBe("ready");
    expect(mockCheckTTSCache).not.toHaveBeenCalled();
    expect(mockDownloadAndCache).not.toHaveBeenCalled();
  });

  it("服务器离线（status 请求抛错）时跳过，不影响主流程", async () => {
    mockCheckTTSCache.mockRejectedValue(new Error("网络错误"));
    const status = await preloadZipVoice();
    expect(status).toBe("skipped");
    expect(mockDownloadAndCache).not.toHaveBeenCalled();
  });

  it("服务器资源未就绪时跳过（不触发重型下载）", async () => {
    mockCheckTTSCache.mockResolvedValue({ wasmReady: false, modelReady: false, vocoderReady: false });
    const status = await preloadZipVoice();
    expect(status).toBe("skipped");
    expect(mockPrepareTTS).not.toHaveBeenCalled();
    expect(mockDownloadAndCache).not.toHaveBeenCalled();
  });

  it("服务器 vocoder 未就绪时跳过（不触发重型下载）", async () => {
    mockCheckTTSCache.mockResolvedValue({ wasmReady: true, modelReady: true, vocoderReady: false });
    const status = await preloadZipVoice();
    expect(status).toBe("skipped");
    expect(mockPrepareTTS).not.toHaveBeenCalled();
    expect(mockDownloadAndCache).not.toHaveBeenCalled();
  });

  it("服务器就绪时触发 prepareTTS + downloadAndCache，最终 ready", async () => {
    const status = await preloadZipVoice();
    expect(status).toBe("ready");
    expect(mockPrepareTTS).toHaveBeenCalled();
    expect(mockDownloadAndCache).toHaveBeenCalled();
    expect(getTTSPreloadStatus()).toBe("ready");
  });

  it("下载失败时返回 failed 但不抛出异常", async () => {
    mockDownloadAndCache.mockRejectedValue(new Error("下载中断"));
    const status = await preloadZipVoice();
    expect(status).toBe("failed");
  });

  it("并发调用只执行一次（Promise 单例）", async () => {
    let resolveDownload: (() => void) | undefined;
    mockDownloadAndCache.mockImplementation(
      () => new Promise((resolve) => { resolveDownload = () => resolve(new Map()); })
    );
    const p1 = preloadZipVoice();
    const p2 = preloadZipVoice();
    // 同步断言：第二次调用返回同一个 Promise
    expect(p1).toBe(p2);
    // 推进微任务，直到 downloadAndCache mock 被调用并捕获 resolve
    for (let i = 0; i < 10 && !resolveDownload; i++) {
      await Promise.resolve();
    }
    expect(resolveDownload).toBeDefined();
    resolveDownload?.();
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).toBe("ready");
    expect(s2).toBe("ready");
    expect(mockDownloadAndCache).toHaveBeenCalledTimes(1);
  });
});
