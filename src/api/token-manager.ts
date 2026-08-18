// Rough token estimation: ~1 token per Chinese char, ~1 token per 3.5 English chars
// 中文按 1 字 ≈ 1 token（接近 Qwen/主流中文 tokenizer 的真实值，偏保守安全）
export function estimateTokens(text: string): number {
  let chineseChars = 0;
  let otherChars = 0;

  for (const char of text) {
    if (/[一-鿿㐀-䶿\u{20000}-\u{2a6df}]/u.test(char)) {
      chineseChars++;
    } else if (/\s/.test(char)) {
      otherChars += 0.25;
    } else {
      otherChars++;
    }
  }

  return Math.ceil(chineseChars + otherChars / 3.5);
}

export interface TokenBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
}

const MODEL_LIMITS: Record<string, TokenBudget> = {
  // ── OpenAI ──
  "gpt-4o": { maxInputTokens: 128000, maxOutputTokens: 16384 },
  "gpt-4o-mini": { maxInputTokens: 128000, maxOutputTokens: 16384 },
  "gpt-4-turbo": { maxInputTokens: 128000, maxOutputTokens: 4096 },
  "gpt-4": { maxInputTokens: 8192, maxOutputTokens: 4096 },
  "gpt-3.5-turbo": { maxInputTokens: 16385, maxOutputTokens: 4096 },
  "o1": { maxInputTokens: 200000, maxOutputTokens: 100000 },
  "o1-mini": { maxInputTokens: 128000, maxOutputTokens: 65536 },
  "o3-mini": { maxInputTokens: 200000, maxOutputTokens: 100000 },
  "gpt-4.1": { maxInputTokens: 1048576, maxOutputTokens: 16384 },
  "o3": { maxInputTokens: 200000, maxOutputTokens: 100000 },
  "o4-mini": { maxInputTokens: 200000, maxOutputTokens: 100000 },

  // ── Anthropic (Claude) ──
  "claude-sonnet-4-6": { maxInputTokens: 200000, maxOutputTokens: 8192 },
  "claude-haiku-4-5": { maxInputTokens: 200000, maxOutputTokens: 8192 },
  "claude-3.5-sonnet": { maxInputTokens: 200000, maxOutputTokens: 8192 },
  "claude-3.5-haiku": { maxInputTokens: 200000, maxOutputTokens: 8192 },
  "claude-3-opus": { maxInputTokens: 200000, maxOutputTokens: 4096 },
  "claude-3-sonnet": { maxInputTokens: 200000, maxOutputTokens: 4096 },
  "claude-3-haiku": { maxInputTokens: 200000, maxOutputTokens: 4096 },
  "claude-4-5-sonnet": { maxInputTokens: 200000, maxOutputTokens: 8192 },
  "claude-4-5-haiku": { maxInputTokens: 200000, maxOutputTokens: 8192 },

  // ── DeepSeek ──
  "deepseek-chat": { maxInputTokens: 128000, maxOutputTokens: 8192 },
  "deepseek-reasoner": { maxInputTokens: 128000, maxOutputTokens: 8192 },
  "deepseek-coder": { maxInputTokens: 128000, maxOutputTokens: 8192 },

  // ── Google Gemini ──
  "gemini-2.5-pro": { maxInputTokens: 1048576, maxOutputTokens: 65536 },
  "gemini-2.5-flash": { maxInputTokens: 1048576, maxOutputTokens: 65536 },
  "gemini-1.5-pro": { maxInputTokens: 1048576, maxOutputTokens: 8192 },
  "gemini-1.5-flash": { maxInputTokens: 1048576, maxOutputTokens: 8192 },
  "gemini-2.0-flash": { maxInputTokens: 1048576, maxOutputTokens: 8192 },
  "gemini-pro": { maxInputTokens: 32768, maxOutputTokens: 8192 },

  // ── 阿里通义千问 (Qwen) ──
  "qwen-turbo": { maxInputTokens: 128000, maxOutputTokens: 6000 },
  "qwen-plus": { maxInputTokens: 128000, maxOutputTokens: 6000 },
  "qwen-max": { maxInputTokens: 128000, maxOutputTokens: 6000 },
  "qwen-long": { maxInputTokens: 10000000, maxOutputTokens: 6000 },
  "qwen2.5": { maxInputTokens: 128000, maxOutputTokens: 8192 },

  // ── ModelScope 开源 Qwen3 系列（原生上下文 32768，YaRN 可扩 131072）──
  // 注意：大小写敏感前缀匹配，大写 "Qwen/" 不会误匹配上面的小写 qwen 条目
  "Qwen/Qwen3-8B": { maxInputTokens: 32768, maxOutputTokens: 8192 },
  "Qwen/Qwen3-4B": { maxInputTokens: 32768, maxOutputTokens: 8192 },
  "Qwen/Qwen3": { maxInputTokens: 32768, maxOutputTokens: 8192 },

  // ── ModelScope 其他开源模型 ──
  "deepseek-ai/DeepSeek": { maxInputTokens: 128000, maxOutputTokens: 8192 },
  "meta-llama/Llama-4": { maxInputTokens: 1048576, maxOutputTokens: 4096 },
  "THUDM/glm": { maxInputTokens: 128000, maxOutputTokens: 4096 },
  "stepfun-ai/Step": { maxInputTokens: 131072, maxOutputTokens: 4096 },

  // ── 智谱 GLM ──
  "glm-4": { maxInputTokens: 128000, maxOutputTokens: 4096 },
  "glm-4-flash": { maxInputTokens: 128000, maxOutputTokens: 4096 },
  "glm-4-plus": { maxInputTokens: 128000, maxOutputTokens: 4096 },
  "glm-3-turbo": { maxInputTokens: 128000, maxOutputTokens: 4096 },

  // ── 百度文心一言 ──
  "ernie-4.0": { maxInputTokens: 128000, maxOutputTokens: 4096 },
  "ernie-3.5": { maxInputTokens: 128000, maxOutputTokens: 4096 },
  "ernie-speed": { maxInputTokens: 128000, maxOutputTokens: 4096 },

  // ── 讯飞星火 ──
  "spark-max": { maxInputTokens: 128000, maxOutputTokens: 4096 },
  "spark-pro": { maxInputTokens: 128000, maxOutputTokens: 4096 },

  // ── 腾讯混元 ──
  "hunyuan": { maxInputTokens: 256000, maxOutputTokens: 4096 },

  // ── Moonshot (月之暗面) ──
  "moonshot-v1-8k": { maxInputTokens: 8192, maxOutputTokens: 4096 },
  "moonshot-v1-32k": { maxInputTokens: 32768, maxOutputTokens: 4096 },
  "moonshot-v1-128k": { maxInputTokens: 131072, maxOutputTokens: 4096 },

  // ── MiniMax ──
  "MiniMax-M3": { maxInputTokens: 131072, maxOutputTokens: 4096 },
  "MiniMax-T1": { maxInputTokens: 1048576, maxOutputTokens: 4096 },
  "abab6": { maxInputTokens: 200000, maxOutputTokens: 4096 },
  "abab6.5": { maxInputTokens: 200000, maxOutputTokens: 4096 },

  // ── 零一万物 ──
  "yi-large": { maxInputTokens: 32768, maxOutputTokens: 4096 },
  "yi-medium": { maxInputTokens: 16384, maxOutputTokens: 4096 },

  // ── Meta Llama ──
  "llama-3.1": { maxInputTokens: 128000, maxOutputTokens: 4096 },
  "llama-3": { maxInputTokens: 8192, maxOutputTokens: 4096 },

  // ── Mistral ──
  "mistral-large": { maxInputTokens: 128000, maxOutputTokens: 4096 },
  "mistral-medium": { maxInputTokens: 32000, maxOutputTokens: 4096 },
};

