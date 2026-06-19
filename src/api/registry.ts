import type { AIProvider, ProviderConfig } from "./types";
import { createOpenAIProvider } from "./providers/openai";
import { createAnthropicProvider } from "./providers/anthropic";

export function getProvider(config: ProviderConfig): AIProvider {
  // 不缓存 — provider 是轻量闭包，缓存会导致改 API key 后旧 key 继续使用
  if (config.format === "anthropic") {
    return createAnthropicProvider(config);
  }
  return createOpenAIProvider(config);
}

export function clearProviderCache(): void {
  // 保留接口兼容，不再需要清理
}
