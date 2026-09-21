import type { AIProvider, ChatCompletionRequest, ChatCompletionResponse, ProviderConfig } from "../types";
import { APIError, handleFetchError } from "../error-handler";
import { apiFetch } from "@/lib/api-client";
import { useUIStore } from "@/stores/ui-store";
import { readSSEData } from "./stream";
import { normalizeBaseUrl } from "./base-url";
import { proxyWithSessionRetry } from "./proxy-session";

export function createAnthropicProvider(config: ProviderConfig): AIProvider {
  const baseUrl = normalizeBaseUrl(config.baseUrl, "/messages") || "https://api.anthropic.com/v1";

  // 请求头超时（同 openai.ts：直连挂起时中断，超时错误区别于用户取消）
  const REQUEST_TIMEOUT_MS = 120_000;
  const DIRECT_STREAM_TIMEOUT_MS = 30_000;

  const isStreaming = (req: ChatCompletionRequest) => req.stream ?? config.stream !== false;

  async function withTimeout(
    req: ChatCompletionRequest,
    leg: "直连" | "代理",
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<Response>
  ): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
      req.signal?.removeEventListener("abort", onAbort);
    };
    // 已中止的 signal 不会触发新注册的 listener，必须先同步透传一次
    if (req.signal?.aborted) controller.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await run(controller.signal);
    } catch (e) {
      if (timedOut && !req.signal?.aborted) {
        throw new Error(`${leg}超时（${timeoutMs / 1000} 秒无响应），请检查网络或 API 地址`, { cause: e });
      }
      throw e;
    } finally {
      clearTimeout(timer);
      // 不摘 abort 转发监听：响应头到手时 SSE 正文仍在读，提前摘掉会让"停止"
      // 按钮不再中断连接（round 2 R-52，与 openai.ts 同一处）
    }
  }

  function buildMessages(req: ChatCompletionRequest) {
    let systemPrompt = "";
    const merged: { role: string; content: string }[] = [];
    for (const msg of req.messages) {
      if (msg.role === "system") {
        systemPrompt += (systemPrompt ? "\n" : "") + msg.content;
        continue;
      }
      const content = typeof msg.content === "string" ? msg.content : String(msg.content ?? "");
      const last = merged[merged.length - 1];
      // Anthropic 要求 user/assistant 严格交替：QA 里失败或取消的那一轮会把
      // 用户消息留在历史中，下一轮就出现连续两条 user → 400，且之后每次追问
      // 都失败直到用户点"新会话"（round 2 R-36）。同角色合并成一条即可。
      if (last && last.role === msg.role) {
        last.content = last.content ? `${last.content}\n\n${content}` : content;
      } else {
        merged.push({ role: msg.role, content });
      }
    }
    // 首条必须是 user：否则整个请求被拒
    while (merged.length && merged[0].role !== "user") merged.shift();
    return { systemPrompt, messages: merged };
  }

  function buildBody(req: ChatCompletionRequest) {
    const { systemPrompt, messages } = buildMessages(req);
    const body: Record<string, unknown> = {
      model: config.model || req.model || "claude-sonnet-4-6",
      max_tokens: req.max_tokens ?? config.maxTokens ?? 2048,
      // 各 Agent 为 JSON 生成精调的采样参数（如图谱 0.3）必须传递，
      // 丢弃会导致默认 ~1.0 的高随机性、JSON 解析失败率上升
      temperature: req.temperature ?? 0.7,
      messages,
      // 默认开启流式；可在 API 设置中关闭，支持请求级覆盖（与直连超时预算共用判据）
      stream: isStreaming(req),
    };
    if (systemPrompt) body.system = systemPrompt;
    return body;
  }

  async function doDirect(req: ChatCompletionRequest): Promise<Response> {
    // 非流式的响应头等整段生成完才回来，跟着缩会直连白打一次、代理重打一次
    // （同一份 token 花两遍），所以只有流式请求用短预算
    const timeoutMs = isStreaming(req) ? DIRECT_STREAM_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    return withTimeout(req, "直连", timeoutMs, (signal) =>
      fetch(`${baseUrl}/messages`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(buildBody(req)),
      })
    );
  }

  async function doProxy(req: ChatCompletionRequest): Promise<Response> {
    return proxyWithSessionRetry(() =>
      withTimeout(req, "代理", REQUEST_TIMEOUT_MS, (signal) =>
        apiFetch("/api/proxy/chat", {
          method: "POST",
          signal,
          body: JSON.stringify({
            url: `${baseUrl}/messages`,
            headers: {
              "x-api-key": config.apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: buildBody(req),
          }),
        })
      )
    );
  }

  /** 解析 Anthropic 格式的流式 SSE 响应，聚合 content_block_delta 事件中的 text */
  async function parseStreamedResponse(response: Response): Promise<ChatCompletionResponse> {
    const { events, raw } = await readSSEData(response);
    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for (const evt of events) {
      const e = evt as Record<string, unknown>;
      // Anthropic 流式错误块
      if (e.type === "error") {
        const err = e.error as Record<string, unknown> | undefined;
        const msg = typeof err?.message === "string" ? err.message : JSON.stringify(e);
        throw new APIError(`API 返回错误：${msg}`, "server", 200, raw);
      }
      // 文本增量
      if (e.type === "content_block_delta") {
        const delta = e.delta as Record<string, unknown> | undefined;
        if (typeof delta?.text === "string") content += delta.text;
      }
      // 用量统计
      if (e.type === "message_start") {
        const msg = e.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, unknown> | undefined;
        inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
      }
      if (e.type === "message_delta") {
        const usage = e.usage as Record<string, unknown> | undefined;
        outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
      }
    }

    // 流式结束后内容为空 → 抛错（避免静默返回空白结果）
    if (!content.trim()) {
      throw new APIError(
        `API 返回了空结果（流式响应无内容）。可能原因：模型名称不存在或无权访问、请求参数不被支持。原始响应：${raw.slice(0, 300)}`,
        "server",
        200,
        raw
      );
    }

    return {
      content,
      tokensUsed: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
    };
  }

  async function parseResponse(response: Response): Promise<ChatCompletionResponse> {
    if (!response.ok) await handleFetchError(response);
    // 流式响应（SSE）与普通 JSON 响应分流
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      return parseStreamedResponse(response);
    }

    const raw = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new APIError(
        `API 返回了无法解析的响应：${raw.slice(0, 200)}。请检查 API 地址和密钥。`,
        "unknown",
        response.status,
        raw
      );
    }

    // 检测 200 状态下的空壳响应（content 缺失/为空时抛错，避免静默返回空内容）
    const contentArr = data.content as Array<{ text?: unknown }> | null | undefined;
    const content = typeof contentArr?.[0]?.text === "string" ? contentArr[0].text : null;
    if (content === null) {
      const model = typeof data.model === "string" ? data.model : "";
      const errBody = typeof data.error === "string" ? data.error
        : data.error ? JSON.stringify(data.error)
        : raw.slice(0, 300);
      throw new APIError(
        `API 返回了空结果（content 为空）${model ? `，模型：${model}` : ""}。` +
        `可能原因：模型名称不存在或无权访问、请求参数不被支持。原始响应：${errBody}`,
        "server",
        response.status,
        raw
      );
    }

    return {
      content,
      tokensUsed: {
        input: (data.usage as { input_tokens?: number } | undefined)?.input_tokens || 0,
        output: (data.usage as { output_tokens?: number } | undefined)?.output_tokens || 0,
        total: ((data.usage as { input_tokens?: number } | undefined)?.input_tokens || 0) + ((data.usage as { output_tokens?: number } | undefined)?.output_tokens || 0),
      },
    };
  }

  return {
    format: "anthropic",
    async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const offline = useUIStore.getState().offlineMode;
      const hasToken = !!localStorage.getItem("sync-token");

      if (offline || !hasToken) {
        return parseResponse(await doDirect(req));
      }

      // 与 openai.ts 同一处：换腿只解决"这条路走不通"，厂商答过之后再打一次就是
      // 把同一份 token 花两遍，所以解析留在两段 catch 之外。
      let response: Response;
      try {
        response = await doDirect(req);
      } catch (err) {
        // 用户取消：绝不能再打一次
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        try {
          response = await doProxy(req);
        } catch (proxyErr) {
          // 代理在解析前就失败：会话失效要如实报（它最贴近真相），其余保留原始错误
          if (proxyErr instanceof APIError && proxyErr.apiCode === "auth") throw proxyErr;
          throw err;
        }
      }
      return parseResponse(response);
    },
  };
}