const DEFAULT_BUDGET: TokenBudget = { maxInputTokens: 128000, maxOutputTokens: 4096 };

// Sorted by key length descending — longer prefixes match first
// e.g. "gpt-4o-mini" matches before "gpt-4o"
const SORTED_MODEL_ENTRIES = Object.entries(MODEL_LIMITS).sort((a, b) => b[0].length - a[0].length);

export function getTokenBudget(model: string, contextWindow?: number): TokenBudget {
  // Look up model's known output token limit
  let knownOutput = DEFAULT_BUDGET.maxOutputTokens;
  if (MODEL_LIMITS[model]) {
    knownOutput = MODEL_LIMITS[model].maxOutputTokens;
  } else {
    for (const [key, budget] of SORTED_MODEL_ENTRIES) {
      if (model.startsWith(key)) { knownOutput = budget.maxOutputTokens; break; }
    }
  }
  // User-configured context window takes priority for input tokens
  if (contextWindow && contextWindow > 0) {
    return { maxInputTokens: contextWindow, maxOutputTokens: knownOutput };
  }
  // Exact match first
  if (MODEL_LIMITS[model]) return MODEL_LIMITS[model];
  // Prefix match for versioned models (e.g. "gpt-4o-mini-2024-07-18" → "gpt-4o-mini")
  for (const [key, budget] of SORTED_MODEL_ENTRIES) {
    if (model.startsWith(key)) return budget;
  }
  return DEFAULT_BUDGET;
}

