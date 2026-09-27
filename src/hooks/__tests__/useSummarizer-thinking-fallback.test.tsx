/**
 * 范围总结与问答的「空正文 → 关掉思考重发一发」（收口笔 A）
 *
 * 这两条路过去是裸调 `provider.chat`（`useSummarizer.ts:571`、`:712`），三条自愈一条都没有：
 * 上下文窗口、输出上限、以及"这一发一个字正文都没回"。第三项在推理型厂商上最要命——
 * 它们会把整份输出预算花在思考上，`delta.content` 一个字都不发（真厂商实测：
 * `982 帧 / 正文 0 字 / reasoning_content 3002 字 / finish_reason=length`）。
 * 地图/图谱/本章摘要早就有"第二发带 `thinking:false`"这条退路，这两条漏在外面：
 * 症状是用户点一次问答，在推理型厂商上**永远**拿到"API 返回了空内容"。
 *
 * 封顶两发（制作人 2026-09-27 拍的口径）：第一发照旧让模型想，只有确认那一发一个字都没回
 * 才关思考重发；两发都不成就如实失败。**不许**把超时/限流/CORS 也算成"该关思考"——
 * 那种时候重发就是白烧一发配额。
 *
 * 立红读数：这七条写下来时全红（那两条路上根本没有重发这一步），只有"非空正文不许重发"
 * 那两条是反过来的——它们现在就是绿的，因为过去压根不重发；留在这里是防"接上退路之后
 * 顺手把超时也一起重发"，按老规矩如实标注成保护性判据，不算立红的成绩。
 *
 * ## 刀账 A1..A8（一次性跑满 12 条：本文件 7 + 本章摘要那 5 条，分开跑会漏归因）
 *
 * 基线（每刀 `cp` 还原后当场核 sha256 前 16 位；盘上 `MUT-` 残留计数 0）：
 * 内核 `src/agents/utils.ts` = `19ed5dae8ecb4106`，本章摘要 `src/agents/summarizer.ts` =
 * `eaf64c1c87cb0ea5`（八刀跑完只删了一处重复注释，语义未动，现值 `f05a8a41cd004084`），
 * 范围/问答 `src/hooks/useSummarizer.ts` = `4fb6d957ae7b503e`。
 * 0 刀对照：12 条全绿。
 *
 * - **A1** 摘掉 `if (!isEmptyResultError(err)) throw err;`（凡抛错都算空正文）→ 红 3：
 *   正是三条"超时／限流不许白烧第二发"。这一刀是它们唯一的牙。
 * - **A2** 反向：catch 里无条件 `throw err`（空正文也不再降级）→ 红 6（本章摘要 3 + 本文件 3）。
 *   "只回几个空格"那条 **✓**——它走的是另一支，两支队伍各红各的，才算分得开。
 * - **A3** `first.content.trim()` 摘成 `first.content` → 红 1：正是"provider 没抛错、只回了空白正文"。
 * - **A4** 抛错那支的 `ask(false)` 换成 `ask(undefined)`（降级形同没降）→ 红 5：
 *   三条"第二发要真的把思考关掉"+ 本章摘要另外两条；空白正文那条 ✓。
 * - **A5** 尾那支的 `ask(false)` 换成 `ask(undefined)` → 红 1：正是空白正文那条。
 *   **A4/A5 必须各下一刀**：两处 `ask(false)` 一起改，红名一样，看不出是不是只接对了一处。
 * - **A6** 搬家证据、刀在**另一个文件**：`summarizer.ts` 退回裸 `chatWithContextRetry` →
 *   本章摘要 3 条红，本文件 7 条全 ✓。
 * - **A7** 只绕范围总结那一处 → 红 1：范围那条；问答 5 条全 ✓。
 * - **A8** 只绕问答那一处 → 红 3：问答那三条；范围那条 ✓。
 *   **A7/A8 各一刀**才咬得住"两个调用点只接了一个"的半修。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSummarizer } from "../useSummarizer";
import { useNovelStore } from "@/stores/novel-store";
import { useAPIStore } from "@/stores/api-store";
import { cancelAllAiTasks } from "@/lib/ai-task-queue";
import { APIError } from "@/api/error-handler";

const chat = vi.hoisted(() => vi.fn());
const loadChapters = vi.hoisted(() => vi.fn(async () => [
  { id: "c1", novelId: "n1", index: 0, title: "第一章 渡口", content: "第一章的正文。".repeat(20) },
  { id: "c2", novelId: "n1", index: 1, title: "第二章 逆流", content: "第二章的正文。".repeat(20) },
]));

vi.mock("@/rag/index", () => ({
  buildIndex: vi.fn(async () => undefined),
  retrieveRelevantWithDetails: vi.fn(async () => ({ text: "", results: [], engine: "tfidf" })),
  getBGEMeta: () => null,
}));
vi.mock("@/sync/sync-client", () => ({ syncClient: { pushNow: vi.fn(async () => undefined) } }));
vi.mock("@/api/registry", () => ({ getProvider: () => ({ format: "openai", chat }) }));
vi.mock("@/db/repositories", async (orig) => {
  const real = await (orig() as Promise<Record<string, unknown>>);
  return { ...real, loadChapters, saveSummary: vi.fn(async () => undefined) };
});

/** 真 provider 对空正文抛的就是这一句（`openai.ts:154` 流式、`:190` 非流式），前缀是 `isEmptyResultError` 认的锚 */
const emptyBody = () => new APIError(
  "API 返回了空结果（流式响应无内容）。模型把 2048 token 花在思考上、一个字正文都没回（思考与正文共用同一份输出预算）。",
  "server", 200, "data: [DONE]",
);
const timeoutErr = () => new APIError("请求超时（120 秒）：直连与代理都没能在期限内返回", "network", 0, "");

