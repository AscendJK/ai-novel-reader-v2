/**
 * RAG 索引构建 + 轮询 + 下载的公共函数
 * 消除 embedding-retriever.ts、SummaryPanel.tsx、BookSelect.tsx 中的重复代码
 */

import { authHeaders } from "@/lib/auth-headers";
import { apiFetch } from "@/lib/api-client";
import { sharedDB } from "@/db/database";
import { normalizeChunks } from "./chunk-utils";
import { enforceIndexedDBQuota, ensureCacheSpace, updateAccessTime } from "./rag-cache-utils";
import { ragLog } from "@/lib/logger";

/** API 错误响应格式 */
interface ApiErrorResponse {
  error?: string;
}
import { useRAGStore } from "@/stores/rag-store";

// 全局构建锁，防止重复构建
const activeBuilds = new Map<string, Promise<DownloadResult>>();

// ============================================================
// 类型定义
// ============================================================

export type BuildStatus = "none" | "queued" | "loading" | "building" | "encoding" | "ready" | "error";

export interface BuildProgress {
  status: BuildStatus;
  message?: string;
  current?: number;
  total?: number;
  queuePosition?: number;
}

export interface BuildOptions {
  /** 小说 ID */
  novelId: string;
  /** 引擎名称 */
  engine: string;
  /** 进度回调 */
  onProgress?: (progress: BuildProgress) => void;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 轮询间隔（毫秒），默认 3000 */
  pollInterval?: number;
  /** 超时时间（毫秒），默认 600000（10分钟） */
  timeout?: number;
  /** 最大连续失败次数，默认 10 */
  maxFailCount?: number;
}

export interface DownloadOptions {
  /** 小说 ID */
  novelId: string;
  /** 引擎名称 */
  engine: string;
  /** 是否更新 RAGStore 的 cachedKeys，默认 true */
  updateStore?: boolean;
}

export interface DownloadResult {
  /** 缓存 key */
  cacheKey: string;
  /** chunks 数量 */
  chunkCount: number;
  /** 向量维度 */
  dim: number;
}

// ============================================================
// 触发构建
// ============================================================

interface BuildTriggerResult {
  status: BuildStatus;
  queuePosition?: number;
  error?: string;
}

/**
 * 触发服务端 RAG 索引构建
 * @returns 构建触发结果
 */
async function triggerBuild(novelId: string, engine: string): Promise<BuildTriggerResult> {
  const resp = await apiFetch(`/api/rag/${novelId}/build`, {
    method: "POST",
    body: JSON.stringify({ engine }),
  });

  if (!resp.ok) {
    const err: ApiErrorResponse = await resp.json().catch(() => ({}));
    return {
      status: "error",
      error: err.error || `构建请求失败 (${resp.status})`,
    };
  }

  const result = await resp.json();

  if (result.status === "busy") {
    return {
      status: "error",
      error: "服务器繁忙，当前排队已满",
    };
  }

  return {
    status: result.status || "building",
    queuePosition: result.queuePosition,
  };
}

// ============================================================
// 轮询状态
// ============================================================

interface PollResult {
  status: BuildStatus;
  current?: number;
  total?: number;
  queuePosition?: number;
  error?: string;
}

/**
 * 查询构建状态
 */
async function fetchBuildStatus(novelId: string, engine: string): Promise<PollResult> {
  const resp = await apiFetch(
    `/api/rag/${novelId}/status?engine=${encodeURIComponent(engine)}`
  );

  if (!resp.ok) {
    throw new Error(`状态查询失败 (${resp.status})`);
  }

  const data = await resp.json();

  return {
    status: data.status,
    current: data.current,
    total: data.total,
    queuePosition: data.queuePosition,
    error: data.error,
  };
}

// ============================================================
// 下载索引
// ============================================================

/**
 * 从服务端下载构建好的索引并存入 IndexedDB
 */