/**
 * 获取模型在预算表中匹配到的条目信息，用于 UI 展示
 * 返回匹配到的 key 和预算，或 null（未匹配）
 */
export function getMatchedModelInfo(model: string): { matchedKey: string; budget: TokenBudget } | null {
  if (!model) return null;
  if (MODEL_LIMITS[model]) {
    return { matchedKey: model, budget: MODEL_LIMITS[model] };
  }
  for (const [key, budget] of SORTED_MODEL_ENTRIES) {
    if (model.startsWith(key)) {
      return { matchedKey: key, budget };
    }
  }
  return null;
}

/**
 * 获取人类可读的模型上下文长度提示文字
 * 例如："Qwen3 系列，32,768 tokens" 或 "未匹配，默认 128,000 tokens"
 */
export function getModelContextHint(model: string): string {
  const info = getMatchedModelInfo(model);
  if (!info) {
    return `未匹配到已知模型，默认使用 ${DEFAULT_BUDGET.maxInputTokens.toLocaleString()} tokens`;
  }
  return `匹配到 ${info.matchedKey}，上下文 ${info.budget.maxInputTokens.toLocaleString()} tokens`;
}

export function canFitInContext(text: string, model: string, outputTokens: number, contextWindow?: number): boolean {
  const budget = getTokenBudget(model, contextWindow);
  const estimated = estimateTokens(text);
  return estimated + outputTokens <= budget.maxInputTokens;
}

export function truncateToFit(text: string, model: string, reservedOutput: number, contextWindow?: number): string {
  const budget = getTokenBudget(model, contextWindow);
  const noticeText = "\n\n[文本因长度限制被截断...]";
  const noticeTokens = estimateTokens(noticeText);
  const maxInputEstimate = budget.maxInputTokens - reservedOutput - noticeTokens;

  const currentTokens = estimateTokens(text);
  if (currentTokens <= maxInputEstimate) return text;

  // Binary search approximate truncation point
  let left = 0;
  let right = text.length;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const slice = text.slice(0, mid);
    if (estimateTokens(slice) <= maxInputEstimate) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  let result = text.slice(0, left);
  if (estimateTokens(result) > maxInputEstimate && left > 0) {
    result = text.slice(0, left - 1);
  }
  return result + noticeText;
}
