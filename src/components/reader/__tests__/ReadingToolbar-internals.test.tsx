/**
 * `ReadingToolbar` 组件内部判据（地板第 1 档·字体面板那一块）。
 *
 * 这只组件只有"六行控件 + 一堆上下界"，但它每行都管着一件会看见的事：
 * 1) **窄屏不许出现「双页」**（`:49` 那个 `filter`）；「大屏自动双页」那一行是**两条门槛**
 *    （`:59`：模式不是滚动 **且** 宽度 ≥768），少一条就是"手机上摆着一行点了没用的开关"。
 *    宽度那条边界在 767／768，两侧各打一次。
 * 2) **同两个 ± 按钮按模式管两件不同的事**（`:71-87`）：滚动模式是"行/秒、步长 0.5、0.5–5"，
 *    翻页模式是"秒/页、步长 1、3–60"。串了档就是"按加减把翻页间隔改成了速度"。
 *    上下界这一族全靠 `disabled` 拦（点禁用的按钮 `onClick` 根本不触发，jsdom 与浏览器一致），
 *    所以**每个界都从两侧各判一次**：界上按得住、界内还能点——只判前者，任何"整行起不来"
 *    的写法都能骗过去（同一形状的教训见 `useContinuousScroll` 那档的"让权型判据两头一起判"）。
 * 3) **钳制不在同一行上**：自动阅读那四支（`:74/:77/:82/:85`）与字号（`:95/:98`）自己带
 *    `Math.max/min`，而**行距（`:110/:113`）与段距（`:120/:123`）不带**，传出去的是原样算术
 *    （段距 1 那一档点「减」就是 `-1`）。这一屏的越界防线在 store：`ui-store.ts:143-155`
 *    把行距取整到一位小数再钳 1.2–2.4、把段距钳 0–20。所以这里判的是"传出去的算术与显示口径"，
 *    **"连点会不会漂出界"那一半不归这只组件，本档不替它背书**（真链路上由 store 兜）。
 *    这个不对称值得记一笔：把钳制抄在两处，改一处漏一处时不会有任何测试响。
 * 4) **字体四档的 label 与 key 不许串**（`:129-138`）：点「楷体」传出去的是
 *    `"KaiTi, serif"` 这一整串 CSS 值，写错的症状是"选了楷体但正文换成宋体"，界面上看不出来。
 * 5) `React.memo`（`:32`）：这一屏挂在阅读页顶栏，正文滚动／进度变化都会让父级重渲染，
 *    props 没变时不该整块重画。这一格判得到是因为把 `Button` 换成计数包装——**摘掉 memo 必红**；
 *    与之配对的那一条判"props 真变了必须重画"，否则"永远不重画"的写法也能骗过第一一条。
 *
 * **本档刻意没判的三格**（写在前面，别让"这只有测试了"盖住）：
 * ① 面板根上那句 `onClick={(e) => e.stopPropagation()}`（`:44`）量出来是**死代码**：外层关面板的
 *    监听是 mousedown（`ReadingChrome.tsx:174` 与 `:61`），而它自己已经用
 *    `closest("[data-font-panel]")` 做了包含判断；全仓再没有 document 级 click 监听（grep 三条
 *    全是 mousedown）。按"死代码不写判据"的口径没给它立红，制作人点头后单独一笔删掉了。
 * ② `md:opacity-0`／`min-h-[44px]` 这类只在真实布局里成立的触控尺寸与悬停显形，jsdom 量不到。
 *
 * ## 变异台账：33 刀打在基线 `496889c9…`（8410 字节 / 31 条全绿），另 4 刀打在 `0215543b…`（补可访问名之后）
 *
 * 前 33 刀的基线是"产品代码一行没动"的那一版；R-N 那四刀打在补可访问名之后的新基线上
 * （`0215543b…`，见下面「可访问名」那一族）。每刀手改一处、跑完立刻按基线还原并核 SHA256；
 * 33 轮固定读数都是
 * `markers=1 / transform_failed=0 / skipped=0 / markers_left=0 / diff_lines=0 / restored_sha=496889c9`。
 * - **窄屏与两半门槛**：R1 摘掉「双页」那道 filter＝2 红、R2 宽度门槛从 ≥768 挪成 >768＝1 红、
 *   R3 自动双页行丢掉「滚动不摆」＝1 红、R4 丢掉宽度那半＝1 红（两半各一刀，摘一边只咬一边）。
 * - **接线**：R5 勾选状态写死＝2 红、R6 传出去是字符串而非布尔＝1 红、R7 模式串写死＝1 红、
 *   R8 选中标态整条丢掉＝1 红、R28 粗细按钮不接回调＝1 红、R29 楷体串成宋体的 CSS 值＝2 红、
 *   R30 字体档不区分当前＝1 红。
 * - **同两个 ± 按钮分档**：R9 行标题不看模式＝4 红（标题一错，凡是按「翻页间隔」找控件的用例全塌）、
 *   R10 速度步长 0.5→1＝1 红、R13 间隔步长 1→2＝1 红、R16 单位说反＝1 红、
 *   R17 滚动那支套用分页的说法＝1 红。
 * - **八个界，每个从两侧各一刀**：R11/R12 速度的 0.5 与 5＝各 1 红（**同一批名字、同一条用例**，
 *   说明那条用例里两侧各有哨兵）；R14/R15 间隔的 3 与 60＝各 1 红；R19/R20 字号的 12 与 24＝各 1 红；
 *   R22/R23 行距的 1.2 与 2.4＝各 1 红；R25 段距步长＝2 红、R26/R27 段距的 0 与 20＝各 1 红。
 * - **显示与 memo**：R21 行距步长 0.1→0.2＝1 红、R24 不锁一位小数（`toFixed(1)` 换成 `String`）＝1 红、
 *   R31 给 memo 塞一个恒判"不相等"的比较器＝1 红（只红"不该重画"那一头，配对的"必须重画"照绿——
 *   这两条成对才有意义，单看任何一条都能被另一种坏法骗过）。
 * - **R18 字号步长 1→2＝1 红；两行数值显示各一刀：R32 字号显示多加一格＝2 红（第二条红是搭上了
 *   "props 真变了必须重画"里那句按屏上数字取的断言，属顺带咬到，不是那条用例的本职）、
 *   R33 段距显示多加一格＝1 红。**
 * - **可访问名那一族（4 刀，基线换过：`0215543b…`＝补名字之后的 34 条全绿版；这一族每轮都连跑
 *   三只文件共 94 条，因为名字是跨文件同一件事）**：N6 字号两枚方向对调＝1 红（两枚名字仍各自
 *   唯一，所以这刀证的是**名字锚住了方向**，不是只判"有没有名字"）、N7 摘掉段距「减」那一枚＝2 红
 *   （名册少一枚 + 同行不得同名那道）、N8 分页那枚套用滚动的说法＝1 红（名字跟着当前档走，判到了）、
 *   N9 名字里塞进当前值＝2 红（**这一刀刻意要红**：口径是"名字不带值、值由旁边那格数字报"，
 *   将来谁把 `16` 写进名字，这条先响）。
 *   N9 第一遍编辑没带上 `MUT-` 标记，读数是 `markers=0` → 按"markers≠1 那轮不作数"重切为 N9b，
 *   重切后才是上面那个 2 红。
 *   还有一格要说明白：**补名字没顺手改掉行为那半的定位方式**——步长／界／显示那二十来条仍按行标签
 *   取兄弟节点（`rowOf`／`minusOf`）。理由是它们要成对取"界上"与"界内"两枚，改走名字等于在一次
 *   只补名字的改动里同时换掉二十条用例的取法，出问题时分不清是哪半。
 *
 * **三笔要交代的（甲／乙／丙，避免和上面 ①②③ 混）**：
 * 甲 **R4 与 R5 一度同盘**（`markers=2`）：我给 R4 打完标记后没有立刻跑，接着又打了 R5 的标记，
 *    那一轮 2 红不能归因给任何单刀 → 作废、还原、各打一遍（R4＝1 红、R5b＝2 红）。教训是
 *    **"下一刀就跑"，不要把两刀的编辑排在同一个跑之前**。
 * 乙 R5 第一遍只红 1 条，我判断「勾选状态跟着 prop 走」那条**判得不够狠**（只在 true 一侧取样，
 *    写死成 `checked` 时它恰好也满足）→ 加强成"false 时不许勾上、true 时才勾"，再重打才有 2 红。
 *    加强之后前面几刀的读数与基线一起重跑过，台账里 R5 记的是加强后的那一轮。
 * 丙 **字号那两支的 `Math.max/min` 单摘是等价变异**：界上已经被 `disabled` 拦住，走到不了钳制那一行，
 *    所以「钳制」与「disabled」这两道同职的闸，任何一道单独摘掉都不红（R19/R20 摘 disabled 才红）。
 *    这不是判据没牙，是**产品本来就有两道**——记在这儿，免得将来有人拿"钳制那行没测试"来判它有 bug。
 *
 * **仍然没判到的**：`min-h-[44px]` 那套只在真实布局里成立的触控尺寸（上面第 ② 条）。
 *
 * **删掉死代码之后重跑过一遍**：面板根那句 `stopPropagation` 单独一笔删掉之后，这一屏 31 条
 * 与基线一起重跑，全绿照旧（删的是一个走不到的分支，判据一条都不受影响——这正是"不给它立红"的理由：
 * 立了红反而要在删的时候连判据一起改）。删完的产品文件是新基线，后面的刀要按新字节重新取。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ReadingToolbar } from "../ReadingToolbar";

/** 数 `Button` 被渲染了几回：这是唯一能看见 memo 有没有生效的读数 */
const rt = vi.hoisted(() => ({ renders: 0 }));

