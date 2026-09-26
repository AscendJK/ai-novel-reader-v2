/**
 * `BookTab` 组件内部判据（地板第 2 档第九批·全书分析那一屏）。
 *
 * 浏览器层判过"生成出来的是不是全书"（C2/C16/C17）与地图、图谱各自的形状（D/E 段），
 * 这一屏自己管的四件事没被判过：
 * 1) 五枚入口共用一个展开槽 `bookSub`——点开时间线不许把人物关系也撑开，再点同一枚要收起；
 * 2) `selfLoading` 各归各（时间线在跑只有时间线转圈）；
 * 3) 地图那一段的 `loading = loading || loadingMap`：IndexedDB 里那份还没读出来时不许点；
 * 4) `loadMap` 的成功 / 失败 / **换书之后晚到**三种收法，以及生成地图回 `null`（厂商失败）
 *    时不许把已有那张图清成空白。第 4 条坏起来的形状是"上一本书的地图留在这一本上"。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BookTab } from "../BookTab";

type Props = Parameters<typeof BookTab>[0];
type SectionProps = Record<string, unknown>;

const seen = vi.hoisted(() => ({ map: [] as SectionProps[], graph: [] as SectionProps[] }));
const repo = vi.hoisted(() => ({ loadMap: vi.fn() }));

vi.mock("@/db/repositories", () => ({ loadMap: repo.loadMap }));
vi.mock("../../shared/NovelMapSection", () => ({
  NovelMapSection: (props: SectionProps) => {
    seen.map.push(props);
    const click = (key: string) => () => {
      const fn = props[key] as (() => Promise<unknown>) | undefined;
      void fn?.();
    };
    return (
      <div data-testid="map-section">
        <button onClick={props.onClick as () => void}>开地图</button>
        <button onClick={click("onGenerate")}>生成地图</button>
        <button onClick={click("onRegenerate")}>重画地图</button>
        <span>{props.mapData ? "有地图" : "没地图"}</span>
      </div>
    );
  },
}));
vi.mock("../../shared/CharacterGraphSection", () => ({
  CharacterGraphSection: (props: SectionProps) => {
    seen.graph.push(props);
    return (
      <div data-testid="graph-section">
        <button onClick={props.onClick as () => void}>开图谱</button>
        <span>{props.graphData ? "有图谱" : "没图谱"}</span>
      </div>
    );
  },
}));

import type { SummaryItem } from "@/stores/summary-store";

function summary(id: string, title: string, content: string): SummaryItem {
  return {
    id, novelId: "book-1", chapterId: "__book__", chapterTitle: title, content,
    tokensUsed: 100, createdAt: 1, updatedAt: 1,
  } as SummaryItem;
}

const TIMELINE = summary("t-1", "剧情时间线", "时间线的正文");
const CHARACTERS = summary("c-1", "全书人物关系", "人物关系的正文");
const GLOBAL = summary("g-1", "全书总览", "全书总览的正文");

function setup(over: Partial<Props> = {}) {
  const handlers = {
    setBookSub: vi.fn(),
    onMapDataChange: vi.fn(),
    onGenerateTimeline: vi.fn(),
    onRegenerateTimeline: vi.fn(),
    onGenerateCharacters: vi.fn(),
    onRegenerateCharacters: vi.fn(),
    onGenerateGraph: vi.fn(async () => undefined),
    onRegenerateGraph: vi.fn(async () => undefined),
    onGenerateGlobal: vi.fn(),
    onRegenerateGlobal: vi.fn(),
    onGenerateMap: vi.fn(async () => null),
    onRegenerateMap: vi.fn(async () => null),
  };
  const base = {
    novelId: "book-1",
    timelineSummaries: [TIMELINE],
    characterSummaries: [CHARACTERS],
    globalSummaries: [GLOBAL],
    bookSub: null,
    setBookSub: handlers.setBookSub,
    loading: false,
    characterGraphData: null,
    onGenerateTimeline: handlers.onGenerateTimeline,
    onRegenerateTimeline: handlers.onRegenerateTimeline,
    onGenerateCharacters: handlers.onGenerateCharacters,
    onRegenerateCharacters: handlers.onRegenerateCharacters,
    onGenerateGraph: handlers.onGenerateGraph,
    onRegenerateGraph: handlers.onRegenerateGraph,
    onGenerateGlobal: handlers.onGenerateGlobal,
    onRegenerateGlobal: handlers.onRegenerateGlobal,
    onGenerateMap: handlers.onGenerateMap,
    onRegenerateMap: handlers.onRegenerateMap,
    onMapDataChange: handlers.onMapDataChange,
  } as Props;
  const el = <BookTab {...base} {...over} />;
  const view = render(el);
  return {
    ...view,
    handlers,
    /** 换书那类判据要重挂：整棵树换掉，不留下第一次的 DOM */
    rerenderWith: (next: Partial<Props>) => view.rerender(<BookTab {...base} {...over} {...next} />),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const MAP_DATA = { places: [{ name: "渡口" }] } as never;

