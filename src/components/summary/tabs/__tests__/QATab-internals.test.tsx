import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { QATab } from "../QATab";

/**
 * `QATab` 内部那一层——浏览器档（`e2e/specs/c-ai-generate.spec.ts` 的 C19~C21）量不到的另一半。
 *
 * e2e 钉的是"点下去之后东西落在哪儿"（收藏落点、新会话清的是哪半、回车发不发）。它量不到的是
 * 这一屏自己那几枚开关的**接线**：两枚 disabled 各有各的来源（面板 `loading` 锁「生成」、
 * `qaLoading` 锁「发送」，写串了界面上看不出来）、范围结果的移除按的是哪条的 id、
 * 收藏按钮长在谁身上、`droppedTurns` 为 0 时那句提示**不该出现**（C17 只判过"有值"那一半），
 * 以及折叠那一格收起时到底收走了什么。
 */

type QaHook = Parameters<typeof QATab>[0]["qaHook"];
type Msg = QaHook["qaMessages"][number];
type Range = QaHook["rangeResults"][number];

const cap = vi.hoisted(() => ({
  submit: 0,
  range: 0,
  clear: 0,
  bookmark: [] as [string, string, string, string | undefined][],
}));

let rangeResults: Range[] = [];

function makeHook(over: Partial<QaHook> = {}): QaHook {
  return {
    qaMessages: [],
    setQaMessages: vi.fn(),
    customQuestion: "",
    setCustomQuestion: vi.fn(),
    rangeFrom: "",
    setRangeFrom: vi.fn(),
    rangeTo: "",
    setRangeTo: vi.fn(),
    rangeResults,
    setRangeResults: vi.fn(),
    qaLoading: false,
    qaError: null,
    setQaError: vi.fn(),
    handleSubmitQuestion: () => { cap.submit += 1; return Promise.resolve(); },
    handleRangeSummary: () => { cap.range += 1; return Promise.resolve(); },
    handleClearQaCache: () => { cap.clear += 1; },
    addMessage: vi.fn(),
    ...over,
  };
}

const msg = (id: string, role: "user" | "assistant", content: string, extra: Partial<Msg> = {}): Msg => ({
  id, role, content, tokensUsed: 10, ...extra,
} as Msg);

const range = (id: string, title: string): Range =>
  ({ id, title, content: `${title}的内容`, tokensUsed: 20, createdAt: 1_700_000_000_000 }) as Range;

function renderTab(hook: QaHook, props: Partial<Parameters<typeof QATab>[0]> = {}) {
  cleanup();
  render(
    <QATab
      qaHook={hook}
      loading={false}
      chapterCount={9}
      selectedChapterId="ch-2"
      onBookmark={(title, content, chapterId, scope) => cap.bookmark.push([title, content, chapterId, scope])}
      {...props}
    />,
  );
}

beforeEach(() => {
  cap.submit = 0;
  cap.range = 0;
  cap.clear = 0;
  cap.bookmark = [];
  rangeResults = [range("r-1", "范围甲"), range("r-2", "范围乙")];
});

