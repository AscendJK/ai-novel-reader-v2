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
  /**
   * 用户在设置里亲手填的输出上限（没填为 undefined）。
   *
   * 必须与 `maxOutputTokens` 分开存：后者在用户填过之后就等于用户值，光看它分不出
   * "模型本来就能写 8192" 和 "用户说了 8192"。而这两件事的待遇不同——只有用户显式说过的，
   * 才允许顶掉任务级的默认预算（见 `resolveOutputReserve`）。
   */
  userMaxOutputTokens?: number;
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
  // 真厂商实测（2026-09-27 直连 `api.deepseek.com`）：`max_tokens` 填到 65536 都回 200，
  // 单发时间线实际吃掉 10,004 completion token（其中思考 7,739）。它以前不在表里，
  // 于是走 `DEFAULT_BUDGET` 的 4096——分析类要的 8192 被压成 4096，正文一个字都回不来。
  "deepseek-flash": { contextWindow: 128000, maxOutputTokens: 16384 },
  "deepseek-v4-pro": { contextWindow: 128000, maxOutputTokens: 16384 },
  "deepseek-v4-flash": { contextWindow: 128000, maxOutputTokens: 16384 },

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

/**
 * 运行时从服务端错误中发现并缓存的真实上下文长度（keyed by model name）
 * 仅内存态，刷新页面后重置
 */
const discoveredContextWindows = new Map<string, number>();

/**
 * 从 API 错误信息中提取真实上下文长度
 * 兼容 "maximum context length is 32768 tokens" / "context_length: 8192" 等模式
 */
/** 合理的上下文长度范围：范围外的数字（请求 ID、时间戳等）不可信 */
const CONTEXT_LENGTH_MIN = 2048;
const CONTEXT_LENGTH_MAX = 2_000_000;

function isValidContextLength(n: number): boolean {
  return Number.isFinite(n) && n >= CONTEXT_LENGTH_MIN && n <= CONTEXT_LENGTH_MAX;
}

export function extractContextLength(text: string): number | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  // "requested 4096 completion tokens" / "max_tokens must be <= 8192" 这类消息里的
  // 数字是**输出**上限，不是上下文长度。缓存了它就等于之后所有任务都按这个小窗口
  // 钳制输入（配合负预算即产出空白正文），且缓存只有会话内、没有失效机制。
  const talksAboutOutputLimit = /(completion|completion_tokens|max_tokens|输出)/i.test(text);
  // 优先匹配带单位的形式：32768 tokens / 8192 tokens——但要求消息本身在讲上下文
  const withUnit = lower.match(/(\d{4,8})\s*(?:token|tokens)/i);
  if (withUnit && /context|上下文|window|长度/.test(lower) && !talksAboutOutputLimit) {
    const n = parseInt(withUnit[1], 10);
    if (isValidContextLength(n)) return n;
  }
  // 其次匹配 context/window 附近的数字（含中文"长度/限制"场景）
  const nearLength = text.match(/(?:context|context length|window|上下文|长度|限制)[^0-9]{0,20}(\d{4,8})/i);
  if (nearLength) {
    const n = parseInt(nearLength[1], 10);
    if (isValidContextLength(n)) return n;
  }
  // 不做"任意 4-8 位数字"兜底：错误体中的请求 ID、时间戳会被误当上下文长度
  // 写入 discoveredContextWindows 且无失效机制，会污染整个会话的 token 预算
  return null;
}

/**
 * 记录运行时发现的服务端真实上下文长度
 */
export function setDiscoveredContextWindow(model: string, contextWindow: number): void {
  if (!model || !isValidContextLength(contextWindow)) return;
  discoveredContextWindows.set(model, contextWindow);
}

/**
 * 获取运行时发现的服务端真实上下文长度（未发现返回 undefined）
 */
export function getDiscoveredContextWindow(model: string): number | undefined {
  return discoveredContextWindows.get(model);
}

