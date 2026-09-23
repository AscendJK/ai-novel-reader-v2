/**
 * 四类文字任务的输出预留：设置里那个上限必须真的顶得开任务常数
 *
 * 起因是真厂商实测：sensenova 的 `deepseek-flash` 是推理模型，4096 的输出预算会被
 * "思考"整个吃满（`completion_tokens=4096 / reasoning_tokens=4096 / 正文 0 字`），
 * 人物关系分析与剧情时间线因此一个字都拿不到。制作人在设置里把输出上限填成 8192——
 * 对地图（常数 16384）生效了，对这两类任务却毫无作用，因为它们的请求写成
 * `Math.min(上限, 4096)`：常数是一堵墙，用户填多少都被它挡回去。
 *
 * 现在常数只在**用户没填**时用，而且这三类任务的常数已经从 4096 抬到 8192（制作人拍的：
 * 人物/时间线/全书总览都是"一次写一整篇"，4096 对一本长篇的名单或大事记真的会写不完）。
 * 章节总结仍留 1024——它一章一份，实测没写满过。
 *
 * 这里钉三件事：
 *  1. 没填 → 逐任务等于**当前**常数（改动只在常数上，别处不许漂移）；
 *  2. 填了 → 发出去的就是他填的那个数（所以这里故意填一个不等于任何常数的 12000）；
 *  3. 填得窗口装不下 → 按窗口钳，宁可少给输出也不许把喂给模型的原文挤穿
 *     （实测预留与可用输入 1:1 兑换）。
 *
 * 图谱与地图各自的文件里已经钉了同样的三条（`graph-agent.test.ts`、`map-agent.test.ts`），
 * 范围总结与问答在 e2e C 组按真请求体判（`e2e/specs/c-ai-generate.spec.ts`）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Novel } from "@/parsers/types";
import { summarizerAgent, globalSummarizerAgent } from "../summarizer";
import { characterAnalysisAgent, timelineAgent } from "../analyzers";

const repo = vi.hoisted(() => ({ loadNovel: vi.fn() }));
const chat = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({ config: undefined as unknown }));

vi.mock("@/db/repositories", () => ({ loadNovel: repo.loadNovel }));
vi.mock("@/api/registry", () => ({ getProvider: () => ({ format: "openai", chat }) }));
vi.mock("@/stores/api-store", () => ({
  useAPIStore: { getState: () => ({ getActiveProvider: () => store.config }) },
}));

/** gpt-4o：表内 128k 窗口 / 16384 输出上限——表值高于所有文字任务的常数，才好判"谁在挡" */
const BASE = { id: "p1", format: "openai" as const, name: "t", apiKey: "k", baseUrl: "u", model: "gpt-4o" };
/** 用户没填：只有表值 */
const NO_USER_CAP = { ...BASE, maxTokens: undefined };
/** 用户填了一个高于所有任务常数的数（12000：不撞任何常数，才判得出"谁在挡"） */
const USER_12000 = { ...BASE, maxTokens: 12000 };

const TASKS = [
  { label: "章节总结", agent: summarizerAgent, default: 1024 },
  { label: "全书总览", agent: globalSummarizerAgent, default: 8192 },
  { label: "人物关系分析", agent: characterAnalysisAgent, default: 8192 },
  { label: "剧情时间线", agent: timelineAgent, default: 8192 },
];

function novel(chapterCount = 4): Novel {
  const id = "book-1";
  return {
    id, title: "笑傲测试", author: "某作者", fileName: "f.txt", fileFormat: "txt",
    totalChars: 4000, chapterCount, createdAt: 1, updatedAt: 1,
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-ch-${i}`, novelId: id, index: i, title: `第${i + 1}章 标题`,
      content: `第${i + 1}章正文：令狐冲练剑，岳不群在旁看着。`.repeat(20), startOffset: 0, endOffset: 30,
    })),
  };
}

/** 发出去的那一发的 max_tokens */
function sentMaxTokens(callIndex = 0): number {
  return chat.mock.calls[callIndex][0].max_tokens as number;
}

async function runTask(agent: (typeof TASKS)[number]["agent"]) {
  return await agent.run({ novelId: "book-1", onStatus: vi.fn() } as never);
}

beforeEach(() => {
  repo.loadNovel.mockReset();
  chat.mockReset();
  repo.loadNovel.mockResolvedValue(novel());
  chat.mockResolvedValue({ content: "一段分析。", tokensUsed: { output: 10 } });
  store.config = NO_USER_CAP;
});

describe("用户没填输出上限：逐任务保持今天的常数", () => {
  it.each(TASKS)("$label 发 $default", async ({ agent, default: d }) => {
    const r = await runTask(agent);
    expect(r.success, r.error).toBe(true);
    expect(sentMaxTokens()).toBe(d);
  });
});

describe("用户填过输出上限：常数让路", () => {
  beforeEach(() => { store.config = USER_12000; });

  // 变异：把任意一个任务改回 `Math.min(b.maxOutputTokens, 常数)` → 那一档红在常数
  it.each(TASKS)("$label 发的是用户填的 12000", async ({ agent }) => {
    const r = await runTask(agent);
    expect(r.success, r.error).toBe(true);
    expect(sentMaxTokens()).toBe(12000);
  });
});

describe("用户填得窗口装不下时按窗口钳制", () => {
  it("12k 窗口 + 填 32768：宁可只留 10888 给输出，也要保住 512 的输入下限", async () => {
    store.config = { ...BASE, contextWindow: 12000, maxTokens: 32768 };
    const r = await runTask(summarizerAgent);
    expect(r.success, r.error).toBe(true);
    // bound = 12000 − min(1000, 600) − 512 = 10888
    expect(sentMaxTokens()).toBe(12000 - 600 - 512);
  });
});
