/**
 * `SearchTab` 单元判据（地板第 2 档第十一批·组件档）。
 *
 * 浏览器层只在真后端那一档碰过搜索（`e2e/specs-real/r-rag.spec.ts`），假厂商套里
 * 一条判据都没有。这一档只管**界面说的话跟状态对不对得上**：索引没就绪时那句提示、
 * 离线时不该给的按钮、按钮什么时候该禁住、引擎那行的颜色和名字、两个空状态谁赢。
 * 这些在真后端上要么造不出来（`indexReady === null`、离线、降级），要么造出来也说不清
 * 是哪一格坏了。
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { SearchTab } from "../SearchTab";
import type { useSearch } from "../../hooks/useSearch";

type SearchHook = ReturnType<typeof useSearch>;

const BGE = "Xenova/bge-small-zh-v1.5";

function makeHook(over: Partial<SearchHook> = {}): SearchHook {
  return {
    searchQuery: "",
    setSearchQuery: vi.fn(),
    searchResults: [],
    searchEngine: "none",
    searchLoading: false,
    searchError: null,
    handleSearch: vi.fn(async () => {}),
    clearSearch: vi.fn(),
    ...over,
  };
}

function setup(
  over: {
    hook?: Partial<SearchHook>;
    engine?: string;
    indexReady?: boolean | null;
    offlineMode?: boolean;
  } = {},
) {
  const searchHook = makeHook(over.hook);
  const onBuild = vi.fn();
  const view = render(
    <SearchTab
      searchHook={searchHook}
      engine={over.engine ?? "tfidf"}
      indexReady={over.indexReady ?? null}
      offlineMode={over.offlineMode ?? false}
      onBuild={onBuild}
    />,
  );
  /**
   * 搜索按钮只有图标，**靠可访问名认**——它没有 `aria-label` 时这几条一起红，
   * 因为读屏软件念不出这是什么键（拿结构认就看不见这件事）。
   */
  const searchBtn = () => screen.getByRole("button", { name: "搜索" }) as HTMLButtonElement;
  const engineSpan = () => screen.getByText(/引擎:/).querySelector("span") as HTMLElement;
  return { ...view, searchHook, onBuild, searchBtn, engineSpan };
}