export async function downloadAndCacheIndex(options: DownloadOptions): Promise<DownloadResult> {
  const { novelId, engine, updateStore = true } = options;
  const cacheKey = `${novelId}-${engine}`;

  const resp = await apiFetch(
    `/api/rag/${novelId}/index?engine=${encodeURIComponent(engine)}`
  );

  if (!resp.ok) {
    throw new Error(`索引下载失败 (${resp.status})`);
  }

  // 解析二进制响应
  const buffer = await resp.arrayBuffer();

  // 边界验证
  if (buffer.byteLength < 12) {
    throw new Error("索引数据过小，无法解析 header");
  }

  const headerView = new DataView(buffer.slice(0, 12));
  const chunksJsonLen = headerView.getUint32(0, true);
  const dim = headerView.getUint32(4, true);
  const chunkCount = headerView.getUint32(8, true);

  // 验证 header 值的合理性
  if (dim === 0 || dim > 4096) {
    throw new Error(`向量维度异常: ${dim}`);
  }
  if (chunkCount === 0 || chunkCount > 1000000) {
    throw new Error(`chunk 数量异常: ${chunkCount}`);
  }

  const expectedMinSize = 12 + chunksJsonLen;
  if (expectedMinSize > buffer.byteLength) {
    throw new Error(`chunksJsonLen (${chunksJsonLen}) 超出数据范围`);
  }

  const expectedVectorBytes = chunkCount * dim * 4;
  const actualVectorBytes = buffer.byteLength - expectedMinSize;
  if (actualVectorBytes < expectedVectorBytes) {
    throw new Error(`向量数据不完整: 期望 ${expectedVectorBytes} 字节, 实际 ${actualVectorBytes} 字节`);
  }

  // 解析 chunks JSON
  const chunksJsonBytes = new Uint8Array(buffer.slice(12, 12 + chunksJsonLen));
  const chunksJson = new TextDecoder().decode(chunksJsonBytes);
  const chunks = JSON.parse(chunksJson);

  // 提取 vectors 二进制数据
  const vectorsBuffer = buffer.slice(12 + chunksJsonLen);

  // 存入 IndexedDB（直接存二进制）
  await sharedDB.ragCache.put({
    id: cacheKey,
    novelId,
    engine,
    vectorsBuffer,
    chunks: normalizeChunks(chunks),
    dim,
    chunkCount,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    accessCount: 0,
  });

  // 更新 store
  if (updateStore) {
    try {
      useRAGStore.getState().addCachedKey(cacheKey);
    } catch { /* ignore */ }
  }

  // 清理超限缓存（合并了 ensureCacheSpace 的逻辑，只执行一次全表扫描）
  enforceIndexedDBQuota();

  ragLog(`索引下载完成: ${chunkCount} 片段 · ${dim} 维`);

  return {
    cacheKey,
    chunkCount,
    dim,
  };
}

// ============================================================
// 主函数：构建 + 轮询 + 下载
// ============================================================

/**
 * 触发 RAG 索引构建，轮询状态，完成后下载到本地缓存
 * 内置去重机制，同一 novelId+engine 只会有一个构建任务在运行
 *
 * @example
 * ```ts
 * await buildAndPollRAGIndex({
 *   novelId: "xxx",
 *   engine: "bge-small-zh",
 *   onProgress: (p) => console.log(p.message),
 * });
 * ```
 */
export async function buildAndPollRAGIndex(options: BuildOptions): Promise<DownloadResult> {
  const {
    novelId,
    engine,
    onProgress,
    signal,
    pollInterval = 3000,
    timeout = 600_000,
    maxFailCount = 10,
  } = options;

  const buildKey = `${novelId}-${engine}`;

  // 检查是否已有构建任务在运行
  const existingBuild = activeBuilds.get(buildKey);
  if (existingBuild) {
    ragLog(`构建任务已存在: ${buildKey}，等待完成...`);
    return existingBuild;
  }

  // 创建新的构建任务
  const buildPromise = doBuild({
    novelId,
    engine,
    onProgress,
    signal,
    pollInterval,
    timeout,
    maxFailCount,
    buildKey,
  });

  // 存储到活跃构建 Map
  activeBuilds.set(buildKey, buildPromise);

  try {
    const result = await buildPromise;
    return result;
  } finally {
    // 清理活跃构建记录
    activeBuilds.delete(buildKey);
  }
}

