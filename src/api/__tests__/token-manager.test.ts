/**
 * token-manager 测试
 *
 * ── 「删掉预算表的输出上限那一列 + `output_limit` 自愈」这一笔的变异台账（2026-09-27 晚）──
 * 基线 sha（每刀跑完 `cp` 还原后逐字对上）：`token-manager.ts` f85e4494、`agents/utils.ts` ff1b8190、
 * `ApiSettings.tsx` eeb12f8f。每刀 markers=1（单处手工编辑），判据分母都核过 `Tests …` 那一行。
 *  - **N1** 删 `not less or equal to` 那条模式（longcat 原话）→ **红 2**：本文件"longcat 的中文嵌套"
 *    ＋ `utils-context.test.ts` 的"is not less or equal to N 那种措辞也认"。附带量到一件好事：
 *    摘掉之后兜底那条宽松模式会抠成 **1000000**（我们自己发出去的那个数），也就是学到错的天花板——
 *    所以"特定措辞排在宽松模式前面"这个顺序是有牙的，不是排版。
 *  - **N2** 删 `should be in` 那条模式 → **红 2**（重试层两条）。**本文件"sensenova 的原话"那条当场没红**：
 *    它的夹具里带 `MaxTokens` 字段名，第一条模式就够了。→ 补一条"整句没提字段名"的用例，重打同一刀 → 红 3。
 *  - **N3** `getTokenBudget` 里"两个天花板取更小"折成取更大 → **红 0**：`setDiscoveredMaxOutput` /
 *    `getDiscoveredMaxOutput` 当时在整个测试套里**零引用**，这一格压根没判据。→ 补"两个天花板的折法"
 *    五条（各用独占模型名，免得模块级 Map 串台），重打 → **红 2**。
 *  - **N4** 把 `[\d,]{3,}` 的数字长度门槛放松成 `{1,}`（只放松 `[1, N]` 那条）→ **红 0**。
 *    如实记：`[1, 32]` 那一格有**两道同职的闸**（长度门槛＋`MIN_OUTPUT_RESERVE` 范围校验），
 *    单摘任一道都是等价变异。N5 证明的是"摘掉范围校验那一道有牙"（因为补了 `[1, 511]`／`[1, 512]`）。
 *  - **N5** 摘掉 `extractMaxOutputTokens` 的 `n >= MIN_OUTPUT_RESERVE` → **红 1**（"小于一档像样输出的数字
 *    不当作上限"）。这条判据的老夹具只有 `[1, 32]`，那时这一刀是 0 红——补了 511／512 两档才有读数。
 *  - **N6** 摘掉重试的 `learned < asked` → **红 2**：两条"一次都不许多发"。
 *  - **N7** 重试里让学到的数冒充用户填的（`userMaxOutputTokens ?? learned`）→ **红 1**：
 *    "学到的数不许变成用户填过"。（"用户填 16384、厂商说 [1, 4096]"那一条不红——它两取的都是 4096，
 *    分不出是谁给的；所以那格靠 N3 钉，不靠这条。）
 *  - **N8** 摘掉重试里那行 `maxOutputTokens: Math.min(learned, userCap ?? learned)` → **红 0**：
 *    那一行是**重复计算**（取更小只在 `getTokenBudget` 一处说了算，缓存里已经是 learned），
 *    于是按简化落地，这一格不算"判不到"。
 *  - **N9** `computeAvailableInput` 恢复"再按 `budget.maxOutputTokens` 钳一次" → **红 2**：
 *    本文件"输入空间照调用点给的预留整份扣"＋ `token-manager-require-usable.test.ts` 的"文案里的数字同源"。
 *  - **N10** `resolveOutputReserve` 整个不看上限（`wanted = taskDefault`）→ **红 16**：本笔判据最密的一格，
 *    三只文件一起红（`token-manager-reserve` 6 条、`output-reserve-callsites` 6 条、重试层 4 条）。
 *  - **N11** `ApiSettings.tsx` 输出那一格的 placeholder 改成"匹配到模型就写 4096" → **红 1**：
 *    "换个模型名，placeholder 与说明逐字不变"。
 *  - **N12** 让上限只能压低预设（老 bug 的形状：`min(用户上限, 任务常数)`）→ **红 7**（当场我只数出 6，
 *    回看 `/tmp/n12.log` 是 7 条：`token-manager-reserve` 4 条＋调用点 3 条）。与 N10 名字部分重叠，
 *    归属靠刀标签分辨，不靠红名（同一条判据可以被两把不同的刀打红）。
 */

