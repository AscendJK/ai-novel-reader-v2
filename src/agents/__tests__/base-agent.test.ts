/**
 * BaseAgent 外壳的判别力测试（第 1 档补直接判据）
 *
 * `base-agent.ts` 只有 117 行，可四只真 Agent（analyzers / graph-agent / map-agent / summarizer）
 * 都从它出发，而它管的两件事都是**静默**的：
 * - 喂给模型的是"整本正文"还是"只有目录"——选错了模型照样回一段很顺的文本，界面上没有异常，
 *   产出却是纯目录幻觉（旧账 R-40 同一族），或者在千章书上把内存吃穿。
 * - 用户看到的错误文案——把厂商英文原文漏到屏上，或把内部码当文案，都是"能看但没用"。
 *
 * 桩只拦最外三层（IndexedDB 仓储 / provider 注册表 / API store），`prepareAgentContext`
 * 与预算表**真跑**：判"要不要全书加载"唯一可信的读数就是 `loadNovel` 的第三个参数，
 * 拦掉 utils 只能判到中间那个 options 对象，等于没判。
 *
 * 未判、未改的一格（写清楚，别让它以后被当成"有人看着"）：`execute` 抛 AbortError 时
 * `handleError` 只给文案"操作已取消"、**不**置 `cancelled`，是不是失败要靠上层
 * `runTask.ts:77` 的 `isAbortError(result.error, context.signal)` 兜——signal 已 abort 时兜得住。
 * "另有一把内部信号被 abort、而 `context.signal` 没 abort"这一发我没在产品里找到现场，
 * 所以只钉当前口径（文案友好、不 reject），不替它编一条更严的判据。
 *
 * 变异台账（每刀手动一次一处、跑完立刻 `cp` 字节备份还原并核 SHA256 回
 * `381afc45…`；`MUT-` 残留计数 0）：
 * | 刀 | 改法 | 红了哪几条 |
 * | --- | --- | --- |
 * | 1 | `loadAllContent` 恒成 `undefined`（预检索够用也全书加载） | 1 条：「够长时只要目录」`expected undefined to be false` |
 * | 2 | `loadAllContent` 恒成 `false`（从不全书加载） | 2 条：「差一个字符就不算」「完全没有预检索」`expected false to be undefined` |
 * | 3 | 摘掉 `if (!env.success) return` | 2 条：「小说查不到」「未配置 API」——`seen` 长度 1 而不是 0 |
 * | 4 | `handleError` 回 `appError.message`（厂商原文） | 2 条：「中文文案」「取消走『操作已取消』」`expected … error: 'aborted'` |
 * | 5 | 摘掉 `run()` 的 try/catch | 5 条：错误面四条全 reject + 「绝不 reject」 |
 * | 6 | `run()` 内联 `prepareAgentContext(...)`，不再走 `this.prepareEnvironment` | 1 条：「子类覆写算数」——`loadNovel` 被调了 1 次 |
 * | 7 | `console.error` 不再带 `appError.code` | 1 条：「码要留在 console.error 里」 |
 * | 8 | 把 `[${appError.code}]` 拼进用户文案 | 3 条：三条文案判据（屏上那句长了前缀） |
 *
 * 刀1 与刀2 各只咬自己那一格、刀6 只咬虚方法那一格，说明这几条不是"一起红"的连体判据；
 * 刀4/刀8 都咬文案但红法不同（一个是英文原文上屏、一个是内部码上屏），两条各管一桩。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Novel } from "@/parsers/types";
import type { Agent, AgentContext, AgentResult } from "../types";
import type { AIProvider } from "@/api/types";
import { APIError } from "@/api/error-handler";
import { PRE_RETRIEVED_MIN_CHARS } from "../utils";
import { BaseAgent, type AgentEnvironment } from "../base-agent";

// ── 只拦最外层：不发请求、不开 IndexedDB、不读真设置 ──
const repo = vi.hoisted(() => ({ loadNovel: vi.fn() }));
const registry = vi.hoisted(() => ({ getProvider: vi.fn() }));
const apiStore = vi.hoisted(() => ({ state: { getActiveProvider: vi.fn((): unknown => undefined) } }));

vi.mock("@/db/repositories", () => ({ loadNovel: repo.loadNovel }));
vi.mock("@/api/registry", () => ({ getProvider: registry.getProvider }));
vi.mock("@/stores/api-store", () => ({ useAPIStore: { getState: () => apiStore.state } }));

const CONFIG = {
  id: "p1",
  format: "openai" as const,
  name: "配置名",
  apiKey: "sk-ascii-only",
  baseUrl: "https://example.invalid/v1",
  model: "gpt-4o",
};

function makeNovel(id: string, title: string): Novel {
  return {
    id,
    title,
    author: "作者",
    fileName: `${id}.txt`,
    fileFormat: "txt",
    totalChars: 1000,
    chapterCount: 2,
    createdAt: 1,
    updatedAt: 1,
    chapters: [0, 1].map((i) => ({
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

/** 记录 execute 收到的东西，行为可由用例替换（抛出 / 返回） */
class ProbeAgent extends BaseAgent {
  name = "probe";
  description = "探针 Agent";
  seen: Array<{ context: AgentContext; env: AgentEnvironment }> = [];
  behavior: () => Promise<AgentResult> = async () => ({ success: true, data: "ok", tokensUsed: 7 });

