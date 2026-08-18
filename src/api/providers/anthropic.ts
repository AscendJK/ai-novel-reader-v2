import type { AIProvider, ChatCompletionRequest, ChatCompletionResponse, ProviderConfig } from "../types";
import { APIError, handleFetchError } from "../error-handler";
import { apiFetch } from "@/lib/api-client";
import { useUIStore } from "@/stores/ui-store";
import { readSSEData } from "./stream";

export function createAnthropicProvider(config: ProviderConfig): AIProvider {
  const baseUrl = config.baseUrl || "https://api.anthropic.com/v1";

  function buildMessages(req: ChatCompletionRequest) {
    let systemPrompt = "";
    const messages: { role: string; content: string }[] = [];
    for (const msg of req.messages) {
      if (msg.role === "system") {
        systemPrompt += (systemPrompt ? "\n" : "") + msg.content;
      } else {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    return { systemPrompt, messages };
  }

  function buildBody(req: ChatCompletionRequest) {
    const { systemPrompt, messages } = buildMessages(req);
    const body: Record<string, unknown> = {
      model: config.model || req.model || "claude-sonnet-4-6",
      max_tokens: req.max_tokens ?? config.maxTokens ?? 2048,
      messages,
      stream: true, // 统一使用流式，避免部分 API 非流式返回空壳
    };
    if (systemPrompt) body.system = systemPrompt;
    return body;
  }

  async function doDirect(req: ChatCompletionRequest): Promise<Response> {
    return fetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(buildBody(req)),
    });
  }

  async function doProxy(req: ChatCompletionRequest): Promise<Response> {
    return apiFetch("/api/proxy/chat", {
      method: "POST",
      signal: req.signal,
      body: JSON.stringify({
        url: `${baseUrl}/messages`,
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: buildBody(req),
      }),
    });
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

      try {
        return parseResponse(await doDirect(req));
      } catch (err) {
        // 如果是取消请求，直接抛出
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        // 如果是认证错误，直接抛出（代理也无法解决）
        if (err instanceof APIError && (err.apiCode === "auth" || err.code === "AUTH")) throw err;
        // 其他错误（包括 CORS、网络错误等）都走代理
        try {
          return parseResponse(await doProxy(req));
        } catch {
          // 代理也失败了，抛出原始错误
          throw err;
        }
      }
    },
  };
}
