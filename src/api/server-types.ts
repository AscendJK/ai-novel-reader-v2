/**
 * 服务端 API 响应类型定义
 * 为前端 API 调用提供类型安全
 */

// ============================================================
// 小说相关
// ============================================================

/** 小说元数据 */
export interface NovelInfo {
  id: string;
  title: string;
  author?: string;
  fileName: string;
  fileFormat: string;
  totalChars: number;
  chapterCount: number;
  createdAt: number;
  updatedAt: number;
  /** 是否已加入书架（仅书库查询时返回） */
  joined?: boolean;
}

/** 章节信息 */
export interface ChapterInfo {
  id: string;
  novelId: string;
  index: number;
  title: string;
  content: string;
  startOffset?: number;
  endOffset?: number;
}

/** 上传小说请求 */
export interface UploadNovelRequest {
  novel: Omit<NovelInfo, "joined">;
  chapters: Omit<ChapterInfo, "novelId">[];
}

// ============================================================
// RAG 相关
// ============================================================

/** RAG 构建状态 */
export type RagBuildStatus = "none" | "queued" | "loading" | "building" | "encoding" | "ready" | "error";

/** RAG 状态响应 */
export interface RagStatusResponse {
  status: RagBuildStatus;
  current?: number;
  total?: number;
  chunkCount?: number;
  dim?: number;
  queuePosition?: number;
  error?: string;
  engine?: string;
  updatedAt?: number;
}

/** RAG 构建触发响应 */
export interface RagBuildResponse {
  status: RagBuildStatus;
  queuePosition?: number;
  error?: string;
}

/** RAG 索引数据响应 */
export interface RagIndexResponse {
  chunks: Array<{ id: string; content: string } | string>;
  vectorsBase64: string;
  chunkCount: number;
  dim: number;
  engine: string;
}

/** RAG 编码请求 */
export interface RagEncodeRequest {
  texts: string[];
  engine: string;
}

/** RAG 编码响应 */
export interface RagEncodeResponse {
  vectors: number[][];
}

/** RAG 查询响应 */
export interface RagQueryResponse {
  results: Array<{
    content: string;
    score: number;
    chapterId?: string;
    chapterTitle?: string;
  }>;
  engine: string;
}

// ============================================================
// 同步相关
// ============================================================

/** 同步注册请求 */
export interface SyncRegisterRequest {
  username: string;
  mode: "create" | "join";
  clientId: string;
}

/** 同步注册响应 */
export interface SyncRegisterResponse {
  success: boolean;
  token?: string;
  activeCount?: number;
  data?: {
    summaries: Array<{ id: string; novelId: string; chapterId: string; type: string; content: string; updatedAt?: number }>;
    notes: Array<{ id: string; novelId: string; chapterId: string; content: string; updatedAt?: number }>;
    settings?: Record<string, unknown>;
    progress?: {
      readingPositions?: Record<string, { chapterId: string; chapterIndex: number }>;
      lastOpened?: Record<string, number>;
    };
  };
  error?: string;
  conflict?: boolean;
}

/** 同步推送请求 */
export interface SyncPushRequest {
  username: string;
  clientId: string;
  changes: {
    summaries?: Array<{ id: string; novelId: string; chapterId: string; type: string; content: string; updatedAt?: number }>;
    notes?: Array<{ id: string; novelId: string; chapterId: string; content: string; updatedAt?: number }>;
    settings?: Record<string, unknown>;
    progress?: {
      readingPositions?: Record<string, { chapterId: string; chapterIndex: number }>;
      lastOpened?: Record<string, number>;
    };
  };
  lastSyncTime: number;
}

/** 同步推送响应 */
export interface SyncPushResponse {
  merged: boolean;
  data: {
    summaries: Array<{ id: string; novelId: string; chapterId: string; type: string; content: string; updatedAt?: number }>;
    notes: Array<{ id: string; novelId: string; chapterId: string; content: string; updatedAt?: number }>;
    settings?: Record<string, unknown>;
    progress?: {
      readingPositions?: Record<string, { chapterId: string; chapterIndex: number }>;
      lastOpened?: Record<string, number>;
    };
  };
}

/** 心跳响应 */
export interface HeartbeatResponse {
  activeCount: number;
}

// ============================================================
// 代理相关
// ============================================================

/** 代理聊天请求 */
export interface ProxyChatRequest {
  url: string;
  headers?: Record<string, string>;
  body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
    [key: string]: unknown;
  };
}

/** 代理聊天响应 */
export interface ProxyChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============================================================
// 管理后台相关
// ============================================================

/** 管理后台统计信息 */
export interface AdminStats {
  userCount: number;
  novelCount: number;
  summaryCount: number;
  noteCount: number;
  dbSize: number;
  uptime: number;
}

/** 管理后台用户信息 */
export interface AdminUserInfo {
  username: string;
  novelCount: number;
  summaryCount: number;
  noteCount: number;
  lastSyncAt?: number;
  isOnline: boolean;
}

/** 管理后台小说信息 */
export interface AdminNovelInfo {
  id: string;
  title: string;
  author?: string;
  chapterCount: number;
  totalChars: number;
  userCount: number;
  hasRagIndex: boolean;
  createdAt: number;
}

// ============================================================
// 通用类型
// ============================================================

/** API 错误响应 */
export interface ApiErrorResponse {
  error: string;
  details?: unknown;
  statusCode?: number;
}

/** 分页参数 */
export interface PaginationParams {
  page?: number;
  pageSize?: number;
}

/** 分页响应 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * 类型守卫：检查响应是否为错误
 */
export function isApiError(response: unknown): response is ApiErrorResponse {
  return (
    typeof response === "object" &&
    response !== null &&
    "error" in response &&
    typeof (response as ApiErrorResponse).error === "string"
  );
}

/**
 * 安全解析 API 响应
 * 如果响应是错误，抛出 Error
 * 否则返回类型化的数据
 */
export async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json();

  if (!response.ok) {
    const error = isApiError(data) ? data.error : `请求失败 (${response.status})`;
    throw new Error(error);
  }

  return data as T;
}
