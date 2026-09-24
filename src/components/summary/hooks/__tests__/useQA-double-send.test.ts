/**
 * 问答不许双发（制作人定口径：不要双发）。
 *
 * `handleSubmitQuestion` 里那道"忙时不双发"读的是 `qaLoading` 这个 **React state**
 * （`useQA.ts:165`）。同一拍里连点两下发送，两次拿到的闭包都还是 `qaLoading===false`
 * 的旧值，两次都放行 → 同一个问题出门两次。组件层也拦不住：按钮的 disabled 读的是
 * 面板级 `loading`（`QATab.tsx:111`），不是 `qaHook.qaLoading`，后者只换来一个转圈。
 * 修法跟项目里既有的两把锁一致（`qaRunRef` / `savingNoteRef`）：用 ref 当场立闸。
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useQA } from "../useQA";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup() {
  const ask = vi.fn();
  const gate = deferred<{ answer: string; tokensUsed: number } | null>();
  ask.mockReturnValue(gate.promise);
  const hook = renderHook(() =>
    useQA({ novelId: "A", askCustomQuestion: ask, generateRangeSummary: vi.fn(), clearQaCache: vi.fn() }),
  );
  act(() => hook.result.current.setCustomQuestion("甲的问题"));
  return { ask, gate, hook };
}

describe("useQA · 忙时不双发", () => {
  it("同一拍里连点两下发送，问题只许出门一次", async () => {
    const { ask, gate, hook } = setup();
    let first: Promise<void> = undefined as unknown as Promise<void>;
    let second: Promise<void> = undefined as unknown as Promise<void>;
    act(() => {
      first = hook.result.current.handleSubmitQuestion();
      second = hook.result.current.handleSubmitQuestion();
    });
    await act(async () => {
      gate.resolve(null);
      await first;
      await second;
    });
    expect(ask, "两下点击发出两个请求，用户会看到同一条答案刷两遍").toHaveBeenCalledTimes(1);
    expect(ask.mock.calls.map((c) => c[0])).toEqual(["甲的问题"]);
  });

  it("上一问没落地前，重新填的问题也不许挤进去", async () => {
    const { ask, gate, hook } = setup();
    let first: Promise<void> = undefined as unknown as Promise<void>;
    act(() => { first = hook.result.current.handleSubmitQuestion(); });
    await act(async () => { await Promise.resolve(); });
    expect(ask).toHaveBeenCalledTimes(1);

    // 换一个问题，在第一个还挂着时再提交
    act(() => hook.result.current.setCustomQuestion("乙的问题"));
    let second: Promise<void> = undefined as unknown as Promise<void>;
    act(() => { second = hook.result.current.handleSubmitQuestion(); });
    await act(async () => { await Promise.resolve(); });
    expect(ask, "第一个回答还没回来就发第二个，两本书式的串台会出现在同一本里").toHaveBeenCalledTimes(1);

    gate.resolve({ answer: "甲的答复", tokensUsed: 3 });
    await act(async () => { await first; await second; });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("上一问答完落定后，下一问正常发得出去（闸不能焊死）", async () => {
    const { ask, gate, hook } = setup();
    let first: Promise<void> = undefined as unknown as Promise<void>;
    act(() => { first = hook.result.current.handleSubmitQuestion(); });
    gate.resolve({ answer: "甲的答复", tokensUsed: 3 });
    await act(async () => { await first; });
    expect(ask).toHaveBeenCalledTimes(1);

    act(() => hook.result.current.setCustomQuestion("乙的问题"));
    const gate2 = deferred<{ answer: string; tokensUsed: number } | null>();
    ask.mockReturnValueOnce(gate2.promise);
    let second: Promise<void> = undefined as unknown as Promise<void>;
    act(() => { second = hook.result.current.handleSubmitQuestion(); });
    await act(async () => {
      gate2.resolve({ answer: "乙的答复", tokensUsed: 2 });
      await second;
    });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0]).toBe("乙的问题");
  });

  // 下面这一组是**诊断用**：它们在当前代码上也绿（旧写法读 state，重渲染一次就补上了），
  // 留着是为了"换成 ref 之后别把这层互斥弄丢"——真要回归时它们会第一个喊。
  it("范围总结在飞时，提问挤不进去（两者共用一把闸）", async () => {
    const ask = vi.fn();
    const range = vi.fn();
    const rangeGate = deferred<null>();
    range.mockReturnValue(rangeGate.promise);
    const hook = renderHook(() =>
      useQA({ novelId: "A", askCustomQuestion: ask, generateRangeSummary: range, clearQaCache: vi.fn() }),
    );
    act(() => {
      hook.result.current.setRangeFrom("1");
      hook.result.current.setRangeTo("3");
      hook.result.current.setCustomQuestion("甲的问题");
    });
    let r: Promise<void> = undefined as unknown as Promise<void>;
    act(() => { r = hook.result.current.handleRangeSummary(); });
    await act(async () => { await Promise.resolve(); });
    expect(range).toHaveBeenCalledTimes(1);

    let q: Promise<void> = undefined as unknown as Promise<void>;
    act(() => { q = hook.result.current.handleSubmitQuestion(); });
    await act(async () => {
      rangeGate.resolve(null);
      await r;
      await q;
    });
    expect(ask, "范围总结还没落地就放行提问，等于同一本书两个 AI 活儿并行").not.toHaveBeenCalled();
  });

  it("连点两下范围总结也只跑一次", async () => {
    const range = vi.fn();
    const gate = deferred<null>();
    range.mockReturnValue(gate.promise);
    const hook = renderHook(() =>
      useQA({ novelId: "A", askCustomQuestion: vi.fn(), generateRangeSummary: range, clearQaCache: vi.fn() }),
    );
    act(() => {
      hook.result.current.setRangeFrom("1");
      hook.result.current.setRangeTo("3");
    });
    let a: Promise<void> = undefined as unknown as Promise<void>;
    let b: Promise<void> = undefined as unknown as Promise<void>;
    act(() => {
      a = hook.result.current.handleRangeSummary();
      b = hook.result.current.handleRangeSummary();
    });
    await act(async () => {
      gate.resolve(null);
      await a;
      await b;
    });
    expect(range, "两下点击发出两个范围总结").toHaveBeenCalledTimes(1);
  });

  it("范围总结跑完之后，下一回范围与提问都正常发得出去（复位的闸不能焊死）", async () => {
    const ask = vi.fn();
    const range = vi.fn();
    const g1 = deferred<null>();
    const g2 = deferred<null>();
    range.mockReturnValueOnce(g1.promise).mockReturnValueOnce(g2.promise);
    ask.mockResolvedValue({ answer: "甲的答复", tokensUsed: 1 });
    const hook = renderHook(() =>
      useQA({ novelId: "A", askCustomQuestion: ask, generateRangeSummary: range, clearQaCache: vi.fn() }),
    );
    act(() => {
      hook.result.current.setRangeFrom("1");
      hook.result.current.setRangeTo("3");
    });
    let a: Promise<void> = undefined as unknown as Promise<void>;
    act(() => { a = hook.result.current.handleRangeSummary(); });
    g1.resolve(null);
    await act(async () => { await a; });
    expect(range).toHaveBeenCalledTimes(1);

    let b: Promise<void> = undefined as unknown as Promise<void>;
    act(() => { b = hook.result.current.handleRangeSummary(); });
    await act(async () => {
      g2.resolve(null);
      await b;
    });
    expect(range, "第一次跑完没把闸开回来，之后永远发不出去").toHaveBeenCalledTimes(2);

    act(() => hook.result.current.setCustomQuestion("甲的问题"));
    await act(async () => { await hook.result.current.handleSubmitQuestion(); });
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
