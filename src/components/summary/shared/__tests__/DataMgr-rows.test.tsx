/**
 * `DataMgr` + `Row` 组件内部判据（地板第 2 档第十批·数据管理那一屏）。
 *
 * 这一屏全是"删东西"，坏起来的三种形状都很贵：
 * 1) **硬删而不是软删**（`db.summaries.put({ ...existing, deleted })` 少了 spread 就把整条
 *    记录换成只有两个字段的空壳，恢复与同步都拿不到原文）；
 * 2) **删多了**（按类型筛那一步写成不过滤，就会把别的总结一起标死）；
 * 3) **确认框没拦住**（点错了没法回）。
 * 另有"库里查不到的那条要跳过，但界面那一项照样要收掉"，以及笔记那两行靠
 * `chapterId === "__book__"` 分全书/章节——分错边就是"删章节笔记把全书笔记一起删了"。
 *
 * `Row` 本身只有"标签 + 一枚没有文字的删除按钮"，一并在这里钉：图标按钮必须点得到，
 * 而且点它只喊自己那一行的回调。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DataMgr } from "../DataMgr";
import { Row } from "../Row";
import { useSummaryStore } from "@/stores/summary-store";

type Rec = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => ({
  summaryRows: [] as Rec[],
  noteRows: [] as Rec[],
  putSummary: [] as Rec[],
  putNote: [] as Rec[],
  deleteGraph: vi.fn(async () => {}),
  deleteMap: vi.fn(async () => {}),
  pushNow: vi.fn(),
  confirm: vi.fn(() => true as boolean),
}));

vi.mock("@/db/database", () => ({
  getUserDB: () => ({
    summaries: {
      get: async (id: string) => h.summaryRows.find((r) => r.id === id),
      put: async (rec: Rec) => { h.putSummary.push(rec); },
    },
    notes: {
      where: () => ({ equals: () => ({ toArray: async () => h.noteRows }) }),
      put: async (rec: Rec) => { h.putNote.push(rec); },
    },
  }),
}));
vi.mock("@/db/repositories", () => ({ deleteGraph: h.deleteGraph, deleteMap: h.deleteMap }));
vi.mock("@/sync/sync-client", () => ({ syncClient: { pushNow: h.pushNow } }));


function setup(over: Partial<Parameters<typeof DataMgr>[0]> = {}) {
  const handlers = { onDeleteGraph: vi.fn(), onDeleteMap: vi.fn(), onNotesChanged: vi.fn() };
  const props: Parameters<typeof DataMgr>[0] = {
    novelId: "book-1",
    summaries: [
      { id: "ch-1", type: "chapter" },
      { id: "ch-2", type: "chapter" },
      { id: "gl-1", type: "global" },
      { id: "tl-1", type: "timeline" },
      { id: "cr-1", type: "characters" },
    ],
    hasGraph: true,
    onDeleteGraph: handlers.onDeleteGraph,
    hasMap: true,
    onDeleteMap: handlers.onDeleteMap,
    noteCount: { chapter: 2, book: 1 },
    onNotesChanged: handlers.onNotesChanged,
    ...over,
  };
  render(<DataMgr {...props} />);
  return handlers;
}

const delRowOf = (label: string) =>
  (screen.getByText(label).closest("div.flex.items-center") as HTMLElement).querySelector(
    "button:has(svg.lucide-trash-2)",
  ) as HTMLButtonElement;

async function clickDelete(label: string) {
  fireEvent.click(delRowOf(label));
  await act_flush();
}

/** 各 handler 都是 async：让 microtask 跑干，断言才对着稳定态 */
async function act_flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.summaryRows = [
    { id: "ch-1", type: "chapter", novelId: "book-1", chapterId: "c-1", content: "第一章的总结", updatedAt: 100 },
    { id: "ch-2", type: "chapter", novelId: "book-1", chapterId: "c-2", content: "第二章的总结", updatedAt: 100 },
    { id: "gl-1", type: "global", novelId: "book-1", chapterId: "__book__", content: "全书总览", updatedAt: 100 },
    { id: "tl-1", type: "timeline", novelId: "book-1", chapterId: "__book__", content: "时间线", updatedAt: 100 },
    { id: "cr-1", type: "characters", novelId: "book-1", chapterId: "__book__", content: "人物关系", updatedAt: 100 },
  ];
  h.noteRows = [
    { id: "n-1", novelId: "book-1", chapterId: "c-1", content: "章节笔记一" },
    { id: "n-2", novelId: "book-1", chapterId: "c-2", content: "章节笔记二" },
    { id: "n-3", novelId: "book-1", chapterId: "__book__", content: "全书笔记" },
    { id: "n-4", novelId: "book-1", chapterId: "c-3", content: "已经删过的", deleted: 555 },
  ];
  h.putSummary = [];
  h.putNote = [];
  // jsdom 的 window.confirm 是"未实现"，不装桩就恒返回 undefined —— 那条"说不删"的
  // 判据会假绿（它测的正是"确认框拦住"，桩没装上等于永远拦住）
  vi.stubGlobal("confirm", h.confirm);
  h.confirm.mockReturnValue(true);
  useSummaryStore.setState({ summaries: h.summaryRows.map((r) => ({ ...r })) } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DataMgr · 哪些行该摆出来", () => {
  it("四类总结 + 图谱 + 地图 + 两格笔记全在，章节总结那行带数量", () => {
    setup();
    expect(screen.getByText("章节总结 (2)")).toBeInTheDocument();
    expect(screen.getByText("全书总览")).toBeInTheDocument();
    expect(screen.getByText("剧情时间线")).toBeInTheDocument();
    expect(screen.getByText("人物关系分析")).toBeInTheDocument();
    expect(screen.getByText("人物关系图谱")).toBeInTheDocument();
    expect(screen.getByText("小说地图")).toBeInTheDocument();
    expect(screen.getByText("章节笔记 (2)")).toBeInTheDocument();
    expect(screen.getByText("全书笔记 (1)")).toBeInTheDocument();
  });

  it("没有的东西不许摆出一枚能点的删除行", () => {
    setup({ summaries: [], hasGraph: false, hasMap: false, noteCount: { chapter: 0, book: 0 } });
    for (const label of ["全书总览", "剧情时间线", "人物关系分析", "人物关系图谱", "小说地图"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("笔记两格各数各的：只有全书笔记时不摆章节笔记那行", () => {
    setup({ summaries: [], hasGraph: false, hasMap: false, noteCount: { chapter: 0, book: 3 } });
    expect(screen.getByText("全书笔记 (3)")).toBeInTheDocument();
    expect(screen.queryByText(/章节笔记/)).not.toBeInTheDocument();
  });
});

describe("DataMgr · 删总结：软删、只删这一类、确认框拦住", () => {
  it("写回的是原记录 + deleted + updatedAt，原文一个字段都不丢", async () => {
    setup();
    await clickDelete("全书总览");
    expect(h.putSummary).toHaveLength(1);
    const [rec] = h.putSummary;
    expect(rec).toMatchObject({ id: "gl-1", type: "global", novelId: "book-1", content: "全书总览" });
    expect(typeof rec.deleted).toBe("number");
    expect((rec.deleted as number) > 0).toBe(true);
    expect(rec.updatedAt).toBe(rec.deleted);
  });

  it("只删被点那一类：章节总结在库里一条都不许多写", async () => {
    setup();
    await clickDelete("剧情时间线");
    expect(h.putSummary.map((r) => r.id)).toEqual(["tl-1"]);
    expect(h.summaryRows.map((r) => r.id)).toContain("ch-1");
  });

  it("删完界面收掉该类型、其余留着，并催一次同步", async () => {
    setup();
    await clickDelete("章节总结 (2)");
    const left = useSummaryStore.getState().summaries.map((s) => s.id);
    expect(left).toEqual(["gl-1", "tl-1", "cr-1"]);
    expect(h.pushNow).toHaveBeenCalledTimes(1);
  });

  it("库里已经查不到的那条：跳过写回，但界面那一项照样收掉", async () => {
    h.summaryRows = h.summaryRows.filter((r) => r.id !== "gl-1");
    setup();
    await clickDelete("全书总览");
    expect(h.putSummary).toHaveLength(0);
    expect(useSummaryStore.getState().summaries.map((s) => s.id)).not.toContain("gl-1");
    expect(h.pushNow).toHaveBeenCalledTimes(1);
  });

  it("确认框说不删：库里不写一行、界面不变、也不催同步", async () => {
    h.confirm.mockReturnValueOnce(false);
    setup();
    await clickDelete("全书总览");
    expect(h.putSummary).toHaveLength(0);
    expect(useSummaryStore.getState().summaries).toHaveLength(5);
    expect(h.pushNow).not.toHaveBeenCalled();
  });

  it("确认文案要带上删的是什么，'所有'两个字不许省（删的是一整类，不是这一条）", async () => {
    setup();
    await clickDelete("人物关系分析");
    expect(h.confirm).toHaveBeenCalledWith("确认删除所有 人物关系分析？");
  });
});

describe("DataMgr · 删图谱、地图与笔记", () => {
  it("图谱：删库、回父层、催同步，三样一次都不能少", async () => {
    const handlers = setup();
    await clickDelete("人物关系图谱");
    expect(h.deleteGraph).toHaveBeenCalledWith("book-1");
    expect(handlers.onDeleteGraph).toHaveBeenCalledTimes(1);
    expect(h.pushNow).toHaveBeenCalledTimes(1);
    expect(h.putSummary).toHaveLength(0);
  });

  it("地图：走的是 deleteMap 那一条，不许串到图谱上", async () => {
    const handlers = setup();
    await clickDelete("小说地图");
    expect(h.deleteMap).toHaveBeenCalledWith("book-1");
    expect(h.deleteGraph).not.toHaveBeenCalled();
    expect(handlers.onDeleteMap).toHaveBeenCalledTimes(1);
  });

  it("图谱/地图也吃确认框：说不删就一个库都不碰", async () => {
    h.confirm.mockReturnValueOnce(false);
    const handlers = setup();
    await clickDelete("人物关系图谱");
    expect(h.deleteGraph).not.toHaveBeenCalled();
    expect(handlers.onDeleteGraph).not.toHaveBeenCalled();
    expect(h.pushNow).not.toHaveBeenCalled();
  });

  it("删章节笔记：只动 chapterId 不是 __book__ 的那些，全书笔记一条不许陪葬", async () => {
    const handlers = setup();
    await clickDelete("章节笔记 (2)");
    expect(h.putNote.map((r) => r.id)).toEqual(["n-1", "n-2"]);
    expect(handlers.onNotesChanged).toHaveBeenCalledTimes(1);
    expect(h.pushNow).toHaveBeenCalledTimes(1);
  });

  it("删全书笔记：只动 __book__ 那一条", async () => {
    setup();
    await clickDelete("全书笔记 (1)");
    expect(h.putNote.map((r) => r.id)).toEqual(["n-3"]);
  });

  it("已经标过 deleted 的笔记不重复写回", async () => {
    h.noteRows.push({ id: "n-5", novelId: "book-1", chapterId: "__book__", content: "早就删了", deleted: 777 });
    setup({ noteCount: { chapter: 2, book: 2 } });
    await clickDelete("全书笔记 (2)");
    expect(h.putNote.map((r) => r.id)).toEqual(["n-3"]);
  });

  it("笔记那两行的确认文案要写明不可恢复", async () => {
    setup();
    await clickDelete("全书笔记 (1)");
    expect(h.confirm).toHaveBeenCalledWith("确认删除所有 全书笔记？此操作不可恢复。");
  });

  it("确认框说不删笔记：一条都不写，父层也不许被告知变更", async () => {
    h.confirm.mockReturnValueOnce(false);
    const handlers = setup();
    await clickDelete("章节笔记 (2)");
    expect(h.putNote).toHaveLength(0);
    expect(handlers.onNotesChanged).not.toHaveBeenCalled();
  });
});

describe("Row · 标签与那枚没有文字的删除按钮", () => {
  it("两行各喊各的：删除按钮按图标认得到，点它只喊自己那行的 onDelete", () => {
    const a = vi.fn();
    const b = vi.fn();
    render(
      <div>
        <Row label="第一条" onDelete={a} />
        <Row label="第二条" onDelete={b} />
      </div>,
    );
    fireEvent.click(delRowOf("第一条"));
    fireEvent.click(delRowOf("第二条"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(screen.getByText("第一条")).toBeInTheDocument();
  });
});
