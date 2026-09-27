/**
 * agents/utils — 上下文选取 / 运行环境准备 / 400 自愈 的判别力测试
 *
 * 这批用例守的是"喂给模型的是哪几章"和"用哪本书的数据"。
 * 这两类 bug 最恶劣的地方是静默：模型照样返回一段很顺的文本，界面上毫无异常，
 * 但实际上它只看过开头三章（图谱漏了后半本），或者它看的是另一本书。
 * 所以每条用例都断言"选中的是哪几条"，而不是"返回了字符串"。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Novel } from "@/parsers/types";
import type { AgentContext } from "../types";
import { APIError } from "@/api/error-handler";
import { getTokenBudget, resolveOutputReserve } from "@/api/token-manager";
import {
  sampleChaptersContent,
  getRelevantContent,
  prepareAgentContext,
  getProviderBudget,
  chatWithContextRetry,
  executeAgentTask,
  formatAgentError,
  PRE_RETRIEVED_MIN_CHARS,
} from "../utils";

// ── 边界依赖全部拦掉：不发请求、不开 IndexedDB ──
const repo = vi.hoisted(() => ({ loadNovel: vi.fn() }));
const registry = vi.hoisted(() => ({ getProvider: vi.fn() }));
const apiStore = vi.hoisted(() => ({ state: { getActiveProvider: vi.fn((): unknown => undefined) } }));

vi.mock("@/db/repositories", () => ({ loadNovel: repo.loadNovel }));
vi.mock("@/api/registry", () => ({ getProvider: registry.getProvider }));
vi.mock("@/stores/api-store", () => ({ useAPIStore: { getState: () => apiStore.state } }));

function chapters(n: number, fill = "正文") {
  return Array.from({ length: n }, (_, i) => ({
    title: `第${i + 1}章`,
    content: `${fill}${i + 1}`,
  }));
}

/** 抽出采样结果里实际选中的章节标题（顺序敏感） */
function sampledTitles(text: string): string[] {
  return [...text.matchAll(/【(.+?)】/g)].map((m) => m[1]);
}