/** 让首屏那次 loadMap 落定，之后的断言才对着稳定态 */
async function settled() {
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  seen.map = [];
  seen.graph = [];
  repo.loadMap.mockResolvedValue({ data: null, updatedAt: undefined });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("BookTab · 一个展开槽管五枚入口", () => {
  it("五枚入口各开各的那一格：点谁就回谁的 key", () => {
    const { handlers } = setup();
    fireEvent.click(screen.getByRole("button", { name: "剧情时间线" }));
    fireEvent.click(screen.getByRole("button", { name: "全书人物关系" }));
    fireEvent.click(screen.getByRole("button", { name: "全书总览" }));
    fireEvent.click(screen.getByRole("button", { name: "开图谱" }));
    fireEvent.click(screen.getByRole("button", { name: "开地图" }));
    expect(handlers.setBookSub.mock.calls.map((c) => c[0])).toEqual([
      "timeline", "characters", "global", "graph", "map",
    ]);
  });

  it("展开槽的值原样回传：开 → 那一格的 key，收 → null", () => {
    const a = setup({ bookSub: null });
    fireEvent.click(screen.getByRole("button", { name: "剧情时间线" }));
    expect(a.handlers.setBookSub).toHaveBeenLastCalledWith("timeline");
    a.unmount();

    const b = setup({ bookSub: "timeline" });
    fireEvent.click(screen.getByRole("button", { name: "剧情时间线" }));
    expect(b.handlers.setBookSub).toHaveBeenCalledWith(null);
  });

  it("只有被展开那一格的正文在 DOM 里，另两格不许跟着漏出来", () => {
    setup({ bookSub: "timeline" });
    expect(screen.getByText("时间线的正文")).toBeInTheDocument();
    expect(screen.queryByText("人物关系的正文")).not.toBeInTheDocument();
    expect(screen.queryByText("全书总览的正文")).not.toBeInTheDocument();
  });

  it("图谱与地图那两格也认同一个槽：bookSub=graph 时只有图谱展开", () => {
    setup({ bookSub: "graph" });
    expect(screen.getByRole("button", { name: "开图谱" })).toBeInTheDocument();
    expect(seen.graph.at(-1)?.isOpen).toBe(true);
    expect(seen.map.at(-1)?.isOpen).toBe(false);
    expect(screen.queryByText("时间线的正文")).not.toBeInTheDocument();
  });
});

describe("BookTab · 谁在跑就谁转圈", () => {
  it("时间线在跑：只有那一格收到 selfLoading=true，其余三格是 false", () => {
    setup({ timelineLoading: true });
    const rows = ["剧情时间线", "全书人物关系", "全书总览"];
    const spinners = rows.map((label) => {
      const btn = screen.getByRole("button", { name: label }) as HTMLElement;
      return !!btn.querySelector("svg.lucide-loader-circle");
    });
    expect(spinners).toEqual([true, false, false]);
  });

  it("全书总览在跑：不许让时间线跟着转", () => {
    setup({ globalLoading: true });
    const tl = screen.getByRole("button", { name: "剧情时间线" }) as HTMLElement;
    expect(tl.querySelector("svg.lucide-loader-circle")).toBeFalsy();
  });

  it("整屏 loading 传到底下每一格（地图段也算在忙）", () => {
    setup({ loading: true });
    expect(seen.map.at(-1)?.loading).toBe(true);
    expect(seen.graph.at(-1)?.loading).toBe(true);
  });
});

describe("BookTab · 地图那一段的数据链", () => {
  it("库里那份还在读时，地图入口算在忙（点了会对没读到的数据开生成）", async () => {
    const gate = deferred<{ data: unknown; updatedAt: number }>();
    repo.loadMap.mockReturnValue(gate.promise);
    setup();
    await settled();
    expect(seen.map.at(-1)?.loading).toBe(true);

    gate.resolve({ data: MAP_DATA, updatedAt: 5 });
    await settled();
    expect(seen.map.at(-1)?.loading).toBe(false);
  });

  it("读到地图：透传给地图段，并把同一份交回父层", async () => {
    repo.loadMap.mockResolvedValue({ data: MAP_DATA, updatedAt: 7 });
    const { handlers } = setup();
    await waitFor(() => expect(screen.getByText("有地图")).toBeInTheDocument());
    expect(handlers.onMapDataChange).toHaveBeenCalledWith(MAP_DATA);
    expect(seen.map.at(-1)?.updatedAt).toBe(7);
  });

  it("读失败：两样都得归空，不许把上一本的图留在屏上", async () => {
    repo.loadMap.mockRejectedValueOnce(new Error("gone"));
    const { handlers } = setup();
    await waitFor(() => expect(handlers.onMapDataChange).toHaveBeenCalledWith(null));
    expect(screen.getByText("没地图")).toBeInTheDocument();
  });

  it("换书时旧请求晚到：只许取消，不许写进新书", async () => {
    const a = deferred<{ data: unknown; updatedAt: number }>();
    repo.loadMap.mockReturnValueOnce(a.promise);
    const view = setup({ novelId: "A" });
    await settled();

    const b = deferred<{ data: unknown; updatedAt: number }>();
    repo.loadMap.mockReturnValueOnce(b.promise);
    view.rerenderWith({ novelId: "B" });
    await settled();

    a.resolve({ data: MAP_DATA, updatedAt: 1 });
    await settled();
    expect(view.handlers.onMapDataChange).not.toHaveBeenCalledWith(MAP_DATA);
    expect(screen.getByText("没地图")).toBeInTheDocument();

    b.resolve({ data: { places: [{ name: "黑木崖" }] } as never, updatedAt: 2 });
    await settled();
    expect(screen.getByText("有地图")).toBeInTheDocument();
  });

  it("生成地图回 null（厂商失败）：已有那张图不许被清成空白", async () => {
    repo.loadMap.mockResolvedValue({ data: MAP_DATA, updatedAt: 3 });
    const { handlers } = setup();
    await waitFor(() => expect(screen.getByText("有地图")).toBeInTheDocument());
    handlers.onMapDataChange.mockClear();
    handlers.onGenerateMap.mockResolvedValue(null as never);

    fireEvent.click(screen.getByRole("button", { name: "生成地图" }));
    await settled();
    expect(screen.getByText("有地图")).toBeInTheDocument();
    expect(handlers.onMapDataChange).not.toHaveBeenCalled();
  });

  it("生成地图回了新的一份：透传、交回父层，界面上从「没地图」变「有地图」", async () => {
    const fresh = { places: [{ name: "虎牢关" }] } as never;
    const { handlers } = setup();
    await settled();
    expect(screen.getByText("没地图")).toBeInTheDocument();
    handlers.onMapDataChange.mockClear();
    handlers.onGenerateMap.mockResolvedValue(fresh as never);

    fireEvent.click(screen.getByRole("button", { name: "生成地图" }));
    await settled();
    expect(handlers.onMapDataChange).toHaveBeenCalledWith(fresh);
    expect(screen.getByText("有地图")).toBeInTheDocument();
  });

  it("生成地图抛错：保留旧的、只把错误记进日志", async () => {
    repo.loadMap.mockResolvedValue({ data: MAP_DATA, updatedAt: 3 });
    const { handlers } = setup();
    await waitFor(() => expect(screen.getByText("有地图")).toBeInTheDocument());
    handlers.onGenerateMap.mockRejectedValueOnce(new Error("boom") as never);
    handlers.onMapDataChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "生成地图" }));
    await settled();
    expect(screen.getByText("有地图")).toBeInTheDocument();
    expect(handlers.onMapDataChange).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("Map generation failed:", expect.any(Error));
  });

  it("重画那一条走的是 onRegenerateMap，收法与生成同规", async () => {
    const fresh = { places: [{ name: "洛阳" }] } as never;
    const { handlers } = setup();
    await settled();
    handlers.onRegenerateMap.mockResolvedValue(fresh as never);
    fireEvent.click(screen.getByRole("button", { name: "重画地图" }));
    await settled();
    expect(handlers.onRegenerateMap).toHaveBeenCalledTimes(1);
    expect(handlers.onMapDataChange).toHaveBeenCalledWith(fresh);
  });
});
