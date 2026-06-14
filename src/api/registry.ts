import type { AIProvider, ProviderConfig } from "./types";
import { createOpenAIProvider } from "./providers/openai";
import { createAnthropicProvider } from "./providers/anthropic";

const providerCache = new Map<string, AIProvider>();

export function getProvider(config: ProviderConfig): AIProvider {
  const cacheKey = `${config.id}:${config.baseUrl}:${config.model}`;
  if (providerCache.has(cacheKey)) return providerCache.get(cacheKey)!;

  let provider: AIProvider;
  if (config.format === "anthropic") {
    provider = createAnthropicProvider(config);
  } else {
    provider = createOpenAIProvider(config);
  }

  providerCache.set(cacheKey, provider);
  return provider;
}

export function clearProviderCache(): void {
  providerCache.clear();
}