/**
 * 实际的构建逻辑
 */
async function doBuild(options: BuildOptions & { buildKey: string }): Promise<DownloadResult> {
  const {
    novelId,
    engine,
    onProgress,
    signal,
    pollInterval = 3000,
    timeout = 600_000,
    maxFailCount = 10,
    buildKey,
  } = options;

  // 1. 触发构建
  const triggerResult = await triggerBuild(novelId, engine);

  if (triggerResult.status === "error") {
    throw new Error(triggerResult.error);
  }

  // 如果已经是 ready 状态（理论上不会，但防御性编程）
  if (triggerResult.status === "ready") {
    return downloadAndCacheIndex({ novelId, engine });
  }

  // 报告初始状态
  onProgress?.({
    status: triggerResult.status,
    message: triggerResult.status === "queued"
      ? `排队中 (第 ${triggerResult.queuePosition} 位)...`
      : "服务器构建中...",
    queuePosition: triggerResult.queuePosition,
  });

  // 2. 轮询状态
  return new Promise<DownloadResult>((resolve, reject) => {
    let failCount = 0;
    let elapsed = 0;
    let hasBeenBuilding = false; // 跟踪是否已经开始构建

    const timer = setInterval(async () => {
      // 检查取消
      if (signal?.aborted) {
        clearInterval(timer);
        reject(new Error("操作已取消"));
        return;
      }

      // 检查超时
      elapsed += pollInterval;
      if (elapsed > timeout) {
        clearInterval(timer);
        reject(new Error("构建超时，请稍后刷新状态"));
        return;
      }

      try {
        const result = await fetchBuildStatus(novelId, engine);
        failCount = 0;

        // 构建完成
        if (result.status === "ready") {
          clearInterval(timer);
          try {
            const downloadResult = await downloadAndCacheIndex({ novelId, engine });
            resolve(downloadResult);
          } catch (err) {
            reject(err);
          }
          return;
        }

        // 构建失败
        if (result.status === "error") {
          clearInterval(timer);
          reject(new Error(result.error || "构建失败"));
          return;
        }

        // 标记已经开始构建（避免状态回退到 queued）
        if (result.status === "building" || result.status === "loading" || result.status === "encoding") {
          hasBeenBuilding = true;
        }

        // 更新进度（如果已经开始构建，不再显示 queued 状态）
        let message: string;
        let displayStatus = result.status;

        if (result.status === "queued" && hasBeenBuilding) {
          // 已经开始构建后，queued 状态视为仍在构建中
          displayStatus = "building";
          message = `正在编码 (${result.current ?? 0}/${result.total ?? "?"})`;
        } else if (result.status === "queued") {
          message = `排队中 (第 ${result.queuePosition || "?"} 位)...`;
        } else if (result.status === "loading") {
          message = "正在加载嵌入模型...";
        } else {
          message = `正在编码 (${result.current ?? 0}/${result.total ?? "?"})`;
        }

        onProgress?.({
          status: displayStatus,
          message,
          current: result.current,
          total: result.total,
          queuePosition: result.queuePosition,
        });

      } catch (err) {
        failCount++;
        ragLog(`轮询失败 (${failCount}/${maxFailCount}): ${err}`);

        if (failCount >= maxFailCount) {
          clearInterval(timer);
          reject(new Error("无法连接服务器，构建状态已停止更新"));
        }
      }
    }, pollInterval);

    // 支持取消信号
    if (signal) {
      signal.addEventListener("abort", () => {
        clearInterval(timer);
        reject(new Error("操作已取消"));
      }, { once: true });
    }
  });
}

// ============================================================
// 便捷函数：仅检查状态并下载（不触发构建）
// ============================================================

/**
 * 检查索引状态，如果已 ready 则下载
 * 用于自动下载服务端已构建但本地未缓存的索引
 */
export async function checkAndDownloadIfReady(
  novelId: string,
  engine: string
): Promise<DownloadResult | null> {
  try {
    const status = await fetchBuildStatus(novelId, engine);
    if (status.status === "ready") {
      return await downloadAndCacheIndex({ novelId, engine });
    }
  } catch { /* ignore */ }
  return null;
}
