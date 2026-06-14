import { AppError, type ErrorCode } from "@/lib/error-handler";

/** API 错误代码类型 */
export type APIErrorCode = "auth" | "network" | "context_length" | "rate_limit" | "quota_exceeded" | "server" | "unknown";

/** API 错误代码到统一错误代码的映射 */
const API_TO_ERROR_CODE: Record<APIErrorCode, ErrorCode> = {
  "auth": "AUTH",
  "network": "NETWORK",
  "context_length": "CONTEXT_LENGTH",
  "rate_limit": "RATE_LIMIT",
  "quota_exceeded": "QUOTA_EXCEEDED",
  "server": "SERVER_ERROR",
  "unknown": "API_ERROR",
};

/**
 * API 错误类
 * 继承自 AppError，保持向后兼容
 */
export class APIError extends AppError {
  statusCode?: number;
  originalBody?: string;
  apiCode: APIErrorCode;

  constructor(
    message: string,
    code: APIErrorCode,
    statusCode?: number,
    originalBody?: string
  ) {
    const errorCode = API_TO_ERROR_CODE[code] || "API_ERROR";
    const severity = code === "auth" ? "high" : "medium";
    super(message, errorCode, severity, { statusCode, originalBody, apiCode: code });
    this.name = "APIError";
    this.apiCode = code;
    this.statusCode = statusCode;
    this.originalBody = originalBody;
  }
}

function classifyError(status: number, body: string): { code: APIErrorCode; message: string } {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(body); } catch { /* ignore */ }

  const apiMessage = typeof parsed?.error === "string" ? parsed.error as string
    : typeof (parsed?.error as Record<string,unknown>)?.message === "string" ? (parsed?.error as Record<string,unknown>).message as string
    : "";

  // 401 / 403 — auth failure (wrong key, expired key, insufficient permissions)
  if (status === 401 || status === 403) {
    return {
      code: "auth",
      message: `API 认证失败 (${status})：API Key 错误、已过期或无权访问该模型。请检查 Key 是否正确，确认账户状态正常。`,
    };
  }

  // 402 — quota / balance exhausted (common with DeepSeek, some OpenAI-compatible providers)
  if (status === 402) {
    return {
      code: "quota_exceeded",
      message: `API 额度已用尽或账户余额不足 (${status})。请充值或等待额度重置。`,
    };
  }

  // 429 — rate limit
  if (status === 429) {
    const retryAfter = apiMessage || "请稍后重试";
    return {
      code: "rate_limit",
      message: `API 请求频率过高 (429)：${retryAfter}。建议等待几秒后重试，或降低请求频率。`,
    };
  }

  // 413 / 400 — possible context length exceeded
  if (status === 413 || status === 400) {
    const lower = apiMessage.toLowerCase();
    if (
      lower.includes("context") || lower.includes("token") || lower.includes("length") ||
      lower.includes("maximum") || lower.includes("limit") || lower.includes("too long") ||
      lower.includes("reduce") || lower.includes("truncat")
    ) {
      return {
        code: "context_length",
        message: `请求内容超过模型上下文长度限制 (${status})。请尝试使用支持更长上下文的模型，或拆分成较短的请求。`,
      };
    }
    // Other 400 errors — show the actual API message
    return {
      code: "unknown",
      message: `API 请求错误 (${status}): ${apiMessage || body.slice(0, 300)}`,
    };
  }

  // 5xx — server error
  if (status >= 500) {
    return {
      code: "server",
      message: `API 服务器错误 (${status})：服务暂时不可用，请稍后重试。如果持续出现，可能是模型厂商服务中断。`,
    };
  }

  return {
    code: "unknown",
    message: `API 错误 (${status}): ${apiMessage || body.slice(0, 300)}`,
  };
}

export async function handleFetchError(response: Response): Promise<never> {
  const body = await response.text();
  const { code, message } = classifyError(response.status, body);
  throw new APIError(message, code, response.status, body);
}
