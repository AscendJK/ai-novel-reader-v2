export type ProviderFormat = "openai" | "anthropic";

export interface ProviderConfig {
  id: string;
  format: ProviderFormat;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  /** 是否使用流式响应（默认 true）。ModelScope 等服务商强制要求流式；不支持流式的 API 请设为 false */
  stream?: boolean;
  /** 是否启用思考模式（DeepSeek 等推理模型的 thinking 参数）。false 时发送 thinking:{type:disabled} 关闭思考 */
  thinking?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  /** 模型名覆盖；缺省时使用 ProviderConfig.model */
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  /**
   * 请求级思考开关：false 时这一发显式关掉模型思考，优先级高于 `ProviderConfig.thinking`。
   * 给"这一发等于没回话才降级重发"用（`map-agent` / `graph-agent`）：第一发仍然让模型想，
   * 只有确认那一发要么一个字正文都没回、要么被输出上限切成了半截 JSON（见下面 `truncated`），
   * 第二发才关思考重发。摘要/范围总结/问答那三条路只认前一种（半段话仍然能看）。
   */
  thinking?: boolean;
  signal?: AbortSignal;
}

export interface ChatCompletionResponse {
  content: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
  /**
   * 厂商说这一发**被输出上限切断了**（OpenAI 的 `finish_reason:"length"` /
   * Anthropic 的 `stop_reason:"max_tokens"`）。只在确实是那一档时填 `true`，其余情况不填
   * （`content_filter` 之类别算进来——关思考重发救不了内容策略）。
   *
   * 为什么要有这一格：推理模型把预算花在思考上之后，除了"一个字正文都不回"，还有第二种形状是
   * **挤出半截 JSON**（2026-09-28 真厂商实测：`completion=8192 / 思考 8080 / 正文 246 字 /
   * finish_reason=length`）。地图与图谱要的是整份 JSON，半截与空是同一件事，而 agent 原先只认
   * "空正文"，于是那一发既没触发降级、也没把真正的原因说出来。
   */
  truncated?: boolean;
}

export interface AIProvider {
  format: ProviderFormat;
  chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}
