/**
 * 四类文字任务的输出预留：设置里那个上限必须真的顶得开任务常数
 *
 * 起因是真厂商实测：`deepseek-flash`（在 `api.deepseek.com`）是推理模型，4096 的输出预算会被
 * "思考"整个吃满（`completion_tokens=4096 / reasoning_tokens=4096 / 正文 0 字`），
 * 人物关系分析与剧情时间线因此一个字都拿不到。制作人在设置里把输出上限填成 8192——
 * 对地图（常数 16384）生效了，对这两类任务却毫无作用，因为它们的请求写成
 * `Math.min(上限, 4096)`：常数是一堵墙，用户填多少都被它挡回去。
 *
 * 现在常数只在**用户没填**时用。下面的默认值是 2026-09-27 直连 `api.deepseek.com` 按 `max_tokens`
 * 一档一档量出来的（`anr-e2e-real/probe-deepseek-budget.mjs`），不是拍出来的：
 *  - **章节总结 1024 → 4096**：老口径写的是"它一章一份，实测没写满过"，那句话今天被推翻了——
 *    1024 那一发 `completion_tokens=1024 / reasoning_tokens=1024 / 正文 0 字 / finish_reason=length`，
 *    思考把整份预算吃光；抬到 4096 同一发回 484 字正文、`finish_reason=stop`（实际只用 1,174 token，
 *    所以多出来的预算不是白给的开销，是"推理型厂商能不能用"的差别）。
 *  - **人物关系分析／剧情时间线 8192 → 16384**：时间线在 8192 那一发是 `正文 2007 字 +
 *    finish_reason=length`（思考 6800 token 占大头，正文截在半句上），16384 才 `stop`（正文 3232 字、
 *    实际吃 10,004 token）。**全书总览不动 8192**——没量过，不给它编一个数。
 *  - 代价实测过：预留与可用输入 1:1 兑换，128k 窗口下时间线的可用输入 118,808 → 110,616。
 *
 * 这里钉四件事：
 *  1. 没填 → 逐任务等于**当前**常数（改动只在常数上，别处不许漂移）；
 *  2. 填了 → 发出去的就是他填的那个数（所以这里故意填一个不等于任何常数的 12000）；
 *  3. 填得窗口装不下 → 按窗口钳，宁可少给输出也不许把喂给模型的原文挤穿（1:1 兑换）；
 *  4. **表里的输出上限低于任务常数时按表值发**：常数抬到 16384 之后，这一档才真的判得出"有没有超发"
 *     ——输出超限的 400 没有自愈（只有 `context_length` 那一类会重试），超发等于直接落一句 `[输出超限]`。
 *
 * 图谱与地图各自的文件里已经钉了同样的三条（`graph-agent.test.ts`、`map-agent.test.ts`），
 * 范围总结与问答在 e2e C 组按真请求体判（`e2e/specs/c-ai-generate.spec.ts`）。
 *
 * 变异台账（2026-09-27，基线 sha：`token-manager.ts` f93ba831、`analyzers.ts` bbec5a9f、
 * `summarizer.ts` 674dab26；每刀 markers=1、跑完 `cp` 还原后 sha 逐字对上）：
 *  - **K1** 把 `deepseek-flash` 的表值改回 4096（等价于"条目不存在"）→ 红 1：`token-manager.test.ts`
 *    那条"命中自己的条目"。（那一格的红名在本文件之外，故记在这里。）
 *  - **K2** `ANALYZER_OUTPUT_TOKENS` 退回 8192 → 红 2：人物关系分析／剧情时间线"发 16384"两条。
 *  - **K3** 章节总结的 `OUTPUT_TOKENS` 退回 1024 → 红 1："章节总结 发 4096"。
 *  - **K4** `resolveOutputReserve` 里摘掉 `budget.maxOutputTokens` 那一项（只留窗口钳）
 *    → 红 3：下面"按模型上限发"那两条 **加上** `token-manager-reserve.test.ts` 里"逐档等于旧的
 *      Math.min(上限, 常数)"。**如实记**：新加的那两条在立红阶段是绿的（当时常数 8192 ≤ 表值 8192、
 *      常数 4096 ≤ 表值 4096，撞不出差别），牙是常数抬上去之后才长出来的——所以 K4 这一刀
 *      同时是"这两条现在到底有没有牙"的证据。
 *  - BASE 模型从 `gpt-4o`（表值 16384）换成 `o1`（100000）本身也是量过的：留在 gpt-4o 时
 *    分析类常数与表值同数，"把常数整个换成表值"那把刀取不出读数。
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

/**
 * `o1`：表内 200k 窗口 / 100000 输出上限——表值必须**高于**所有文字任务的常数，才好判"谁在挡"。
 * 以前这里是 `gpt-4o`（上限 16384）：分析类常数抬到 16384 之后两者相等，于是"把常数整个换成模型上限"
 * 那把刀在这一档上量不出来（发出去的还是 16384）。换一只更高的模型才有牙。
 */
const BASE = { id: "p1", format: "openai" as const, name: "t", apiKey: "k", baseUrl: "u", model: "o1" };
/** 用户没填：只有表值 */
const NO_USER_CAP = { ...BASE, maxTokens: undefined };
/** 用户填了一个高于所有任务常数的数（12000：不撞任何常数，才判得出"谁在挡"） */
const USER_12000 = { ...BASE, maxTokens: 12000 };

const TASKS = [
  { label: "章节总结", agent: summarizerAgent, default: 4096 },
  { label: "全书总览", agent: globalSummarizerAgent, default: 8192 },
  { label: "人物关系分析", agent: characterAnalysisAgent, default: 16384 },
  { label: "剧情时间线", agent: timelineAgent, default: 16384 },
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

/**
 * 常数抬到 16384 之后新增的这一档：厂商自己说"我最多写 8192"时不许超发。
 * 输出超限的 400 没有自愈（`chatWithContextRetry` 只认 `context_length` 那一类），
 * 超发等于让整条任务落一句 `[输出超限]` ——那是"抬预算"这个修法自己的反证，必须钉住。
 * 取两个不同的键各打一遍：`deepseek-chat`（表值 8192）挡时间线，`claude-3-opus`（表值 4096）挡人物关系分析，
 * 这样"只在某一支漏掉表值钳"和"两支都漏"红的是不同的名字。
 */
describe("模型上限低于任务常数时按模型上限发（不许超发撞 400）", () => {
  it("时间线在 `deepseek-chat`（上限 8192）上发 8192，不是常数 16384", async () => {
    store.config = { ...BASE, model: "deepseek-chat", maxTokens: undefined };
    const r = await runTask(timelineAgent);
    expect(r.success, r.error).toBe(true);
    expect(sentMaxTokens()).toBe(8192);
  });

  it("人物关系分析在 `claude-3-opus`（上限 4096）上发 4096", async () => {
    store.config = { ...BASE, model: "claude-3-opus", maxTokens: undefined };
    const r = await runTask(characterAnalysisAgent);
    expect(r.success, r.error).toBe(true);
    expect(sentMaxTokens()).toBe(4096);
  });
});
