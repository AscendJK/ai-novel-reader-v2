/**
 * `NotesTab` 组件内部判据（地板第 2 档第七批·组件档）。
 *
 * 浏览器层 C22~C25 判的是"走完一趟旅程"，这里判的是那一屏自己管的几件事，
 * 浏览器层天生量不到：两枚 disabled 各读哪个状态、本章与全书各用哪个展开槽、
 * 卡片上的点击什么时候该被工具条吃掉、编辑中点卡片该不该顺手折叠、
 * 空状态文案跟着哪一页变、时间取哪一个、徽章跟着 `source` 变。
 *
 * 列表怎么按当前章筛在父层（`SummaryPanel.tsx:239`），本组件只认 `filteredNotes`。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NotesTab } from "../NotesTab";
import type { useNotes } from "../../hooks/useNotes";
import type { NoteItem } from "@/db/repositories";

type NotesHook = ReturnType<typeof useNotes>;

function makeNote(over: Partial<NoteItem> = {}): NoteItem {
  return {
    id: "n-1",
    novelId: "book-1",
    chapterId: "c-1",
    chapterTitle: "第一章 风起",
    content: "城下的雪落了三天。",
    source: "user",
    sourceLabel: "用户笔记",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function makeHook(over: Partial<NotesHook> = {}): NotesHook {
  return {
    notes: [],
    setNotes: vi.fn(),
    noteContent: "",
    setNoteContent: vi.fn(),
    noteTab: "chapter",
    setNoteTab: vi.fn(),
    savingNote: false,
    expandedChapter: null,
    setExpandedChapter: vi.fn(),
    expandedBook: null,
    setExpandedBook: vi.fn(),
    editingNoteId: null,
    editingContent: "",
    setEditingContent: vi.fn(),
    loadNotesList: vi.fn(async () => {}),
    handleSaveNote: vi.fn(async () => {}),
    handleDeleteNote: vi.fn(async () => {}),
    handleEditNote: vi.fn(),
    handleSaveEditNote: vi.fn(async () => {}),
    handleCancelEdit: vi.fn(),
    handleMoveToBook: vi.fn(async () => {}),
    ...over,
  } as NotesHook;
}

/** 一条笔记那张卡片（三枚 class 只有它凑齐：MiniCard 没 min-w-0，问答的范围卡没 overflow-hidden） */
function cardOf(text: string): HTMLElement {
  const el = screen.getByText(text).closest(".shadow-none.overflow-hidden.min-w-0");
  if (!el) throw new Error(`找不到卡片：${text}`);
  return el as HTMLElement;
}

const NOTE = makeNote({ id: "n-a", content: "一条笔记的正文", sourceLabel: "雪夜随手记" });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotesTab · 两枚子页与空状态", () => {
  it("哪一页被选中由 noteTab 说，点另一页只是回传，不改自己的状态", () => {
    const hook = makeHook({ noteTab: "chapter" });
    const { rerender } = render(<NotesTab notesHook={hook} filteredNotes={[]} />);
    const chapterBtn = screen.getByRole("button", { name: "本章笔记" });
    const bookBtn = screen.getByRole("button", { name: "全书笔记" });
    expect(chapterBtn).toHaveClass("bg-secondary");
    expect(bookBtn).not.toHaveClass("bg-secondary");

    fireEvent.click(bookBtn);
    fireEvent.click(chapterBtn);
    expect(hook.setNoteTab).toHaveBeenNthCalledWith(1, "book");
    expect(hook.setNoteTab).toHaveBeenNthCalledWith(2, "chapter");
    expect(hook.setNoteTab).toHaveBeenCalledTimes(2);

    rerender(<NotesTab notesHook={makeHook({ noteTab: "book" })} filteredNotes={[]} />);
    expect(screen.getByRole("button", { name: "全书笔记" })).toHaveClass("bg-secondary");
    expect(screen.getByRole("button", { name: "本章笔记" })).not.toHaveClass("bg-secondary");
  });

  it("空状态文案跟着当前这一页变", () => {
    const { rerender } = render(<NotesTab notesHook={makeHook()} filteredNotes={[]} />);
    expect(screen.getByText("暂无本章笔记")).toBeInTheDocument();
    rerender(<NotesTab notesHook={makeHook({ noteTab: "book" })} filteredNotes={[]} />);
    expect(screen.getByText("暂无全书笔记")).toBeInTheDocument();
    expect(screen.queryByText("暂无本章笔记")).not.toBeInTheDocument();
  });

  it("库里还有笔记、这一页却筛空了 → 显示空态，不许把别页的卡片漏出来", () => {
    const hook = makeHook({ notes: [NOTE] });
    render(<NotesTab notesHook={hook} filteredNotes={[]} />);
    expect(screen.getByText("暂无本章笔记")).toBeInTheDocument();
    expect(screen.queryByText("一条笔记的正文")).not.toBeInTheDocument();
  });
});

