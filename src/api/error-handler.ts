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
 * 认的是**前缀**而不是整句：空正文的措辞会随手上的证据变（见下面那只 `emptyResultNote`——
 * 有思考证据就说"思考吃满了预算"），锚不许跟着文案漂。
 * provider 抛的那句与 agent 自己判空白正文时写的那句都算。
 *
 * 用途只有一个：agent 的降级重发要靠它决定"这一发要不要关掉模型思考再试"。
 * 所以超时、CORS、限流、解析失败一律不算——那些时候关思考是白关。
 */
const EMPTY_RESULT_MESSAGE = /^API 返回了空(结果|响应)/;

export function isEmptyResultError(err: unknown): boolean {
  return err instanceof Error && EMPTY_RESULT_MESSAGE.test(err.message);
}

/**
 * 空正文那句报错该怎么说。**两条腿共用这一份**，谁都不许自己抄一遍文案。
 *
 * 有思考证据才说"思考吃满了预算"——2026-09-27 真厂商实测到
 * `completion_tokens=8192 / reasoning_tokens=8192 / 正文 0 字`，思考与正文共用同一份输出预算，
 * 这时候旧文案猜的那三种原因（模型名不存在、无权访问、参数不支持）全是假话：名对、参对、密钥对。
 * 没证据或数字是 0，就照旧说那三种猜测，**不替厂商编一个原因**。
 *
 * 三家给的证据长得不一样，所以数字得由调用方挑好了传进来：OpenAI 格式的非流式与主流厂商在
 * `usage.completion_tokens_details.reasoning_tokens`；Anthropic 格式没这个字段，它的思考是
 * `content` 里的 thinking 块、预算记在 `usage.output_tokens`（正文一个字都没有时那一发输出的
 * 就是思考花掉的）。**还有一类只给流里的 `delta.reasoning_content`、usage 里什么都不给**
 * （2026-09-27 实测：modelscope 的 vllm 版 `ZhipuAI/GLM-5.3-Flash`，`982 帧 / 正文 0 字 /
 * reasoning_content 3002 字`）——那种时候只有字数可说，就报字数，**不换算成 token 糊人**。
 * 传错的不是这句文案的事，是"到底有没有证据"的事，判据在各自那条腿里。
 */
export function emptyResultNote(reasoningTokens: unknown, reasoningChars?: unknown): string {
  if (typeof reasoningTokens === "number" && reasoningTokens > 0) {
    return `模型把 ${reasoningTokens} token 花在思考上、一个字正文都没回（思考与正文共用同一份输出预算）。` +
      `可以在设置里关闭思考，或调大输出上限。`;
  }
  if (typeof reasoningChars === "number" && reasoningChars > 0) {
    return `模型把这一发花在思考上、一个字正文都没回（响应里回的是 ${reasoningChars} 字思考，` +
      `这一家没给 token 明细）。可以在设置里关闭思考，或调大输出上限。`;
  }
  return "可能原因：模型名称不存在或无权访问、请求参数不被支持。";
}

/**
 * 「这一发没拿到答案，而且是路的问题」的唯一判法。分两样，待遇正好相反，所以必须分得开：
 *  · `"timeout"`：到期了 —— 再撞一发划算（provider 两条腿各自到期的那句原话、代理回过来的 504/524）。
 *  · `"unreachable"`：请求根本没出浏览器（CORS 被拦、地址写错、断网）—— 再撞一发只是白等。
 * 认不到一律 `null`，交回调用方按普通错误处理。**不许猜**：猜成 timeout 会把 401 也重发一发。
 *
 * 为什么要单独立一处：`map-agent.ts` 过去自己抄了一遍，拿 `message.includes("CORS"|"blocked"|"524")`
 * 去认，而全仓没有任何代码会产出带 "CORS" 的错误（浏览器 fetch 出不了门只说 `Failed to fetch`，
 * `blocked` 只有 IndexedDB 那只在用）——那一支因此永远走不到；真到期的是代理那句
 * HTTP 504（`server/routes/proxy.js:211`），它不带 "524" 字样，于是也判不成超时。
 *
 * `APIError` 那一支只看状态码：`classifyError` 从不产出 apiCode `"network"`（浏览器 fetch 失败
 * 压根没有 HTTP 响应可分类），5xx 一律归 `"server"`，所以 504/524 只能按 statusCode 认。
 * 用户取消（AbortError）两句原话都不沾，自然落到 `null`。
 */
export type TransportFailure = "timeout" | "unreachable";

/** provider 腿到期的原话（`openai.ts:52`、`anthropic.ts:41`：`${leg}超时（N 秒无响应）…`） */
const LEG_TIMEOUT_MESSAGE = /超时|timeout/i;
/** 三个引擎对"请求出不了门"各自给的原话（实现给的，不是我们造的） */
const UNREACHABLE_MESSAGE = /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|XHR error)/i;

export function classifyTransportFailure(err: unknown): TransportFailure | null {
  if (err instanceof APIError) {
    const s = err.statusCode;
    return s === 504 || s === 524 ? "timeout" : null;
  }
  if (!(err instanceof Error)) return null;
  if (LEG_TIMEOUT_MESSAGE.test(err.message)) return "timeout";
  return UNREACHABLE_MESSAGE.test(err.message) ? "unreachable" : null;
}

/**
 * `unreachable` 那句要说的话——**唯一出处**，地图与图谱都从这里取（刀账 TF3 在
 * `graph-agent.test.ts`：改这里的一个字，两处同时红；只红一处就说明还有一只用手抄的字面）。
 *
 * 为什么这句话值得共用：症状是同一条——请求压根没到厂商，重试只是白等。而"后端已经关了"
 * 也走这一句（`apiFetch` 原样返回 `fetch(...)`，`src/lib/api-client.ts:104`，同源请求出不了门
 * 同样只给 `TypeError: Failed to fetch`），所以它必须同时点出"改用支持代理的服务商"这条出路。
 */
export const UNREACHABLE_HINT = "API 请求没能出得去：浏览器直连被 CORS 拦下、API 地址写错、后端没在跑或已经断网。请检查 API 地址，或改用支持服务器代理的服务商。";

/**
 * 「厂商答了，答的是**这一场不接**」：认证不过（401/403）、额度用尽（402）、限流（429）。
 * 这三种重发第二发只会再撞一次同一个答案——Key 不会自己变对、余额不会自己回来、
 * 而限流窗口最坏被自己往后推。所以拿到它们**别再打**，直接把厂商那句交回界面。
 *
 * 与 `classifyTransportFailure` 是两回事，不许并成一栏：那一位判的是"路的问题"
 * （到期值得再撞、请求没出浏览器别白撞），这一位判的是"厂商明确拒了"。
 * 500/504 也**不在这里**——那是服务瞬时不可用，再撞一发是划算的。
 *
 * 只认 `apiCode`，不认 message 字面：`map-agent.ts` 上一版手抄字面判错过一次
 * （判据用假夹具绿着、产品那一支永远走不到）。认不到一律 `null`。
 */
export function classifyVendorRefusal(err: unknown): APIErrorCode | null {
  return err instanceof APIError
    && (err.apiCode === "auth" || err.apiCode === "quota_exceeded" || err.apiCode === "rate_limit")
    ? err.apiCode
    : null;
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