  protected async execute(context: AgentContext, env: AgentEnvironment): Promise<AgentResult> {
    this.seen.push({ context, env });
    return this.behavior();
  }
}

/** 覆写 `prepareEnvironment`：不调 `prepareAgentContext`，直接给一只固定 env */
class StubEnvAgent extends ProbeAgent {
  static stubEnv: AgentEnvironment = {
    novel: makeNovel("stub-book", "桩书"),
    provider: { format: "openai", chat: vi.fn() } as unknown as AIProvider,
    budget: { contextWindow: 1, maxOutputTokens: 1 },
    modelName: "stub-model",
  };

  protected async prepareEnvironment(): Promise<{ success: true; novel: Novel; provider: AIProvider; budget: AgentEnvironment["budget"]; modelName: string }> {
    const { novel, provider, budget, modelName } = StubEnvAgent.stubEnv;
    return { success: true, novel, provider, budget, modelName };
  }
}

/** 只取 `loadNovel` 实际收到的第三个参数：`false` 与"根本没传"必须能分开 */
function thirdArg(): unknown {
  expect(repo.loadNovel).toHaveBeenCalled();
  return repo.loadNovel.mock.calls[0][2];
}

beforeEach(() => {
  repo.loadNovel.mockReset().mockResolvedValue(makeNovel("book-A", "A 书"));
  registry.getProvider.mockReset().mockReturnValue({ format: "openai", chat: vi.fn() });
  apiStore.state.getActiveProvider.mockReset().mockReturnValue(CONFIG);
});

describe("prepareEnvironment — 整本正文到底读不读进内存", () => {
  it("预检索内容够长时只要目录：loadNovel 第三参必须是 false，不是 undefined", async () => {
    const agent = new ProbeAgent();
    // 语义检索已经给出正文段落，再把全书读进来就是白占内存
    await agent.run({ novelId: "book-A", preRetrieved: "令".repeat(PRE_RETRIEVED_MIN_CHARS) });
    expect(thirdArg()).toBe(false);
  });

  it("预检索差一个字符就不算：这一格必须回到 undefined（照常全书加载）", async () => {
    // 阈值由 `PRE_RETRIEVED_MIN_CHARS` 一处管着三件事，所以这里按常量取值而不是写死 100：
    // 哪天常量改了，这一条测的才是新边界。
    const agent = new ProbeAgent();
    await agent.run({ novelId: "book-A", preRetrieved: "令".repeat(PRE_RETRIEVED_MIN_CHARS - 1) });
    expect(thirdArg()).toBeUndefined();
  });

  it("完全没有预检索时不许「顺手」传 false：那样问答只见目录不见正文", async () => {
    const agent = new ProbeAgent();
    await agent.run({ novelId: "book-A" });
    expect(thirdArg()).toBeUndefined();
  });

  it("子类覆写 prepareEnvironment 算数：run() 调的是虚方法，不是内联那一份", async () => {
    // map-agent 恒传 false、summarizer 恒传 true，全靠这一句 `this.prepareEnvironment(context)`。
    // 有人把 base 的实现内联进 run()（看着是"少一层"的重构），这两只子类会立刻退回默认口径：
    // 章节总结从此拿不到正文。
    const agent = new StubEnvAgent();
    const result = await agent.run({ novelId: "book-A", preRetrieved: "令".repeat(PRE_RETRIEVED_MIN_CHARS) });
    expect(repo.loadNovel).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(agent.seen[0].env.modelName).toBe("stub-model");
    expect(agent.seen[0].env.novel.id).toBe("stub-book");
  });
});