describe("NotesTab · 输入区与那枚 disabled", () => {
  it("输入框受控回传，组件自己不吞状态", () => {
    const hook = makeHook({ noteContent: "半截话" });
    render(<NotesTab notesHook={hook} filteredNotes={[]} />);
    const box = document.getElementById("note-input") as HTMLTextAreaElement;
    expect(box.value).toBe("半截话");
    fireEvent.change(box, { target: { value: "整句" } });
    expect(hook.setNoteContent).toHaveBeenCalledWith("整句");
    expect(box.value).toBe("半截话");
  });

  it("三格取值：只正在保存也禁、只正文空白也禁、两样都好才放行", () => {
    const a = render(<NotesTab notesHook={makeHook({ savingNote: true, noteContent: "有正文" })} filteredNotes={[]} />);
    expect(screen.getByRole("button", { name: /保存笔记/ })).toBeDisabled();
    a.unmount();

    const b = render(<NotesTab notesHook={makeHook({ savingNote: false, noteContent: "   \n " })} filteredNotes={[]} />);
    expect(screen.getByRole("button", { name: /保存笔记/ })).toBeDisabled();
    b.unmount();

    render(<NotesTab notesHook={makeHook({ savingNote: false, noteContent: "有正文" })} filteredNotes={[]} />);
    expect(screen.getByRole("button", { name: /保存笔记/ })).toBeEnabled();
  });

  it("禁着的那一枚点下去不会喊 handler", () => {
    const hook = makeHook({ savingNote: true, noteContent: "有正文" });
    render(<NotesTab notesHook={hook} filteredNotes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /保存笔记/ }));
    expect(hook.handleSaveNote).not.toHaveBeenCalled();
  });

  it("放行那一格点下去才真的走 hook 的保存", () => {
    const hook = makeHook({ noteContent: "有正文" });
    render(<NotesTab notesHook={hook} filteredNotes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /保存笔记/ }));
    expect(hook.handleSaveNote).toHaveBeenCalledTimes(1);
  });
});

