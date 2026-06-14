/**
 * 统一错误处理模块
 * 提供标准化的错误类型和处理函数
 */

// ============================================================
// 错误类型定义
// ============================================================

/** 错误严重程度 */
export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

/** 错误代码（统一） */
export type ErrorCode =
  | 'UNKNOWN'
  | 'NETWORK'
  | 'AUTH'
  | 'DATABASE'
  | 'VALIDATION'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'API_ERROR'
  | 'SYNC_ERROR'
  | 'PARSER_ERROR'
  // API 专用错误代码
  | 'RATE_LIMIT'
  | 'QUOTA_EXCEEDED'
  | 'CONTEXT_LENGTH'
  | 'SERVER_ERROR';

/** 应用错误类 */
export class AppError extends Error {
  constructor(
    message: string,
    public code: ErrorCode = 'UNKNOWN',
    public severity: ErrorSeverity = 'medium',
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** API 错误响应 */
interface ApiErrorResponse {
  error?: string;
  message?: string;
  details?: unknown;
}

// ============================================================
// 错误处理函数
// ============================================================

/**
 * API 错误代码映射（从 APIError.code 到 ErrorCode）
 */
const API_ERROR_CODE_MAP: Record<string, ErrorCode> = {
  'auth': 'AUTH',
  'network': 'NETWORK',
  'context_length': 'CONTEXT_LENGTH',
  'rate_limit': 'RATE_LIMIT',
  'quota_exceeded': 'QUOTA_EXCEEDED',
  'server': 'SERVER_ERROR',
  'unknown': 'API_ERROR',
};

/**
 * 标准化错误对象
 * 将各种类型的错误转换为 AppError
 */
export function normalizeError(error: unknown, context?: string): AppError {
  // 已经是 AppError
  if (error instanceof AppError) {
    return error;
  }

  // 检查是否是 APIError（通过 name 属性判断，避免循环依赖）
  if (error instanceof Error && error.name === 'APIError') {
    const apiError = error as any;
    const mappedCode = API_ERROR_CODE_MAP[apiError.code] || 'API_ERROR';
    return new AppError(
      apiError.message,
      mappedCode,
      mappedCode === 'AUTH' ? 'high' : 'medium',
      {
        original: error,
        statusCode: apiError.statusCode,
        originalBody: apiError.originalBody,
        apiCode: apiError.code,
      }
    );
  }

  // 标准 Error
  if (error instanceof Error) {
    // 检查是否是 AbortError
    if (error.name === 'AbortError') {
      return new AppError(
        error.message,
        'ABORTED',
        'low',
        { original: error }
      );
    }

    // 检查是否是网络错误
    if (error.message.includes('fetch') || error.message.includes('network')) {
      return new AppError(
        error.message,
        'NETWORK',
        'medium',
        { original: error }
      );
    }

    return new AppError(
      error.message,
      'UNKNOWN',
      'medium',
      { original: error }
    );
  }

  // 字符串错误
  if (typeof error === 'string') {
    return new AppError(error, 'UNKNOWN', 'medium');
  }

  // 其他类型
  return new AppError(
    String(error),
    'UNKNOWN',
    'low',
    { original: error }
  );
}

/**
 * 处理错误（统一入口）
 * @param error 错误对象
 * @param context 错误上下文描述
 * @param silent 是否静默处理（只记录日志，不抛出）
 */
export function handleError(
  error: unknown,
  context: string = 'Unknown',
  silent: boolean = true
): AppError {
  const appError = normalizeError(error, context);

  // 记录日志
  const logMessage = `[${appError.code}] ${context}: ${appError.message}`;

  switch (appError.severity) {
    case 'critical':
    case 'high':
      console.error(logMessage, appError);
      break;
    case 'medium':
      console.warn(logMessage);
      break;
    case 'low':
      console.debug(logMessage);
      break;
  }

  // 如果不静默，抛出错误
  if (!silent) {
    throw appError;
  }

  return appError;
}

/**
 * 创建安全的异步函数包装器
 * 自动捕获并处理错误
 */
export function safeAsync<T>(
  fn: () => Promise<T>,
  context: string,
  fallback?: T
): Promise<T | undefined> {
  return fn().catch((error) => {
    handleError(error, context);
    return fallback;
  });
}

/**
 * 创建安全的同步函数包装器
 * 自动捕获并处理错误
 */
export function safeSync<T>(
  fn: () => T,
  context: string,
  fallback?: T
): T | undefined {
  try {
    return fn();
  } catch (error) {
    handleError(error, context);
    return fallback;
  }
}

// ============================================================
// 用户友好的错误消息
// ============================================================

/**
 * 获取用户友好的错误消息
 */
export function getUserFriendlyMessage(error: unknown): string {
  const appError = normalizeError(error);

  switch (appError.code) {
    case 'NETWORK':
      return '网络连接失败，请检查网络设置';
    case 'AUTH':
      return '认证失败，请检查 API Key 是否正确';
    case 'DATABASE':
      return '数据访问失败，请刷新页面重试';
    case 'VALIDATION':
      return '输入数据无效，请检查后重试';
    case 'TIMEOUT':
      return '请求超时，请稍后重试';
    case 'ABORTED':
      return '操作已取消';
    case 'API_ERROR':
      return 'API 调用失败，请检查配置';
    case 'SYNC_ERROR':
      return '同步失败，请检查网络连接';
    case 'PARSER_ERROR':
      return '数据解析失败，请检查文件格式';
    case 'RATE_LIMIT':
      return '请求频率过高，请稍后重试';
    case 'QUOTA_EXCEEDED':
      return 'API 额度已用尽，请充值或等待重置';
    case 'CONTEXT_LENGTH':
      return '请求内容超过模型上下文长度限制';
    case 'SERVER_ERROR':
      return 'API 服务器错误，请稍后重试';
    default:
      return appError.message || '发生未知错误，请重试';
  }
}

// ============================================================
// 错误上报（预留接口）
// ============================================================

/**
 * 上报错误到监控系统（预留接口）
 * 可以接入 Sentry、LogRocket 等服务
 */
export function reportError(error: AppError): void {
  // TODO: 接入错误监控服务
  // Sentry.captureException(error);
  console.debug('[ErrorReporter]', error.code, error.message);
}