export function getTokenBudget(model: string, contextWindow?: number, maxOutputTokens?: number): TokenBudget {
  const userCap = maxOutputTokens && maxOutputTokens > 0 ? maxOutputTokens : undefined;
  // 表命中（精确优先，其次按 key 长度降序做前缀匹配，长 key 先命中：
  // "gpt-4o-mini" 要抢在 "gpt-4o" 前面）
  const hit = MODEL_LIMITS[model] ?? SORTED_MODEL_ENTRIES.find(([key]) => model.startsWith(key))?.[1];
  const knownOutput = userCap ?? hit?.maxOutputTokens ?? DEFAULT_BUDGET.maxOutputTokens;
  // 上下文窗口的优先级：用户填的 > 服务端自报的（400 自愈缓存，仅会话内）> 表值 > 默认。
  // 四条来源在这里算完，最后一次性组装对象——过去四个 return 各拼一份字面量，
  // 新增字段极易漏带（`userMaxOutputTokens` 就是这么要求统一的）。
  const resolvedWindow = contextWindow && contextWindow > 0
    ? contextWindow
    : discoveredContextWindows.get(model) ?? hit?.contextWindow ?? DEFAULT_BUDGET.contextWindow;
  // 表命中路径必须带走上面算好的 knownOutput：过去直接 return 表对象，用户在设置里
  // 调的输出上限对已知模型完全不生效，而预算不足的报错文案正是让他去调这个。
  return { contextWindow: resolvedWindow, maxOutputTokens: knownOutput, userMaxOutputTokens: userCap };
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
 * 获取人类可读的模型最大输出 token 提示文字
 * 例如："Qwen3 系列，8,192 tokens" 或 "未匹配，默认 4,096 tokens"
 */
export function getModelMaxOutputHint(model: string): string {
  const info = getMatchedModelInfo(model);
  if (!info) {
    return `未匹配到已知模型，默认使用 ${DEFAULT_BUDGET.maxOutputTokens.toLocaleString()} tokens`;
  }
  return `匹配到 ${info.matchedKey}，最大输出 ${info.budget.maxOutputTokens.toLocaleString()} tokens`;
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
  // 下限 0：预算为负时下游会算出"截断到负数字符"，正文被切光而提示语还在
  return Math.max(0, budget.contextWindow - outputBudget - safetyMargin);
}

/** 低于这个输入预算，截断后的 prompt 只剩指令本身，模型会凭空产出正文 */
export const MIN_USABLE_INPUT_TOKENS = 512;

/** 输出预留的下限：比这更小，模型连一段像样的分析都写不完，宁可直接失败 */
export const MIN_OUTPUT_RESERVE = 512;

/**
 * 一个任务的输出预留——**同时**是发出去的 `max_tokens` 和输入侧要扣掉的量。
 *
 * 为什么只能有一个出处：过去这两件事分别写成 `Math.min(上限, 字面常数)`，于是
 * ① 用户在设置里填的输出上限被常数顶掉（设置页那句"填写后优先使用"是假的，真厂商实测
 * `deepseek-flash` 在 4096 预留里把预算全花在 reasoning 上、正文 0 字）；
 * ② 分开写迟早会漂——`map-agent.ts` 的目录抽样按 4096 留、请求却发 `min(上限, 16384)`，
 * 正是它的注释警告过的"预算算小了，严格校验 input+max_tokens≤窗口的服务商必 400"。
 *
 * 让路的范围限定在"用户显式填过"：没填时逐字等于旧的 `Math.min(上限, 常数)`，零回归面。
 * 钳制的理由是实测出来的兑换率：预留与可用输入 1:1（128k 窗口预留 2048→8192，
 * 可用输入 124,952→118,808；32k 窗口 + 上限 8192 时范围总结能带的整章数 9→7）。
 * 也就是说抬预留**不会**换来"上下文不足"，换来的是少喂原文——所以要按窗口钳住，
 * 不许把输入挤到 `MIN_USABLE_INPUT_TOKENS` 门下。
 *
 * @param budget 该 provider 的预算（含用户填的上限）
 * @param taskDefault 该任务的默认输出预算（原写死在各 agent 里的常数）
 * @param what 报错文案里的任务名，与 `requireUsableInput` 同一口径
 */
export function resolveOutputReserve(budget: TokenBudget, taskDefault: number, what = "该请求"): number {
  const margin = Math.min(1000, Math.floor(budget.contextWindow * 0.05));
  const wanted = budget.userMaxOutputTokens ?? taskDefault;
  const reserve = Math.min(wanted, budget.maxOutputTokens, budget.contextWindow - margin - MIN_USABLE_INPUT_TOKENS);
  if (reserve < MIN_OUTPUT_RESERVE) {
    // 两种可能：窗口真的供不起最小预留 → 这句必抛；或者用户自己把上限调得比 512 还小 →
    // 那是合法偏好（窗口够大时 available 远超下限），原样返回他的话，不替他改主意。
    requireUsableInput(budget, MIN_OUTPUT_RESERVE, what);
    return reserve;
  }
  return reserve;
}

/**
 * 需要真正拼进 prompt 的输入预算：不够用就直接失败。
 *
 * 静默截断成空正文比报错恶劣得多——模型会凭章节标题 hallucinate 出一篇"总结"
 * 并正常入库，用户在界面上看不出任何异常（round 2 R-07）。
 */
export function requireUsableInput(budget: TokenBudget, agentMaxTokens: number, what = "该请求"): number {
  const available = computeAvailableInput(budget, agentMaxTokens);
  if (available < MIN_USABLE_INPUT_TOKENS) {
    throw new Error(
      `模型上下文窗口不足以生成${what}：可用输入约 ${available} tokens` +
      `（窗口 ${budget.contextWindow}、输出预留 ${Math.min(agentMaxTokens, budget.maxOutputTokens)}）。` +
      `请在设置中改用更长上下文的模型，或调低输出上限。`
    );
  }
  return available;
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
