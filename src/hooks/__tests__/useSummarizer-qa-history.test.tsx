/**
 * 问答的历史装配：装不下就少带，但"少带"这件事不许只留在控制台
 *
 * 这条链以前只有一句 `console.log("[qa] 历史超出预算…")`：界面上对话气泡照旧一排，
 * 模型却只看过最近一两轮——于是它要么答非所问，要么把没送出去的早先内容猜出来接着编，
 * 而用户完全不知道发生了什么。范围总结在 `b883540` 已经立过同样的规矩（少带的章要写出来），
 * 这里给问答补上同一份诚实。
 *
 * 钉三件事：
 *  1. 预算真的会裁：发出去的消息只带装得下的那一截，且带的是**最近**的那头（顺序错了等于串历史）；
 *  2. 裁掉几条要随结果返回（界面据此提示），并在系统提示里对模型明说；
 *  3. 没裁时不许出现提示（否则提示就成了噪音，等于把"每次都少带"合法化）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSummarizer } from "../useSummarizer";
import { useNovelStore } from "@/stores/novel-store";
import { useAPIStore } from "@/stores/api-store";
import { cancelAllAiTasks } from "@/lib/ai-task-queue";

const chat = vi.hoisted(() => vi.fn());

vi.mock("@/rag/index", () => ({
  buildIndex: vi.fn(async () => undefined),
  retrieveRelevantWithDetails: vi.fn(async () => ({ text: "", results: [], engine: "tfidf" })),
  getBGEMeta: () => null,
}));
vi.mock("@/sync/sync-client", () => ({ syncClient: { pushNow: vi.fn(async () => undefined) } }));
vi.mock("@/api/registry", () => ({
  getProvider: () => ({ format: "openai", chat }),
}));

/** 4000 的窗口：输出预留 2048 + 安全余量 200 → 可用输入 1752，历史上限 30% ≈ 525 tokens */
function setup() {
  cancelAllAiTasks();
  useNovelStore.setState({
    currentNovel: {
      id: "n1", title: "测试书", author: "", fileName: "t.txt", fileFormat: "txt",
      totalChars: 10, chapterCount: 1, createdAt: 1, updatedAt: 1,
      chapters: [{ id: "c1", novelId: "n1", index: 0, title: "第一章", content: "正文", startOffset: 0, endOffset: 2 }],
    } as never,
  });
  useAPIStore.setState({
    providers: [{
      id: "p-4k", format: "openai", name: "四千窗口", apiKey: "sk-test",
      baseUrl: "https://example.test/v1", model: "unmatched-model", contextWindow: 4000,
    }],
    activeProviderId: "p-4k",
  });
  chat.mockReset();
  chat.mockResolvedValue({ content: "一段回答。", tokensUsed: { output: 5 } });
}

/** 一条 300 字的中文消息 ≈ 300 tokens；六条一起 1824，远超历史上限 */
function turn(i: number) {
  const text = `第${i}轮的内容。`.padEnd(300, "字");
  return [
    { role: "user" as const, content: text },
    { role: "assistant" as const, content: text },
  ];
}

function sentMessages() {
  return chat.mock.calls[0][0].messages as { role: string; content: string }[];
}

beforeEach(setup);

describe("问答的历史裁剪", () => {
  // 变异：把 `if (keptReversed.length > 0 && historyTokens + cost > historyCap) break;` 删掉
  // → 三条全红（请求带了全部历史 / droppedTurns 变 0 / 提示不再出现）
  it("装不下时只带最近那一截，并把裁掉的条数交回调用方", async () => {
    const history = [1, 2, 3].flatMap(turn); // 6 条，最早的是 "第1轮"
    const { result } = renderHook(() => useSummarizer());
    let outcome: Awaited<ReturnType<typeof result.current.askCustomQuestion>> = null;
    await act(async () => {
      outcome = await result.current.askCustomQuestion("最后一个问题讲了什么", history);
    });

    expect(outcome, "问答应当成功").not.toBeNull();
    const messages = sentMessages();
    const nonSystem = messages.filter((m) => m.role !== "system");
    // 结构：最近的历史若干条 + 本次提问；一条都不许超预算
    expect(nonSystem.length).toBeLessThan(history.length + 1);
    expect(nonSystem.at(-1)!.content).toBe("最后一个问题讲了什么");
    // 带的是最近那头：倒二条应当是第 3 轮（最新的一答），不是第 1 轮
    expect(nonSystem.at(-2)!.content).toContain("第3轮");
    expect(nonSystem.some((m) => m.content.includes("第1轮"))).toBe(false);
    expect(outcome!.droppedTurns).toBeGreaterThan(0);
    expect(outcome!.droppedTurns + nonSystem.length - 1).toBe(history.length);
  });

  it("系统提示要告诉模型更早的对话没附上（否则它会猜着往下编）", async () => {
    const { result } = renderHook(() => useSummarizer());
    await act(async () => {
      await result.current.askCustomQuestion("最后一个问题讲了什么", [1, 2, 3].flatMap(turn));
    });
    const system = sentMessages().find((m) => m.role === "system")!.content;
    expect(system).toMatch(/更早的 \d+ 条(对话|消息).*没有?附上/);
    expect(system).toMatch(/不要.*(猜|编)/);
  });

  it("历史装得下时不裁、也不许凭空冒出一条提示", async () => {
    const { result } = renderHook(() => useSummarizer());
    let outcome: Awaited<ReturnType<typeof result.current.askCustomQuestion>> = null;
    // 两条各 20 字：远低于这一档配置下的历史上限，装得下是必然的
    const fits = [
      { role: "user" as const, content: "第一问很短" },
      { role: "assistant" as const, content: "第一答很短" },
    ];
    await act(async () => {
      outcome = await result.current.askCustomQuestion("追问一句", fits);
    });
    expect(outcome!.droppedTurns).toBe(0);
    const messages = sentMessages();
    expect(messages.filter((m) => m.role !== "system").length).toBe(3);
    expect(messages.find((m) => m.role === "system")!.content).not.toMatch(/更早的 \d+ 条/);
  });

  it("厂商请求体里的条数与提示里说的数一致（不许一处裁、另一处报别的数）", async () => {
    const history = [1, 2, 3, 4, 5].flatMap(turn); // 10 条
    const { result } = renderHook(() => useSummarizer());
    let outcome: Awaited<ReturnType<typeof result.current.askCustomQuestion>> = null;
    await act(async () => {
      outcome = await result.current.askCustomQuestion("第五问", history);
    });
    const kept = sentMessages().filter((m) => m.role !== "system").length - 1;
    expect(outcome!.droppedTurns).toBe(history.length - kept);
    const system = sentMessages().find((m) => m.role === "system")!.content;
    expect(system).toContain(`更早的 ${outcome!.droppedTurns} 条`);
  });
});
