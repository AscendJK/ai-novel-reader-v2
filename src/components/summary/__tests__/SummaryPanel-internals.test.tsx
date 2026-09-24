/**
 * `SummaryPanel` 单元判据（地板第 2 档第十二批·面板本体）。
 *
 * 这只文件是 AI 面板的接线盒：五格 tab、三把 hook、任务台账、检索索引状态全从它手里过。
 * 浏览器层（C/G/F 组）天天加载它，但量不到它自己管的那几件事：
 * 1) **`indexReady` 的四条出口**——ready / 非 ready / 请求抛错 / tfidf 引擎。坏起来的形状是
 *    "关键词引擎也被那句『索引未构建』拦住"（`=== false` 写成 `!indexReady` 就中招），
 *    以及"服务器只是没答上来却喊未构建"（null 与 false 是两句话）。
 * 2) **面板上那枚「立即构建」的整条路**（进度映射 `"none"`→`"idle"`、数字补 0、成功要把
 *    indexReady 当场翻真、失败不许翻）。书架上那枚判过（F1/F2），面板这条路一条没有。
 * 3) **换书与"晚到的旧请求"的收尾**——图谱/地图存在组件 state 里，串书的形状是
 *    "上一本的地图留在这一本上"。
 * 4) **它往下发的 props 是哪一份**：summaries 按 novelId 过滤、笔记按 `__book__` 分边、
 *    删完图谱 `hasGraph` 要跟着翻假（不翻就是条目还挂在原地）。
 * 5) **收藏落点的优先级**（显式 scope 胜过那串 sentinel）与"存库失败不许上屏"。
 *
 * 手法：五格 tab 与 DataMgr 全换成"只把收到的 props 记下来"的桩——于是判的就是
 * **面板交下去的是哪一份数据**，而不是各格自己的画法（那些在各自的批里）。
 * rAF 走"排住—手动冲"：面板有三处收尾挂在 rAF 上，等真调度器会让判据跟着机器快慢抖。
 *
 * 刻意没判的一条：`value`/`onValueChange` 那套受控 tab 状态（`:30-42`）。两个渲染点里
 * 只有移动端传（`ReadingPanel.tsx:166`），判它等于判 Radix 的受控实现。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";

import { SummaryPanel } from "../SummaryPanel";

type NovelLite = { id: string; title: string; chapters: { id: string; title: string; content: string }[] };
type Props = Parameters<typeof SummaryPanel>[0];
type Bag = Record<string, unknown>;
/** 桩函数的最小形状：要调用它、要数它被调用过几次，不想把 `vi.fn()` 的泛型推一遍。 */
type Fn = ((...args: unknown[]) => unknown) & { mock: { calls: unknown[][] }; mockClear: () => void };

const BGE = "Xenova/bge-small-zh-v1.5";
const TFIDF_NAME = "TF-IDF（内置）";
const BGE_NAME = "BGE Small 中文专精（推荐）";

const m = vi.hoisted(() => ({
  novel: { current: null as unknown, selectedChapterId: "" },
  rag: { engine: "tfidf", addKey: null as unknown, removeKey: null as unknown },
  ui: { offlineMode: false },
  summaries: [] as unknown[],
  task: {} as Bag,
  notes: {} as Bag,
  qa: {} as Bag,
  search: {} as Bag,
  build: {} as Bag,
  repo: { loadGraph: null as unknown, loadMap: null as unknown, saveNote: null as unknown },
  net: { apiFetch: null as unknown, pushNow: null as unknown },
  rag2: { buildIndex: null as unknown, buildAndPoll: null as unknown, nth: 0 },
  seen: {} as Record<string, Bag>,
}));

const book = (id: string, title = "书甲"): NovelLite => ({
  id,
  title,
  chapters: [
    { id: `${id}-c1`, title: "第一章 风起", content: "洛阳城下的雪" },
    { id: `${id}-c2`, title: "第二章 云涌", content: "虎牢关的鼓声" },
  ],
});
const sum = (id: string, novelId: string, type: string, chapterId = "__book__") => ({ id, novelId, chapterId, type });
const loaded = (mark: string) => ({ data: { mark } });
/** 取面板交给某格的那份 prop（桩在渲染时把 props 记进 m.seen）。 */
const lastOf = (which: string) => m.seen[which] as Bag;
const savedNote = () => (m.repo.saveNote as Fn).mock.calls.at(-1)?.[0] as Bag;
/** `setNotes` 收到的是 updater（前插），拿一份假 prev 跑一遍才知道它到底怎么排。 */
const prepended = (prev: unknown[]) => {
  const updater = (m.notes.setNotes as Fn).mock.calls.at(-1)?.[0];
  return (updater as (p: unknown[]) => unknown[])(prev);
};

