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

    // 检测 200 状态下的空壳响应（如 ModelScope 在模型不可用/参数错误时返回 choices:null）
    const choices = data.choices as Array<{ message?: { content?: unknown } }> | null | undefined;
    const content = typeof choices?.[0]?.message?.content === "string" ? choices[0].message.content : null;
    if (content === null) {
      const model = typeof data.model === "string" ? data.model : "";
      const errBody = typeof data.error === "string" ? data.error
        : data.error ? JSON.stringify(data.error)
        : raw.slice(0, 300);
      throw new APIError(
        `API 返回了空结果（choices 为空）${model ? `，模型：${model}` : ""}。` +
        `可能原因：模型名称不存在或无权访问、请求参数不被支持。原始响应：${errBody}`,
        "server",
        response.status,
        raw
      );
    }

    return {
      content,
      tokensUsed: {
        input: (data.usage as { prompt_tokens?: number } | undefined)?.prompt_tokens || 0,
        output: (data.usage as { completion_tokens?: number } | undefined)?.completion_tokens || 0,
        total: (data.usage as { total_tokens?: number } | undefined)?.total_tokens || 0,
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
        } catch {
          // 代理也失败了，抛出原始错误
          throw err;
        }
      }
    },
  };
}