describe("QATab 的开关各按各的来源", () => {
  it("面板在加载：范围总结的「生成」锁住，但问答自身的输入框还留着", () => {
    renderTab(makeHook(), { loading: true });
    expect(screen.getByRole("button", { name: "生成" })).toBeDisabled();
    expect(screen.getByPlaceholderText(/输入问题/)).toBeEnabled();
  });

  it("空白题目不许发送（只有空格也不算有字）", () => {
    renderTab(makeHook({ customQuestion: "   " }));
    expect(screen.getByRole("button", { name: /发送/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /发送/ }));
    expect(cap.submit).toBe(0);

    renderTab(makeHook({ customQuestion: "鼓声响了几夜" }));
    expect(screen.getByRole("button", { name: /发送/ })).toBeEnabled();
  });

  it("两个 loading 各管各的：面板忙只锁「生成」，问答在跑不锁「生成」", () => {
    // 写串的形状是"问答在跑 → 整屏都点不动"或"面板忙 → 还能再发一问"。这里钉住两枚按钮
    // 各自读的是哪一份状态。（答案在飞时「发送」看着还能点，是真挡住的是 useQA 里
    // `if (!customQuestion.trim() || qaLoading) return` 那句早退，不在这只组件里。）
    renderTab(makeHook({ qaLoading: true, customQuestion: "还有问题" }));
    expect(screen.getByRole("button", { name: "生成" })).toBeEnabled();
    expect(document.querySelector(".animate-spin")).toBeTruthy();

    renderTab(makeHook({ customQuestion: "还有问题" }));
    expect(screen.getByRole("button", { name: "生成" })).toBeEnabled();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("打字要回传给 hook（受控输入，不许自己吞掉一份状态）", () => {
    const hook = makeHook();
    renderTab(hook);
    fireEvent.change(screen.getByPlaceholderText(/输入问题/), { target: { value: "下一问" } });
    expect(hook.setCustomQuestion).toHaveBeenCalledWith("下一问");
    fireEvent.change(screen.getByLabelText("起始章节"), { target: { value: "3" } });
    expect(hook.setRangeFrom).toHaveBeenCalledWith("3");
  });
});

describe("QATab 的折叠与移除", () => {
  it("点「范围总结」那一行：整条输入收起，再点回来", () => {
    renderTab(makeHook());
    expect(screen.getByLabelText("起始章节")).toBeInTheDocument();
    fireEvent.click(screen.getByText("范围总结"));
    expect(screen.queryByLabelText("起始章节")).toBeNull();
    expect(screen.queryByRole("button", { name: "生成" })).toBeNull();
    fireEvent.click(screen.getByText("范围总结"));
    expect(screen.getByLabelText("起始章节")).toBeInTheDocument();
  });

  it("移除一条范围总结只按那一条的 id：另一条不许跟着掉", () => {
    const hook = makeHook();
    renderTab(hook);
    expect(screen.getByText("范围甲")).toBeInTheDocument();

    // 卡片补上可访问名之后，这里按名字取「范围甲」那一枚：点的就是要删的那条，不再靠屏幕顺序
    fireEvent.click(screen.getByRole("button", { name: "删除 范围甲" }));

    const calls = vi.mocked(hook.setRangeResults).mock.calls;
    expect(calls.length).toBe(1);
    const updater = calls[0][0];
    expect(typeof updater, "移除该走函数式更新，不然并发下会覆盖别人的结果").toBe("function");
    const kept = (updater as (prev: Range[]) => Range[])(rangeResults);
    expect(kept.map((r) => r.id)).toEqual(["r-2"]);
  });
});

describe("QATab 的气泡出口", () => {
  it("收藏按钮只长在答案上，问题气泡不许冒出两枚", () => {
    renderTab(makeHook({
      qaMessages: [msg("a-1", "assistant", "答一"), msg("q-1", "user", "问一"), msg("q-0", "user", "问零")],
    }));
    expect(screen.getAllByRole("button", { name: "收藏到本章" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "收藏到全书" })).toHaveLength(1);
  });

  it("「本章」带的是当前章与 chapter 范围，「全书」带的是 __book__ 与 book 范围", () => {
    renderTab(makeHook({ qaMessages: [msg("a-1", "assistant", "只此一答")] }));

    fireEvent.click(screen.getByRole("button", { name: "收藏到本章" }));
    expect(cap.bookmark).toEqual([["AI 回答", "只此一答", "ch-2", "chapter"]]);

    fireEvent.click(screen.getByRole("button", { name: "收藏到全书" }));
    expect(cap.bookmark[1]).toEqual(["AI 回答", "只此一答", "__book__", "book"]);
  });

  it("没选中章节时只有「本章」让路，「全书」照旧可点", () => {
    renderTab(makeHook({ qaMessages: [msg("a-1", "assistant", "答")] }), { selectedChapterId: null });
    expect(screen.getByRole("button", { name: "收藏到本章" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "收藏到全书" })).toBeEnabled();
  });

  it("droppedTurns 为 0 或没带时不许出现「超出上下文预算」那句", () => {
    // C17 判的是"有值就要上屏"，这一条判的是反方向：把 0 也当成"少了"就是天天报假警
    renderTab(makeHook({
      qaMessages: [
        msg("a-2", "assistant", "答二", { droppedTurns: 0 }),
        msg("q-2", "user", "问二"),
        msg("a-1", "assistant", "答一"),
      ],
    }));
    expect(screen.queryByText(/超出上下文预算/)).toBeNull();
  });

  it("提示行只跟着答案：问题气泡上带野数字也不许冒出来", () => {
    // 形状：`addMessage` 把 droppedTurns 错挂到 user 那条上（或渲染时不分成因）
    renderTab(makeHook({
      qaMessages: [msg("q-1", "user", "只有一问", { droppedTurns: 2 } as Partial<Msg>)],
    }));
    expect(screen.queryByText(/超出上下文预算/)).toBeNull();

    renderTab(makeHook({
      qaMessages: [msg("a-1", "assistant", "带三轮没上", { droppedTurns: 3 }), msg("q-1", "user", "问")],
    }));
    expect(screen.getByText(/更早 3 条对话超出上下文预算/)).toBeInTheDocument();
  });
});

describe("QATab 的键盘", () => {
  it("回车发送并拦住默认换行，Shift+回车两条都不做", () => {
    const hook = makeHook({ customQuestion: "鼓声" });
    renderTab(hook);
    const box = screen.getByPlaceholderText(/输入问题/);

    // fireEvent 返回 false 表示 defaultPrevented —— 换行被吞掉才算"回车是发送"
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    expect(cap.submit).toBe(1);

    const before = cap.submit;
    expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true })).toBe(true);
    expect(cap.submit, "Shift+回车不该发出去").toBe(before);
  });

  it("清空整段历史走 hook 那一个出口，不在组件里另写一套", () => {
    const hook = makeHook({ qaMessages: [msg("a-1", "assistant", "答")] });
    renderTab(hook);
    fireEvent.click(screen.getByRole("button", { name: "新会话" }));
    expect(cap.clear).toBe(1);
    expect(hook.setQaMessages, "组件不许自己搬空列表（否则持久化那半边的清理会漏掉）").not.toHaveBeenCalled();
  });
});

