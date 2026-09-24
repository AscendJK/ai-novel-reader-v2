/**
 * `ChapterTab` 组件内部判据（地板第 2 档第八批·组件档）。
 *
 * 浏览器层判的是"点了确实生成"（C1/C8/C13/C26），这一屏自己管的四件事量不到：
 * 1) 「总结本章」那枚 disabled 读的是 `loading || 没选中章节`，两半各管一段；
 * 2) 批量在跑时**不许**在「总结本章」里转圈（`loading && !isBatchRunning`）——
 *    批量跑着还显示"这一章在生成"，用户会以为整本卡在一章；
 * 3) 「停止」与进度条必须成对：面板重挂后本地 `isBatchRunning` 归零，进度条却来自
 *    任务台账（`ChapterTab.tsx:94-95` 那段注释就是这件事的案发现场），只认本地状态
 *    就会出现"有进度条、没停止键"；
 * 4) 批量确认框三条出口传的是不同的 `skipExisting`。
 * 外加透传给 `MiniCard` 的那一笔（标题、字数、时间取 updatedAt 回退 createdAt、
 * 精简/截断标记、收藏带的是**这一章**的 chapterId）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChapterTab } from "../ChapterTab";
import type { SummaryItem } from "@/stores/summary-store";

function makeSummary(over: Partial<SummaryItem> = {}): SummaryItem {
  return {
    id: "s-1",
    novelId: "book-1",
    chapterId: "c-1",
    chapterTitle: "第一章 风起",
    content: "城下的雪落了三天。",
    tokensUsed: 420,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_800_000_000_000,
    ...over,
  } as SummaryItem;
}


function setup(over: Partial<Parameters<typeof ChapterTab>[0]> = {}) {
  const handlers = {
    onSummarize: vi.fn(),
    onSummarizeAll: vi.fn(),
    onStopBatch: vi.fn(),
    onRegenerate: vi.fn(),
    onBookmark: vi.fn(),
  };
  const view = render(
    <ChapterTab
      chapterSummary={undefined}
      loading={false}
      hasSelectedChapter
      generateProgress={null}
      onSummarize={handlers.onSummarize}
      onSummarizeAll={handlers.onSummarizeAll}
      onStopBatch={handlers.onStopBatch}
      onRegenerate={handlers.onRegenerate}
      onBookmark={handlers.onBookmark}
      {...over}
    />,
  );
  const rerenderWith = (next: Partial<Parameters<typeof ChapterTab>[0]>) =>
    view.rerender(
      <ChapterTab
        chapterSummary={over.chapterSummary}
        loading={false}
        hasSelectedChapter
        generateProgress={null}
        onSummarize={handlers.onSummarize}
        onSummarizeAll={handlers.onSummarizeAll}
        onStopBatch={handlers.onStopBatch}
        onRegenerate={handlers.onRegenerate}
        onBookmark={handlers.onBookmark}
        {...over}
        {...next}
      />,
    );
  return { ...view, handlers, rerenderWith };
}

/** lucide 1.17 里 `Loader2` 画出来的类名是 `lucide-loader-circle`（图标改名过，类名跟着改） */
const spinners = () => document.querySelectorAll("svg.lucide-loader-circle").length;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChapterTab · 两枚入口按钮的状态", () => {
  it("「总结本章」的 disabled 两半各管一段：正在生成禁、没选中章节也禁", () => {
    const a = setup();
    expect(screen.getByRole("button", { name: /总结本章/ })).toBeEnabled();
    a.unmount();

    const b = setup({ loading: true });
    expect(screen.getByRole("button", { name: /总结本章/ })).toBeDisabled();
    b.unmount();

    setup({ hasSelectedChapter: false, onSummarize: () => {} });
    expect(screen.getByRole("button", { name: /总结本章/ })).toBeDisabled();
  });

  it("没选中章节时点下去不会喊 onSummarize（禁着的那枚不许有出口）", () => {
    const { handlers } = setup({ hasSelectedChapter: false });
    fireEvent.click(screen.getByRole("button", { name: /总结本章/ }));
    expect(handlers.onSummarize).not.toHaveBeenCalled();
  });

  it("放行那一格点下去才真的走 onSummarize", () => {
    const { handlers } = setup();
    fireEvent.click(screen.getByRole("button", { name: /总结本章/ }));
    expect(handlers.onSummarize).toHaveBeenCalledTimes(1);
  });

  it("单独生成才转圈：批量在跑时 loading 也是真，但那枚不许显示'本章在生成'", () => {
    const { rerenderWith } = setup();
    expect(spinners()).toBe(0);
    rerenderWith({ loading: true });
    expect(spinners()).toBe(1); // 单章生成 → 转圈
    rerenderWith({ loading: false });
    expect(spinners()).toBe(0);
  });

  it("批量跑到一半：进度条在、停止键在、'总结本章'不转圈，全批结束才一起收", () => {
    const { rerenderWith } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^批量/ }));
    fireEvent.click(screen.getByRole("button", { name: "跳过已有总结" }));

    rerenderWith({ loading: true, generateProgress: { current: 1, total: 3 } });
    expect(spinners(), "批量跑着却显示'这一章在生成'，用户会以为整本卡在一章").toBe(0);
    expect(screen.getByRole("button", { name: /^停止/ })).toBeInTheDocument();

    // 进度还在就不算完成：这一格如果清了，下一步 loading 再起就会转圈
    rerenderWith({ loading: false, generateProgress: { current: 2, total: 3 } });
    rerenderWith({ loading: true, generateProgress: null });
    expect(spinners(), "整批还没跑完就被当成跑完了").toBe(0);

    // 真的收尾：没在跑、也没有进度
    rerenderWith({ loading: false, generateProgress: null });
    expect(screen.queryByRole("button", { name: /^停止/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^批量/ })).toBeInTheDocument();
  });

  it("面板重挂之后：本地状态归零，只要台账还有进度就得摆出「停止」", () => {
    setup({ generateProgress: { current: 2, total: 3 } }); // 全新挂载，isBatchRunning 初值 false
    expect(screen.getByRole("button", { name: /^停止/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^批量/ })).not.toBeInTheDocument();
  });

  it("「批量」在别的任务在跑时禁着，点「停止」会喊 onStopBatch 并让位回「批量」", () => {
    const { handlers } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^批量/ }));
    fireEvent.click(screen.getByRole("button", { name: "全部重新生成" }));
    expect(screen.getByRole("button", { name: /^停止/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^停止/ }));
    expect(handlers.onStopBatch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /^批量/ })).toBeInTheDocument();
  });

  it("没给 onStopBatch 时点「停止」不许炸（可选 prop）", () => {
    setup({ onStopBatch: undefined });
    fireEvent.click(screen.getByRole("button", { name: /^批量/ }));
    fireEvent.click(screen.getByRole("button", { name: "跳过已有总结" }));
    fireEvent.click(screen.getByRole("button", { name: /^停止/ }));
    expect(screen.getByRole("button", { name: /^批量/ })).toBeInTheDocument();
  });
});