describe("SearchTab · 索引没就绪不许让你搜", () => {
  it("嵌入引擎 + 索引确认没建 → 输入框整个不给，只给提示和构建按钮", () => {
    setup({ engine: BGE, indexReady: false });
    expect(screen.queryByLabelText("语义搜索"), "索引没建就让人搜，只会得到一句'未找到相关内容'的假话").toBeNull();
    expect(screen.getByText("嵌入引擎索引未构建，无法使用语义搜索")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即构建索引" })).toBeInTheDocument();
  });

  it("嵌入引擎 + 还没查过索引状态（null）→ 照常给界面，不许拦", () => {
    setup({ engine: BGE, indexReady: null });
    expect(screen.getByLabelText("语义搜索")).toBeInTheDocument();
    expect(screen.queryByText("嵌入引擎索引未构建，无法使用语义搜索")).toBeNull();
  });

  it("嵌入引擎 + 索引就绪 → 照常给界面", () => {
    setup({ engine: BGE, indexReady: true });
    expect(screen.getByLabelText("语义搜索")).toBeInTheDocument();
  });

  it("tfidf + 索引没建 → 照常给界面（tfidf 本来就不吃索引）", () => {
    setup({ engine: "tfidf", indexReady: false });
    expect(screen.getByLabelText("语义搜索")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即构建索引" })).toBeNull();
  });

  it("离线 → 那句话换成'离线'，并且绝不给构建按钮", () => {
    setup({ engine: BGE, indexReady: false, offlineMode: true });
    expect(screen.queryByRole("button", { name: "立即构建索引" }), "离线点了也是白点").toBeNull();
    expect(screen.getByText("离线模式下无法构建索引")).toBeInTheDocument();
  });

  it("点「立即构建索引」→ 交到 onBuild 手里", () => {
    const { onBuild } = setup({ engine: BGE, indexReady: false });
    fireEvent.click(screen.getByRole("button", { name: "立即构建索引" }));
    expect(onBuild).toHaveBeenCalledTimes(1);
  });
});

describe("SearchTab · 这一趟发得出去吗", () => {
  it("正在搜 → 按钮禁住，图标换成转圈", () => {
    const { searchBtn } = setup({ hook: { searchQuery: "剑修", searchLoading: true } });
    expect(searchBtn()).toBeDisabled();
    expect(document.querySelector("svg.lucide-loader-circle")).not.toBeNull();
    expect(document.querySelector("svg.lucide-search"), "转圈和放大镜不该同时画").toBeNull();
  });

  it("查询词空的或纯空格 → 按钮禁住；一有字就解禁", () => {
    const a = setup({ hook: { searchQuery: "" } });
    expect(a.searchBtn()).toBeDisabled();
    a.unmount();
    const b = setup({ hook: { searchQuery: "   " } });
    expect(b.searchBtn(), "三个空格搜不出东西，按钮别装成能用").toBeDisabled();
    b.unmount();
    const c = setup({ hook: { searchQuery: "剑" } });
    expect(c.searchBtn()).toBeEnabled();
  });

  it("回车：先掐掉默认行为，再发起搜索", () => {
    const { searchHook } = setup({ hook: { searchQuery: "剑修" } });
    const input = screen.getByLabelText("语义搜索");
    expect(fireEvent.keyDown(input, { key: "Enter" }), "回车没 preventDefault，会把整页刷掉").toBe(false);
    expect(searchHook.handleSearch).toHaveBeenCalledTimes(1);
  });

  it("打字用的不是回车 → 不该触发搜索", () => {
    const { searchHook } = setup({ hook: { searchQuery: "剑修" } });
    fireEvent.keyDown(screen.getByLabelText("语义搜索"), { key: "a" });
    expect(searchHook.handleSearch).not.toHaveBeenCalled();
  });

  it("点按钮 → 发起搜索", () => {
    const { searchHook, searchBtn } = setup({ hook: { searchQuery: "剑修" } });
    fireEvent.click(searchBtn());
    expect(searchHook.handleSearch).toHaveBeenCalledTimes(1);
  });

  it("打字 → 每个新值都交回 setSearchQuery，框里显示的是传进来的那个（受控）", () => {
    const { searchHook } = setup({ hook: { searchQuery: "剑" } });
    const input = screen.getByLabelText("语义搜索") as HTMLInputElement;
    expect(input.value).toBe("剑");
    fireEvent.change(input, { target: { value: "剑修" } });
    expect(searchHook.setSearchQuery).toHaveBeenCalledWith("剑修");
    expect(input.value, "自己偷偷改框里的字，用户的输入法状态就乱了").toBe("剑");
  });
});

describe("SearchTab · 界面说的话要和状态对上", () => {
  it("一次都没搜 → 引擎那行报的是配置里的引擎", () => {
    setup({ engine: "tfidf" });
    expect(screen.getByText(/引擎:/).textContent).toContain("TF-IDF（内置）");
  });

  it("搜完用的是嵌入引擎 → 名字换成它，标成绿色", () => {
    const { engineSpan } = setup({
      engine: "tfidf",
      hook: { searchQuery: "剑修", searchEngine: BGE, searchResults: [{ content: "甲", score: 0.5 }] },
    });
    expect(engineSpan().textContent).toBe("BGE Small 中文专精（推荐）");
    expect(engineSpan().className).toContain("text-green-400");
  });

  it("搜完降级成了 tfidf → 名字说实话，标成黄色", () => {
    const { engineSpan } = setup({
      engine: BGE,
      hook: { searchQuery: "剑修", searchEngine: "tfidf" },
    });
    expect(engineSpan().textContent).toBe("TF-IDF（内置）");
    expect(engineSpan().className).toContain("text-yellow-400");
  });

  it("没搜过时名字与颜色必须同源：配的是内置 TF-IDF 就不许标成绿色", () => {
    const { engineSpan } = setup({ engine: "tfidf" });
    expect(engineSpan().textContent).toBe("TF-IDF（内置）");
    expect(engineSpan().className, "名字说你在用内置打分，颜色却说你在用语义引擎").toContain("text-yellow-400");
  });

  it("有结果才报条数，一条没有就不许挂个「· 0 条结果」", () => {
    const a = setup({
      hook: { searchQuery: "剑修", searchResults: [{ content: "甲", score: 0.5 }, { content: "乙", score: 0.4 }] },
    });
    expect(screen.getByText(/2 条结果/)).toBeInTheDocument();
    a.unmount();
    setup({ hook: { searchQuery: "剑修" } });
    expect(screen.queryByText(/条结果/)).toBeNull();
  });

  it("两条结果都画出来：分数留三位小数、按顺序编号", () => {
    setup({
      hook: {
        searchQuery: "剑修",
        searchResults: [
          { content: "第一段正文", score: 0.9124 },
          { content: "第二段正文", score: 0.5 },
        ],
      },
    });
    expect(screen.getByText("0.912")).toBeInTheDocument();
    expect(screen.getByText("0.500")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.getByText("第一段正文")).toBeInTheDocument();
    expect(screen.getByText("第二段正文")).toBeInTheDocument();
  });

  it("报错了 → 原因原文照登，并且不许同时冒出一句「未找到相关内容」", () => {
    setup({ hook: { searchQuery: "剑修", searchError: "模型加载失败" } });
    expect(screen.queryByText("未找到相关内容"), "明明是坏了，不许说成'没找到'").toBeNull();
    expect(screen.getByText("模型加载失败")).toBeInTheDocument();
  });

  it("「未找到相关内容」要四样同时成立，缺一样就不许说", () => {
    const found = () => screen.queryByText("未找到相关内容");
    // ① 四样都成立
    const a = setup({ hook: { searchQuery: "剑修" } });
    expect(found()).toBeInTheDocument();
    a.unmount();
    // ② 还在搜 → 话别说太早
    const b = setup({ hook: { searchQuery: "剑修", searchLoading: true } });
    expect(found(), "结果还没回来就说没找到").toBeNull();
    b.unmount();
    // ③ 有查询词但确实有结果
    const c = setup({ hook: { searchQuery: "剑修", searchResults: [{ content: "甲", score: 0.5 }] } });
    expect(found()).toBeNull();
    c.unmount();
    // ④ 没查词（该说的是"输入查询…"）
    const d = setup({ hook: { searchQuery: "" } });
    expect(found()).toBeNull();
    expect(screen.getByText("输入查询进行语义搜索")).toBeInTheDocument();
    d.unmount();
    // ⑤ 报错了（已由上一条判，这里再钉一次四条件里的那一格）
    setup({ hook: { searchQuery: "剑修", searchError: "炸了" } });
    expect(found()).toBeNull();
  });

  it("一有查询词，「输入查询进行语义搜索」就该让位", () => {
    setup({ hook: { searchQuery: "剑修" } });
    expect(screen.queryByText("输入查询进行语义搜索")).toBeNull();
  });
});
