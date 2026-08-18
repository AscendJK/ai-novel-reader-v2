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
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  signal?: AbortSignal;
}

export interface ChatCompletionResponse {
  content: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
}

export interface AIProvider {
  format: ProviderFormat;
  chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}
