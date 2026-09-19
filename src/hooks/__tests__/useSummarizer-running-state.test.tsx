/**
 * 问答失败后的运行态收口（round 3 R-73）
 *
 * `askCustomQuestion` 在 `try` 之外就 `startTask`，而中间那步 `requireUsableInput`
 * 在上下文窗口不足时**必抛**（批次 3 的 R-07 修法），于是 `endTask()` 永远跑不到。
 * 卡住的不只是组件里的 isRunning：`startTask` 还写了模块级 `aiRunning`
 * （不随组件卸载复位）和 `summaryStore.isGenerating`，而同步把 `getAiRunning`
 * 当门控交给 syncClient —— 症状是"AI 按钮全灰、进度条一直转、本地改动不再上传，
 * 而界面仍显示已同步"，只有刷新能救。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSummarizer } from "../useSummarizer";
import { useNovelStore } from "@/stores/novel-store";
import { useAPIStore } from "@/stores/api-store";
import { useSummaryStore } from "@/stores/summary-store";
import { getAiRunning, setAiRunning } from "@/lib/ai-state";

vi.mock("@/rag/index", () => ({
  buildIndex: vi.fn(async () => undefined),
  retrieveRelevantWithDetails: vi.fn(async () => ({ text: "", results: [], engine: "tfidf" })),
  getBGEMeta: () => null,
}));
vi.mock("@/sync/sync-client", () => ({ syncClient: { pushNow: vi.fn(async () => undefined) } }));

beforeEach(() => {
  localStorage.clear();
  setAiRunning(false);
  useSummaryStore.setState({ isGenerating: false });
  useNovelStore.setState({
    currentNovel: {
      id: "n1", title: "测试书", author: "", fileName: "t.txt", fileFormat: "txt",
      totalChars: 10, chapterCount: 1, createdAt: 1, updatedAt: 1,
      chapters: [{ id: "c1", novelId: "n1", index: 0, title: "第一章", content: "正文", startOffset: 0, endOffset: 2 }],
    } as never,
  });
  useAPIStore.setState({
    providers: [{
      id: "p-small", format: "openai", name: "小窗口模型", apiKey: "sk-test",
      baseUrl: "https://example.test/v1", model: "tiny-model",
      contextWindow: 2000, maxTokens: 2048,
    }],
    activeProviderId: "p-small",
  });
});

describe("useSummarizer 问答的运行态收口", () => {
  it("上下文窗口不足时问答失败，但不把 AI 运行态永久锁住", async () => {
    const { result } = renderHook(() => useSummarizer());

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.askCustomQuestion("这本书讲了什么", []).catch((e) => e);
    });

    // 失败必须以"返回 null + 可见错误条"收口，而不是把异常抛给调用方
    expect(outcome).toBeNull();
    expect(result.current.error).toMatch(/上下文窗口不足/);

    // 核心不变量：一次失败的问答不得留下运行态
    expect(getAiRunning()).toBe(false);
    expect(useSummaryStore.getState().isGenerating).toBe(false);
  });

  it("问答失败后仍可再次发起任务（运行态没有卡死）", async () => {
    const { result } = renderHook(() => useSummarizer());
    await act(async () => { await result.current.askCustomQuestion("第一问", []).catch(() => undefined); });
    await act(async () => { await result.current.askCustomQuestion("第二问", []).catch(() => undefined); });

    expect(getAiRunning()).toBe(false);
    expect(useSummaryStore.getState().isGenerating).toBe(false);
  });
});