vi.mock("@/stores/novel-store", () => ({
  useNovelStore: (sel: (s: Bag) => unknown) =>
    sel({ currentNovel: m.novel.current, selectedChapterId: m.novel.selectedChapterId }),
}));
vi.mock("@/stores/rag-store", () => ({
  useRAGStore: (sel: (s: Bag) => unknown) =>
    sel({ engine: m.rag.engine, addIndexLoadingKey: m.rag.addKey, removeIndexLoadingKey: m.rag.removeKey }),
}));
vi.mock("@/stores/ui-store", () => ({ useUIStore: (sel: (s: Bag) => unknown) => sel({ offlineMode: m.ui.offlineMode }) }));
vi.mock("@/stores/summary-store", () => ({ useSummaryStore: (sel: (s: Bag) => unknown) => sel({ summaries: m.summaries }) }));
vi.mock("@/stores/build-store", () => ({ useBuildStore: { getState: () => m.build } }));
vi.mock("@/hooks/useSummarizer", () => ({ useSummarizer: () => m.task }));
vi.mock("@/components/summary/hooks", () => ({
  useNotes: () => m.notes,
  useQA: () => m.qa,
  useSearch: () => m.search,
}));
vi.mock("@/components/summary/tabs", () => {
  const stub = (which: string, label: string) => (props: Bag) => {
    m.seen[which] = props;
    return <div data-tab={which}>桩:{label}</div>;
  };
  return {
    QATab: stub("qa", "问答"),
    ChapterTab: stub("chapter", "本章分析"),
    BookTab: stub("book", "全书分析"),
    NotesTab: stub("notes", "笔记"),
    SearchTab: stub("search", "搜索"),
  };
});
vi.mock("@/components/summary/shared", () => ({
  DataMgr: (props: Bag) => {
    m.seen.dataMgr = props;
    return (
      <div>
        <span>hasGraph={String(props.hasGraph)}</span>
        <span>hasMap={String(props.hasMap)}</span>
        <span>noteCount={JSON.stringify(props.noteCount)}</span>
        <span>summaries={JSON.stringify(props.summaries)}</span>
        <button onClick={() => (props.onDeleteGraph as () => void)()}>删图谱</button>
        <button onClick={() => (props.onDeleteMap as () => void)()}>删地图</button>
        <button onClick={() => (props.onNotesChanged as () => void)()}>重读笔记</button>
      </div>
    );
  },
}));
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/db/repositories", () => ({
  loadGraph: (id: string) => (m.repo.loadGraph as Fn)(id) as unknown,
  loadMap: (id: string) => (m.repo.loadMap as Fn)(id) as unknown,
  saveNote: (n: unknown) => (m.repo.saveNote as Fn)(n) as unknown,
}));
vi.mock("@/lib/api-client", () => ({ apiFetch: (u: string) => (m.net.apiFetch as Fn)(u) as unknown }));
vi.mock("@/sync/sync-client", () => ({ syncClient: { pushNow: () => (m.net.pushNow as Fn)() } }));
vi.mock("@/rag/index", () => ({ buildIndex: (...a: unknown[]) => (m.rag2.buildIndex as Fn)(...a) as unknown }));
vi.mock("@/rag/build-index", () => ({
  buildAndPollRAGIndex: (o: unknown) => (m.rag2.buildAndPoll as Fn)(o) as unknown,
}));
vi.mock("@/parsers/utils", () => ({ uuid: () => `note-${(m.rag2.nth += 1)}` }));

/** rAF：排住，等用例自己冲（`flushFrames`）。`cancelAnimationFrame` 真的摘得掉。 */
let rafNth = 0;
const frames = new Map<number, FrameRequestCallback>();
const defer = () => new Promise<void>((r) => setTimeout(r, 0));

let view: RenderResult | null = null;
function setup(props: Props = {}) {
  view = render(<SummaryPanel {...props} />);
  return view;
}
/** 换书 / 换引擎 / 任务态翻脸都走这条：改完 hoisted 状态再重渲染一次。 */
async function again(props: Props = {}) {
  await act(async () => {
    view?.rerender(<SummaryPanel {...props} />);
    await defer();
  });
}
async function flush() {
  await act(async () => {
    await defer();
  });
}
async function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => {
    pending.forEach((cb) => cb(0));
    await defer();
  });
}
async function openDataMgr() {
  fireEvent.click(screen.getByRole("button", { name: /数据管理/ }));
  await flush();
}
/**
 * Radix 1.1 的 tab 在**automatic 模式**下是 `onMouseDown` 换格（`:121-123`），
 * `fireEvent.click` 只补 `onClick` 不换格——踩过一次，症状是"点了笔记，笔记那格没出来"。
 */