describe("ChapterTab · 批量确认框的三条出口", () => {
  it("点了「批量」只是开框，一发都不许先跑出去", () => {
    const { handlers } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^批量/ }));
    expect(screen.getByText("批量总结设置")).toBeInTheDocument();
    expect(handlers.onSummarizeAll).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^批量/ })).toBeInTheDocument();
  });

  it("「取消」关框且不发起；之后再点可以再选一次", () => {
    const { handlers } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^批量/ }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("批量总结设置")).not.toBeInTheDocument();
    expect(handlers.onSummarizeAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^批量/ }));
    expect(screen.getByText("批量总结设置")).toBeInTheDocument();
  });

  it("两枚确认按钮传的是不同的 skipExisting：跳过已有 true、全部重新生成 false", () => {
    const a = setup();
    fireEvent.click(screen.getByRole("button", { name: /^批量/ }));
    fireEvent.click(screen.getByRole("button", { name: "跳过已有总结" }));
    expect(a.handlers.onSummarizeAll).toHaveBeenCalledWith({ skipExisting: true });
    expect(screen.queryByText("批量总结设置")).not.toBeInTheDocument();
    a.unmount();

    const b = setup();
    fireEvent.click(screen.getByRole("button", { name: /^批量/ }));
    fireEvent.click(screen.getByRole("button", { name: "全部重新生成" }));
    expect(b.handlers.onSummarizeAll).toHaveBeenCalledWith({ skipExisting: false });
  });
});

