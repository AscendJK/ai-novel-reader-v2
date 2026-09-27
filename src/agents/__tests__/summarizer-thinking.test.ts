/**
 * 逐章摘要的"空正文 → 关思考重发"判别力
 *
 * 真厂商实测到的形状（2026-09-27，modelscope `ZhipuAI/GLM-5.3-Flash`）：按产品这一发原样复刻
 * （同 prompt、`max_tokens:1024`、`temperature:0.5`、`stream:true`）得到
 * `994 帧 / delta.content 0 字 / reasoning_content 3404 字 / finish_reason=length`——整份输出预算
 * 被思考链吃光，正文一个字都不发；而把提示里的"300-500 字"改成"120 字以内"，同一型号立刻回正文。
 * 也就是说**这家配上了也用不了本章摘要**，而界面上只有一句"API 返回了空内容"。
 *
 * 地图与图谱早就走这条路（`map-agent.ts:164` / `graph-agent.ts:97`：第二发带 `thinking:false` 重发），
 * 本章摘要漏在外面。判据按两头发写：第一发不许动思考（默认权留给厂商），只有确认那一发一个字
 * 正文都没回，才允许第二发。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Novel } from "@/parsers/types";
import { summarizerAgent } from "../summarizer";

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

/**
 * 章数按判据挑：判"发了几发"的用例只放**一章**——两章时"每章各一发"与"一章发两发"数值相同，
 * 计数就退化成弱断言（第一版就这么被喂绿过一条）；判"重发不许只跟着第一章"那一格才用两章。
 */
function makeNovel(chapterCount = 1, id = "book-1"): Novel {
  const chapters = Array.from({ length: chapterCount }, (_, i) => ({
    id: `${id}-ch-${i + 1}`, novelId: id, index: i, title: `第${i + 1}章 归程`,
    content: `第${i + 1}章正文：令狐冲在山道上回头看了一眼，洛阳的灯火已经远了。`.repeat(3),
    startOffset: 0, endOffset: 10,
  }));
  return {
    id, title: "笑傲测试", author: "某作者", fileName: "f.txt", fileFormat: "txt",
    totalChars: chapters.reduce((s, c) => s + c.content.length, 0), chapterCount,
    createdAt: 1, updatedAt: 1, chapters,
  };
}

/** 第 N 发请求（逐章摘要只有一条 user 消息，所以 prompt 取 messages[0]） */
function sent(at: number) {
  return chat.mock.calls[at][0] as { messages: Array<{ content: string }>; thinking?: boolean };
}
const thinkingOf = (at: number) => sent(at).thinking;
const promptOf = (at: number) => sent(at).messages[0].content;

async function run(chapterCount = 1) {
  repo.loadNovel.mockResolvedValue(makeNovel(chapterCount));
  return await summarizerAgent.run({ novelId: "book-1", onStatus: vi.fn() } as never);
}

beforeEach(() => {
  repo.loadNovel.mockReset();
  chat.mockReset();
  store.config = CONFIG;
});

describe("本章摘要的空正文重发", () => {
  it("第一发一个字正文都没回：必须再发一发关掉思考，正文取第二发那份", async () => {
    chat
      .mockResolvedValueOnce({ content: "", tokensUsed: { output: 0 } })
      .mockResolvedValue({ content: "这一章写的是归程与灯火。", tokensUsed: { output: 12 } });

    const r = await run();

    expect(r.success, "第二发拿到正文，整单就不该判失败").toBe(true);
    expect(chat, "空正文之后必须重发一发（而不是直接落一句失败）").toHaveBeenCalledTimes(2);
    expect(thinkingOf(0), "第一发不许动思考：默认权留给厂商").toBeUndefined();
    expect(thinkingOf(1), "第二发要带 thinking:false").toBe(false);
    const summaries = (r.data as { summaries: Array<{ content: string }> }).summaries;
    expect(summaries[0].content, "屏上要的是第二发的正文，不是那句失败").toBe("这一章写的是归程与灯火。");
  });

  it("两发都回空正文：这一章算失败，报的是空内容，并且不许发第三发", async () => {
    chat.mockResolvedValue({ content: "   ", tokensUsed: { output: 0 } });

    const r = await run();

    expect(r.success).toBe(false);
    expect(r.error, "递出去的原因要说准是空正文").toContain("空");
    expect(chat, "一发空正文之后重发一次就封顶").toHaveBeenCalledTimes(2);
    expect(thinkingOf(1), "封顶那一发就是关了思考的那一发").toBe(false);
    const summaries = (r.data as { summaries: Array<{ content: string }> }).summaries;
    expect(summaries.map((s) => s.content), "空白总结不许入库").toEqual(["总结生成失败: API 返回了空内容"]);
  });

  it("第一发就有正文：只许发一发（重发是空正文的退路，不是每次都走）", async () => {
    chat.mockResolvedValue({ content: "正常的总结正文。", tokensUsed: { output: 8 } });

    const r = await run();

    expect(r.success).toBe(true);
    expect(chat, "有正文就不该再花第二发").toHaveBeenCalledTimes(1);
    expect(thinkingOf(0)).toBeUndefined();
  });

  it("两章都空：每章各自重发一次（共四发），不许只重发第一章", async () => {
    chat.mockResolvedValue({ content: "", tokensUsed: { output: 0 } });

    await run(2);

    expect(chat, "两章 × 两发").toHaveBeenCalledTimes(4);
    const 章节顺序 = [0, 1, 2, 3].map((i) => (promptOf(i).includes("第1章正文") ? 1 : 2));
    expect(章节顺序, "重发必须跟着自己那一章的原文，不能串章").toEqual([1, 1, 2, 2]);
    expect([thinkingOf(0), thinkingOf(1), thinkingOf(2), thinkingOf(3)]).toEqual([undefined, false, undefined, false]);
  });
});

/**
 * 变异台账（2026-09-27 深夜实跑。基线快照 `E:/ClaudeCode/anr-e2e-real/mut-baseline-summarizer.ts`
 * ＝这份修复后的 `summarizer.ts`，sha 前缀 `15b672c1b7068f39`；还原走 `cp` 快照而不走 `git restore`
 * ——同一文件里带着未提交的修复，restore 会把它一起退掉。三刀跑完都是 markers=0、
 * sha 回到 `15b672c1b7068f39`、`git diff --numstat` 回到 `14 / 3`，还原后重跑 4 条全绿）：
 * - X1 摘掉重发（回到改造前：空正文直接落一句失败）→ **实测红 3 条：1、2、4**，与预期一致。
 * - X2 第一发就带 `thinking:false` → **实测红 3 条：1、3、4**（三处都判了"第一发不许动思考"）。
 * - X3 把正文取成 `chapters[0].content`（＝把请求抽到循环外、重发串回第一章的错写）
 *   → **实测红 1 条：只有第 4 条**「两章都空：每章各自重发一次（共四发），不许只重发第一章」，
 *   1/2/3 全绿——单章时串不串章看不出来，串章那半格只有两章才咬得住。
 * 没有一刀 0 红；三处"空正文重发"的格子（重发发生／第一发不动思考／重发跟着自己那章）各有哨兵。
 */
