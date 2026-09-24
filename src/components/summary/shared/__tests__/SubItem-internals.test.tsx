/**
 * `SubItem` 组件内部判据（地板第 2 档第九批·shared 档）。
 *
 * 全书分析那一屏的四行（时间线 / 人物关系 / 全书总览 + 章节总结复用）都由这只组件画。
 * 浏览器层 C2/C16/C17 判过"点开哪一行、拿到什么结果"，这里判的是这一行自己管的：
 * **`showSpinner = selfLoading ?? loading`（`SubItem.tsx:54`）**——整屏在忙（别的行在跑）
 * 与"这一行在跑"是两件事，写成 `selfLoading || loading` 就会四行一起转圈，
 * 用户看不出到底哪一项在跑；空态与非空态两条分支各用一次它，所以两态都验。
 * 另有：展开与否才决不决定渲染正文、重新生成那枚跟着 `loading` 禁用、
 * 日期取 `updatedAt || createdAt`、`usedFallback` 要落到卡片上。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Clock } from "lucide-react";
import { SubItem } from "../SubItem";

type Summaries = Parameters<typeof SubItem>[0]["summaries"];

function makeSummary(over: Partial<Summaries[number]> = {}): Summaries[number] {
  return {
    id: "s-1",
    chapterTitle: "全书总览",
    content: "三条线索都指向等待。",
    tokensUsed: 320,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_800_000_000_000,
    ...over,
  };
}

const HEAD = {
  label: "剧情时间线",
  icon: <Clock className="h-3 w-3" />,
  emptyLabel: "生成剧情时间线",
};

function setup(over: Partial<Parameters<typeof SubItem>[0]> = {}) {
  const handlers = { onGenerate: vi.fn(), onRegenerate: vi.fn(), onClick: vi.fn() };
  const view = render(
    <SubItem
      {...HEAD}
      isOpen={false}
      summaries={[]}
      loading={false}
      onGenerate={handlers.onGenerate}
      onRegenerate={handlers.onRegenerate}
      onClick={handlers.onClick}
      {...over}
    />,
  );
  return { ...view, handlers };
}

/** 这一行里有没有那枚转圈（lucide 1.17 的 `Loader2` 实际类名是 loader-circle） */
const spinning = (row: HTMLElement) => !!row.querySelector("svg.lucide-loader-circle");

const row = () => screen.getByRole("button", { name: new RegExp(HEAD.emptyLabel) });
const headRow = () => screen.getByRole("button", { name: new RegExp(HEAD.label) });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("SubItem · 空态那一行就是生成入口", () => {
  it("没有结果时整行是一枚生成按钮，点它只喊 onGenerate", () => {
    const { handlers } = setup();
    expect(screen.getByText("生成剧情时间线")).toBeInTheDocument();
    fireEvent.click(row());
    expect(handlers.onGenerate).toHaveBeenCalledTimes(1);
    expect(handlers.onClick).not.toHaveBeenCalled();
    expect(handlers.onRegenerate).not.toHaveBeenCalled();
  });

  it("整屏在忙时空态那枚禁着，点下去不喊", () => {
    const { handlers } = setup({ loading: true });
    expect(row()).toBeDisabled();
    fireEvent.click(row());
    expect(handlers.onGenerate).not.toHaveBeenCalled();
  });

  it("转圈三格：selfLoading=false 压住全局 loading、=true 自己转、不给值就跟着全局", () => {
    const a = setup({ loading: true, selfLoading: false });
    expect(spinning(row()), "别的行在跑，不许这一行也跟着转圈").toBe(false);
    a.unmount();

    const b = setup({ loading: false, selfLoading: true });
    expect(spinning(b.container)).toBe(true);
    b.unmount();

    const c = setup({ loading: true, selfLoading: undefined });
    expect(spinning(c.container)).toBe(true);
    c.unmount();

    const d = setup({ loading: false, selfLoading: undefined });
    expect(spinning(d.container)).toBe(false);
  });
});

