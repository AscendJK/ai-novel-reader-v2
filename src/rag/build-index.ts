/**
 * RAG 索引构建 + 轮询 + 下载的公共函数
 * 消除 embedding-retriever.ts、SummaryPanel.tsx、BookSelect.tsx 中的重复代码
 */

import { apiFetch } from "@/lib/api-client";
import { sharedDB } from "@/db/database";
import { normalizeChunks } from "./chunk-utils";
import { enforceIndexedDBQuota } from "./rag-cache-utils";
import { withQuotaRetry } from "@/lib/quota-guard";
import { ragLog } from "@/lib/logger";

/** API 错误响应格式 */
interface ApiErrorResponse {
  error?: string;
  /** 白名单拒绝时服务端会带回被拒的那只引擎与可选清单 */
  engine?: string;
  allowed?: unknown;
}
import { useRAGStore } from "@/stores/rag-store";

// 全局构建锁，防止重复构建
const activeBuilds = new Map<string, Promise<DownloadResult>>();
// 同一份构建的多个等待者各自订阅进度广播（共享任务不属于任何一个调用方）
const buildListeners = new Map<string, Set<(p: BuildProgress) => void>>();

// ============================================================
// 类型定义
// ============================================================

export type BuildStatus = "none" | "queued" | "loading" | "building" | "encoding" | "downloading" | "ready" | "error";

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
    const allowed = (Array.isArray(err.allowed) ? err.allowed : []).filter((e) => typeof e === "string");
    return {
      status: "error",
      // 服务端拒掉这只引擎时（`routes/rag.js:275-277` 回 error + engine + allowed）必须把
      // "是哪只、能换哪几只"一起显示：这条错误最常见的来源就是两侧白名单不同步，只报
      // "不支持的嵌入引擎"等于让用户自己猜该换成谁。
      error: err.error
        ? allowed.length
          ? `${err.error}：${err.engine ?? engine}。可选：${allowed.join("、")}`
          : err.error
        : `构建请求失败 (${resp.status})`,
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
  message?: string;
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

  // 存入 IndexedDB（直接存二进制）；配额不足时自动降级清理并重试
  await withQuotaRetry(async () => {
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
  });

  // 更新 store
  if (updateStore) {
    try {
      useRAGStore.getState().addCachedKey(cacheKey);
    } catch (e) { console.warn("[rag] 更新缓存 key 失败:", e); }
  }

  // 清理超限缓存；把刚下载完的这本也保护住——否则它会立刻被自己触发的这轮
  // 淘汰清掉，之后每次检索都重新下一遍（round 2 R-26）
  await enforceIndexedDBQuota([novelId]);

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
 *   engine: "Xenova/bge-small-zh-v1.5",
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
  let shared = activeBuilds.get(buildKey);
  if (!shared) {
    ragLog(`启动构建任务: ${buildKey}`);
    shared = doBuild({
      novelId,
      engine,
      pollInterval,
      timeout,
      maxFailCount,
      buildKey,
      // 不把发起者的 signal 交给共享任务：任何一个人的取消只该让他自己退出等待，
      // 其余等待者仍在等同一份构建（旧实现首个预取被取消会连带 reject 所有人）
      signal: undefined,
      onProgress: (p) => {
        for (const listener of buildListeners.get(buildKey) ?? []) {
          try { listener(p); } catch { /* 单个订阅者出错不影响其他人 */ }
        }
      },
    }).finally(() => {
      activeBuilds.delete(buildKey);
      buildListeners.delete(buildKey);
    });
    activeBuilds.set(buildKey, shared);
  } else {
    ragLog(`构建任务已存在: ${buildKey}，等待完成...`);
  }

  if (!onProgress) return await raceWithAbort(shared, signal);

  const listeners = buildListeners.get(buildKey) ?? new Set<NonNullable<BuildOptions["onProgress"]>>();
  listeners.add(onProgress);
  buildListeners.set(buildKey, listeners);
  try {
    return await raceWithAbort(shared, signal);
  } finally {
    listeners.delete(onProgress);
  }
}

/** 调用方取消时只让自己退出；共享构建继续为其他等待者跑完 */
async function raceWithAbort<T>(shared: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await shared;
  if (signal.aborted) throw new Error("操作已取消");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("操作已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); }
    );
  });
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

        if (result.status === "downloading") {
          message = result.message || "正在下载嵌入模型...";
          displayStatus = "loading";
        } else if (result.status === "queued" && hasBeenBuilding) {
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
  } catch (e) { console.warn(`[rag] 下载/缓存索引检查失败 (${novelId}-${engine}):`, e); }
  return null;
}
