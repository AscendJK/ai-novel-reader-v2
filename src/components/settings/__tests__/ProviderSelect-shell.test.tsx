/**
 * settings/ProviderSelect — 设置页那只「API 提供商」下拉首次有直接判据
 *
 * 它是"用哪份配置去发请求"的唯一出口：列出来的是**配好密钥的那些**，选中的那个 id
 * 直接写进 store，之后所有 AI 调用都按它取。`ui/select` 与 `ui/label` 的自家契约已由
 * `select-label.test.tsx` 判过，这里只判这一层做的四个决定：
 * 1. **只列配好 key 的**（`p.apiKey` 过滤）——没密钥的那条选了也发不出去，出现在列表里
 *    就是给读者一个注定失败的选项；
 * 2. **一行报三件事**：名字（空名兜底成「未命名」）、协议徽章、模型；
 * 3. **框里回显的就是当前 `activeProviderId` 那一条**，且它跟着 store 变；
 * 4. **出口只有一个**：点一条就是把那条的 id 交给 `setActiveProvider`。
 *
 * 有意不判的格子（写了理由，不是漏）：
 * - 徽章那一支写的是 `format === "anthropic" ? "Anthropic" : "OpenAI"`：**未知协议也报
 *   "OpenAI"**。这是现状（`registry.ts` 那边同样是"不是 anthropic 就走 openai 腿"），
 *   两边一致，所以这里钉现状、不逼它改文案；真要加第三种协议，改这里就会红。
 * - 列表的裁切、popper 定位、能不能滚到最后一项：归浏览器层（`select-label.test.tsx`
 *   头部也记着"这只组件在 e2e 一条都没有"）。
 * - 没有 `disabled`、没有"当前选中项打勾"的自定义样式：这一层没写，无从判起。
 * - 徽章的 `variant`（配色档位）：PS13 换档 0 红，是有意的——颜色归 `ui/badge` 自己与浏览器层，
 *   这一层只判徽章上那几个字（PS4 在判）。
 * - `value={activeProviderId || undefined}` 里那个 `|| undefined`：**判不到**（PS6 与加强后的
 *   PS6c 都 0 红，实测两种写法形状完全同形），归浏览器层；同一格的其它写法有牙——PS7 把受控值
 *   写死就红 3 条，PS12 摘掉 placeholder 红 2 条。
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const { state } = vi.hoisted(() => ({
  state: {
    providers: [] as Array<{ id: string; name: string; apiKey: string; model: string; format: string }>,
    activeProviderId: "",
    setActiveProvider: vi.fn(),
  },
}));

vi.mock("@/stores/api-store", () => ({
  // 组件用三个选择器各拿一格，所以 mock 必须真的把选择器叫一遍（写成返回整只 state 会让
  // "选择器取错字段"这种改法照样绿）
  useAPIStore: (sel: (s: typeof state) => unknown) => sel(state),
}));

import { ProviderSelect } from "../ProviderSelect";

const ALPHA = { id: "p-alpha", name: "自家 411", apiKey: "sk-1", model: "deepseek-v3", format: "openai" };
const BETA = { id: "p-beta", name: "中转 Claude", apiKey: "sk-2", model: "claude-sonnet", format: "anthropic" };
const NOKEY = { id: "p-nokey", name: "还没配的", apiKey: "", model: "gpt-4o", format: "openai" };
const NONAME = { id: "p-noname", name: "", apiKey: "sk-3", model: "glm-4", format: "openai" };

beforeAll(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.releasePointerCapture = (id: number) => id;
  proto.hasPointerCapture = () => false;
});

beforeEach(() => {
  cleanup();
  state.providers = [ALPHA, BETA, NOKEY];
  state.activeProviderId = ALPHA.id;
  state.setActiveProvider = vi.fn();
});

/** 把列表打开：这只组件不给 `open`，只能按真人的路子点触发器 */
function openList() {
  fireEvent.click(screen.getByRole("combobox"));
  const listbox = screen.queryByRole("listbox");
  if (!listbox) throw new Error("前提破了：列表没在 jsdom 里开起来（不是产品的错，是夹具没接上）");
  return listbox;
}

