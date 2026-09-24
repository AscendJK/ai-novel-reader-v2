/**
 * `useNotes` 单元判据（地板第 2 档第七批·hook 档）。
 *
 * 这一档只判**落库那一笔的形状**：落没落、落到哪一章、清没清输入框、抛错的时候
 * 用户刚打的字还在不在、什么时候该 push 什么时候不该。前四条浏览器层 C22~C25 也判，
 * 但那里拿不到 `saveNote` 的实参（存进去的记录长什么样看不见），失败分支
 * （写库抛错）真 IndexedDB 也不会平白给——`src/db/repositories.ts` 那几个函数把
 * 异常全吞在自己 try/catch 里，hook 永远看不到 reject，只有这里造得出来。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const repo = vi.hoisted(() => ({
  loadNotes: vi.fn(),
  saveNote: vi.fn(),
  deleteNote: vi.fn(),
  pushNow: vi.fn(),
}));

vi.mock("@/db/repositories", () => ({
  loadNotes: repo.loadNotes,
  saveNote: repo.saveNote,
  deleteNote: repo.deleteNote,
}));
vi.mock("@/sync/sync-client", () => ({ syncClient: { pushNow: repo.pushNow } }));
vi.mock("@/parsers/utils", () => ({ uuid: () => "n-new" }));

import { useNotes } from "../useNotes";
import type { NoteItem } from "@/db/repositories";

function makeNote(over: Partial<NoteItem> = {}): NoteItem {
  return {
    id: "n-1",
    novelId: "book-1",
    chapterId: "c-1",
    chapterTitle: "第一章 风起",
    content: "原文",
    source: "user",
    sourceLabel: "用户笔记",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function renderNotes(
  opts: { noteTab?: "chapter" | "book"; selectedChapterId?: string | null; notes?: NoteItem[] } = {},
) {
  const { noteTab = "chapter", selectedChapterId = "c-1" } = opts;
  const hook = renderHook(() =>
    useNotes({
      novelId: "book-1",
      selectedChapterId,
      chapters: [{ id: "c-1", title: "第一章 风起" }, { id: "c-2", title: "第二章 云涌" }],
    }),
  );
  if (opts.notes) {
    const seed = opts.notes;
    act(() => hook.result.current.setNotes(seed));
  }
  act(() => hook.result.current.setNoteTab(noteTab));
  return hook;
}

/** 让 handler 里那两个 setState 真的落到 result 上（React 18 的 act 队列） */
async function flush() {
  await act(async () => { await Promise.resolve(); });
}

const saved = () => repo.saveNote.mock.calls.map((c) => c[0] as NoteItem);
const STAMP = 1_700_000_000_000;
/** 两条笔记的固定样本。handler 只会 spread 出对象、再整体换数组，从不就地改，所以可以跨用例共用 */
const two = [makeNote({ id: "n-1", content: "第一条" }), makeNote({ id: "n-2", content: "第二条" })];

beforeEach(() => {
  vi.clearAllMocks();
  repo.loadNotes.mockResolvedValue([]);
  repo.saveNote.mockResolvedValue(undefined);
  repo.deleteNote.mockResolvedValue(undefined);
  repo.pushNow.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("confirm", () => true);
});

