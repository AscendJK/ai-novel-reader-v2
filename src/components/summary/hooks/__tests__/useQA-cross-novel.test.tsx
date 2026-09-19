/**
 * 问答在飞时切书不得串台（round 3 R-80）
 *
 * setQaMessages 用 React 的 prev 做基准、却用旧闭包里的 novelId 写回 store：
 * SummaryPanel 常驻不按书重挂，所以"提问 → 等回答 → 中途换书"时，
 * 基准已是新书的消息，写回的键还是旧书 → 旧书历史被别的书覆盖，
 * 当前界面还多出一条不属于它的回答。
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useQA } from "../useQA";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("useQA 跨书隔离", () => {
  it("回答在切换小说之后才到达时，只进提问那本书的历史", async () => {
    const ask = vi.fn();
    const gate = deferred<{ answer: string; tokensUsed: number } | null>();
    ask.mockReturnValue(gate.promise);

    const { result, rerender } = renderHook(
      ({ novelId }: { novelId: string }) => useQA({
        novelId,
        askCustomQuestion: ask,
        generateRangeSummary: vi.fn(),
        clearQaCache: vi.fn(),
      }),
      { initialProps: { novelId: "A" } }
    );

    // B 先留下自己的历史
    rerender({ novelId: "B" });
    act(() => { result.current.addMessage("user", "B 的历史"); });

    // 回到 A 提问（回答挂起）
    rerender({ novelId: "A" });
    act(() => { result.current.setCustomQuestion("甲的问题"); });
    let submitting: Promise<void>;
    act(() => { submitting = result.current.handleSubmitQuestion(); });
    await act(async () => { await Promise.resolve(); });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toBe("甲的问题");

    // 等回答期间换到 B —— 这就是用户"提问后去书架翻另一本"的动作
    rerender({ novelId: "B" });
    await act(async () => { gate.resolve({ answer: "甲的答复", tokensUsed: 4 }); await submitting!; });

    // B 的界面里不该出现 A 的回答
    expect(result.current.qaMessages.map((m) => m.content)).toEqual(["B 的历史"]);

    // A 的历史必须还是"自己的问题 + 自己的回答"，不掺 B 的消息
    rerender({ novelId: "A" });
    expect(result.current.qaMessages.map((m) => m.content).sort()).toEqual(["甲的答复", "甲的问题"]);
  });
});