function selectTab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
}
const calls = (fn: unknown) => (fn as Fn).mock.calls.length;

beforeEach(() => {
  frames.clear();
  rafNth = 0;
  view = null;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++rafNth, cb);
    return rafNth;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  m.novel.current = null;
  m.novel.selectedChapterId = "";
  m.rag.engine = "tfidf";
  m.rag.addKey = vi.fn();
  m.rag.removeKey = vi.fn();
  m.ui.offlineMode = false;
  m.summaries = [];
  m.task = {
    isRunning: false, currentTask: "", currentTaskType: null, error: null, progress: null, isQueued: false,
    summarizeChapter: vi.fn(), summarizeAllChapters: vi.fn(), regenerateChapter: vi.fn(),
    generateGlobalSummary: vi.fn(), regenerateGlobal: vi.fn(), generateCharacterAnalysis: vi.fn(),
    generateTimeline: vi.fn(), regenerateCharacters: vi.fn(), regenerateTimeline: vi.fn(),
    generateMap: vi.fn(), regenerateMap: vi.fn(), generateRangeSummary: vi.fn(), askCustomQuestion: vi.fn(),
    clearQaCache: vi.fn(), clearError: vi.fn(), stopTasks: vi.fn(),
    generateCharacterGraph: vi.fn(async () => null), regenerateCharacterGraph: vi.fn(async () => null),
    ragEngineUsed: "",
  };
  m.notes = {
    notes: [] as unknown[], noteTab: "chapter",
    setNoteContent: vi.fn(), setNotes: vi.fn(), loadNotesList: vi.fn(),
  };
  m.qa = { qaError: null, setQaError: vi.fn(), messages: [] as unknown[] };
  m.search = {
    searchQuery: "", searchResults: [] as unknown[], searchEngine: "none", searchLoading: false, searchError: null,
    setSearchQuery: vi.fn(), clearSearch: vi.fn(), handleSearch: vi.fn(),
  };
  m.build = { startBuild: vi.fn(), updateProgress: vi.fn(), finishBuild: vi.fn(), failBuild: vi.fn() };
  m.repo.loadGraph = vi.fn(async () => ({ data: null }));
  m.repo.loadMap = vi.fn(async () => ({ data: null }));
  m.repo.saveNote = vi.fn(async () => {});
  m.net.apiFetch = vi.fn(async () => ({ json: async () => ({ status: "ready" }) }));
  m.net.pushNow = vi.fn();
  m.rag2.buildIndex = vi.fn(async () => ({}));
  m.rag2.buildAndPoll = vi.fn(async () => ({}));
  m.rag2.nth = 0;
  m.seen = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SummaryPanel：没开书与五格 tab", () => {
  it("没开书时只有一层空壳：五枚 tab 一枚都不许出现，也不许去查索引状态", () => {
    setup();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("AI 分析")).toBeNull();
    expect(m.net.apiFetch).not.toHaveBeenCalled();
    expect(m.build.startBuild).not.toHaveBeenCalled();
  });

  it("默认停在「本章分析」那一格；换到「笔记」之后两格不并存", () => {
    m.novel.current = book("A");
    setup();
    expect(screen.getByText("桩:本章分析")).toBeInTheDocument();
    expect(screen.queryByText("桩:笔记")).toBeNull();
    selectTab("笔记");
    expect(screen.getByText("桩:笔记")).toBeInTheDocument();
    expect(screen.queryByText("桩:本章分析")).toBeNull();
  });

  it("defaultTab 说的就是开在哪一格", () => {
    m.novel.current = book("A");
    setup({ defaultTab: "qa" });
    expect(screen.getByText("桩:问答")).toBeInTheDocument();
  });
});