/** 某一行的文字（一行的三个格子在同一个 role=option 里） */
function optionText(name: string | RegExp): string {
  return String(screen.getByRole("option", { name }).textContent);
}

describe("列表里有什么", () => {
  it("配好密钥的才上架：没配 key 的那条连名字都不许出现", () => {
    render(<ProviderSelect />);
    openList();
    expect(screen.getAllByRole("option").map((o) => o.textContent?.trim())).toHaveLength(2);
    expect(document.body.textContent).not.toContain("还没配的");
  });

  it("一行的三件事各在其位：名字、协议徽章、模型", () => {
    render(<ProviderSelect />);
    openList();
    const alpha = optionText(/自家 411/);
    expect(alpha).toContain("自家 411");
    expect(alpha).toContain("OpenAI");
    expect(alpha).toContain("(deepseek-v3)");
  });

  it("协议只有两说：anthropic 报 Anthropic，其余报 OpenAI（未知协议也报 OpenAI 是现状）", () => {
    state.providers = [BETA, { ...ALPHA, id: "p-x", format: "what-is-this" }];
    render(<ProviderSelect />);
    openList();
    expect(optionText(/中转 Claude/)).toContain("Anthropic");
    expect(optionText(/自家 411/)).toContain("OpenAI");
  });

  it("名字空着不许真给一个空选项——兜底成「未命名」", () => {
    state.providers = [NONAME];
    render(<ProviderSelect />);
    openList();
    expect(optionText(/未命名/)).toContain("未命名");
    expect(optionText(/未命名/)).toContain("(glm-4)");
  });

  it("顺序照 store 给的原样排（用户在设置页排的顺序就是这里的顺序）", () => {
    state.providers = [BETA, ALPHA];
    render(<ProviderSelect />);
    openList();
    const texts = screen.getAllByRole("option").map((o) => String(o.textContent).trim());
    expect(texts[0]).toContain("中转 Claude");
    expect(texts[1]).toContain("自家 411");
  });

  it("一条都没配好：不崩、列表空着、框里仍是那句提示", () => {
    state.providers = [NOKEY];
    state.activeProviderId = "";
    render(<ProviderSelect />);
    // 开列表之前先把触发器拿到手：Radix  modal 一开就给触发器那棵子树挂 aria-hidden，
    // 之后再按 role 取就取不到了（这是 Radix 的形状，不是产品坏了）
    const box = screen.getByRole("combobox");
    expect(box.textContent).toContain("选择 API 提供商");
    openList();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(box.textContent).toContain("选择 API 提供商");
  });
});

describe("选中的那一格", () => {
  it("框里回显的就是 activeProviderId 那一条（名字与模型都在）", () => {
    render(<ProviderSelect />);
    const box = screen.getByRole("combobox");
    expect(box.textContent).toContain("自家 411");
    expect(box.textContent).toContain("deepseek-v3");
    expect(box.textContent).not.toContain("中转 Claude");
  });

  it("store 换人之后框里跟着换（不是一次性快照）", () => {
    const { rerender } = render(<ProviderSelect />);
    state.activeProviderId = BETA.id;
    rerender(<ProviderSelect />);
    expect(screen.getByRole("combobox").textContent).toContain("中转 Claude");
  });

  it("没选过（id 是空串）时显示的是那句提示，而不是一个空框", () => {
    state.activeProviderId = "";
    render(<ProviderSelect />);
    const box = screen.getByRole("combobox");
    expect(box.textContent).toContain("选择 API 提供商");
    // 加这一格是因为 PS6 那记刀 0 红：只判正文的话，`value=""` 与 `value={undefined}`
    // 在这一版 Radix 的 jsdom 输出完全一样（实测 TEXT/data-placeholder 两处同形）。
    // 带占位这个状态时 `data-placeholder` 挂在触发器上，而选中某条时它变成空值属性
    // （`data-placeholder=""` 仍在）——所以"有没有这个属性"整族同形，判不出写死与受控。
    // 实测三条路（没选 / 选中 / 选中但那条没配 key）都是同一形状，这一格只能留给浏览器层。
    expect(box.hasAttribute("data-placeholder")).toBe(true);
  });

  it("当前选中的那条已经不在列表里（密钥被清掉）：不崩，列表里不许有它", () => {
    state.providers = [ALPHA, { ...BETA, apiKey: "" }];
    state.activeProviderId = BETA.id;
    render(<ProviderSelect />);
    openList();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toHaveLength(1);
    expect(screen.queryByRole("option", { name: /中转 Claude/ })).toBeNull();
  });
});

