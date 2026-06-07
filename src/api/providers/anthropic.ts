import type { AIProvider, ChatCompletionRequest, ChatCompletionResponse, ProviderConfig } from "../types";
import { APIError, handleFetchError } from "../error-handler";
import { apiFetch } from "@/lib/api-client";
import { useUIStore } from "@/stores/ui-store";

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

  async function parseResponse(response: Response): Promise<ChatCompletionResponse> {
    if (!response.ok) await handleFetchError(response);
    const data = await response.json();
    if (!data || typeof data !== "object") {
      throw new APIError("API 返回了无法识别的响应格式，请检查 API 地址和密钥。", "unknown");
    }
    const content = typeof data.content?.[0]?.text === "string" ? data.content[0].text : "";
    return {
      content,
      tokensUsed: {
        input: data.usage?.input_tokens || 0,
        output: data.usage?.output_tokens || 0,
        total: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
    };
  }

  return {
    type: "anthropic",
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
        if (err instanceof APIError && err.code === "auth") throw err;
        // 其他错误（包括 CORS、网络错误等）都走代理
        try {
          return parseResponse(await doProxy(req));
        } catch (proxyErr) {
          // 代理也失败了，抛出原始错误
          throw err;
        }
      }
    },
  };
}