describe("SubItem · 有结果那一行", () => {
  const two: Summaries = [makeSummary(), makeSummary({ id: "s-2", chapterTitle: "第二份", content: "第二条正文" })];

  it("行头是折叠开关：点它只喊 onClick，不生成也不重生成", () => {
    const { handlers } = setup({ summaries: two });
    fireEvent.click(headRow());
    expect(handlers.onClick).toHaveBeenCalledTimes(1);
    expect(handlers.onGenerate).not.toHaveBeenCalled();
    expect(handlers.onRegenerate).not.toHaveBeenCalled();
  });

  it("收起时正文不在 DOM 里，展开才挂出来（两份都要在）", () => {
    const closed = setup({ summaries: two, isOpen: false });
    expect(screen.queryByText("三条线索都指向等待。")).not.toBeInTheDocument();
    expect(screen.queryByText("第二条正文")).not.toBeInTheDocument();
    closed.unmount();

    setup({ summaries: two, isOpen: true });
    expect(screen.getByText("三条线索都指向等待。")).toBeInTheDocument();
    expect(screen.getByText("第二条正文")).toBeInTheDocument();
  });

  it("展开之后不许再冒出第二个生成入口", () => {
    setup({ summaries: two, isOpen: true });
    expect(screen.queryByText("生成文字分析")).not.toBeInTheDocument();
    expect(screen.queryByText(HEAD.emptyLabel)).not.toBeInTheDocument();
  });

  it("箭头跟着展开态换向", () => {
    const closed = setup({ summaries: two, isOpen: false });
    expect(closed.container.querySelector("svg.lucide-chevron-right")).toBeTruthy();
    expect(closed.container.querySelector("svg.lucide-chevron-down")).toBeFalsy();
    closed.unmount();

    const opened = setup({ summaries: two, isOpen: true });
    expect(opened.container.querySelector("svg.lucide-chevron-down")).toBeTruthy();
    expect(opened.container.querySelector("svg.lucide-chevron-right")).toBeFalsy();
  });

  it("行尾那枚「重新生成」：点它喊 onRegenerate，整屏忙时禁着", () => {
    const { handlers } = setup({ summaries: two, isOpen: true });
    const regen = screen.getByRole("button", { name: "重新生成" });
    fireEvent.click(regen);
    expect(handlers.onRegenerate).toHaveBeenCalledTimes(1);
    expect((regen as HTMLButtonElement).disabled).toBe(false);
  });

  it("整屏在忙时「重新生成」禁着，但这一行自己不转圈", () => {
    setup({ summaries: two, isOpen: true, loading: true, selfLoading: false });
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    expect(spinning(headRow())).toBe(false);
  });

  it("每张卡片各带自己的字数、标题与正文", () => {
    setup({ summaries: two, isOpen: true });
    expect(screen.getByText("全书总览")).toBeInTheDocument();
    expect(screen.getByText("第二份")).toBeInTheDocument();
    expect(screen.getAllByText("~320")).toHaveLength(2);
  });

  it("时间取 updatedAt，为 0 才回退 createdAt", () => {
    const updated = new Date(1_800_000_000_000).toLocaleString("zh-CN");
    const created = new Date(1_700_000_000_000).toLocaleString("zh-CN");
    const a = setup({ summaries: [makeSummary()], isOpen: true });
    expect(screen.getByText(updated)).toBeInTheDocument();
    expect(screen.queryByText(created)).not.toBeInTheDocument();
    a.unmount();

    setup({ summaries: [makeSummary({ updatedAt: 0 })], isOpen: true });
    expect(screen.getByText(created)).toBeInTheDocument();
  });

  it("走了兜底的那份要标「精简」，没走的不许跟着标", () => {
    setup({
      summaries: [makeSummary({ id: "s-1", usedFallback: true }), makeSummary({ id: "s-2", usedFallback: false })],
      isOpen: true,
    });
    expect(screen.getAllByText("精简")).toHaveLength(1);
  });
});