vi.mock("@/components/ui/button", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("@/components/ui/button");
  const R = await import("react");
  const Actual = mod.Button as unknown as React.ComponentType<Record<string, unknown>>;
  return {
    ...mod,
    Button: (props: Record<string, unknown>) => {
      rt.renders += 1;
      return R.createElement(Actual, props);
    },
  };
});

type Props = Parameters<typeof ReadingToolbar>[0];

const H = {
  setFontSize: vi.fn(),
  cycleFontWeight: vi.fn(),
  setLineHeight: vi.fn(),
  setParagraphSpacing: vi.fn(),
  setFontFamily: vi.fn(),
  setReadingMode: vi.fn(),
  setAutoSwitchPageMode: vi.fn(),
  setAutoReadInterval: vi.fn(),
  setAutoReadSpeed: vi.fn(),
};

/** 默认档取的是日常读数：字号 18、行距 1.8、段距 8、速度 1.5 行/秒、间隔 5 秒 */
function toolbarProps(over: Partial<Props> = {}): Props {
  return {
    fontSize: 18,
    fontWeight: 400,
    lineHeight: 1.8,
    paragraphSpacing: 8,
    currentWeightLabel: "常规",
    fontFamily: "system-ui",
    readingMode: "single",
    autoSwitchPageMode: false,
    autoReadInterval: 5,
    autoReadSpeed: 1.5,
    windowWidth: 1200,
    ...H,
    ...over,
  };
}