describe("出口与标签", () => {
  it("点一条＝把那条的 id 交给 setActiveProvider（不是名字、不是下标）", () => {
    render(<ProviderSelect />);
    openList();
    fireEvent.click(screen.getByRole("option", { name: /中转 Claude/ }));
    expect(state.setActiveProvider).toHaveBeenCalledTimes(1);
    expect(state.setActiveProvider).toHaveBeenCalledWith("p-beta");
  });

  it("标签与控件对得上号：点标签聚焦得到，读屏也叫得出这枚下拉的名字", () => {
    render(<ProviderSelect />);
    const label = screen.getByText("API 提供商");
    const box = screen.getByRole("combobox", { name: "API 提供商" });
    expect(label).toHaveAttribute("for", "active-provider");
    expect(label.getAttribute("for")).toBe(box.getAttribute("id"));
  });
});

// ── 变异台账（还原法：字节基线 sha256=25f23056… / 1467 B，一刀一跑一还原）───────────────
//
// 13 把刀：11 把至少打红一条，两把 0 红——一把是**真等价变异**（PS6/PS6c），一把是
// **有意不判的格子**（PS13，文件头部写着）。12 条用例每一条都被至少一刀指名打红过。
// 每轮 markers=1（对照 0）、transform_failed=0、markers_left=0、diff_lines=0、sha 回到基线。
// 跑法 %TEMP%\knife-pselect.sh。`greens` 那一列别当读数用——vitest 只给慢用例打时间行，
// 逐行数会少报，条数一律看 `sum[...]`。
//
// PS1  不过滤（没配 key 的也上架）    3 红：才上架 / 一条都没配好 / 选中的那条已没配 key
// PS2  过滤条件写反（只列没配的）     10 红：整面塌，只剩两条与"配没配 key"无关的标签/出口判据
// PS3  空名不兜底                     1 红：兜底成「未命名」
// PS4  协议两说对调                   2 红：一行的三件事 / 协议只有两说
// PS5  不报模型                       3 红：一行的三件事 / 未命名那条 / 框里回显
// PS6→PS6c `|| undefined` 摘掉        **0 红＝真等价变异**（写了判据也没牙）
//      第一版只判正文 → 0 红；加强成"触发器带 data-placeholder"再打 → 仍 0 红。
//      三条对照实测（没选 / 选中 / 选中但那条没配 key）在 `value=""` 与 `value={undefined}`
//      两种写法下**形状完全一样**（正文与 data-placeholder 两处同形，Radix 也不报警），
//      所以这一格在 jsdom 判不到，归浏览器层。对照是 PS12（摘掉 placeholder）红 2 条——
//      证明"正文那句提示"本身有牙，没牙的是"空串要不要归一成 undefined"这一格。
// PS7  受控值写死成第一条             3 红：一条都没配好 / store 换人跟着换 / 没选过显示提示
//      （PS6 那次"加强判据"没咬到的东西，这一记校准刀证明同一格别的写法确实咬得到——
//       所以 PS6 的 0 红是等价变异，不是判据坏。这条对照是这一笔最值钱的一笔。）
// PS8  出口没接上 store               1 红：点一条交 id
// PS9  交名字不交 id                  1 红：同一条（两把刀打同一格，各自算数）
// PS10 标签指错 id                    1 红：标签与控件对得上号（可访问名与 for↔id 两处同红）
// PS11 顺序倒过来排                   1 红：顺序照 store
// PS12 摘掉 placeholder               2 红：没选过显示提示 / 一条都没配好
// PS13 Badge 换配色                   0 红＝**有意不判**：颜色档位归 ui/badge 自己与浏览器层，
//      这一层只判徽章上那几个字（PS4 已经在判）。
