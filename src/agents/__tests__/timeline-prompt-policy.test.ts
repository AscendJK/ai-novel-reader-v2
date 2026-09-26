/**
 * 剧情时间线的提示词：表格禁令已放开，子列表禁令还留着
 *
 * 背景是同一件事的两头。渲染侧以前只吃 CommonMark（全仓没有 `remark-gfm`），模型画出的表格
 * 会以裸竖线的面目上屏，所以提示词里写着「不要使用表格」——那是**为了迁就画不出**而加的约束。
 * `049fa80` 接上 remark-gfm 之后渲染侧能画了，这条约束就变成纯粹的额外限制；制作人点头放开。
 * 但「不要在编号列表内添加子列表」那一半**不是同一件事**：它管的是大事记的形状（一条事件一段），
 * 与表格能不能画无关，所以留着。
 *
 * 判的都是"发出去的那一发里写了什么"，两条腿各判各的：
 * 1. 正常那一发（全文进上下文）；
 * 2. 上下文吃紧那一发（改用章节目录推断）。**只改主提示不改兜底**是最容易漏的一格，
 *    因为兜底那条只在窗口小的模型或超长目录上才走得到。
 *
 * 有意不判：提示词的其余措辞。这里只钉"这一条禁令在不在"，把整段措辞钉死会让正常润色变成红。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Novel } from "@/parsers/types";
import { timelineAgent } from "../analyzers";

const repo = vi.hoisted(() => ({ loadNovel: vi.fn() }));
const chat = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({ config: undefined as unknown }));

vi.mock("@/db/repositories", () => ({ loadNovel: repo.loadNovel }));
vi.mock("@/api/registry", () => ({ getProvider: () => ({ format: "openai", chat }) }));
vi.mock("@/stores/api-store", () => ({
  useAPIStore: { getState: () => ({ getActiveProvider: () => store.config }) },
}));

const BASE = { id: "p1", format: "openai" as const, name: "t", apiKey: "k", baseUrl: "u" };
/** 128k 窗口：全文塞得下，走正常那一发 */
const BIG = { ...BASE, model: "gpt-4o", maxTokens: undefined };
/** 8k 窗口：目录一抽样就必然顶穿可用输入，走兜底那一发 */
const SMALL = { ...BASE, model: "gpt-4", maxTokens: undefined };

function novel(chapterCount: number, charsPerChapter: number): Novel {
  const id = "book-1";
  return {
    id, title: "笑傲测试", author: "某作者", fileName: "f.txt", fileFormat: "txt",
    totalChars: chapterCount * charsPerChapter, chapterCount, createdAt: 1, updatedAt: 1,
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-ch-${i}`, novelId: id, index: i, title: `第${i + 1}章 标题`,
      content: `第${i + 1}章正文：令狐冲练剑，岳不群在旁看着。`.repeat(charsPerChapter / 22),
      startOffset: 0, endOffset: charsPerChapter,
    })),
  };
}

/** 发出去那一发的用户正文 */
async function sentPrompt(cfg: typeof BIG): Promise<string> {
  chat.mockResolvedValue({ content: "1. **【起】**（第1章 · 开端）遇异。→ 无。", usage: {} });
  repo.loadNovel.mockResolvedValue(novel(200, 4000));
  store.config = cfg;
  await timelineAgent.run({ novelId: "book-1", onStatus: vi.fn() } as never);
  expect(chat).toHaveBeenCalled();
  const msgs = chat.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
  return msgs[1].content;
}

beforeEach(() => {
  chat.mockReset();
  repo.loadNovel.mockReset();
});

describe("时间线提示词里的两条禁令", () => {
  it("正常那一发：不许再有表格禁令", async () => {
    const p = await sentPrompt(BIG);
    expect(p).not.toMatch(/不要使用表格|不要用表格/);
  });

  it("正常那一发：子列表禁令必须还在（它管的是大事记的形状，与能不能画表格无关）", async () => {
    const p = await sentPrompt(BIG);
    expect(p).toContain("不要在编号列表内添加子列表");
  });

  it("兜底那一发：同一条禁令放开，且这条走得通（真走到了目录推断分支）", async () => {
    const p = await sentPrompt(SMALL);
    // 先证明这一发确实是兜底那条：它带着"基于目录推断"这句，主提示里没有
    expect(p).toContain("基于目录推断");
    expect(p).not.toMatch(/不要用表格|不要使用表格/);
    expect(p).toContain("不要在列表项内使用子列表");
  });
});