import { describe, it, expect } from "vitest";
import { estimateTokens, getTokenBudget, canFitInContext, truncateToFit, extractContextLength, extractMaxOutputTokens, setDiscoveredContextWindow, setDiscoveredMaxOutput, getDiscoveredMaxOutput, computeAvailableInput, MIN_OUTPUT_RESERVE } from "../token-manager";

describe("estimateTokens", () => {
  it("应该估算中文文本的 token 数", () => {
    // 中文字符约 1.5 个字符 = 1 token
    const text = "你好世界"; // 4 个中文字符
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("应该估算英文文本的 token 数", () => {
    // 英文字符约 3.5 个字符 = 1 token
    const text = "hello world"; // 11 个字符
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("应该处理混合文本", () => {
    const text = "Hello 你好 World 世界";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  it("应该处理空字符串", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("应该处理只有空格的字符串", () => {
    const tokens = estimateTokens("   ");
    expect(tokens).toBeGreaterThanOrEqual(0);
  });
});

describe("getTokenBudget", () => {
  /**
   * 2026-09-27：预算表里那一列「按模型名写死的最大输出」删了，这一组的老期望全写着那一列的值。
   * 它们当初编码的是"表说了算"——而真厂商实测到的正是它的反面：`deepseek-flash` 不在表里 →
   * 走默认的 4096 → 分析类要的 8192 被压成 4096 → 一发下来 `reasoning_tokens=4096 / 正文 0 字`。
   * 现在表只剩一件事要说：**窗口多大**（那是"能喂多少原文"的唯一依据，留着）。输出侧由
   * 用户填的 / 厂商 400 里学到的决定，两样都没有就是 `undefined`＝不设上限，只被窗口钳。
   */
  it("已知模型：表里只给窗口，输出侧一个数都不许造", () => {
    const budget = getTokenBudget("gpt-4o");
    expect(budget.contextWindow).toBe(128000);
    expect(budget.maxOutputTokens).toBeUndefined();
    expect(budget.userMaxOutputTokens).toBeUndefined();
  });

  it("应该通过前缀匹配返回 budget", () => {
    const budget = getTokenBudget("gpt-4o-mini-2024-07-18");
    expect(budget.contextWindow).toBe(128000);
    expect(budget.maxOutputTokens).toBeUndefined();
  });

  it("未匹配的模型：窗口有兜底，输出侧没有（老口径的 4096 就是压死推理型厂商的那把钳）", () => {
    const budget = getTokenBudget("unknown-model");
    expect(budget.contextWindow).toBe(128000);
    expect(budget.maxOutputTokens).toBeUndefined();
  });

  it("应该优先使用用户配置的 contextWindow", () => {
    const budget = getTokenBudget("gpt-4o", 100000);
    expect(budget.contextWindow).toBe(100000);
    expect(budget.maxOutputTokens).toBeUndefined();
  });

  it("应该处理 Claude 模型", () => {
    const budget = getTokenBudget("claude-sonnet-4-6");
    expect(budget.contextWindow).toBe(200000);
  });

  it("应该处理 DeepSeek 模型", () => {
    const budget = getTokenBudget("deepseek-chat");
    expect(budget.contextWindow).toBe(128000);
  });

  /**
   * `deepseek-flash` 在真厂商上量到的两件事（2026-09-27 直连 `api.deepseek.com`，
   * 脚本 `anr-e2e-real/probe-deepseek-budget.mjs`）：
   *  - 一发时间线吃到 `completion_tokens=10004`（其中思考 7739）还在 `finish_reason=stop` 内收全 →
   *    它的输出能力远高于过去表外那个 4096 猜测；
   *  - `max_tokens` 8192／16384／32768／200000 全收，1000000 才拒：
   *    `the valid range of max_tokens is [1, 393216]`。
   * 这条判据钉的是"它在表里有自己的窗口"，输出那一列已经整个删掉，所以这里不再断言输出数——
   * 想断"别被压成 4096"的地方在 `output-reserve-callsites.test.ts`（判的是实际发出去的那个数）。
   */
  it("deepseek-flash 有自己的窗口条目，且输出侧不从表里来", () => {
    const budget = getTokenBudget("deepseek-flash");
    expect(budget.contextWindow).toBe(128000);
    expect(budget.maxOutputTokens).toBeUndefined();
  });

  it("用户填的输出上限仍然是唯一的用户侧天花板", () => {
    expect(getTokenBudget("deepseek-flash", undefined, 8192).maxOutputTokens).toBe(8192);
    expect(getTokenBudget("deepseek-flash", undefined, 8192).userMaxOutputTokens).toBe(8192);
  });

  it("发现了服务端真实上下文后应优先使用", () => {
    // 模拟 400 自愈写入发现缓存（Qwen/Qwen3-8B 真实上下文 32768）
    setDiscoveredContextWindow("Qwen/Qwen3-8B", 16384);
    const budget = getTokenBudget("Qwen/Qwen3-8B");
    // 发现缓存（16384）优先于 MODEL_LIMITS（32768）
    expect(budget.contextWindow).toBe(16384);
  });

  it("用户配置的 contextWindow 应高于发现缓存", () => {
    setDiscoveredContextWindow("Qwen/Qwen3-8B", 16384);
    const budget = getTokenBudget("Qwen/Qwen3-8B", 40000);
    expect(budget.contextWindow).toBe(40000);
  });
});

/**
 * `output_limit` 自愈要认的字。四串措辞里三串是 2026-09-27 直连量到的厂商原话
 * （`anr-e2e-real/probe-deepseek-budget.mjs reject <id>`），一串是文档形状（anthropic，未实测）：
 *  - deepseek `Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`
 *  - sensenova `field MaxTokens invalid, should be in [1, 65536]`
 *  - longcat `参数校验失败: /max_tokens: 1000000 is not less or equal to 262144`
 * 另两家量不出东西：modelscope 对 1000000 回的是 **HTTP 200 + 空壳**（`choices:null`，没数字），
 * 411 三档全撞在 429 配额墙上。所以"认不到就返回 null"不是偷懒，是现实。
 */
describe("extractMaxOutputTokens — 从厂商那句 400 里抠出它的天花板", () => {
  it("deepseek 的 `[1, 393216]`：区间写法，逗号是分隔符", () => {
    expect(extractMaxOutputTokens("Invalid max_tokens value, the valid range of max_tokens is [1, 393216] (request_id: 8193)")).toBe(393216);
  });

  it("sensenova 的原话 `field MaxTokens invalid, should be in [1, 65536]`", () => {
    // 如实记：这句里带 `MaxTokens` 字段名，所以**删掉 `should be in` 那条模式它也绿**
    // （2026-09-27 的 N2 刀量到的：那条刀的红名全在重试层，不在这一格）。
    // 真正"句子没提字段名"的形状由下一条钉。
    expect(extractMaxOutputTokens('{"error":{"message":"field MaxTokens invalid, should be in [1, 65536]","code":"3"}}')).toBe(65536);
  });

  it("整句没提任何字段名、只剩 `should be in [1, N]` 时也认（sensenova 那句去掉字段名的形状）", () => {
    // 措辞是我们归纳的（厂商原话带字段名），钉的是"不靠字段名也能认"这一格。
    // 重试层另有两条拿这个形状判（`utils-context.test.ts` 的 [1, 4096]／[1, 2048]）。
    expect(extractMaxOutputTokens("参数不合法，should be in [1, 65536]")).toBe(65536);
  });

  it("longcat 的中文嵌套 + `is not less or equal to 262144`", () => {
    expect(extractMaxOutputTokens("参数校验失败: \n/max_tokens: 1000000 is not less or equal to 262144\n")).toBe(262144);
  });

  it("文档形状 `max_tokens: ensure this is <= 8192` 也认", () => {
    expect(extractMaxOutputTokens("max_tokens: ensure this is <= 8192")).toBe(8192);
  });

  it("千分位逗号写在数字里也认（`[1, 393,216]`）", () => {
    expect(extractMaxOutputTokens("the valid range of max_tokens is [1, 393,216]")).toBe(393216);
  });

  it("modelscope 那种没有数字的空壳、以及只讲上下文的句子，一律返回 null（不许猜）", () => {
    expect(extractMaxOutputTokens('{"choices":null,"usage":{"total_tokens":0}}')).toBeNull();
    expect(extractMaxOutputTokens("请求的输出参数不合法")).toBeNull();
    // 这句在讲上下文：抠出来的 8192 会被当成输出上限，那是把窗口当预算，两头都错
    expect(extractMaxOutputTokens("This model's maximum context length is 8192 tokens")).toBeNull();
  });

  it("小于一档像样输出的数字不当作上限（511 那种宁可不学）", () => {
    // 两格分开钉：`[1, 32]` 被"数字至少三位"的形状门槛挡掉，`[1, 256]` 三位齐但没过 `MIN_OUTPUT_RESERVE`。
    // 只留前一条的话，把 `n >= MIN_OUTPUT_RESERVE` 摘掉是量不出来的（N5 那把刀第一次就是这么 0 红的）。
    expect(extractMaxOutputTokens("the valid range of max_tokens is [1, 32]")).toBeNull();
    expect(extractMaxOutputTokens(`the valid range of max_tokens is [1, ${MIN_OUTPUT_RESERVE - 1}]`)).toBeNull();
    // 门槛之上就该认：免得把"整段范围校验"错当成"一律不认"
    expect(extractMaxOutputTokens(`the valid range of max_tokens is [1, ${MIN_OUTPUT_RESERVE}]`)).toBe(MIN_OUTPUT_RESERVE);
  });
});

describe("两个天花板的折法：用户填的 与 厂商教的", () => {
  /**
   * 这一档是 2026-09-27 补的：N3 那把刀（`Math.min(...caps)` 改成 `Math.max`）当场 **0 红**，
   * 也就是"两个来源都在时取更小的"这一格压根没判据。刀口记在 `output-reserve-callsites.test.ts` 的台账里。
   * 每个用例各用一只独占的模型名：`discoveredMaxOutputs` 是模块级 Map，共用键会让用例互相串。
   */
  it("用户填 16384、厂商说自己只能写 4096 → 预算按 4096（取更小，不是取更大）", () => {
    setDiscoveredMaxOutput("fold-smaller-model", 4096);
    const budget = getTokenBudget("fold-smaller-model", undefined, 16384);
    expect(budget.maxOutputTokens).toBe(4096);
    // 但"用户填过 16384"这条事实不许被改写：它是任务默认预算让不让路的唯一依据
    expect(budget.userMaxOutputTokens).toBe(16384);
  });

  it("用户填 1024、厂商说 8192 → 还是 1024：他亲手填的那个小的数说了算", () => {
    setDiscoveredMaxOutput("fold-bigger-model", 8192);
    expect(getTokenBudget("fold-bigger-model", undefined, 1024).maxOutputTokens).toBe(1024);
  });

  it("只有厂商教的：它成为这一家的天花板（下一发不必再撞同一堵墙）", () => {
    setDiscoveredMaxOutput("fold-only-model", 3072);
    const budget = getTokenBudget("fold-only-model");
    expect(budget.maxOutputTokens).toBe(3072);
    expect(budget.userMaxOutputTokens, "学到的不许冒充用户填的").toBeUndefined();
    expect(getDiscoveredMaxOutput("fold-only-model")).toBe(3072);
  });

  it("小过一档像样输出的数字不写进缓存（511 那种宁可不学）", () => {
    setDiscoveredMaxOutput("guard-low-model", MIN_OUTPUT_RESERVE - 1);
    expect(getTokenBudget("guard-low-model").maxOutputTokens).toBeUndefined();
    expect(getDiscoveredMaxOutput("guard-low-model")).toBeUndefined();
  });

  it("大得离谱的数字也不写（窗口那一列另有范围校验，输出侧不能没有）", () => {
    setDiscoveredMaxOutput("guard-high-model", 2_000_001);
    expect(getTokenBudget("guard-high-model").maxOutputTokens).toBeUndefined();
  });
});

describe("extractContextLength", () => {
  it("应该提取带单位的数字", () => {
    expect(extractContextLength("maximum context length is 32768 tokens")).toBe(32768);
    expect(extractContextLength("context_length exceeded: 8192 tokens")).toBe(8192);
  });

  it("应该提取 length 附近的数字", () => {
    expect(extractContextLength("请求超过上下文长度限制 16384")).toBe(16384);
  });

  it("不应把独立的数字（请求 ID/时间戳）当作上下文长度", () => {
    // 错误体中的随机数字曾被兜底正则误判，污染整个会话的 token 预算
    expect(extractContextLength("request id: 1735829475628 failed")).toBe(null);
    expect(extractContextLength("error code 12345 at host")).toBe(null);
  });

  it("范围外的数字返回 null（过小或过大）", () => {
    expect(extractContextLength("1234 tokens")).toBe(null);
    expect(extractContextLength("99999999 tokens")).toBe(null);
  });

  it("无数字时返回 null", () => {
    expect(extractContextLength("请求内容超过模型上下文长度限制")).toBe(null);
    expect(extractContextLength("")).toBe(null);
  });
});

describe("computeAvailableInput", () => {
  it("精确计算可用输入 = 上下文 - 输出预算 - 安全余量", () => {
    const available = computeAvailableInput({ contextWindow: 32768, maxOutputTokens: 8192 }, 4096);
    // 32768 - min(4096,8192)=4096 - min(1000,1638)=1000 = 27672
    expect(available).toBe(27672);
  });

  /**
   * **这条的口径 2026-09-27 跟着表那一列一起翻了**。老的那条叫「agent 输出预算超过模型上限时按模型
   * 上限算」：这里再 `min` 一次，好让文案与扣减量对上。但"模型上限"那时来自预算表按模型名猜，
   * 于是同一件事有两个地方说了算，而猜错的那一次是往小里猜——推理型厂商就死在这道二次钳上。
   * 现在预留由 `resolveOutputReserve` 一处算完（用户填的/厂商教的都在那里折进去），
   * 这里只照它给的数扣，不再改。
   */
  it("输入空间照调用点给的预留整份扣，不再被第二个数改写", () => {
    expect(computeAvailableInput({ contextWindow: 32768, maxOutputTokens: 4096 }, 8192)).toBe(32768 - 8192 - 1000);
    // 用户填的那个上限不参与这里的扣减：它的作用点在 `resolveOutputReserve`（那条判据在那个函数上钉）
    expect(computeAvailableInput({ contextWindow: 32768 }, 8192)).toBe(32768 - 8192 - 1000);
  });

  it("安全余量不超过 1000", () => {
    const available = computeAvailableInput({ contextWindow: 128000, maxOutputTokens: 16384 }, 4096);
    // 128000 - min(4096,16384)=4096 - min(1000,6400)=1000 = 122904
    expect(available).toBe(122904);
  });
});

describe("canFitInContext", () => {
  it("应该返回 true（文本可以放入上下文）", () => {
    const text = "短文本";
    const result = canFitInContext(text, "gpt-4o", 1000);
    expect(result).toBe(true);
  });

  it("应该返回 false（文本太长）", () => {
    const text = "很长的文本".repeat(100000);
    const result = canFitInContext(text, "gpt-4o", 1000);
    expect(result).toBe(false);
  });

  it("应该考虑用户配置的 contextWindow", () => {
    const text = "中等长度的文本".repeat(1000);
    const result = canFitInContext(text, "gpt-4o", 1000, 5000);
    // 使用用户配置的 5000 作为 contextWindow
    expect(typeof result).toBe("boolean");
  });
});

describe("truncateToFit", () => {
  it("应该返回原始文本（不需要截断）", () => {
    const text = "短文本";
    const result = truncateToFit(text, "gpt-4o", 1000);
    expect(result).toBe(text);
  });

  it("应该截断过长的文本", () => {
    const text = "很长的文本".repeat(100000);
    const result = truncateToFit(text, "gpt-4o", 1000);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("[文本因长度限制被截断...]");
  });

  it("应该保留截断通知", () => {
    const text = "很长的文本".repeat(100000);
    const result = truncateToFit(text, "gpt-4o", 1000);
    expect(result.endsWith("[文本因长度限制被截断...]")).toBe(true);
  });

  it("应该处理空字符串", () => {
    const result = truncateToFit("", "gpt-4o", 1000);
    expect(result).toBe("");
  });
});
