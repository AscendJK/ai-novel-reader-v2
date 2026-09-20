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
import {
  sampleChaptersContent,
  getRelevantContent,
  prepareAgentContext,
  getProviderBudget,
  chatWithContextRetry,
  executeAgentTask,
  formatAgentError,
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

  it("阈值边界：恰好 100 字符算预检索，99 字符必须回退采样", () => {
    expect(getRelevantContent(ctx("a".repeat(100)), chapters(13)).label).toBe("语义检索相关段落");
    const short = getRelevantContent(ctx("a".repeat(99)), chapters(13));
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
    expect(r.budget).toEqual({ contextWindow: 32768, maxOutputTokens: 8192 });
  });

  it("未配置 API 时不抛异常：config 为空、model 为空串（调用方据此走失败分支）", () => {
    apiStore.state.getActiveProvider.mockReturnValue(undefined);
    const r = getProviderBudget();
    expect(r.model).toBe("");
    expect(r.config).toBeFalsy();
    expect(r.budget).toEqual({ contextWindow: 128000, maxOutputTokens: 4096 });
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

  it("错误信息里读不到真实窗口时抛出，而不是拿旧预算再撞一次", async () => {
    const attempt = vi.fn(async () => {
      throw new APIError("上下文超长", "context_length");
    });
    await expect(chatWithContextRetry(env("selfheal-model-5", 128000), attempt as never)).rejects.toThrow("上下文超长");
    expect(attempt).toHaveBeenCalledTimes(1);
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