describe("NotesTab · 展开槽按页分家", () => {
  it("本章页用本章的槽：没展开就点开，已展开就点收", () => {
    const hook = makeHook();
    const first = render(<NotesTab notesHook={hook} filteredNotes={[NOTE]} />);
    fireEvent.click(cardOf("一条笔记的正文"));
    expect(hook.setExpandedChapter).toHaveBeenCalledWith("n-a");
    expect(hook.setExpandedBook).not.toHaveBeenCalled();
    first.unmount();

    const opened = makeHook({ expandedChapter: "n-a" });
    render(<NotesTab notesHook={opened} filteredNotes={[NOTE]} />);
    fireEvent.click(cardOf("一条笔记的正文"));
    expect(opened.setExpandedChapter).toHaveBeenCalledWith(null);
  });

  it("全书页用全书的槽，不去碰本章那一个", () => {
    const hook = makeHook({ noteTab: "book" });
    const first = render(<NotesTab notesHook={hook} filteredNotes={[NOTE]} />);
    fireEvent.click(cardOf("一条笔记的正文"));
    expect(hook.setExpandedBook).toHaveBeenCalledWith("n-a");
    expect(hook.setExpandedChapter).not.toHaveBeenCalled();
    first.unmount();

    // 展开样式同样只认本页那个槽：本章槽指着这条也不作数
    const opened = render(
      <NotesTab notesHook={makeHook({ noteTab: "book", expandedBook: "n-a" })} filteredNotes={[NOTE]} />,
    );
    expect(screen.getByText("一条笔记的正文")).toHaveClass("whitespace-pre-wrap");
    opened.unmount();

    render(
      <NotesTab
        notesHook={makeHook({ noteTab: "book", expandedBook: null, expandedChapter: "n-a" })}
        filteredNotes={[NOTE]}
      />,
    );
    expect(screen.getByText("一条笔记的正文")).toHaveClass("line-clamp-2");
  });

  it("展开样式只看本页那个槽：另一页展开了不算这一页展开了", () => {
    const hook = makeHook({ noteTab: "chapter", expandedBook: "n-a", expandedChapter: null });
    render(<NotesTab notesHook={hook} filteredNotes={[NOTE]} />);
    expect(screen.getByText("一条笔记的正文")).toHaveClass("line-clamp-2");
    expect(screen.getByText("一条笔记的正文")).not.toHaveClass("whitespace-pre-wrap");
  });

  it("编辑中的卡片点下去不折叠（光标在输入框里，折叠等于吞掉编辑）", () => {
    const hook = makeHook({ editingNoteId: "n-a", editingContent: "草稿" });
    render(<NotesTab notesHook={hook} filteredNotes={[NOTE]} />);
    fireEvent.click(cardOf("草稿"));
    expect(hook.setExpandedChapter).not.toHaveBeenCalled();
  });
});