function makeNovel(id: string, title: string, chapterCount = 3): Novel {
  return {
    id,
    title,
    author: "作者",
    fileName: `${id}.txt`,
    fileFormat: "txt",
    totalChars: 1000,
    chapterCount,
    createdAt: 1,
    updatedAt: 1,
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-ch-${i}`,
      novelId: id,
      index: i,
      title: `第${i + 1}章`,
      content: `第${i + 1}章内容`,
      startOffset: 0,
      endOffset: 10,
    })),
  };
}

beforeEach(() => {
  repo.loadNovel.mockReset();
  registry.getProvider.mockReset();
  apiStore.state.getActiveProvider.mockReset().mockReturnValue(undefined);
});

// ============================================================
// 回退采样：没有 RAG 预检索时，哪些章节会被喂给模型
// ============================================================

describe("sampleChaptersContent — 回退采样选中哪些章节", () => {
  it("长书采样必须覆盖开头、中段、结尾（只看开头＝漏掉后半本）", () => {
    const result = sampleChaptersContent(chapters(13));
    expect(sampledTitles(result)).toEqual(["第1章", "第2章", "第3章", "第7章", "第13章"]);
  });

  it("中段取样点取整除位（floor），不越过中点", () => {
    // 13 章：floor(13/2)=6 → 第 7 章；若改成 ceil 会拿成第 8 章
    expect(sampledTitles(sampleChaptersContent(chapters(13)))).toContain("第7章");
  });

  it("末章只在章节数 > 3 时补入，且必须是真正的最后一章", () => {
    expect(sampledTitles(sampleChaptersContent(chapters(4)))).toEqual(["第1章", "第2章", "第3章", "第4章"]);
    expect(sampledTitles(sampleChaptersContent(chapters(3)))).toEqual(["第1章", "第2章", "第3章"]);
  });

  it("中段取样开关的边界是 6 章：6 章不取中段，7 章才取", () => {
    expect(sampledTitles(sampleChaptersContent(chapters(6)))).toEqual(["第1章", "第2章", "第3章", "第6章"]);
    expect(sampledTitles(sampleChaptersContent(chapters(7)))).toEqual(["第1章", "第2章", "第3章", "第4章", "第7章"]);
  });

  it("章节数不足时不越界取空（老索引必须被过滤掉）", () => {
    expect(() => sampledTitles(sampleChaptersContent(chapters(2)))).not.toThrow();
    expect(sampledTitles(sampleChaptersContent(chapters(2)))).toEqual(["第1章", "第2章"]);
    expect(sampledTitles(sampleChaptersContent(chapters(1)))).toEqual(["第1章"]);
    expect(sampleChaptersContent([])).toBe("");
  });

  it("maxSamples 限制实际送出的章节条数（预算收紧时不能超发）", () => {
    expect(sampledTitles(sampleChaptersContent(chapters(13), 3))).toEqual(["第1章", "第2章", "第3章"]);
    expect(sampledTitles(sampleChaptersContent(chapters(13), 1))).toEqual(["第1章"]);
  });

  it("单章正文截到 2000 字符：长章不吃掉整段预算，短章原样保留", () => {
    const long = chapters(8);
    long[0].content = "甲".repeat(2600);
    const result = sampleChaptersContent(long);
    expect(result).toContain("甲".repeat(2000));
    expect(result).not.toContain("甲".repeat(2001));
    // 未被截断的章节内容必须完整出现（改成 200 会让模型只看到章节开头一句）
    expect(result).toContain("正文5");
  });

  it("拼接顺序保持原书章节顺序（乱序会让模型把后文当前情节点）", () => {
    const titles = sampledTitles(sampleChaptersContent(chapters(13)));
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, "zh", { numeric: true })));
  });
});

// ============================================================
// 预检索 vs 回退采样：走哪条路，以及标签是否如实
// ============================================================

describe("getRelevantContent — 预检索与回退采样两条路径", () => {
  const ctx = (preRetrieved?: string): AgentContext => ({ novelId: "n1", preRetrieved });

  it("预检索内容够长时直接用它，并标成语义检索（不回退采样）", () => {
    const pre = "令狐冲与任盈盈在梅庄相遇，岳不群露出真面目。".repeat(10); // > 100 字符
    const r = getRelevantContent(ctx(pre), chapters(13));
    expect(r.content).toBe(pre);
    expect(r.label).toBe("语义检索相关段落");
    expect(sampledTitles(r.content)).toEqual([]);
  });

  it("阈值边界：恰好到门槛算预检索，差一个字符必须回退采样", () => {
    expect(getRelevantContent(ctx("a".repeat(PRE_RETRIEVED_MIN_CHARS)), chapters(13)).label).toBe("语义检索相关段落");
    const short = getRelevantContent(ctx("a".repeat(PRE_RETRIEVED_MIN_CHARS - 1)), chapters(13));
    expect(short.label).toBe("内容样本");
    expect(short.content).toContain("第13章");
  });

  it("没有预检索时回退采样，标签如实写成内容样本", () => {
    const r = getRelevantContent(ctx(undefined), chapters(13));
    expect(r.label).toBe("内容样本");
    expect(sampledTitles(r.content)).toEqual(["第1章", "第2章", "第3章", "第7章", "第13章"]);
  });
});

// ============================================================
// 运行环境准备：绝不能拿 A 书的 id 去取 B 书的数据
// ============================================================

describe("prepareAgentContext — 加载哪本书", () => {
  const config = { id: "p1", format: "openai" as const, name: "t", apiKey: "k", baseUrl: "u", model: "gpt-4o" };

  beforeEach(() => {
    apiStore.state.getActiveProvider.mockReturnValue(config);
    registry.getProvider.mockReturnValue({ format: "openai", chat: vi.fn() });
  });

  it("preloadedNovel 是别的书时必须回源按 novelId 加载（串号防护）", async () => {
    repo.loadNovel.mockResolvedValue(makeNovel("book-B", "B 书"));
    const result = await prepareAgentContext({
      novelId: "book-B",
      // 批量循环里残留的上一本书：id 不匹配就绝不能复用
      preloadedNovel: makeNovel("book-A", "A 书"),
    });
    expect(repo.loadNovel).toHaveBeenCalledWith("book-B", undefined, undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.novel.id).toBe("book-B");
      expect(result.novel.title).toBe("B 书");
    }
  });

  it("preloadedNovel 就是本书时复用，不再整本读一次 IndexedDB", async () => {
    repo.loadNovel.mockResolvedValue(makeNovel("book-B", "B 书"));
    const preloaded = makeNovel("book-B", "B 书", 5);
    const result = await prepareAgentContext({ novelId: "book-B", preloadedNovel: preloaded });
    expect(repo.loadNovel).not.toHaveBeenCalled();
    if (result.success) expect(result.novel).toBe(preloaded);
  });

  it("loadAllContent 选项透传给仓储（地图只要目录，不该把全书正文读进内存）", async () => {
    repo.loadNovel.mockResolvedValue(makeNovel("book-A", "A 书"));
    await prepareAgentContext({ novelId: "book-A" }, { loadAllContent: false });
    expect(repo.loadNovel).toHaveBeenCalledWith("book-A", undefined, false);
  });

  it("小说查不到时失败并给出文案，不带空数据继续跑", async () => {
    repo.loadNovel.mockResolvedValue(null);
    const result = await prepareAgentContext({ novelId: "gone" });
    expect(result).toEqual({ success: false, error: "小说数据未找到" });
  });

  it("未配置 API 时把配置提示原样返回（不许退化成默认 provider）", async () => {
    apiStore.state.getActiveProvider.mockReturnValue(undefined);
    repo.loadNovel.mockResolvedValue(makeNovel("book-A", "A 书"));
    const result = await prepareAgentContext({ novelId: "book-A" });
    expect(result).toEqual({ success: false, error: "请先在设置中配置 API" });
    expect(registry.getProvider).not.toHaveBeenCalled();
  });
});

// ============================================================
// Provider 预算与 400 自愈
// ============================================================

describe("getProviderBudget", () => {
  it("用户在设置里填的上下文窗口与输出上限必须进预算", () => {
    apiStore.state.getActiveProvider.mockReturnValue({
      id: "p", format: "openai", name: "t", apiKey: "k", baseUrl: "u",
      model: "custom-xyz", contextWindow: 32768, maxTokens: 8192,
    });
    const r = getProviderBudget();
    expect(r.model).toBe("custom-xyz");
    // 逐字段比，不拿 toEqual 整对象：`userMaxOutputTokens` 记录的是"这个上限是用户亲手
    // 填的"，任务默认预算要不要给它让路全看这一格，被 toEqual 的 undefined 宽松规则
    // 混过去就等于把这条事实从判据里抹掉了。
    expect(r.budget.contextWindow).toBe(32768);
    expect(r.budget.maxOutputTokens).toBe(8192);
    expect(r.budget.userMaxOutputTokens).toBe(8192);
  });

  it("用户没填输出上限时不许凭空造一个（否则任务默认预算就永远让路）", () => {
    apiStore.state.getActiveProvider.mockReturnValue({
      id: "p", format: "openai", name: "t", apiKey: "k", baseUrl: "u",
      model: "gpt-4o",
    });
    const r = getProviderBudget();
    // **这条的名字一直说的是"不许凭空造"，而老期望造的正是反话**：它写的是 `16384 // 表值`，
    // 因为那时预算表里有一列按模型名写死的"最大输出"。2026-09-27 那一列删了（它是在猜，猜小了的
    // 代价实测过：推理型厂商把整份预算花在思考上、正文一个字都不回），现在标题才是真被守住的：
    // 用户没填、也没从 400 学到 → `undefined`，任务默认预算不必让路。
    expect(r.budget.maxOutputTokens).toBeUndefined();
    expect(r.budget.userMaxOutputTokens).toBeUndefined();
    expect(r.budget.contextWindow).toBe(128000); // 窗口那一列留着
  });

  it("未配置 API 时不抛异常：config 为空、model 为空串（调用方据此走失败分支）", () => {
    apiStore.state.getActiveProvider.mockReturnValue(undefined);
    const r = getProviderBudget();
    expect(r.model).toBe("");
    expect(r.config).toBeFalsy();
    // 老期望是 `{ contextWindow: 128000, maxOutputTokens: 4096 }`——那个 4096 就是被删掉的
    // "未匹配一律按 4096 猜"。空模型名现在只有窗口可给，输出侧留空由任务预设决定。
    expect(r.budget).toEqual({ contextWindow: 128000, maxOutputTokens: undefined, userMaxOutputTokens: undefined });
  });
});