/**
 * 换状态一律用 `rerender`，不要再 render 一只：这一屏每行的标签都同名（两行都是「滚动速度」），
 * 同屏两只会让 `getByText` 直接报 multiple，夹具就不干净了。
 */
function setup(over: Partial<Props> = {}) {
  const view = render(<ReadingToolbar {...toolbarProps(over)} />);
  return {
    ...H,
    rerender: (next: Partial<Props>) => view.rerender(<ReadingToolbar {...toolbarProps(next)} />),
  };
}

/** 一行的标签是 `<span>`，它的父节点里只有这一行的控件：± 按文档序就是 [减, 加] */
const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;
const rowButtons = (label: string) => [...rowOf(label).querySelectorAll("button")];
const minusOf = (label: string) => rowButtons(label)[0] as HTMLButtonElement;
const plusOf = (label: string) => rowButtons(label)[1] as HTMLButtonElement;
/** 选中标态只由 `variant` 承载：default → bg-primary，outline → border-input */
const isSelected = (el: Element) => el.className.includes("bg-primary");
const valueSpan = (label: string) =>
  [...rowOf(label).querySelectorAll("span")].find((s) =>
    s.className.includes("tabular-nums"),
  ) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  rt.renders = 0;
});

describe("ReadingToolbar · 阅读模式三档与窄屏门槛", () => {
  it("宽屏三档全摆出来", () => {
    setup();
    expect(screen.getByRole("button", { name: "滚动" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "单页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "双页" })).toBeInTheDocument();
  });

  it("窄屏（767）不许出现「双页」，另两档照旧", () => {
    setup({ windowWidth: 767 });
    expect(screen.queryByRole("button", { name: "双页" })).toBeNull();
    expect(screen.getByRole("button", { name: "滚动" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "单页" })).toBeInTheDocument();
  });

  it("宽度门槛正落在 768：767 那一侧收掉双页，768 这一侧放出来", () => {
    const view = setup({ windowWidth: 767 });
    expect(screen.queryByRole("button", { name: "双页" })).toBeNull();
    view.rerender({ windowWidth: 768 });
    expect(screen.getByRole("button", { name: "双页" })).toBeInTheDocument();
  });

  it("当前档是唯一一枚选中标态，其余两档是 outline", () => {
    setup({ readingMode: "single" });
    expect(isSelected(screen.getByRole("button", { name: "单页" }))).toBe(true);
    expect(isSelected(screen.getByRole("button", { name: "滚动" }))).toBe(false);
    expect(isSelected(screen.getByRole("button", { name: "双页" }))).toBe(false);
    expect(screen.getByRole("button", { name: "滚动" }).className).toContain("border-input");
  });

  it("点哪一档就把那一档的模式串交出去，一次一发", () => {
    const h = setup({ readingMode: "single" });
    fireEvent.click(screen.getByRole("button", { name: "滚动" }));
    expect(h.setReadingMode).toHaveBeenCalledWith("scroll");
    fireEvent.click(screen.getByRole("button", { name: "双页" }));
    expect(h.setReadingMode).toHaveBeenCalledWith("double");
    fireEvent.click(screen.getByRole("button", { name: "单页" }));
    expect(h.setReadingMode).toHaveBeenCalledWith("single");
    expect(h.setReadingMode).toHaveBeenCalledTimes(3);
  });
});

describe("ReadingToolbar · 「大屏自动双页」那一行的两条门槛", () => {
  it("滚动模式不摆这一行（滚动没有页可双）", () => {
    setup({ readingMode: "scroll" });
    expect(screen.queryByText("大屏自动双页")).toBeNull();
  });

  it("窄屏不摆这一行，模式对了也不行；同一行宽屏翻页模式才摆", () => {
    const view = setup({ readingMode: "double", windowWidth: 700 });
    expect(screen.queryByText("大屏自动双页")).toBeNull();
    view.rerender({ readingMode: "double", windowWidth: 1000 });
    expect(screen.getByText("大屏自动双页")).toBeInTheDocument();
  });

  it("勾选状态跟着 prop 走：false 时不许是勾上的，true 时才勾", () => {
    const view = setup({ readingMode: "single", autoSwitchPageMode: false });
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    view.rerender({ readingMode: "single", autoSwitchPageMode: true });
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("勾与不勾传出去的是布尔值本身，不是字符串", () => {
    const h = setup({ readingMode: "single", autoSwitchPageMode: false });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(h.setAutoSwitchPageMode).toHaveBeenCalledWith(true);
    h.rerender({ readingMode: "single", autoSwitchPageMode: true });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(h.setAutoSwitchPageMode).toHaveBeenLastCalledWith(false);
  });

  it("勾这一格不许顺手把阅读模式改掉", () => {
    const h = setup({ readingMode: "single" });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(h.setReadingMode).not.toHaveBeenCalled();
    expect(h.setAutoSwitchPageMode).toHaveBeenCalledTimes(1);
  });
});

describe("ReadingToolbar · 同两个 ± 按钮按模式管两件不同的事", () => {
  it("滚动模式那一行说「滚动速度」，数值带「行/秒」单位", () => {
    setup({ readingMode: "scroll", autoReadSpeed: 2 });
    expect(screen.getByText("滚动速度")).toBeInTheDocument();
    expect(screen.queryByText("翻页间隔")).toBeNull();
    expect(valueSpan("滚动速度")).toHaveTextContent("2 行/秒");
  });

  it("翻页模式那一行说「翻页间隔」，数值带「s/页」单位", () => {
    setup({ readingMode: "single", autoReadInterval: 12 });
    expect(screen.getByText("翻页间隔")).toBeInTheDocument();
    expect(screen.queryByText("滚动速度")).toBeNull();
    expect(valueSpan("翻页间隔")).toHaveTextContent("12s/页");
  });

  it("滚动速度按 0.5 步长加减", () => {
    const h = setup({ readingMode: "scroll", autoReadSpeed: 2 });
    fireEvent.click(minusOf("滚动速度"));
    expect(h.setAutoReadSpeed).toHaveBeenCalledWith(1.5);
    fireEvent.click(plusOf("滚动速度"));
    expect(h.setAutoReadSpeed).toHaveBeenLastCalledWith(2.5);
    expect(h.setAutoReadSpeed).toHaveBeenCalledTimes(2);
  });

  it("滚动速度的界是 0.5 与 5：下界按得住、上界按得住，界内那一格还点得动", () => {
    const h = setup({ readingMode: "scroll", autoReadSpeed: 0.5 });
    expect(minusOf("滚动速度")).toBeDisabled();
    fireEvent.click(minusOf("滚动速度"));
    expect(h.setAutoReadSpeed).not.toHaveBeenCalled();
    expect(plusOf("滚动速度").disabled).toBe(false);
    h.rerender({ readingMode: "scroll", autoReadSpeed: 5 });
    expect(plusOf("滚动速度")).toBeDisabled();
    expect(minusOf("滚动速度").disabled).toBe(false);
  });

  it("翻页间隔按 1 步长加减", () => {
    const h = setup({ readingMode: "single", autoReadInterval: 10 });
    fireEvent.click(minusOf("翻页间隔"));
    expect(h.setAutoReadInterval).toHaveBeenCalledWith(9);
    fireEvent.click(plusOf("翻页间隔"));
    expect(h.setAutoReadInterval).toHaveBeenLastCalledWith(11);
  });

  it("翻页间隔的界是 3 与 60：两侧各判「按得住」与「还能点」", () => {
    const h = setup({ readingMode: "single", autoReadInterval: 3 });
    expect(minusOf("翻页间隔")).toBeDisabled();
    fireEvent.click(minusOf("翻页间隔"));
    expect(h.setAutoReadInterval).not.toHaveBeenCalled();
    expect(plusOf("翻页间隔").disabled).toBe(false);
    h.rerender({ readingMode: "single", autoReadInterval: 60 });
    expect(plusOf("翻页间隔")).toBeDisabled();
    expect(minusOf("翻页间隔").disabled).toBe(false);
  });

  it("两支的 title 说的是当前那一档的话（滚动与分页不共用一句）", () => {
    const view = setup({ readingMode: "scroll" });
    expect(minusOf("滚动速度")).toHaveAttribute(
      "title",
      "滚动模式：正文持续滑动的速度（行/秒）",
    );
    view.rerender({ readingMode: "single" });
    expect(minusOf("翻页间隔")).toHaveAttribute("title", "分页模式：每 X 秒自动翻一页");
  });
});

describe("ReadingToolbar · 字号 / 行距 / 段距", () => {
  it("字号按 1 步长加减，中间值原样上屏", () => {
    const h = setup({ fontSize: 18 });
    fireEvent.click(minusOf("字号"));
    expect(h.setFontSize).toHaveBeenCalledWith(17);
    fireEvent.click(plusOf("字号"));
    expect(h.setFontSize).toHaveBeenLastCalledWith(19);
    expect(valueSpan("字号")).toHaveTextContent("18");
  });

  it("字号的界是 12 与 24：界上按得住，界内那一格还点得动", () => {
    const h = setup({ fontSize: 12 });
    expect(minusOf("字号")).toBeDisabled();
    fireEvent.click(minusOf("字号"));
    expect(h.setFontSize).not.toHaveBeenCalled();
    expect(plusOf("字号").disabled).toBe(false);
    h.rerender({ fontSize: 24 });
    expect(plusOf("字号")).toBeDisabled();
    expect(minusOf("字号").disabled).toBe(false);
  });

  it("行距按 0.1 步长加减，传出去的就是这个算术（钳制在 store 那一侧）", () => {
    const h = setup({ lineHeight: 1.8 });
    fireEvent.click(minusOf("行距"));
    expect(h.setLineHeight).toHaveBeenCalledWith(1.8 - 0.1);
    fireEvent.click(plusOf("行距"));
    expect(h.setLineHeight).toHaveBeenLastCalledWith(1.8 + 0.1);
  });

  it("行距的界是 1.2 与 2.4，两侧各判「按得住」与「还能点」", () => {
    const h = setup({ lineHeight: 1.2 });
    expect(minusOf("行距")).toBeDisabled();
    fireEvent.click(minusOf("行距"));
    expect(h.setLineHeight).not.toHaveBeenCalled();
    expect(plusOf("行距").disabled).toBe(false);
    h.rerender({ lineHeight: 2.4 });
    expect(plusOf("行距")).toBeDisabled();
    expect(minusOf("行距").disabled).toBe(false);
  });

  it("行距显示一位小数（浮点尾巴与多余的零都不许上屏）", () => {
    const view = setup({ lineHeight: 1.8 });
    expect(valueSpan("行距")).toHaveTextContent("1.8");
    view.rerender({ lineHeight: 2 });
    expect(valueSpan("行距")).toHaveTextContent("2.0");
  });

  it("段距按 2 步长加减，中间值原样上屏", () => {
    const h = setup({ paragraphSpacing: 8 });
    expect(valueSpan("段距")).toHaveTextContent("8");
    fireEvent.click(minusOf("段距"));
    expect(h.setParagraphSpacing).toHaveBeenCalledWith(6);
    fireEvent.click(plusOf("段距"));
    expect(h.setParagraphSpacing).toHaveBeenLastCalledWith(10);
  });

  it("段距的界是 0 与 20：下界按得住，界内那一格还点得动", () => {
    const h = setup({ paragraphSpacing: 0 });
    expect(minusOf("段距")).toBeDisabled();
    fireEvent.click(minusOf("段距"));
    expect(h.setParagraphSpacing).not.toHaveBeenCalled();
    expect(plusOf("段距").disabled).toBe(false);
    h.rerender({ paragraphSpacing: 20 });
    expect(plusOf("段距")).toBeDisabled();
    expect(minusOf("段距").disabled).toBe(false);
  });

  it("段距那两支不带钳制：1 那一档点「减」传出去是 -1（越界由 store 的 max(0,…) 兜）", () => {
    const h = setup({ paragraphSpacing: 1 });
    fireEvent.click(minusOf("段距"));
    expect(h.setParagraphSpacing).toHaveBeenCalledWith(-1);
    // 对照：字号同一形状的位置是钳过的（`:95` 有 Math.max），所以这两行不能当成一回事判
    fireEvent.click(minusOf("段距"));
    expect(h.setParagraphSpacing).toHaveBeenLastCalledWith(-1);
  });
});

describe("ReadingToolbar · 粗细与字体", () => {
  it("「粗细」那枚按钮显示的就是当前档位标签，点它只喊 cycleFontWeight", () => {
    const h = setup({ currentWeightLabel: "粗体" });
    const btn = rowButtons("粗细")[0];
    expect(btn).toHaveTextContent("粗体");
    fireEvent.click(btn);
    expect(h.cycleFontWeight).toHaveBeenCalledTimes(1);
  });

  it("字体四档全在，摆的顺序是 默认 / 宋体 / 楷体 / 等宽", () => {
    setup();
    expect(rowButtons("字体").map((b) => b.textContent)).toEqual(["默认", "宋体", "楷体", "等宽"]);
  });

  it("点「楷体」传出去的是整串 CSS 值，四档各不串行", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "楷体" }));
    expect(h.setFontFamily).toHaveBeenCalledWith("KaiTi, serif");
    fireEvent.click(screen.getByRole("button", { name: "等宽" }));
    expect(h.setFontFamily).toHaveBeenLastCalledWith("monospace");
    fireEvent.click(screen.getByRole("button", { name: "宋体" }));
    expect(h.setFontFamily).toHaveBeenLastCalledWith("SimSun, serif");
    fireEvent.click(screen.getByRole("button", { name: "默认" }));
    expect(h.setFontFamily).toHaveBeenLastCalledWith("system-ui");
  });

  it("当前字体那一档才是选中标态", () => {
    setup({ fontFamily: "SimSun, serif" });
    expect(rowButtons("字体").map((b) => isSelected(b))).toEqual([false, true, false, false]);
  });
});

describe("ReadingToolbar · 十枚 ± 按钮的可访问名", () => {
  // 图标按钮只画一个 Minus/Plus，读屏里本来什么都念不出来（自动阅读那两枚只有 `title`，
  // 说的还是"这一档是干什么的"，不含方向）。制作人口径（2026-09-26）：按「方向 + 行名」补，
  // 名字里不带当前值——旁边那格数值已经在播报，重复一遍反而啰嗦。
  const namesOf = () =>
    [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")).filter(Boolean);

  it("字号／行距／段距各两枚，名字是「减小/增大 + 行名」", () => {
    setup();
    for (const n of ["减小字号", "增大字号", "减小行距", "增大行距", "减小段距", "增大段距"]) {
      expect(screen.getByRole("button", { name: n })).toBeTruthy();
    }
  });

  it("自动阅读那两枚跟着当前档报名字：滚动说速度、翻页说间隔", () => {
    const view = setup({ readingMode: "scroll" });
    expect(screen.getByRole("button", { name: "减小滚动速度" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "增大滚动速度" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /翻页间隔/ })).toBeNull();
    view.rerender({ readingMode: "single" });
    expect(screen.getByRole("button", { name: "减小翻页间隔" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "增大翻页间隔" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /滚动速度/ })).toBeNull();
  });

  it("同一行的两枚方向不许写反，也不许同名", () => {
    setup({ readingMode: "scroll" });
    expect(minusOf("滚动速度")).toHaveAccessibleName("减小滚动速度");
    expect(plusOf("滚动速度")).toHaveAccessibleName("增大滚动速度");
    expect(minusOf("字号")).toHaveAccessibleName("减小字号");
    expect(plusOf("字号")).toHaveAccessibleName("增大字号");
    // 十个名字互不相同：同名按钮在窄面板里靠位置猜，等于没补
    const labelled = namesOf().filter((n) => /^(减小|增大)/.test(n ?? ""));
    expect(new Set(labelled).size).toBe(labelled.length);
    expect(labelled).toHaveLength(8);
  });
});

describe("ReadingToolbar · 外壳的 memo", () => {
  function withParent(get: (n: number) => Partial<Props>) {
    let bump: ((n: number) => void) | null = null;
    function Parent() {
      const [n, setN] = React.useState(0);
      bump = setN;
      return (
        <>
          <span data-testid="progress">{n}</span>
          <ReadingToolbar {...toolbarProps(get(n))} />
        </>
      );
    }
    render(<Parent />);
    return () => act(() => {
      (bump as (n: number) => void)(1);
    });
  }

  it("props 一个都没变时，父级重渲染不许把这一屏重画一遍", () => {
    const step = withParent(() => ({}));
    const before = rt.renders;
    expect(before).toBeGreaterThan(0);
    step();
    expect(screen.getByTestId("progress")).toHaveTextContent("1");
    expect(rt.renders, "摘掉 React.memo 这一条必红：整块跟着正文进度重画").toBe(before);
  });

  it("props 真变了就必须重画（memo 不许把更新一起挡掉）", () => {
    const step = withParent((n) => ({ fontSize: 18 + n }));
    const before = rt.renders;
    step();
    expect(rt.renders).toBeGreaterThan(before);
    expect(screen.getByText("19")).toBeInTheDocument();
  });
});