describe("QATab 的状态从哪儿来", () => {
  it("范围输入框里显示的就是 hook 的值（结束章的占位提示跟着章节数走）", () => {
    renderTab(makeHook({ rangeFrom: "2", rangeTo: "4" }));
    expect(screen.getByLabelText("起始章节")).toHaveValue("2");
    expect(screen.getByLabelText("结束章节")).toHaveValue("4");
    expect(screen.getByLabelText("结束章节")).toHaveAttribute("placeholder", "9");
  });

  it("一条对话都没有时，气泡区与「新会话」都不该占位", () => {
    renderTab(makeHook({ qaMessages: [] }));
    expect(screen.queryByRole("button", { name: "新会话" })).toBeNull();
    expect(screen.queryByText(/超出上下文预算/)).toBeNull();
  });

  it("问答在跑不许把已有气泡换掉（转圈是加进去的，不是替掉列表）", () => {
    // 与上一条分工：那条判"转圈只跟着 qaLoading"，这条判"列表不被 loading 换掉"——
    // 同一条断言写两遍会让两处红在一刀上，判据就说不清是哪一半坏了
    renderTab(makeHook({ qaLoading: true, qaMessages: [msg("a-1", "assistant", "上一答还在")] }));
    expect(screen.getByText("上一答还在")).toBeInTheDocument();
  });
});

describe("QATab 输入框的可访问名", () => {
  it("提问那格有名字，不是靠 placeholder 撑着（placeholder 给不出可访问名）", () => {
    // 实测：jsdom + dom-accessibility-api 下 textarea 的 placeholder 不进可访问名，
    // 所以这格此前对读屏是哑巴。产品补了 aria-label="提问"，同时留着 placeholder。
    renderTab(makeHook({ customQuestion: "这一卷的主线是什么" }));
    const box = screen.getByRole("textbox", { name: "提问" }) as HTMLTextAreaElement;
    expect(box.id).toBe("qa-input"); // id 与名字并存：老判据按 placeholder 找，e2e 按 id 找
    expect(box).toHaveValue("这一卷的主线是什么");
    expect(box.placeholder).toBe("输入问题，支持追问...");
  });
});
