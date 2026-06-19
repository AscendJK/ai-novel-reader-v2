import type { AIProvider, ChatCompletionRequest, ChatCompletionResponse, ProviderConfig } from "../types";
import { APIError, handleFetchError } from "../error-handler";
import { apiFetch } from "@/lib/api-client";
import { useUIStore } from "@/stores/ui-store";

export function createOpenAIProvider(config: ProviderConfig): AIProvider {
  const baseUrl = config.baseUrl || "https://api.openai.com/v1";

  function buildBody(req: ChatCompletionRequest) {
    return {
      model: config.model || req.model || "gpt-4o",
      messages: req.messages,
      max_tokens: req.max_tokens ?? config.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.7,
    };
  }

  async function doDirect(req: ChatCompletionRequest): Promise<Response> {
    return fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(buildBody(req)),
    });
  }

  async function doProxy(req: ChatCompletionRequest): Promise<Response> {
    return apiFetch("/api/proxy/chat", {
      method: "POST",
      signal: req.signal,
      body: JSON.stringify({
        url: `${baseUrl}/chat/completions`,
        headers: { Authorization: `Bearer ${config.apiKey}` },
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
    return {
      content: typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "",
      tokensUsed: {
        input: data.usage?.prompt_tokens || 0,
        output: data.usage?.completion_tokens || 0,
        total: data.usage?.total_tokens || 0,
      },
    };
  }

  return {
    format: "openai",
    async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const offline = useUIStore.getState().offlineMode;
      const hasToken = !!localStorage.getItem("sync-token");

      // 离线模式或没有 token 时，直接调用（可能失败）
      if (offline || !hasToken) {
        return parseResponse(await doDirect(req));
      }

      try {
        // 先尝试直连
        return parseResponse(await doDirect(req));
      } catch (err) {
        // 如果是取消请求，直接抛出
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        // 如果是认证错误，直接抛出（代理也无法解决）
        if (err instanceof APIError && (err.apiCode === "auth" || err.code === "AUTH")) throw err;
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
