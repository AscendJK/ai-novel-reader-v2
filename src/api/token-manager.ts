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
  contextWindow: number;
  maxOutputTokens: number;
}

const MODEL_LIMITS: Record<string, TokenBudget> = {
  // ── OpenAI ──
  "gpt-4o": { contextWindow: 128000, maxOutputTokens: 16384 },
  "gpt-4o-mini": { contextWindow: 128000, maxOutputTokens: 16384 },
  "gpt-4-turbo": { contextWindow: 128000, maxOutputTokens: 4096 },
  "gpt-4": { contextWindow: 8192, maxOutputTokens: 4096 },
  "gpt-3.5-turbo": { contextWindow: 16385, maxOutputTokens: 4096 },
  "o1": { contextWindow: 200000, maxOutputTokens: 100000 },
  "o1-mini": { contextWindow: 128000, maxOutputTokens: 65536 },
  "o3-mini": { contextWindow: 200000, maxOutputTokens: 100000 },
  "gpt-4.1": { contextWindow: 1048576, maxOutputTokens: 16384 },
  "o3": { contextWindow: 200000, maxOutputTokens: 100000 },
  "o4-mini": { contextWindow: 200000, maxOutputTokens: 100000 },

  // ── Anthropic (Claude) ──
  "claude-sonnet-4-6": { contextWindow: 200000, maxOutputTokens: 8192 },
  "claude-haiku-4-5": { contextWindow: 200000, maxOutputTokens: 8192 },
  "claude-3.5-sonnet": { contextWindow: 200000, maxOutputTokens: 8192 },
  "claude-3.5-haiku": { contextWindow: 200000, maxOutputTokens: 8192 },
  "claude-3-opus": { contextWindow: 200000, maxOutputTokens: 4096 },
  "claude-3-sonnet": { contextWindow: 200000, maxOutputTokens: 4096 },
  "claude-3-haiku": { contextWindow: 200000, maxOutputTokens: 4096 },
  "claude-4-5-sonnet": { contextWindow: 200000, maxOutputTokens: 8192 },
  "claude-4-5-haiku": { contextWindow: 200000, maxOutputTokens: 8192 },

  // ── DeepSeek ──
  "deepseek-chat": { contextWindow: 128000, maxOutputTokens: 8192 },
  "deepseek-reasoner": { contextWindow: 128000, maxOutputTokens: 8192 },
  "deepseek-coder": { contextWindow: 128000, maxOutputTokens: 8192 },

  // ── Google Gemini ──
  "gemini-2.5-pro": { contextWindow: 1048576, maxOutputTokens: 65536 },
  "gemini-2.5-flash": { contextWindow: 1048576, maxOutputTokens: 65536 },
  "gemini-1.5-pro": { contextWindow: 1048576, maxOutputTokens: 8192 },
  "gemini-1.5-flash": { contextWindow: 1048576, maxOutputTokens: 8192 },
  "gemini-2.0-flash": { contextWindow: 1048576, maxOutputTokens: 8192 },
  "gemini-pro": { contextWindow: 32768, maxOutputTokens: 8192 },

  // ── 阿里通义千问 (Qwen) ──
  "qwen-turbo": { contextWindow: 128000, maxOutputTokens: 6000 },
  "qwen-plus": { contextWindow: 128000, maxOutputTokens: 6000 },
  "qwen-max": { contextWindow: 128000, maxOutputTokens: 6000 },
  "qwen-long": { contextWindow: 10000000, maxOutputTokens: 6000 },
  "qwen2.5": { contextWindow: 128000, maxOutputTokens: 8192 },

  // ── ModelScope 开源 Qwen3 系列（原生上下文 32768，YaRN 可扩 131072）──
  // 注意：大小写敏感前缀匹配，大写 "Qwen/" 不会误匹配上面的小写 qwen 条目
  "Qwen/Qwen3-8B": { contextWindow: 32768, maxOutputTokens: 8192 },
  "Qwen/Qwen3-4B": { contextWindow: 32768, maxOutputTokens: 8192 },
  "Qwen/Qwen3": { contextWindow: 32768, maxOutputTokens: 8192 },

  // ── ModelScope 其他开源模型 ──
  "deepseek-ai/DeepSeek": { contextWindow: 128000, maxOutputTokens: 8192 },
  "meta-llama/Llama-4": { contextWindow: 1048576, maxOutputTokens: 4096 },
  "THUDM/glm": { contextWindow: 128000, maxOutputTokens: 4096 },
  "stepfun-ai/Step": { contextWindow: 131072, maxOutputTokens: 4096 },

  // ── 智谱 GLM ──
  "glm-4": { contextWindow: 128000, maxOutputTokens: 4096 },
  "glm-4-flash": { contextWindow: 128000, maxOutputTokens: 4096 },
  "glm-4-plus": { contextWindow: 128000, maxOutputTokens: 4096 },
  "glm-3-turbo": { contextWindow: 128000, maxOutputTokens: 4096 },

  // ── 百度文心一言 ──
  "ernie-4.0": { contextWindow: 128000, maxOutputTokens: 4096 },
  "ernie-3.5": { contextWindow: 128000, maxOutputTokens: 4096 },
  "ernie-speed": { contextWindow: 128000, maxOutputTokens: 4096 },

  // ── 讯飞星火 ──
  "spark-max": { contextWindow: 128000, maxOutputTokens: 4096 },
  "spark-pro": { contextWindow: 128000, maxOutputTokens: 4096 },

  // ── 腾讯混元 ──
  "hunyuan": { contextWindow: 256000, maxOutputTokens: 4096 },

  // ── Moonshot (月之暗面) ──
  "moonshot-v1-8k": { contextWindow: 8192, maxOutputTokens: 4096 },
  "moonshot-v1-32k": { contextWindow: 32768, maxOutputTokens: 4096 },
  "moonshot-v1-128k": { contextWindow: 131072, maxOutputTokens: 4096 },

  // ── MiniMax ──
  "MiniMax-M3": { contextWindow: 131072, maxOutputTokens: 4096 },
  "MiniMax-T1": { contextWindow: 1048576, maxOutputTokens: 4096 },
  "abab6": { contextWindow: 200000, maxOutputTokens: 4096 },
  "abab6.5": { contextWindow: 200000, maxOutputTokens: 4096 },

  // ── 零一万物 ──
  "yi-large": { contextWindow: 32768, maxOutputTokens: 4096 },
  "yi-medium": { contextWindow: 16384, maxOutputTokens: 4096 },

  // ── Meta Llama ──
  "llama-3.1": { contextWindow: 128000, maxOutputTokens: 4096 },
  "llama-3": { contextWindow: 8192, maxOutputTokens: 4096 },

  // ── Mistral ──
  "mistral-large": { contextWindow: 128000, maxOutputTokens: 4096 },
  "mistral-medium": { contextWindow: 32000, maxOutputTokens: 4096 },
};