describe("ChapterTab · 结果卡片那一笔", () => {
  it("没有本章总结时给空态，不许留一张空卡", () => {
    setup();
    expect(screen.getByText("暂无总结，点击上方按钮生成")).toBeInTheDocument();
  });

  it("总结正文、标题、字数、时间都落到卡片上", () => {
    setup({ chapterSummary: makeSummary() });
    expect(screen.getByText("第一章 风起")).toBeInTheDocument();
    expect(screen.getByText("城下的雪落了三天。")).toBeInTheDocument();
    expect(screen.getByText("~420")).toBeInTheDocument();
    expect(
      screen.getByText(new Date(1_800_000_000_000).toLocaleString("zh-CN")),
    ).toBeInTheDocument();
  });

  it("时间取 updatedAt，为 0 才回退 createdAt", () => {
    setup({ chapterSummary: makeSummary({ updatedAt: 0 }) });
    expect(
      screen.getByText(new Date(1_700_000_000_000).toLocaleString("zh-CN")),
    ).toBeInTheDocument();
    expect(screen.queryByText(new Date(1_800_000_000_000).toLocaleString("zh-CN"))).not.toBeInTheDocument();
  });

  it("精简与截断要标出来：走了兜底或内容被裁，卡片不许看起来像完整结果", () => {
    const a = setup({ chapterSummary: makeSummary({ usedFallback: true }) });
    expect(screen.getByText("精简")).toBeInTheDocument();
    expect(screen.getByText("本分析使用了精简模式")).toBeInTheDocument();
    a.unmount();

    setup({ chapterSummary: makeSummary({ truncated: true }) });
    expect(screen.getByText("本分析使用了精简模式")).toBeInTheDocument();
  });

  it("收藏带的是这一章的标题、正文与 chapterId，不许串到别的章", () => {
    const { handlers } = setup({
      chapterSummary: makeSummary({ chapterId: "c-7", chapterTitle: "第七章 出塞", content: "第七的正文" }),
    });
    fireEvent.click(screen.getByTitle("收藏到笔记"));
    expect(handlers.onBookmark).toHaveBeenCalledWith("第七章 出塞", "第七的正文", "c-7");
  });

  it("重新生成走 onRegenerate，空闲时那一枚是放行的", () => {
    const { handlers } = setup({ chapterSummary: makeSummary() });
    const regen = document.querySelector("button:has(svg.lucide-refresh-cw)") as HTMLButtonElement;
    fireEvent.click(regen);
    expect(handlers.onRegenerate).toHaveBeenCalledTimes(1);
    expect(regen.disabled).toBe(false);
  });

  it("正在生成时卡片上那枚「重新生成」禁着（点了会双发）", () => {
    setup({ chapterSummary: makeSummary(), loading: true });
    expect(
      (document.querySelector("button:has(svg.lucide-refresh-cw)") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("批量跑到一半时不摆确认框（框只在点「批量」那一闪之后存在）", () => {
    setup({ generateProgress: { current: 1, total: 3 } });
    expect(screen.queryByText("批量总结设置")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "跳过已有总结" })).not.toBeInTheDocument();
  });
});