describe("run() — 环境没备好就不许动手", () => {
  it("小说查不到：execute 一次都不跑，文案原样是「小说数据未找到」", async () => {
    repo.loadNovel.mockResolvedValue(null);
    const agent = new ProbeAgent();
    const result = await agent.run({ novelId: "gone" });
    expect(agent.seen).toHaveLength(0);
    expect(result).toEqual({ success: false, error: "小说数据未找到" });
  });

  it("未配置 API：execute 一次都不跑，也不许退化成默认 provider 再撞一次", async () => {
    apiStore.state.getActiveProvider.mockReturnValue(undefined);
    const agent = new ProbeAgent();
    const result = await agent.run({ novelId: "book-A" });
    expect(agent.seen).toHaveLength(0);
    expect(registry.getProvider).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: "请先在设置中配置 API" });
    // 反证另一半：配置齐全时 `getProvider` 确实被调了一次——不然上面那句"没被调用"是空判
    apiStore.state.getActiveProvider.mockReturnValue(CONFIG);
    await agent.run({ novelId: "book-A" });
    expect(registry.getProvider).toHaveBeenCalledTimes(1);
  });

  it("execute 拿到的 env 带的是配置里的 model 名（400 自愈的发现缓存靠它当键）", async () => {
    const agent = new ProbeAgent();
    await agent.run({ novelId: "book-A" });
    expect(agent.seen).toHaveLength(1);
    const { env } = agent.seen[0];
    expect(env.novel.id).toBe("book-A");
    expect(env.modelName).toBe("gpt-4o");
    expect(env.budget.contextWindow).toBeGreaterThan(0);
  });

  it("成功结果原样透传，不加壳也不丢 tokensUsed", async () => {
    const agent = new ProbeAgent();
    const result = await agent.run({ novelId: "book-A" });
    expect(result).toEqual({ success: true, data: "ok", tokensUsed: 7 });
  });
});

describe("handleError — 屏上那句与日志里那句各管各的", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => spy.mockClear());

  it("厂商错误给用户看得懂的中文，英文原文与内部码都不许上屏", async () => {
    const agent = new ProbeAgent();
    agent.behavior = async () => {
      throw new APIError("This model's maximum context length is 8192 tokens, however you requested 16000", "context_length", 400);
    };
    const result = await agent.run({ novelId: "book-A" });
    expect(result).toEqual({ success: false, error: "请求内容超过模型上下文长度限制" });
    expect(result.error).not.toContain("maximum context length");
    expect(result.error).not.toContain("CONTEXT_LENGTH");
  });

  it("同一发的码要留在 console.error 里（屏上不给，日志必须有）", async () => {
    const agent = new ProbeAgent();
    agent.behavior = async () => {
      throw new APIError("上下文超长", "context_length", 400);
    };
    await agent.run({ novelId: "book-A" });
    expect(spy).toHaveBeenCalledWith("[Agent:probe] Error:", "CONTEXT_LENGTH", "上下文超长");
  });

  it("取消不是崩溃：走「操作已取消」这一档文案，run() 仍然 resolve", async () => {
    // 刻意用 `name = "AbortError"` 的普通 Error，而不是 DOMException：jsdom 里 DOMException
    // 不是 Error 的实例（旧账踩过），拿它当样本判的就是 jsdom 而不是产品。
    const agent = new ProbeAgent();
    agent.behavior = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    await expect(agent.run({ novelId: "book-A" })).resolves.toEqual({ success: false, error: "操作已取消" });
  });

  it("认不出码的普通错误不许编一句通用文案盖掉真因", async () => {
    // `getUserFriendlyMessage` 的 default 分支回的是 `appError.message`。有人"统一兜底"成
    // "发生未知错误，请重试"，用户就再也说不出坏在哪——这条钉的是 default 分支不许被盖掉。
    const agent = new ProbeAgent();
    agent.behavior = async () => {
      throw new Error("JSON 抽取在第 3 段就断了");
    };
    const result = await agent.run({ novelId: "book-A" });
    expect(result).toEqual({ success: false, error: "JSON 抽取在第 3 段就断了" });
  });

  it("execute 抛出时 run() 绝不 reject（上层 runAgentTask 拿的是 result 不是异常）", async () => {
    const agent = new ProbeAgent();
    agent.behavior = async () => {
      throw new Error("任何失败");
    };
    await expect(agent.run({ novelId: "book-A" })).resolves.toMatchObject({ success: false });
  });
});

describe("BaseAgent 的形状", () => {
  it("一只 Agent 只要实现 execute：name/description/run 都在（四只真 Agent 依赖这份契约）", async () => {
    const agent: Agent = new ProbeAgent();
    expect(agent.name).toBe("probe");
    expect(agent.description).toBe("探针 Agent");
    expect(typeof agent.run).toBe("function");
  });
});