describe("NotesTab · 编辑态那一格", () => {
  it("只有被点那条换成输入框，别条照旧显示正文", () => {
    const hook = makeHook({ editingNoteId: "n-a", editingContent: "草稿中" });
    render(
      <NotesTab
        notesHook={hook}
        filteredNotes={[
          makeNote({ id: "n-a", content: "要改的正文" }),
          makeNote({ id: "n-b", content: "没在改的正文" }),
        ]}
      />,
    );
    expect(screen.getByText("没在改的正文")).toBeInTheDocument();
    expect(screen.queryByText("要改的正文")).not.toBeInTheDocument();
    const editors = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    expect(editors).toHaveLength(2); // 顶部写笔记那一格 + 正在编辑的这一条，不多不少
    const editor = editors.find((e) => e.id !== "note-input")!;
    expect(editor.value).toBe("草稿中");
    fireEvent.change(editor, { target: { value: "改了一点" } });
    expect(hook.setEditingContent).toHaveBeenCalledWith("改了一点");
  });

  it("两格各有各的可访问名：编辑框与顶部输入框都不许是哑巴", () => {
    const hook = makeHook({ editingNoteId: "n-a", editingContent: "草稿中" });
    render(<NotesTab notesHook={hook} filteredNotes={[makeNote({ id: "n-a", content: "要改的正文" })]} />);
    // 实测（jsdom + dom-accessibility-api）：**textarea 不吃 placeholder 当可访问名**，
    // 所以顶部那格原本也是哑巴——上一批判据只能写成 `find((e) => e.id !== "note-input")`
    // 这种排除法，那本身就是症状。两格现在各有各的 aria-label。
    // 刀：A1 摘掉 `aria-label="编辑笔记内容"` → 1 红（找不到 name 编辑笔记内容）；
    //     A2 摘掉 `aria-label="写笔记"` → 1 红（找不到 name 写笔记）。两次基线 `13c3f6ad…7960 B`。
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    const editor = screen.getByRole("textbox", { name: "编辑笔记内容" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("草稿中");
    expect(editor.id).toBe(""); // 没顺手补一个假 id：这格要的是名字，不是又一个句柄
    const top = screen.getByRole("textbox", { name: "写笔记" }) as HTMLTextAreaElement;
    expect(top.id).toBe("note-input"); // id 与名字并存：老判据与 e2e 都还按 id 找
    expect(top.placeholder).toBe("写笔记..."); // placeholder 只是提示，不是名字
  });

  it("Ctrl+Enter 与 Meta+Enter 都算保存，单独 Enter 不许保存", () => {
    const hook = makeHook({ editingNoteId: "n-a", editingContent: "草稿" });
    render(<NotesTab notesHook={hook} filteredNotes={[NOTE]} />);
    const editor = (screen.getAllByRole("textbox") as HTMLTextAreaElement[]).find((e) => e.id !== "note-input")!;
    // 只判"保存喊没喊"。产品在这里没有 preventDefault（`NotesTab.tsx:186-190`），
    // 组合键那次顺带插了个换行——保存成功后编辑框就换掉了，所以量不到危害，
    // 但"它 preventDefault 了"这句话是假话，不钉。
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(hook.handleSaveEditNote).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    expect(hook.handleSaveEditNote).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(hook.handleSaveEditNote).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
    expect(hook.handleSaveEditNote).toHaveBeenCalledTimes(2);
  });

  it("编辑框自己的点击不许冒到卡片（不然打字打着打着卡片就折了）", () => {
    const hook = makeHook({ editingNoteId: "n-a", editingContent: "草稿" });
    render(<NotesTab notesHook={hook} filteredNotes={[NOTE]} />);
    const editor = (screen.getAllByRole("textbox") as HTMLTextAreaElement[]).find((e) => e.id !== "note-input")!;
    fireEvent.click(editor);
    expect(hook.setExpandedChapter).not.toHaveBeenCalled();
  });

  it("编辑中只出「保存 / 取消」，那三枚让位，chevron 也不占位", () => {
    const hook = makeHook({ editingNoteId: "n-a", editingContent: "草稿", expandedChapter: "n-a" });
    render(<NotesTab notesHook={hook} filteredNotes={[NOTE]} />);
    expect(screen.getByTitle("保存")).toBeInTheDocument();
    expect(screen.getByTitle("取消")).toBeInTheDocument();
    expect(screen.queryByTitle("编辑")).not.toBeInTheDocument();
    expect(screen.queryByTitle("移入全书笔记")).not.toBeInTheDocument();
    const card = cardOf("草稿");
    expect(card.querySelectorAll("svg.lucide-chevron-down, svg.lucide-chevron-right")).toHaveLength(0);
  });

  it("没在编辑时才是「编辑 / 移入全书 / 删除」，展开着就有下拉箭头", () => {
    const hook = makeHook({ expandedChapter: "n-a" });
    render(<NotesTab notesHook={hook} filteredNotes={[NOTE]} />);
    expect(screen.getByTitle("编辑")).toBeInTheDocument();
    expect(screen.queryByTitle("保存")).not.toBeInTheDocument();
    expect(screen.queryByTitle("取消")).not.toBeInTheDocument();
    expect(cardOf("一条笔记的正文").querySelectorAll("svg.lucide-chevron-down")).toHaveLength(1);
  });
});

describe("NotesTab · 工具条与徽章", () => {
  it("点工具条不许连带切展开（整排的点击都被吃掉）", () => {
    const hook = makeHook();
    render(<NotesTab notesHook={hook} filteredNotes={[NOTE]} />);
    fireEvent.click(screen.getByTitle("编辑"));
    expect(hook.handleEditNote).toHaveBeenCalledWith(expect.objectContaining({ id: "n-a" }));
    expect(hook.setExpandedChapter).not.toHaveBeenCalled();
  });

  it("三枚出口各喊各的：编辑与移入全书带整条，删除带 id", () => {
    const hook = makeHook();
    render(<NotesTab notesHook={hook} filteredNotes={[NOTE]} />);
    fireEvent.click(screen.getByTitle("移入全书笔记"));
    expect(hook.handleMoveToBook).toHaveBeenCalledWith(expect.objectContaining({ id: "n-a" }));
    const del = cardOf("一条笔记的正文").querySelector("button:has(svg.lucide-trash-2)") as HTMLButtonElement;
    expect(del, "删除那枚没有文字，只能按图标认").toBeTruthy();
    fireEvent.click(del);
    expect(hook.handleDeleteNote).toHaveBeenCalledWith("n-a");
    expect(hook.setExpandedChapter).not.toHaveBeenCalled();
    expect(hook.handleMoveToBook).toHaveBeenCalledTimes(1);
  });

  it("两条笔记各喊各的：出口拿的是自己那一条，不是列表第一条", async () => {
    const hook = makeHook();
    render(
      <NotesTab
        notesHook={hook}
        filteredNotes={[NOTE, makeNote({ id: "n-b", content: "第二条的正文" })]}
      />,
    );
    fireEvent.click(within(cardOf("第二条的正文")).getByTitle("编辑"));
    expect(hook.handleEditNote).toHaveBeenCalledWith(expect.objectContaining({ id: "n-b" }));
    fireEvent.click(cardOf("第二条的正文").querySelector("button:has(svg.lucide-trash-2)") as HTMLButtonElement);
    expect(hook.handleDeleteNote).toHaveBeenCalledWith("n-b");
    fireEvent.click(within(cardOf("一条笔记的正文")).getByTitle("编辑"));
    expect(hook.handleEditNote).toHaveBeenLastCalledWith(expect.objectContaining({ id: "n-a" }));
  });

  it("「移入全书」只在本章那一页摆出来", () => {
    const a = render(<NotesTab notesHook={makeHook()} filteredNotes={[NOTE]} />);
    expect(screen.getByTitle("移入全书笔记")).toBeInTheDocument();
    a.unmount();
    render(<NotesTab notesHook={makeHook({ noteTab: "book" })} filteredNotes={[NOTE]} />);
    expect(screen.queryByTitle("移入全书笔记")).not.toBeInTheDocument();
  });

  it("徽章只认 source，标题只认 sourceLabel：AI 收藏来的不许伪装成用户写的", () => {
    render(
      <NotesTab
        notesHook={makeHook()}
        filteredNotes={[
          makeNote({ id: "n-ai", source: "ai", sourceLabel: "AI 回答" }),
          makeNote({ id: "n-user", source: "user", sourceLabel: "雪夜随手记" }),
        ]}
      />,
    );
    expect(screen.getByText("AI")).toBeInTheDocument();
    expect(screen.getByText("笔记")).toBeInTheDocument();
    expect(screen.getByText("AI 回答")).toBeInTheDocument();
    expect(screen.getByText("雪夜随手记")).toBeInTheDocument();
    expect(screen.queryByText("用户笔记")).not.toBeInTheDocument();
  });

  it("时间取 updatedAt，为 0 才回退 createdAt", () => {
    const updated = new Date(1_800_000_000_000).toLocaleString("zh-CN");
    const created = new Date(1_700_000_000_000).toLocaleString("zh-CN");
    const a = render(<NotesTab notesHook={makeHook()} filteredNotes={[makeNote({ updatedAt: 1_800_000_000_000 })]} />);
    expect(screen.getByText(updated)).toBeInTheDocument();
    expect(screen.queryByText(created)).not.toBeInTheDocument();
    a.unmount();
    render(<NotesTab notesHook={makeHook()} filteredNotes={[makeNote({ updatedAt: 0 })]} />);
    expect(screen.getByText(created)).toBeInTheDocument();
  });
});
