/**
 * 逐章摘要的"空正文 → 关思考重发"判别力
 *
 * 真厂商实测到的形状（2026-09-27，modelscope `ZhipuAI/GLM-5.3-Flash`）：按产品这一发原样复刻
 * （同 prompt、`max_tokens:1024`、`temperature:0.5`、`stream:true`）得到
 * `994 帧 / delta.content 0 字 / reasoning_content 3404 字 / finish_reason=length`——整份输出预算
 * 被思考链吃光，正文一个字都不发；而把提示里的"300-500 字"改成"120 字以内"，同一型号立刻回正文。
 * 也就是说**这家配上了也用不了本章摘要**，而界面上只有一句空正文的报错。
 *
 * 地图与图谱早就走这条路（`map-agent.ts:164` / `graph-agent.ts:97`：第二发带 `thinking:false` 重发），
 * 本章摘要漏在外面。判据按两头发写：第一发不许动思考（默认权留给厂商），只有确认那一发一个字
 * 正文都没回，才允许第二发。
 *
 * **空正文在这一腿是"抛错"，不是"回空串"**（这条本档第一版踩过）：`openai.ts:154` 与 `:190` 两处
 * 都把空正文抛成 `APIError`，前缀「API 返回了空结果」，而 `map-agent` / `graph-agent` 认的是
 * `isEmptyResultError(err)`（`openai.ts:192` 的注释就在说这件事）。所以这里的桩**必须 reject**——
 * 让桩 resolve 一个 `{content:""}` 的话，测的是产品里那条永远走不到的防御分支，真链路上重发一次
 * 都不会发生（实测就是这么红的：R-E2 在 modelscope 上仍等不到正文）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Novel } from "@/parsers/types";
import { APIError } from "@/api/error-handler";
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

/** provider 那一发空正文真实抛出来的东西（照 `openai.ts:154` 的形状造，含 raw 尾巴） */
const emptyBody = () => new APIError(
  "API 返回了空结果（流式响应无内容）。模型把输出预算花在了思考上（reasoning_tokens=3404）。原始响应：data: {\"choices\":[]}",
  "server", 200, "data: {\"choices\":[]}",
);

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
  it("第一发抛「空正文」：必须再发一发关掉思考，正文取第二发那份", async () => {
    chat
      .mockRejectedValueOnce(emptyBody())
      .mockResolvedValue({ content: "这一章写的是归程与灯火。", tokensUsed: { output: 12 } });

    const r = await run();

    expect(r.success, "第二发拿到正文，整单就不该判失败").toBe(true);
    expect(chat, "空正文之后必须重发一发（而不是直接落一句失败）").toHaveBeenCalledTimes(2);
    expect(thinkingOf(0), "第一发不许动思考：默认权留给厂商").toBeUndefined();
    expect(thinkingOf(1), "第二发要带 thinking:false").toBe(false);
    const summaries = (r.data as { summaries: Array<{ content: string }> }).summaries;
    expect(summaries[0].content, "屏上要的是第二发的正文，不是那句失败").toBe("这一章写的是归程与灯火。");
  });

  it("两发都抛「空正文」：这一章算失败，原因说厂商那句，并且不许发第三发", async () => {
    chat.mockRejectedValue(emptyBody());

    const r = await run();

    expect(r.success).toBe(false);
    expect(chat, "一发空正文之后重发一次就封顶").toHaveBeenCalledTimes(2);
    expect(thinkingOf(1), "封顶那一发就是关了思考的那一发").toBe(false);
    const summaries = (r.data as { summaries: Array<{ content: string }> }).summaries;
    // 递出去的原因得是 provider 那句（带 reasoning_tokens 的证据），不许在半路换成"API 返回了空内容"
    expect(summaries[0].content).toMatch(/空(结果|响应)/);
    expect(summaries[0].content).toMatch(/reasoning_tokens=3404/);
    expect(r.error).toMatch(/空(结果|响应)/);
  });

  it("第一发就有正文：只许发一发（重发是空正文的退路，不是每次都走）", async () => {
    chat.mockResolvedValue({ content: "正常的总结正文。", tokensUsed: { output: 8 } });

    const r = await run();

    expect(r.success).toBe(true);
    expect(chat, "有正文就不该再花第二发").toHaveBeenCalledTimes(1);
    expect(thinkingOf(0)).toBeUndefined();
  });

  it("抛的不是空正文（超时／限流／CORS）：不许拿关思考重发去糊，一次就落败", async () => {
    chat.mockRejectedValue(new APIError("API 请求超时（524）", "server", 524, ""));

    const r = await run();

    expect(r.success).toBe(false);
    expect(chat, "关思考只对「空正文」有效，其它错误重发是白烧一发配额").toHaveBeenCalledTimes(1);
    const summaries = (r.data as { summaries: Array<{ content: string }> }).summaries;
    expect(summaries[0].content).toMatch(/524|超时/);
  });

  it("两章都空：每章各自重发一次（共四发），不许只重发第一章", async () => {
    chat.mockRejectedValue(emptyBody());

    await run(2);

    expect(chat, "两章 × 两发").toHaveBeenCalledTimes(4);
    const 章节顺序 = [0, 1, 2, 3].map((i) => (promptOf(i).includes("第1章正文") ? 1 : 2));
    expect(章节顺序, "重发必须跟着自己那一章的原文，不能串章").toEqual([1, 1, 2, 2]);
    expect([thinkingOf(0), thinkingOf(1), thinkingOf(2), thinkingOf(3)]).toEqual([undefined, false, undefined, false]);
  });
});

/**
 * 变异台账（2026-09-27 深夜实跑。基线快照 `E:/ClaudeCode/anr-e2e-real/mut-baseline-summarizer.ts`
 * ＝修复后的 `summarizer.ts`，sha 前缀 `11a8334298310bd6`；还原走 `cp` 快照（同一文件里带着未提交
 * 的修复，`git restore` 会连修复一起退掉）。三刀跑完都是 markers=0、sha 回到上面那个值、
 * `git diff --numstat` 回到 `12 / 7`，还原后重跑 5 条全绿）：
 * - X1 摘掉重发（catch 里空正文也直接 `throw err`）→ **实测红 3 条：1、2、5**。
 * - X2 不判错误种类（把 `if (!isEmptyResultError(err)) throw err;` 整行摘掉，什么错都关思考重发）
 *   → **实测红 1 条：只有第 4 条**（超时那一发被白烧成两发）。
 * - X3 正文取成 `chapters[0].content`（重发串回第一章的错写）→ **实测红 1 条：只有第 5 条**，
 *   1/2/3/4 全绿——单章时串不串章看不出来，那一格只有两章才咬得住。
 * 没有一刀 0 红；"重发发生／第一发不动思考／只认空正文／重发跟着自己那章"四格各有哨兵。
 *
 * 这一档为什么建在 reject 上（留个疤）：第一版让桩 `resolve({content:""})`，四条全绿，
 * 而 19:20 在 modelscope 上复跑 R-E2 仍红——真实 provider 对空正文是抛 `APIError`，
 * 那版重发在真链路上一次都没执行。改完判据先立红（3 红 2 绿：1、2、5 红），再改产品。
 */
