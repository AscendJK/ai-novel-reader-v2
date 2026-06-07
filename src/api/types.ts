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