describe("useNotes · 新建落库那一笔", () => {
  it("空白正文根本不写库：不 trim 之后落库，也不 push", async () => {
    const hook = renderNotes();
    for (const blank of ["", "   ", "\n\t"]) {
      act(() => hook.result.current.setNoteContent(blank));
      await hook.result.current.handleSaveNote();
    }
    await flush();
    expect(repo.saveNote).not.toHaveBeenCalled();
    expect(repo.pushNow).not.toHaveBeenCalled();
    expect(hook.result.current.notes).toHaveLength(0);
  });

  it("本章 + 选中了章节 → 落当前章、带章标题、正文 trim、时间戳非零、source 是 user", async () => {
    const hook = renderNotes();
    act(() => hook.result.current.setNoteContent("  雪落了三天。  "));
    await hook.result.current.handleSaveNote();
    await flush();
    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({
      id: "n-new", novelId: "book-1", chapterId: "c-1",
      chapterTitle: "第一章 风起", content: "雪落了三天。", source: "user", sourceLabel: "用户笔记",
    });
    // 只断"有没有"：把 createdAt 写成 0 在 `NotesTab.tsx:176` 会静默退回 updatedAt，
    // 界面上一个错都不报，而 0 与 null 在断言里长得几乎一样，值得钉一道
    expect(saved()[0].createdAt).toBeGreaterThan(0);
    expect(saved()[0].updatedAt).toBeGreaterThan(0);
  });

  it("本章但没选中章节 → 落点退到全书，标题与标签却还留在章节口径（钉现状，不是钉正确）", async () => {
    const hook = renderNotes({ selectedChapterId: null });
    act(() => hook.result.current.setNoteContent("这一条其实没有章。"));
    await hook.result.current.handleSaveNote();
    await flush();
    // `useNotes.ts:95-97` 只在算 chapterId 时看了 selectedChapterId，另两样只看 noteTab。
    // 于是这条笔记会出现在「全书笔记」那一页（`SummaryPanel.tsx:239` 按 chapterId 筛），
    // 头顶标签却写着"用户笔记 / 当前章节"。用户看到的意外是：写了"本章"笔记，本章页却
    // 显示"暂无本章笔记"。先按现状钉住，改不改由制作人定。
    expect(saved()[0]).toMatchObject({
      chapterId: "__book__", chapterTitle: "当前章节", sourceLabel: "用户笔记",
    });
  });

  it("全书 tab 下就算选中了章节也不许偷偷落到章里去", async () => {
    const hook = renderNotes({ noteTab: "book" });
    act(() => hook.result.current.setNoteContent("全书的一条。"));
    await hook.result.current.handleSaveNote();
    await flush();
    expect(saved()[0]).toMatchObject({
      chapterId: "__book__", chapterTitle: "全书笔记", sourceLabel: "全书笔记",
    });
  });

  it("章 id 不在章节列表里 → 标题回退'当前章节'，不许留 undefined 上架", async () => {
    const hook = renderNotes({ selectedChapterId: "c-gone" });
    act(() => hook.result.current.setNoteContent("孤儿章的一条。"));
    await hook.result.current.handleSaveNote();
    await flush();
    expect(saved()[0].chapterTitle).toBe("当前章节");
  });

  it("成功后排到最前、清空输入框并催一次同步", async () => {
    const hook = renderNotes({ notes: [makeNote({ id: "n-old", content: "旧的一条" })] });
    act(() => hook.result.current.setNoteContent("新的一条"));
    await hook.result.current.handleSaveNote();
    await flush();
    expect(hook.result.current.notes.map((n) => n.id)).toEqual(["n-new", "n-old"]);
    expect(hook.result.current.noteContent).toBe("");
    expect(repo.pushNow).toHaveBeenCalledTimes(1);
  });

  it("写库失败：用户刚打的字一个字都不许没，按钮也要松开", async () => {
    let rejectSave!: (err: unknown) => void;
    repo.saveNote.mockReturnValueOnce(new Promise<void>((_res, rej) => { rejectSave = rej; }));
    const hook = renderNotes();
    act(() => hook.result.current.setNoteContent("这条存不下。"));
    let done!: Promise<void>;
    act(() => { done = hook.result.current.handleSaveNote(); });
    expect(hook.result.current.savingNote, "写库还在路上，按钮就该禁住").toBe(true);

    act(() => rejectSave(new Error("quota")));
    await done;
    await waitFor(() => expect(hook.result.current.savingNote).toBe(false));
    expect(hook.result.current.noteContent).toBe("这条存不下。");
    expect(hook.result.current.notes).toHaveLength(0);
    expect(repo.pushNow).not.toHaveBeenCalled();
  });
});

