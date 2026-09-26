import { AppError, type ErrorCode } from "@/lib/error-handler";

/** API 错误代码类型 */
export type APIErrorCode = "auth" | "network" | "context_length" | "output_limit" | "rate_limit" | "quota_exceeded" | "server" | "unknown";

/** API 错误代码到统一错误代码的映射 */
const API_TO_ERROR_CODE: Record<APIErrorCode, ErrorCode> = {
  "auth": "AUTH",
  "network": "NETWORK",
  "context_length": "CONTEXT_LENGTH",
  "output_limit": "OUTPUT_LIMIT",
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

/**
 * 「这一发一个字正文都没回」的唯一判法。
 *
 * 认的是**前缀**而不是整句：空正文的措辞会随手上的证据变（见 `providers/openai.ts` 的
 * `emptyResultNote`——有 `reasoning_tokens` 就说"思考吃满了预算"），锚不许跟着文案漂。
 * provider 抛的那句与 agent 自己判空白正文时写的那句都算。
 *
 * 用途只有一个：agent 的降级重发要靠它决定"这一发要不要关掉模型思考再试"。
 * 所以超时、CORS、限流、解析失败一律不算——那些时候关思考是白关。
 */
const EMPTY_RESULT_MESSAGE = /^API 返回了空(结果|响应)/;

export function isEmptyResultError(err: unknown): boolean {
  return err instanceof Error && EMPTY_RESULT_MESSAGE.test(err.message);
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

  // 413 / 400 — 长度类错误。这里要分两种，它们的解法正好相反：
  //  · 喂进去的原文太长 → 换更长上下文的模型、或拆短请求；
  //  · 要的输出太长 → 把设置里那个「最大输出 token」调小（跟模型有没有长上下文无关）。
  // 混成一类时第二种收到的是第一条的建议，用户照做也不会有任何变化。
  if (status === 413 || status === 400) {
    const lower = apiMessage.toLowerCase();
    // 输出侧的信号很窄，只认"max_tokens / completion_tokens / 输出长度"这类字样
    const outputSide = /max[_\s-]?tokens|completion[ _]tokens?|maximum output|output[ _]?tokens?|输出长度|输出 ?token|回复长度/.test(lower);
    // 输入侧一旦同时出现，以上下文为准：那种情况真正该减的是原文（厂商给的数字才对得上）
    const inputSide = /context|上下文|prompt|输入长度|输入 ?token|messages/.test(lower);
    const genericLength = /length|maximum|limit|too long|reduce|truncat|token|长度|超限|超过/.test(lower);
    // 413 是"整个请求体太大"，只可能出在喂进去的内容上，不参与输出侧判断
    if (status === 400 && outputSide && !inputSide) {
      return {
        code: "output_limit",
        message: `请求的输出长度超过模型单次允许的上限 (400)。请把设置里的「最大输出 token」调小，或留空用模型默认值。厂商原话：${apiMessage || body.slice(0, 200)}`,
      };
    }
    if (status === 413 || inputSide || genericLength) {
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
