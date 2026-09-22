/**
 * 全书总结的"预检索 / 回退采样"判别力测试
 *
 * 同一个阈值在这条链上管着三件事：要不要整本加载正文、送哪一段文本、标签写什么。
 * 它此前在四个地方各写一遍字面量 100，而标签那一处干脆没写阈值——5 个字的预检索
 * 会让 prompt 顶着"**语义检索相关段落**"、内容却是章节样本，模型据此把样本当成
 * 检索证据引用。这里把三件事钉在同一个来源上。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Novel } from "@/parsers/types";
import { globalSummarizerAgent } from "../summarizer";
import { PRE_RETRIEVED_MIN_CHARS } from "../utils";

const repo = vi.hoisted(() => ({ loadNovel: vi.fn() }));
const chat = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({ config: undefined as unknown }));

vi.mock("@/db/repositories", () => ({ loadNovel: repo.loadNovel }));
vi.mock("@/api/registry", () => ({ getProvider: () => ({ format: "openai", chat }) }));
vi.mock("@/stores/api-store", () => ({
  useAPIStore: { getState: () => ({ getActiveProvider: () => store.config }) },
}));

const CONFIG = {
  id: "p1", format: "openai" as const, name: "t", apiKey: "k", baseUrl: "u",
  model: "sum-small-model", contextWindow: 128000, maxTokens: 4096,
};

function makeNovel(chapterCount: number, id = "book-1"): Novel {
  return {
    id, title: "笑傲测试", author: "某作者", fileName: "f.txt", fileFormat: "txt",
    totalChars: 1000, chapterCount, createdAt: 1, updatedAt: 1,
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-ch-${i}`, novelId: id, index: i, title: `第${i + 1}章 标题`,
      content: `第${i + 1}章正文：令狐冲练剑。`, startOffset: 0, endOffset: 10,
    })),
  };
}

function promptOf(callIndex = 0): string {
  return chat.mock.calls[callIndex][0].messages[1].content as string;
}

async function run(overrides?: Record<string, unknown>) {
  return await globalSummarizerAgent.run({ novelId: "book-1", onStatus: vi.fn(), ...overrides } as never);
}

beforeEach(() => {
  repo.loadNovel.mockReset();
  chat.mockReset();
  store.config = CONFIG;
  repo.loadNovel.mockResolvedValue(makeNovel(13));
  chat.mockResolvedValue({ content: "一份分析。", tokensUsed: { output: 10 } });
});

describe("全书总结的预检索门槛", () => {
  const usable = "梅庄相聚".repeat(PRE_RETRIEVED_MIN_CHARS / 4); // 恰好 100 字符

  it("预检索恰好到达门槛：算可用，并且不再整本加载正文", async () => {
    expect(usable.length).toBe(PRE_RETRIEVED_MIN_CHARS);
    const r = await run({ preRetrieved: usable });
    expect(r.success).toBe(true);
    expect(repo.loadNovel).toHaveBeenCalledWith("book-1", undefined, false);
    const p = promptOf();
    expect(p).toContain("**语义检索相关段落：**");
    expect(p).toContain(usable.slice(0, 24));
    expect(p).not.toContain("【第1章 标题】开头:");
  });

  it("预检索差一个字符不到门槛：不算可用，此时必须真把正文读出来", async () => {
    const r = await run({ preRetrieved: usable.slice(0, PRE_RETRIEVED_MIN_CHARS - 1) });
    expect(r.success).toBe(true);
    expect(repo.loadNovel).toHaveBeenCalledWith("book-1", undefined, undefined);
    expect(promptOf()).toContain("【第1章 标题】开头:");
  });

  it("回退到章节样本时，标签不许标成「语义检索相关段落」", async () => {
    const r = await run({ preRetrieved: "太短了" });
    expect(r.success).toBe(true);
    const p = promptOf();
    // 内容实际是样本
    expect(p).toContain("【第1章 标题】开头:");
    // 标签必须跟着内容走，否则模型会把样本当检索证据引用
    expect(p).toContain("**内容样本（开头几章+中间+结尾的片段）：**");
    expect(p).not.toContain("**语义检索相关段落：**");
  });

  it("预检索可用时不许出现样本标签（两条路径只能有一条）", async () => {
    await run({ preRetrieved: usable });
    const p = promptOf();
    expect(p).not.toContain("**内容样本（开头几章+中间+结尾的片段）：**");
  });

  it("样本标签写了「开头几章+中间+结尾」，就必须真的给出首/中/尾三处", async () => {
    // 13 章 → `sampleChapters` 取第 1、2、7（中点）、13 章。钉死这三处的章号，是
    // 为了让"只塞第一章"这种退化在这里就红：真后端那条（R-E5）在配了检索的书签下走的
    // 是预检索分支，量不到样本分支，所以样本的覆盖只能在这一层守。
    await run({ preRetrieved: "太短了" });
    const p = promptOf();
    expect(p).toContain("【第1章 标题】开头:");
    expect(p).toContain("【第7章 标题】开头:");
    expect(p).toContain("【第13章 标题】开头:");
    // 而且每块都得真带正文，只列标题等于没给内容
    expect(p).toContain("第7章正文：令狐冲练剑。");
  });
});