const DEFAULT_BUDGET: TokenBudget = { contextWindow: 128000, maxOutputTokens: 4096 };

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
    return { contextWindow, maxOutputTokens: knownOutput };
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
    return `未匹配到已知模型，默认使用 ${DEFAULT_BUDGET.contextWindow.toLocaleString()} tokens`;
  }
  return `匹配到 ${info.matchedKey}，上下文 ${info.budget.contextWindow.toLocaleString()} tokens`;
}

/**
 * 计算可用的输入空间（token）
 * 可用空间 = 上下文总长度 - 输出预算 - 安全余量
 * @param budget token 预算
 * @param agentMaxTokens 该 agent 需要的最大输出 token 数
 */
export function computeAvailableInput(budget: TokenBudget, agentMaxTokens: number): number {
  const outputBudget = Math.min(agentMaxTokens, budget.maxOutputTokens);
  const safetyMargin = Math.min(1000, Math.floor(budget.contextWindow * 0.05));
  return budget.contextWindow - outputBudget - safetyMargin;
}

export function canFitInContext(text: string, model: string, outputTokens: number, contextWindow?: number): boolean {
  const budget = getTokenBudget(model, contextWindow);
  const estimated = estimateTokens(text);
  return estimated + outputTokens <= budget.contextWindow;
}

export function truncateToFit(text: string, model: string, reservedOutput: number, contextWindow?: number): string {
  const budget = getTokenBudget(model, contextWindow);
  const noticeText = "\n\n[文本因长度限制被截断...]";
  const noticeTokens = estimateTokens(noticeText);
  const maxInputEstimate = budget.contextWindow - reservedOutput - noticeTokens;

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