describe("useNotes · 编辑、移动与删除", () => {
  it("取消编辑：只丢草稿，库里那条不许被顺手改掉", async () => {
    const hook = renderNotes({ notes: two });
    act(() => hook.result.current.handleEditNote(two[1]));
    expect(hook.result.current.editingNoteId).toBe("n-2");
    expect(hook.result.current.editingContent).toBe("第二条");
    act(() => hook.result.current.setEditingContent("随手打错的一半"));
    act(() => hook.result.current.handleCancelEdit());
    expect(hook.result.current.editingNoteId).toBeNull();
    expect(hook.result.current.editingContent).toBe("");
    expect(repo.saveNote).not.toHaveBeenCalled();
    expect(hook.result.current.notes.map((n) => n.content)).toEqual(["第一条", "第二条"]);
  });

  it("开始编辑把正文交给输入框，但一个字都不写库", () => {
    const hook = renderNotes({ notes: two });
    act(() => hook.result.current.handleEditNote(two[0]));
    expect(hook.result.current.editingNoteId).toBe("n-1");
    expect(hook.result.current.editingContent).toBe("第一条");
    expect(repo.saveNote).not.toHaveBeenCalled();
  });

  it("保存编辑：trim 正文、抬 updatedAt，createdAt 与落点都不许跟着动", async () => {
    const hook = renderNotes({ notes: two });
    act(() => hook.result.current.handleEditNote(two[0]));
    act(() => hook.result.current.setEditingContent("  改成这样  "));
    await hook.result.current.handleSaveEditNote();
    await flush();
    expect(saved()[0]).toMatchObject({
      id: "n-1", content: "改成这样", chapterId: "c-1", sourceLabel: "用户笔记", createdAt: STAMP,
    });
    expect(saved()[0].updatedAt).not.toBe(STAMP);
    expect(repo.pushNow).toHaveBeenCalledTimes(1);
  });

  it("保存编辑只换那一条，另一条一个字不许跟着动", async () => {
    const hook = renderNotes({ notes: two });
    act(() => hook.result.current.handleEditNote(two[1]));
    act(() => hook.result.current.setEditingContent("第二条的新话"));
    await hook.result.current.handleSaveEditNote();
    await flush();
    expect(hook.result.current.notes.map((n) => n.content)).toEqual(["第一条", "第二条的新话"]);
  });

  it("三种不该写库的编辑：正文空白、编辑的那条已不在列表里、压根没在编辑", async () => {
    const hook = renderNotes({ notes: two });
    // ① 只缺正文：在编辑，可正文只剩空白
    act(() => hook.result.current.handleEditNote(two[0]));
    act(() => hook.result.current.setEditingContent("   "));
    await hook.result.current.handleSaveEditNote();
    // ② 只缺"那条还在列表里"：id 指向一条已不在的笔记，正文是满的
    act(() => hook.result.current.handleEditNote(makeNote({ id: "n-gone" })));
    act(() => hook.result.current.setEditingContent("有字，但列表里没这条"));
    await hook.result.current.handleSaveEditNote();
    // ③ 只缺 editingNoteId：草稿留着，但编辑态已经被取消掉
    act(() => hook.result.current.handleCancelEdit());
    act(() => hook.result.current.setEditingContent("没人编辑的草稿"));
    await hook.result.current.handleSaveEditNote();
    await flush();
    expect(repo.saveNote).not.toHaveBeenCalled();
    expect(repo.pushNow).not.toHaveBeenCalled();
    expect(hook.result.current.notes.map((n) => n.content)).toEqual(["第一条", "第二条"]);
  });

  it("confirm 说不删：deleteNote 与 push 一次都不许多打", async () => {
    vi.stubGlobal("confirm", () => false);
    const hook = renderNotes({ notes: two });
    await hook.result.current.handleDeleteNote("n-1");
    await flush();
    expect(repo.deleteNote).not.toHaveBeenCalled();
    expect(repo.pushNow).not.toHaveBeenCalled();
    expect(hook.result.current.notes).toHaveLength(2);
  });

  it("confirm 说删：只少被点那条", async () => {
    const hook = renderNotes({ notes: two });
    await hook.result.current.handleDeleteNote("n-1");
    await flush();
    expect(repo.deleteNote).toHaveBeenCalledWith("n-1");
    expect(hook.result.current.notes.map((n) => n.id)).toEqual(["n-2"]);
    expect(repo.pushNow).toHaveBeenCalledTimes(1);
  });

  it("删除失败：列表原样，也不催同步", async () => {
    repo.deleteNote.mockRejectedValueOnce(new Error("busy"));
    const hook = renderNotes({ notes: two });
    await hook.result.current.handleDeleteNote("n-1");
    await flush();
    expect(hook.result.current.notes).toHaveLength(2);
    expect(repo.pushNow).not.toHaveBeenCalled();
  });

  it("移入全书：只搬被点那条，落点、标题、来路标签三样一起改", async () => {
    const hook = renderNotes({ notes: two });
    await hook.result.current.handleMoveToBook(two[0]);
    await flush();
    expect(saved()[0]).toMatchObject({
      id: "n-1", chapterId: "__book__", chapterTitle: "全书笔记", sourceLabel: "从章节移入",
    });
    expect(saved()[0].updatedAt).not.toBe(STAMP);
    expect(hook.result.current.notes.map((n) => n.chapterId)).toEqual(["__book__", "c-1"]);
    expect(repo.pushNow).toHaveBeenCalledTimes(1);
  });

  it("移动失败：列表里那条的落点不许已经先搬走", async () => {
    repo.saveNote.mockRejectedValueOnce(new Error("quota"));
    const hook = renderNotes({ notes: two });
    await hook.result.current.handleMoveToBook(two[0]);
    await flush();
    expect(hook.result.current.notes.map((n) => n.chapterId)).toEqual(["c-1", "c-1"]);
    expect(repo.pushNow).not.toHaveBeenCalled();
  });
});

describe("useNotes · 加载", () => {
  it("loadNotesList 拉回来就整份换上", async () => {
    const loaded = [makeNote({ id: "n-x" })];
    repo.loadNotes.mockResolvedValueOnce(loaded);
    const hook = renderNotes({ notes: two });
    await act(async () => { await hook.result.current.loadNotesList(); });
    expect(repo.loadNotes).toHaveBeenCalledWith("book-1");
    expect(hook.result.current.notes).toEqual(loaded);
  });

  it("加载抛错不许冒到调用方，列表原样留着", async () => {
    repo.loadNotes.mockRejectedValueOnce(new Error("gone"));
    const hook = renderNotes({ notes: two });
    await expect(
      act(async () => { await hook.result.current.loadNotesList(); }),
    ).resolves.toBeUndefined();
    expect(hook.result.current.notes).toHaveLength(2);
  });
});