describe("SummaryPanel：indexReady 的四条出口", () => {
  it("tfidf 引擎一个状态请求都不发、indexReady 归 null（不许让关键词引擎去扛『未构建』横幅）", async () => {
    m.novel.current = book("A");
    m.rag.engine = "tfidf";
    setup({ defaultTab: "search" });
    await flush();
    await flushFrames();
    expect(m.net.apiFetch).not.toHaveBeenCalled();
    expect(lastOf("search").indexReady).toBeNull();
    expect(screen.queryByText(/该引擎索引未构建/)).toBeNull();
    expect(screen.getByText(/检索引擎:/).textContent).toContain(TFIDF_NAME);
  });

  it("嵌入引擎 + 服务器回 ready：indexReady 真、无横幅、只查一次", async () => {
    m.novel.current = book("A");
    m.rag.engine = BGE;
    setup({ defaultTab: "search" });
    await flush();
    expect(lastOf("search").indexReady).toBe(true);
    expect(screen.queryByText(/该引擎索引未构建/)).toBeNull();
    expect(m.net.apiFetch).toHaveBeenCalledTimes(1);
    expect(String((m.net.apiFetch as Fn).mock.calls[0][0])).toContain(`/api/rag/A/status?engine=${encodeURIComponent(BGE)}`);
  });

  it("服务器回 building → 横幅出现并把回退说全（false 不是 null）", async () => {
    m.novel.current = book("A");
    m.rag.engine = BGE;
    m.net.apiFetch = vi.fn(async () => ({ json: async () => ({ status: "building" }) }));
    setup({ defaultTab: "search" });
    await flush();
    await waitFor(() => expect(lastOf("search").indexReady).toBe(false));
    expect(screen.getByText("该引擎索引未构建，当前使用 TF-IDF 回退检索")).toBeInTheDocument();
  });

  it("状态请求抛错 → null：服务器只是没答，喊『未构建』是假话", async () => {
    m.novel.current = book("A");
    m.rag.engine = BGE;
    m.net.apiFetch = vi.fn(async () => {
      throw new Error("网络不在");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setup({ defaultTab: "search" });
    await flush();
    expect(lastOf("search").indexReady).toBeNull();
    expect(screen.queryByText(/该引擎索引未构建/)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("嵌入引擎但本地没缓存：顶部那行改口 TF-IDF，名字与颜色同源", async () => {
    const a = book("A");
    m.novel.current = a;
    m.rag.engine = BGE;
    m.rag2.buildIndex = vi.fn(async () => {
      throw new Error("索引未缓存，需要先构建");
    });
    setup();
    await flush();
    const line = screen.getByText(/检索引擎:/);
    expect(line.textContent).toContain(TFIDF_NAME);
    expect((line.querySelector("span") as HTMLElement).className).toContain("text-yellow-400");
    expect(m.rag2.buildIndex).toHaveBeenCalledWith("A", a.chapters, BGE, undefined, { cacheOnly: true });
  });

  it("加载标记要配平：preload 成功与失败两条路都摘掉同一把 key（阅读页那枚转圈靠它收）", async () => {
    m.novel.current = book("A");
    m.rag.engine = BGE;
    setup();
    await flush();
    expect(m.rag.addKey).toHaveBeenCalledWith(`A-${BGE}`);
    expect(m.rag.removeKey).toHaveBeenCalledWith(`A-${BGE}`);

    m.rag2.buildIndex = vi.fn(async () => {
      throw new Error("坏了");
    });
    m.novel.current = book("B", "书乙");
    await again();
    await flush();
    expect(m.rag.addKey).toHaveBeenLastCalledWith(`B-${BGE}`);
    expect(m.rag.removeKey).toHaveBeenLastCalledWith(`B-${BGE}`);
  });

  it("换书打断的那趟：标记照摘，但晚到的结果不许改这一本的引擎名", async () => {
    // 门放在对象字段上：闭包里的赋值 TS 追不到，直接 releaseA?.() 会被窄化成 never
    const gate: { release: (v?: unknown) => void; reject: (e: unknown) => void } = {
      release: () => {},
      reject: () => {},
    };
    m.rag.engine = BGE;
    m.rag2.buildIndex = vi.fn((id: string) =>
      id === "A"
        ? new Promise((res, rej) => { gate.release = res as (v?: unknown) => void; gate.reject = rej; })
        : Promise.resolve({}),
    );
    m.novel.current = book("A");
    setup();
    await flush();
    expect(m.rag.addKey).toHaveBeenCalledWith(`A-${BGE}`);
    expect(calls(m.rag.removeKey), "前提：A 那趟还挂在天上，标记此刻不该少").toBe(0);

    m.novel.current = book("B", "书乙");
    await again();
    await flush();
    expect(m.rag.addKey).toHaveBeenLastCalledWith(`B-${BGE}`);
    expect(m.rag.removeKey).toHaveBeenLastCalledWith(`B-${BGE}`);

    // A 那趟晚到、而且是失败收场：它自己挂上的标记必须摘掉（阅读页那枚转圈靠它收），
    // 但"这一本用的是什么引擎"归 B 说话，晚到的失败不许把它改成 TF-IDF。
    gate.reject(new Error("上一本的缓存没命中"));
    await flush();
    expect(m.rag.removeKey, "被打断的那趟也要把自己挂上的标记摘掉").toHaveBeenCalledWith(`A-${BGE}`);
    expect(screen.getByText(/检索引擎:/).textContent).toContain(BGE_NAME);
  });

  it("换引擎打断的那趟：晚到的「嵌入成功」不许把这一本改回嵌入引擎", async () => {
    // 上一格的门管的是失败那条腿；成功那条腿写的值是引擎名本身。换书时两本的引擎同名，
    // 那一刀推不出差别（实测：`if (!cancelled)` 摘掉 33 条全绿），只有**换引擎**才让它显形。
    const gate: { release: (v?: unknown) => void } = { release: () => {} };
    m.rag.engine = BGE;
    m.rag2.buildIndex = vi.fn(() => new Promise((res) => { gate.release = res as (v?: unknown) => void; }));
    m.novel.current = book("A");
    setup();
    await flush();

    m.rag.engine = "tfidf";
    await again();
    await flush();
    expect(screen.getByText(/检索引擎:/).textContent).toContain(TFIDF_NAME);

    gate.release({});
    await flush();
    expect(screen.getByText(/检索引擎:/).textContent, "晚到的那趟已经不作数了，引擎名归这一趟说了算").toContain(TFIDF_NAME);
  });
});

describe("SummaryPanel：换书的收尾与晚到的旧请求", () => {
  it("换书三件事一起成套：草稿抹掉、搜索清空并掐掉在飞那趟、按新书 id 重读图谱/地图/笔记", async () => {
    m.novel.current = book("A");
    setup();
    await flush();
    expect(m.notes.setNoteContent).toHaveBeenCalledWith("");
    expect(m.search.clearSearch).toHaveBeenCalledTimes(1);
    expect(m.repo.loadGraph).toHaveBeenLastCalledWith("A");

    m.novel.current = book("B", "书乙");
    await again();
    await flush();
    expect(calls(m.notes.setNoteContent)).toBe(2);
    expect(m.search.setSearchQuery).toHaveBeenLastCalledWith("");
    expect(calls(m.search.clearSearch)).toBe(2);
    expect(m.repo.loadGraph).toHaveBeenLastCalledWith("B");
    expect(m.repo.loadMap).toHaveBeenLastCalledWith("B");
    expect(calls(m.notes.loadNotesList)).toBe(2);
  });

  it("上一本的读库晚到只许被取消，不许盖到这一本上", async () => {
    // 门放在对象字段上：闭包里的赋值 TS 追不到，直接 releaseA?.() 会被窄化成 never
    const gate: { release: (v?: unknown) => void } = { release: () => {} };
    m.repo.loadGraph = vi.fn(() => new Promise((res) => { gate.release = res as (v?: unknown) => void; }));
    m.novel.current = book("A");
    setup({ defaultTab: "book" });

    m.repo.loadGraph = vi.fn(async () => loaded("B 的图谱"));
    m.novel.current = book("B", "书乙");
    await again({ defaultTab: "book" });
    await flush();
    expect(lastOf("book").characterGraphData).toEqual({ mark: "B 的图谱" });

    gate.release(loaded("A 的图谱"));
    await flush();
    expect(lastOf("book").characterGraphData).toEqual({ mark: "B 的图谱" });
  });

  it("书被合上（currentNovel → null）：图谱、地图、笔记三样当场清", async () => {
    m.novel.current = book("A");
    m.repo.loadGraph = vi.fn(async () => loaded("甲图谱"));
    m.repo.loadMap = vi.fn(async () => loaded("甲地图"));
    setup({ defaultTab: "book" });
    await flush();
    expect(lastOf("book").characterGraphData).toEqual({ mark: "甲图谱" });

    m.novel.current = null;
    await again();
    await flushFrames();
    // 没书时整块卸载，最后一份 props 就是"清完"那一次：三样都归空
    expect(m.notes.setNotes).toHaveBeenCalledWith([]);
  });
});

describe("SummaryPanel：横幅上那枚「立即构建」（面板这条路）", () => {
  async function openWithBanner(props: Props = { defaultTab: "search" }) {
    m.novel.current = book("A");
    m.rag.engine = BGE;
    m.net.apiFetch = vi.fn(async () => ({ json: async () => ({ status: "none" }) }));
    setup(props);
    await flush();
    await waitFor(() => expect(lastOf("search").indexReady).toBe(false));
  }

  it("离线时按钮改文案并禁住，点了也不许发构建请求", async () => {
    await openWithBanner();
    m.ui.offlineMode = true;
    await again({ defaultTab: "search" });
    await flush();
    const btn = screen.getByRole("button", { name: "离线不可用" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(m.rag2.buildAndPoll).not.toHaveBeenCalled();
  });

  it("点下去先按当前书 + 当前引擎 startBuild；进度里 `none` 要写成 `idle`、缺的数字补 0", async () => {
    await openWithBanner();
    m.rag2.buildAndPoll = vi.fn(async (o: unknown) => {
      const cb = (o as { onProgress: (p: unknown) => void }).onProgress;
      cb({ status: "none" });
      cb({ status: "queued", queuePosition: 2, message: "排队中", current: 3, total: 9 });
      return {};
    });
    fireEvent.click(screen.getByRole("button", { name: "立即构建" }));
    await flush();
    expect(m.build.startBuild).toHaveBeenCalledWith("A", BGE);
    expect(m.build.updateProgress).toHaveBeenNthCalledWith(1, "A", BGE, {
      status: "idle", message: "", current: 0, total: 0, queuePosition: undefined,
    });
    expect(m.build.updateProgress).toHaveBeenNthCalledWith(2, "A", BGE, {
      status: "queued", message: "排队中", current: 3, total: 9, queuePosition: 2,
    });
  });

  it("构建成功当场把 indexReady 翻真：横幅消失、搜索那格解禁，且不再问服务器", async () => {
    await openWithBanner();
    expect(screen.getByText(/该引擎索引未构建/)).toBeInTheDocument();
    (m.net.apiFetch as Fn).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "立即构建" }));
    await flush();
    expect(m.build.finishBuild).toHaveBeenCalledWith("A", BGE);
    expect(m.build.failBuild).not.toHaveBeenCalled();
    await waitFor(() => expect(lastOf("search").indexReady).toBe(true));
    expect(screen.queryByText(/该引擎索引未构建/)).toBeNull();
    expect(m.net.apiFetch).not.toHaveBeenCalled();
  });

  it("构建失败：原因原文进 store，横幅原地不许消失；抛的不是 Error 也要有话", async () => {
    await openWithBanner();
    m.rag2.buildAndPoll = vi.fn(async () => {
      throw new Error("服务器拒了这只引擎");
    });
    fireEvent.click(screen.getByRole("button", { name: "立即构建" }));
    await flush();
    expect(m.build.failBuild).toHaveBeenCalledWith("A", BGE, "服务器拒了这只引擎");
    expect(m.build.finishBuild).not.toHaveBeenCalled();
    expect(lastOf("search").indexReady).toBe(false);

    m.rag2.buildAndPoll = vi.fn(async () => {
      throw "字符串罢了";
    });
    fireEvent.click(screen.getByRole("button", { name: "立即构建" }));
    await flush();
    expect(m.build.failBuild).toHaveBeenLastCalledWith("A", BGE, "构建失败");
  });
});

describe("SummaryPanel：任务态、错误横幅与台账收尾", () => {
  it("排队中与真在跑是两句话；活儿收掉之后那一行连同「停止」一起走", async () => {
    m.novel.current = book("A");
    m.task.isRunning = true;
    m.task.isQueued = true;
    m.task.currentTask = "正在生成全书总览";
    setup();
    expect(screen.getByText("正在生成全书总览")).toBeInTheDocument();
    expect(screen.queryByText(/AI 正在执行/)).toBeNull();

    m.task.isQueued = false;
    await again();
    expect(screen.getByText("AI 正在执行：正在生成全书总览...")).toBeInTheDocument();

    m.task.isRunning = false;
    await again();
    expect(screen.queryByText(/AI 正在执行/)).toBeNull();
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  });

  it("「停止」走台账那侧的 stopTasks，不是本地抹一把", () => {
    m.novel.current = book("A");
    m.task.isRunning = true;
    setup();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(m.task.stopTasks).toHaveBeenCalledTimes(1);
  });

  it("错误横幅两路共用，「关闭」必须两个一起清（只清一个就永远关不掉）", () => {
    m.novel.current = book("A");
    m.task.error = "总结失败：429";
    m.qa.qaError = "问答失败：401";
    setup();
    expect(screen.getByText("总结失败：429")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(m.task.clearError).toHaveBeenCalledTimes(1);
    expect(m.qa.setQaError).toHaveBeenCalledWith(null);
  });

  it("只有问答那侧报错时横幅也得亮，且拿的是 qaError 原文", () => {
    m.novel.current = book("A");
    m.qa.qaError = "问答失败：401";
    setup();
    expect(screen.getByText("问答失败：401")).toBeInTheDocument();
  });

  it("这本书的活儿从「有」翻回「没有」那一刻才认回来（挂载时那次闲着不算）", async () => {
    // 整条用同一只 spy：换一只能改变返回值的假实现，计数才不会数到别的头上
    const spy = vi.fn(async () => loaded("后台落库的图谱"));
    m.novel.current = book("A");
    m.repo.loadGraph = spy;
    setup({ defaultTab: "book" });
    await flush();
    // 挂载这一次闲着不算：那 1 发是换书那条路读的，认回来的 effect 只在"有→没有"那条边上动手
    expect(spy.mock.calls.length).toBe(1);

    m.task.isRunning = true;
    await again({ defaultTab: "book" });
    await flush();
    expect(spy.mock.calls.length).toBe(1);

    m.task.isRunning = false;
    spy.mockImplementation(async () => loaded("认回来的图谱"));
    await again({ defaultTab: "book" });
    await flush();
    expect(spy.mock.calls.length).toBe(2);
    expect(lastOf("book").characterGraphData).toEqual({ mark: "认回来的图谱" });
  });

  it("从嵌入引擎换到关键词引擎：上一条留下的『未构建』横幅要先走，不等 rAF 把状态归 null", async () => {
    m.novel.current = book("A");
    m.rag.engine = BGE;
    m.net.apiFetch = vi.fn(async () => ({ json: async () => ({ status: "building" }) }));
    setup({ defaultTab: "search" });
    await flush();
    await waitFor(() => expect(screen.getByText(/该引擎索引未构建/)).toBeInTheDocument());

    m.rag.engine = "tfidf";
    await again({ defaultTab: "search" });
    // 刻意先不 flushFrames：这一段窗口里 indexReady 还是上一条留下的 false，
    // 拦住横幅的只能是"引擎不是嵌入型"那一道
    expect(screen.queryByText(/该引擎索引未构建/)).toBeNull();
    await flushFrames();
    expect(lastOf("search").indexReady).toBeNull();
  });

  it("顶部「检索引擎」三级优先：台账报的引擎 > 本地实际引擎 > 配置值", async () => {
    m.novel.current = book("A");
    m.rag.engine = BGE;
    m.task.ragEngineUsed = "tfidf";
    setup();
    await flush();
    expect(screen.getByText(/检索引擎:/).textContent).toContain(TFIDF_NAME);

    m.task.ragEngineUsed = "";
    await again();
    await flush();
    expect(screen.getByText(/检索引擎:/).textContent).toContain(BGE_NAME);

    m.rag.engine = "tfidf";
    await again();
    await flush();
    await flushFrames();
    expect(screen.getByText(/检索引擎:/).textContent).toContain(TFIDF_NAME);
  });
});

describe("SummaryPanel：收藏到笔记", () => {
  const bookmark = (title: string, content: string, chapterId: string, scope?: "chapter" | "book") => {
    act(() => {
      void (lastOf("qa").onBookmark as (t: string, c: string, id: string, s?: "chapter" | "book") => unknown)(
        title, content, chapterId, scope,
      );
    });
  };

  it("四种全书 sentinel 都落 __book__ 并写「全书笔记」，sourceLabel 留原来的标题", async () => {
    m.novel.current = book("A");
    setup({ defaultTab: "qa" });
    await flush();
    for (const sentinel of ["__global__", "__timeline__", "__characters__", "__book__"]) {
      bookmark("全书总览", "正文", sentinel);
      await flush();
      expect(savedNote()).toMatchObject({ chapterId: "__book__", chapterTitle: "全书笔记", sourceLabel: "全书总览" });
    }
    expect(calls(m.net.pushNow)).toBe(4);
  });

  it("显式 scope 胜过 sentinel：调用方说「本章」就按本章落", async () => {
    m.novel.current = book("A");
    setup({ defaultTab: "qa" });
    await flush();
    bookmark("本章小结", "正文", "__book__", "chapter");
    await flush();
    expect(savedNote()).toMatchObject({ chapterId: "__book__", chapterTitle: "本章小结" });
  });

  it("真章节 id → 带章节标题；空 id 兜到 __book__；成功要前插并立刻 push 一次", async () => {
    m.novel.current = book("A");
    m.notes.notes = [{ id: "老笔记" }];
    setup({ defaultTab: "qa" });
    await flush();
    bookmark("问答", "正文一", "A-c2");
    await flush();
    expect(savedNote()).toMatchObject({
      id: "note-1", chapterId: "A-c2", chapterTitle: "第二章 云涌", source: "ai", sourceLabel: "问答",
    });
    expect((prepended([{ id: "老笔记" }]) as unknown[]).map((n) => (n as Bag).id)).toEqual(["note-1", "老笔记"]);
    expect(m.net.pushNow).toHaveBeenCalledTimes(1);

    bookmark("问答", "正文二", "");
    await flush();
    expect(savedNote()).toMatchObject({ chapterId: "__book__", chapterTitle: "问答" });
  });

  it("存库抛错：不上屏、不 push、只记日志（不许出现「看着存好了」的笔记）", async () => {
    m.novel.current = book("A");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.repo.saveNote = vi.fn(async () => {
      throw new Error("库写不进");
    });
    setup({ defaultTab: "qa" });
    await flush();
    bookmark("问答", "正文", "A-c1");
    await flush();
    expect(m.notes.setNotes).not.toHaveBeenCalled();
    expect(m.net.pushNow).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("SummaryPanel：往下发的 props 是哪一份数据", () => {
  it("summaries 先按 novelId 过滤再分型——别人书的总结一个字都不许进来", async () => {
    m.novel.current = book("A");
    m.novel.selectedChapterId = "A-c1";
    m.summaries = [
      sum("s1", "A", "chapter", "A-c1"), sum("s2", "A", "global"), sum("s3", "A", "characters"),
      sum("s4", "A", "timeline"), sum("x1", "B", "global"), sum("x2", "B", "chapter", "B-c1"),
    ];
    setup({ defaultTab: "book" });
    await flush();
    expect(lastOf("book").globalSummaries).toEqual([expect.objectContaining({ id: "s2" })]);
    expect(lastOf("book").characterSummaries).toEqual([expect.objectContaining({ id: "s3" })]);
    expect(lastOf("book").timelineSummaries).toEqual([expect.objectContaining({ id: "s4" })]);
    // 数据管理那格拿的也是过滤后的那一份（删列表时别把别人书的总结列出来）
    await openDataMgr();
    expect(lastOf("dataMgr").summaries).toEqual([sum("s1", "A", "chapter", "A-c1"), sum("s2", "A", "global"),
      sum("s3", "A", "characters"), sum("s4", "A", "timeline")]);
  });

  it("本章那一格只认「选中章 + type=chapter」那一条（B 书同章号的那条不许顶上）", async () => {
    m.novel.current = book("A");
    m.novel.selectedChapterId = "A-c1";
    m.summaries = [sum("x2", "B", "chapter", "A-c1"), sum("g", "A", "global", "A-c1"), sum("s1", "A", "chapter", "A-c1")];
    setup({ defaultTab: "chapter" });
    await flush();
    expect(lastOf("chapter").chapterSummary).toMatchObject({ id: "s1", novelId: "A" });
  });

  it("本章页只看选中那一章的笔记，全书页只看 __book__（分错边=本章笔记在本章页看不见）", async () => {
    m.novel.current = book("A");
    m.novel.selectedChapterId = "A-c1";
    m.notes.notes = [{ id: "n1", chapterId: "A-c1" }, { id: "n2", chapterId: "A-c2" }, { id: "n3", chapterId: "__book__" }];
    setup({ defaultTab: "notes" });
    await flush();
    expect(lastOf("notes").filteredNotes).toEqual([{ id: "n1", chapterId: "A-c1" }]);

    m.notes.noteTab = "book";
    await again({ defaultTab: "notes" });
    await flush();
    expect(lastOf("notes").filteredNotes).toEqual([{ id: "n3", chapterId: "__book__" }]);
  });

  it("数据管理：删完图谱/地图 hasGraph、hasMap 要跟着翻假，noteCount 按 __book__ 分边", async () => {
    m.novel.current = book("A");
    m.repo.loadGraph = vi.fn(async () => loaded("有图谱"));
    m.repo.loadMap = vi.fn(async () => loaded("有地图"));
    // 两格的数量必须不同，否则"数同一边"这种错法算出来一模一样（M20 第一次就是这么逃掉的）
    m.notes.notes = [
      { id: "n1", chapterId: "A-c1" }, { id: "n2", chapterId: "A-c2" }, { id: "n3", chapterId: "__book__" },
    ];
    setup({ defaultTab: "book" });
    await flush();
    await openDataMgr();
    expect(lastOf("dataMgr").hasGraph).toBe(true);
    expect(lastOf("dataMgr").hasMap).toBe(true);
    expect(lastOf("dataMgr").noteCount).toEqual({ chapter: 2, book: 1 });
    expect(lastOf("dataMgr").novelId).toBe("A");

    (m.notes.loadNotesList as Fn).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "删图谱" }));
    fireEvent.click(screen.getByRole("button", { name: "删地图" }));
    fireEvent.click(screen.getByRole("button", { name: "重读笔记" }));
    await flush();
    expect(lastOf("dataMgr").hasGraph).toBe(false);
    expect(lastOf("dataMgr").hasMap).toBe(false);
    expect(m.notes.loadNotesList).toHaveBeenCalledTimes(1);
  });

  it("SearchTab 拿到的是配置里的引擎与当前离线态（不是面板自己猜的 actualEngine）", async () => {
    m.novel.current = book("A");
    m.rag.engine = BGE;
    m.ui.offlineMode = true;
    setup({ defaultTab: "search" });
    await flush();
    expect(lastOf("search").engine).toBe(BGE);
    expect(lastOf("search").offlineMode).toBe(true);
    expect(typeof lastOf("search").onBuild).toBe("function");
  });
});