function setup() {
  localStorage.clear();
  cancelAllAiTasks();
  useNovelStore.setState({
    currentNovel: {
      id: "n1", title: "测试书", author: "", fileName: "t.txt", fileFormat: "txt",
      totalChars: 400, chapterCount: 2, createdAt: 1, updatedAt: 1,
      chapters: [
        { id: "c1", novelId: "n1", index: 0, title: "第一章 渡口", content: "第一章的正文。".repeat(20), startOffset: 0, endOffset: 180 },
        { id: "c2", novelId: "n1", index: 1, title: "第二章 逆流", content: "第二章的正文。".repeat(20), startOffset: 180, endOffset: 360 },
      ],
    } as never,
  });
  useAPIStore.setState({
    providers: [{
      id: "p-1", format: "openai", name: "测试商", apiKey: "sk-test",
      baseUrl: "https://example.test/v1", model: "unmatched-model", contextWindow: 32000,
    }],
    activeProviderId: "p-1",
  });
  chat.mockReset();
}

beforeEach(setup);

const asked = (i: number) => chat.mock.calls[i][0] as { thinking?: boolean };

describe("问答：空正文才关思考重发", () => {
  it("第一发回空正文 → 第二发必须带 thinking:false，答案取第二发那份", async () => {
    chat.mockRejectedValueOnce(emptyBody())
      .mockResolvedValueOnce({ content: "第二发带回的正文。", tokensUsed: { output: 9 } });
    const { result } = renderHook(() => useSummarizer());
    // 装进对象再取：`let` 在 `act` 的回调里赋值，TS 的控制流看不见，会在断言处把它
    // 收窄成 `null` → `?.answer` 报 "Property 'answer' does not exist on type 'never'"。
    const out: { current: Awaited<ReturnType<typeof result.current.askCustomQuestion>> } = { current: null };
    await act(async () => {
      out.current = await result.current.askCustomQuestion("这一章讲了什么", []);
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(asked(0).thinking, "第一发照旧让模型想（质量优先）").toBeUndefined();
    expect(asked(1).thinking, "降级那一发要真的把思考关掉").toBe(false);
    expect(out.current?.answer).toBe("第二发带回的正文。");
  });

  it("provider 没抛错、只回了空白正文，同样算空正文要降级", async () => {
    chat.mockResolvedValueOnce({ content: "   ", tokensUsed: { output: 0 } })
      .mockResolvedValueOnce({ content: "这回有字了。", tokensUsed: { output: 5 } });
    const { result } = renderHook(() => useSummarizer());
    const out: { current: Awaited<ReturnType<typeof result.current.askCustomQuestion>> } = { current: null };
    await act(async () => {
      out.current = await result.current.askCustomQuestion("讲了什么", []);
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(asked(1).thinking).toBe(false);
    expect(out.current?.answer).toBe("这回有字了。");
  });

  it("两发都是空正文就到此为止：总共两发，不许第三发", async () => {
    chat.mockRejectedValue(emptyBody());
    const { result } = renderHook(() => useSummarizer());
    await act(async () => {
      await result.current.askCustomQuestion("讲了什么", []);
    });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("第一发就有正文：只许发一发（重发是空正文的退路，不是每次都走）", async () => {
    chat.mockResolvedValue({ content: "一次就成。", tokensUsed: { output: 4 } });
    const { result } = renderHook(() => useSummarizer());
    await act(async () => {
      await result.current.askCustomQuestion("讲了什么", []);
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("超时那种失败不是空正文：不许顺手重发一发（保护性：现在就绿，防接上退路后一起重发）", async () => {
    chat.mockRejectedValue(timeoutErr());
    const { result } = renderHook(() => useSummarizer());
    await act(async () => {
      await result.current.askCustomQuestion("讲了什么", []);
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe("范围总结：同一条退路", () => {
  it("第一发回空正文 → 第二发带 thinking:false，总结取第二发那份", async () => {
    chat.mockRejectedValueOnce(emptyBody())
      .mockResolvedValueOnce({ content: "范围总结第二发的正文。", tokensUsed: { output: 9 } });
    const { result } = renderHook(() => useSummarizer());
    const out: { current: Awaited<ReturnType<typeof result.current.generateRangeSummary>> } = { current: null };
    await act(async () => {
      out.current = await result.current.generateRangeSummary(1, 2);
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(asked(0).thinking).toBeUndefined();
    expect(asked(1).thinking).toBe(false);
    expect(out.current?.content).toBe("范围总结第二发的正文。");
  });

  it("超时不是空正文：一发就完，不许白烧第二发（保护性：现在就绿）", async () => {
    chat.mockRejectedValue(timeoutErr());
    const { result } = renderHook(() => useSummarizer());
    await act(async () => {
      await result.current.generateRangeSummary(1, 2);
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