describe("chatWithContextRetry — context_length 自愈", () => {
  const env = (modelName: string, contextWindow: number) => ({
    novel: makeNovel("n", "书"),
    provider: { format: "openai", chat: vi.fn() },
    budget: { contextWindow, maxOutputTokens: 4096 },
    modelName,
  }) as never;

  it("400 后按真实窗口重试一次（重试用的预算必须已经改小）", async () => {
    const seen: Array<{ contextWindow: number }> = [];
    const attempt = vi.fn(async (b: { contextWindow: number }) => {
      seen.push({ contextWindow: b.contextWindow });
      if (seen.length === 1) throw new APIError("This model's maximum context length is 8192 tokens", "context_length");
      return { content: "ok", tokensUsed: { input: 1, output: 1, total: 2 } } as never;
    });
    const res = await chatWithContextRetry(env("selfheal-model-1", 128000), attempt);
    expect(res.content).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(seen[0].contextWindow).toBe(128000);
    expect(seen[1].contextWindow).toBe(8192);
  });

  it("非 context_length 错误原样抛出，不做无意义重试", async () => {
    // 消息里故意带上可被解析成上下文的数字：只有 apiCode 判定能拦住这次重试
    const attempt = vi.fn(async () => {
      throw new APIError("上游 500：模型 maximum context length is 8192 tokens", "server");
    });
    await expect(chatWithContextRetry(env("selfheal-model-4", 128000), attempt as never)).rejects.toThrow("上游 500");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("输出超限（output_limit）走的自愈只许缩输出，一毫都不许动窗口", async () => {
    // **这条的口径 2026-09-27 改过一次**：老的那条叫「不许走自愈」，它防的是真坑——厂商那句
    // 「限制 4096」会被 `extractContextLength` 读成一个窗口，写进发现缓存之后整场会话都按小窗口
    // 喂原文，界面上一次异常都没有。制作人拍的修法（删掉预算表的输出上限那一列 + 认 400 学上限）
    // 不撤销这个恐惧，只是把它挪个位置：现在这一支**要**重试，但改的只有输出侧。
    // 所以两头各钉一句：第二发的 `maxOutputTokens` 必须按厂商给的数字变小，而 `contextWindow` 必须一个字没变。
    const seen: Array<{ contextWindow: number; maxOutputTokens?: number }> = [];
    const attempt = vi.fn(async (b: { contextWindow: number; maxOutputTokens?: number }) => {
      seen.push({ contextWindow: b.contextWindow, maxOutputTokens: b.maxOutputTokens });
      throw new APIError("请求的输出长度超过模型单次允许的上限 (400)。厂商原话：field MaxTokens invalid, should be in [1, 2048]", "output_limit");
    });
    await expect(chatWithContextRetry(env("selfheal-out-7", 128000), attempt as never)).rejects.toThrow("输出长度");
    expect(seen[0].maxOutputTokens).toBe(4096); // 起手是 env 给的那个数
    expect(seen).toHaveLength(2); // 走重试，但不许超过一次
    for (const s of seen) expect(s.contextWindow, "窗口被厂商那句输出上限污染了").toBe(128000);
    expect(seen[1].maxOutputTokens).toBe(2048);
    expect(getTokenBudget("selfheal-out-7").contextWindow).toBe(128000);
  });

  it("错误信息里读不到真实窗口时抛出，而不是拿旧预算再撞一次", async () => {
    const attempt = vi.fn(async () => {
      throw new APIError("上下文超长", "context_length");
    });
    await expect(chatWithContextRetry(env("selfheal-model-5", 128000), attempt as never)).rejects.toThrow("上下文超长");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("自愈重试不许把已有的输出上限冒充成用户亲手填的", async () => {
    // `env.budget.maxOutputTokens` 可能是用户填的，也可能是上一次 400 学到的。回灌时若把它当作
    // `getTokenBudget` 的第三参，重试那一发就凭空多出"用户显式要过这个数"这条事实，任务默认预算
    // 得给它让路：小上限（4096）会把人物关系分析要的 16384 压回去，大上限（16384）对章节总结
    // 又比第一次要得更多。两个方向都不是用户的意思——正好是这次改动要修的反面。
    const seen: Array<{ maxOutputTokens?: number; userMaxOutputTokens?: number }> = [];
    const attempt = vi.fn(async (b: { maxOutputTokens?: number; userMaxOutputTokens?: number }) => {
      seen.push({ maxOutputTokens: b.maxOutputTokens, userMaxOutputTokens: b.userMaxOutputTokens });
      if (seen.length === 1) throw new APIError("This model's maximum context length is 8192 tokens", "context_length");
      return { content: "ok", tokensUsed: { input: 1, output: 1, total: 2 } } as never;
    });
    await chatWithContextRetry(env("selfheal-usercap-model", 128000), attempt);
    expect(seen).toHaveLength(2);
    expect(seen[0].userMaxOutputTokens).toBeUndefined();
    expect(seen[1].userMaxOutputTokens).toBeUndefined();
    expect(seen[1].maxOutputTokens).toBe(4096); // env 给的那个数原样带走，没被改小也没被冒充成用户值
  });

  it("自愈只换上下文窗口，不许顺手把 env 里的输出上限换成\"没有上限\"", async () => {
    // 用户在设置里把输出上限调到 16384（预算不足时的官方建议动作就是这个）。
    // 旧实现在重试处调 getTokenBudget(env.modelName) 不带参数，输出上限被抹回表里的 4096。
    const seen: Array<{ contextWindow: number; maxOutputTokens: number }> = [];
    const attempt = vi.fn(async (b: { contextWindow: number; maxOutputTokens: number }) => {
      seen.push({ contextWindow: b.contextWindow, maxOutputTokens: b.maxOutputTokens });
      if (seen.length === 1) throw new APIError("This model's maximum context length is 8192 tokens", "context_length");
      return { content: "ok", tokensUsed: { input: 1, output: 1, total: 2 } } as never;
    });
    const e = {
      novel: makeNovel("n", "书"),
      provider: { format: "openai", chat: vi.fn() },
      budget: { contextWindow: 128000, maxOutputTokens: 16384 },
      modelName: "selfheal-model-9",
    } as never;
    await chatWithContextRetry(e, attempt as never);
    expect(seen).toHaveLength(2);
    expect(seen[1].contextWindow).toBe(8192);
    expect(seen[1].maxOutputTokens).toBe(16384);
  });
});

/**
 * `output_limit` 自愈——「抬预算」的另一半（制作人 2026-09-27 拍的口径 1：删掉预算表的输出上限那一列，
 * 改成"预设要多少就要多少，厂商嫌多会自己退一步"）。没有这一半，删表就是把厂商从"回空正文"
 * 推到"直接 400 红在 `[输出超限]`"。
 *
 * 认的三种措辞是当天直连量到的原话（`anr-e2e-real/probe-deepseek-budget.mjs reject`）：
 *  - deepseek：`Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`（65536／200000 都收）
 *  - sensenova：`field MaxTokens invalid, should be in [1, 65536]`
 *  - longcat：`参数校验失败: /max_tokens: 1000000 is not less or equal to 262144`
 * 另两家量不出东西：modelscope 对 1000000 回的是 **HTTP 200 + 空壳**（`choices:null`，没数字可抠），
 * 411 三档全撞在 429 配额墙上。所以"认不到数字就不许猜"不是偷懒，是那两家根本没有数字。
 */
describe("chatWithContextRetry — output_limit 自愈（学到上限就缩一档重发）", () => {
  /** 预算一律由 `getTokenBudget` 造：手搓 `{maxOutputTokens: 16384, userMaxOutputTokens: 1024}` 是产品永远产不出的形状 */
  const e = (modelName: string, userCap?: number) =>
    ({
      novel: makeNovel("n", "书"),
      provider: { format: "openai", chat: vi.fn() },
      budget: getTokenBudget(modelName, 128000, userCap),
      modelName,
    }) as never;

  /** 每一发实际要了多少（任务预设取 16384，与调用点同一算法） */
  const asks = (log: Array<{ maxOutputTokens?: number }>) =>
    log.map((b) => resolveOutputReserve({ contextWindow: 128000, ...b } as never, 16384));

  it("厂商说 [1, 3072] 而我们要 16384：按它给的 3072 重发一发，并缓存进这一家的上限", async () => {
    const log: Array<{ maxOutputTokens?: number }> = [];
    const attempt = vi.fn(async (b: { maxOutputTokens?: number }) => {
      log.push({ maxOutputTokens: b.maxOutputTokens });
      if (log.length === 1) {
        throw new APIError("输出超限 (400)。厂商原话：Invalid max_tokens value, the valid range of max_tokens is [1, 3072]", "output_limit");
      }
      return { content: "带回正文了", tokensUsed: { input: 1, output: 1, total: 2 } } as never;
    });
    const r = await chatWithContextRetry(e("learn-range-model"), attempt as never);
    expect(r.content).toBe("带回正文了");
    expect(asks(log)).toEqual([16384, 3072]);
    // 学到的上限进了预算：同一家下一发不再撞同一堵墙。
    // 数字故意取 3072——不是 4096：未匹配的模型过去正落在 4096 那个默认上，取同值会"因为错的理由通过"。
    expect(getTokenBudget("learn-range-model").maxOutputTokens).toBe(3072);
  });

  it("`is not less or equal to N` 那种措辞也认（longcat 实测形状）", async () => {
    const log: Array<{ maxOutputTokens?: number }> = [];
    const attempt = vi.fn(async (b: { maxOutputTokens?: number }) => {
      log.push({ maxOutputTokens: b.maxOutputTokens });
      if (log.length === 1) {
        throw new APIError("输出超限 (400)。厂商原话：参数校验失败: /max_tokens: 300000 is not less or equal to 8192", "output_limit");
      }
      return { content: "ok", tokensUsed: { input: 1, output: 1, total: 2 } } as never;
    });
    await chatWithContextRetry(e("learn-lte-model"), attempt as never);
    expect(asks(log)).toEqual([16384, 8192]);
    // 学到的进了预算，且**下一发的预设让位给它**：这正是删掉表里那一列之后唯一的天花板来源。
    expect(getTokenBudget("learn-lte-model").maxOutputTokens).toBe(8192);
    expect(getTokenBudget("learn-lte-model").userMaxOutputTokens).toBeUndefined();
  });

  it("厂商给的数字不比我们要的小 → 那句 400 不是\"要得太多\"，一次都不许多发", async () => {
    // deepseek 真回过 `[1, 393216]`：若我们只发了 16384 还被拒，问题在别处（配额、参数、模型名）。
    // 拿它当"学到 393216"去重发，等于把一次失败变成两次，还把一个我们没用过的数写进缓存。
    const log: Array<{ maxOutputTokens?: number }> = [];
    const attempt = vi.fn(async (b: { maxOutputTokens?: number }) => {
      log.push({ maxOutputTokens: b.maxOutputTokens });
      throw new APIError("输出超限 (400)。厂商原话：the valid range of max_tokens is [1, 393216]", "output_limit");
    });
    await expect(chatWithContextRetry(e("learn-bigger-model"), attempt as never)).rejects.toThrow("输出超限");
    expect(log).toHaveLength(1);
    expect(getTokenBudget("learn-bigger-model").maxOutputTokens).toBeUndefined();
  });

  it("认不到数字就不许猜：只发一发，错误原样抛（modelscope 那家回的是 200 空壳，压根没有数字）", async () => {
    const log: Array<{ maxOutputTokens?: number }> = [];
    const attempt = vi.fn(async (b: { maxOutputTokens?: number }) => {
      log.push({ maxOutputTokens: b.maxOutputTokens });
      throw new APIError("输出超限 (400)。厂商原话：参数不合法", "output_limit");
    });
    await expect(chatWithContextRetry(e("learn-nnn-model"), attempt as never)).rejects.toThrow("参数不合法");
    expect(log).toHaveLength(1);
    expect(getTokenBudget("learn-nnn-model").maxOutputTokens).toBeUndefined();
  });

  it("用户亲手填了 1024，厂商却说它能写 8192：那不是超发，一次都不许多发", async () => {
    const log: Array<{ maxOutputTokens?: number }> = [];
    const attempt = vi.fn(async (b: { maxOutputTokens?: number }) => {
      log.push({ maxOutputTokens: b.maxOutputTokens });
      throw new APIError("输出超限。厂商原话：should be in [1, 8192]", "output_limit");
    });
    // 用户那一档比厂商给的还小 → 我们实际要的（1024）远在厂商天花板以下，那句 400 另有原因
    // （配额、参数、模型名）。拿"学到 8192"去重发等于白烧一发，还可能把 8192 当成新上限写进缓存。
    await expect(chatWithContextRetry(e("learn-usersmall-model", 1024), attempt as never)).rejects.toThrow("输出超限");
    expect(log).toHaveLength(1);
    // 那一家的缓存里**不许**因此留下 8192：学到的数只在"确实比我们的小"时才进缓存，
    // 否则同一家厂商在别的任务上会被这个从没见过我们ask过的数压住。
    expect(getTokenBudget("learn-usersmall-model").maxOutputTokens).toBeUndefined();
  });

  it("用户填 16384、厂商说 [1, 4096]：重发取更小的那个，而学到的绝不冒充\"用户显式要过\"", async () => {
    const log: Array<{ maxOutputTokens?: number; userMaxOutputTokens?: number }> = [];
    const attempt = vi.fn(async (b: { maxOutputTokens?: number; userMaxOutputTokens?: number }) => {
      log.push({ maxOutputTokens: b.maxOutputTokens, userMaxOutputTokens: b.userMaxOutputTokens });
      if (log.length === 1) {
        throw new APIError("输出超限。厂商原话：should be in [1, 4096]", "output_limit");
      }
      return { content: "ok", tokensUsed: { input: 1, output: 1, total: 2 } } as never;
    });
    await chatWithContextRetry(e("learn-bothcaps-model", 16384), attempt as never);
    // 两个来源都是天花板，取更小的：学到 4096 之后第二发就该要 4096，而不是仍按用户填的 16384 撞第二回
    expect(asks(log)).toEqual([16384, 4096]);
    // 而"用户填过"这条事实必须原样留着：它是任务默认预算让不让路的唯一依据（`resolveOutputReserve`）。
    // 一旦学到的数被写成 `userMaxOutputTokens`，同一家厂商的其他任务会误以为"用户要过 4096"，
    // 连本来该要 16384 的地图也跟着缩——这正是批次 F 修过的那个反面。
    expect(log.map((b) => b.userMaxOutputTokens)).toEqual([16384, 16384]);
  });

  it("用户压根没填时，学到的数不许变成\"用户填过\"（任务默认预算该照要 16384）", async () => {
    const log: Array<{ userMaxOutputTokens?: number; maxOutputTokens?: number }> = [];
    const attempt = vi.fn(async (b: { userMaxOutputTokens?: number; maxOutputTokens?: number }) => {
      log.push({ userMaxOutputTokens: b.userMaxOutputTokens, maxOutputTokens: b.maxOutputTokens });
      if (log.length === 1) {
        throw new APIError("输出超限。厂商原话：should be in [1, 2048]", "output_limit");
      }
      return { content: "ok", tokensUsed: { input: 1, output: 1, total: 2 } } as never;
    });
    await chatWithContextRetry(e("learn-notuser-model"), attempt as never);
    expect(log).toEqual([
      { userMaxOutputTokens: undefined, maxOutputTokens: undefined },
      { userMaxOutputTokens: undefined, maxOutputTokens: 2048 },
    ]);
  });
});

// ============================================================
// 错误出口：格式与包装
// ============================================================

describe("executeAgentTask / formatAgentError", () => {
  it("APIError 走 [apiCode] 前缀（不是内部映射码，也不是成功壳）", async () => {
    const r = await executeAgentTask("map", async () => {
      throw new APIError("超出上下文", "context_length", 400);
    });
    expect(r).toEqual({ success: false, error: "[context_length] 超出上下文" });
  });

  it("成功结果原样透传，不加壳", async () => {
    const r = await executeAgentTask("map", async () => ({ success: true, data: { mapData: { places: [1] } }, tokensUsed: 7 }));
    expect(r).toEqual({ success: true, data: { mapData: { places: [1] } }, tokensUsed: 7 });
  });

  it("非 Error 抛出时归成未知错误而不是崩溃", () => {
    expect(formatAgentError("boom")).toBe("未知错误");
    expect(formatAgentError(new Error("普通失败"))).toBe("普通失败");
  });
});
