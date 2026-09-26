/**
 * `ui/tabs` 的"自己那份契约"判据（地板第 1 档·薄壳档）。
 *
 * 这只壳 53 行、产品逻辑一行都没有，四只出口（`Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`）
 * 全是 shadcn 抄来的 Radix 包装。**唯一用它的文件是 `SummaryPanel.tsx:21`**，而它四只全取
 * （实测 grep：除本文件外无人 import）——所以这一档没有"顺手删掉的死出口"（跟前两档
 * `lib/storage` 的 `safeRemove`、`ui/scroll-area` 的 `ScrollBar` 不同）。
 *
 * 这里**不判 Radix 的行为**，只判这个文件替调用点做的五个决定，坏法全是"分析面板顶栏
 * 那一行悄悄不对了"：
 * 1) **`cn(默认, className)` 是合并，而且必须真走 tailwind-merge**：调用点五处 `TabsContent`
 *    挂 `m-0` 唯一的用途就是抵掉壳自带的 `mt-2`（面板在 ScrollArea 里，顶上多 8px 就是
 *    一条看不懂的缝）；五处 `TabsTrigger` 挂 `text-xs` 抵掉 `text-sm`。写成字符串拼接
 *    或 `clsx` 就两条都留着，谁生效改由 CSS 里的先后决定——同一次改版在真机上可能是
 *    "缝回来了"，也可能"字号又变回 text-sm"。所以合并那几条判据都用 `toks()` **按空格切成
 *    整 token 再比**，不用 `toContain`：`text-sm` 与 `text-xs` 只差一个字符，而
 *    `focus-visible:ring-2` 与 `focus-visible:ring-offset-2` 互为 substring，substring 判不稳。
 * 2) **`Tabs = TabsPrimitive.Root` 是整只别名**：Root 上一字默认类都不加，调用点那句
 *    `flex flex-col flex-1 min-h-0` 直接落在真正那只 div 上——它是整只面板的脊柱
 *    （上面 `shrink-0` 那行 tab 栏 + 下面 `flex-1` 的 ScrollArea 全靠它撑）。哪天"给它补个
 *    默认类"，症状是折叠不下去了，而界面看着还是那五格。
 * 3) **`{...props}` 透传，而且三只壳都靠它带 children**：`value` 走这一行（`className` 是
 *    具名解构掉的），摘掉之后五格全变成同一只无名 tab——`aria-controls`/`id` 的指认链一起断，
 *    点了也不换面板（实测 K9：Trigger 那一行摘掉红 8 条）。**List 那一行原本我以为是空转、
 *    准备写进"不判"，实测推翻了自己**：`children` 同样走它，摘掉直接让五格消失（K15 红 9 条）。
 * 4) **壳里不插层**：`tablist` 的直接孩子就得是各只 tab（Radix 的 RovingFocusGroup 走
 *    `asChild` 不落 DOM，实测 `[...list.children]` 全 BUTTON）。壳里包一层 `<div>` 就同时
 *    打断键盘漫游（方向键换格）与角色树，而鼠标点着还是好的。
 * 5) **受控**：`value` 是唯一真相——点另一格只把新值交回，面板不许自己跳（K16/K17 两把独立刀）。
 *
 * 两格量不到，写在明处（都是实测）：
 * - **"五个挤不挤得下、要不要横滚"jsdom 判不了**：没有布局，`flex-1`/`w-full`/
 *   `overflow-x-auto` 的最终宽高量不到。这一档只判"类有没有落到对的元素上"，后果由
 *   浏览器层 **G3** 判（`e2e/specs/g-narrow.spec.ts:125`：390px 下五格 tab 不滚就得都摸得到）。
 * - **非活动面板的元素其实还在**：实测 `role="tabpanel"` 有 5 只，其中 4 只带 `hidden` 且
 *   **里面一个字都没有**（Radix 的 `children: present && children`）。所以"切走的 Tab 不留内容"
 *   判的是 `data-testid` 的个数，不是 tabpanel 的个数——拿 tabpanel 计数判这条会恒红，
 *   而给 Content 补 `forceMount`（五份内容同时挂在滚动区里）恰好是唯一能咬住它的刀。
 *
 * 一条不算"壳的决定"、因此不判的：`activationMode` 默认 automatic 让聚焦与按下各回报一次
 * （实测点一下 `onValueChange` 收到两次同值）。壳里一个字都没动它，那是 Radix 的默认。
 *
 * **点这行的事件是 mousedown**：Radix 把激活挂在 `onMouseDown`（`index.mjs:121`），
 * 实测 `fireEvent.click` 打不动它、`userEvent.click` 能动（它按真用户顺序发
 * pointerdown→mousedown→mouseup→click）。用例一律走 `userEvent`。
 * 另一条实测：**点已经活动的那一格不会回报**（`useControllableState` 里有 `Object.is` 守卫），
 * 所以"回报新值"那格必须点不同的一格。
 *
 * **15 条判据、17 把刀，逐条读数记在文件末尾**（短号 J1..J15 指判据、K1..K17 指刀）。
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs";

/** 调用点原话（`SummaryPanel.tsx:341-428`）：五格全挂 `text-xs h-7 flex-1 whitespace-nowrap`。 */
const TABS = [
  ["qa", "问答"],
  ["chapter", "本章分析"],
  ["book", "全书分析"],
  ["notes", "笔记"],
  ["search", "搜索"],
] as const;

/** 照 SummaryPanel 的形状拼一只面板；`value` 是受控的调用方状态。 */
function panel(props: { value?: string; onValueChange?: (v: string) => void } = {}) {
  return render(
    <Tabs
      value={props.value ?? "qa"}
      onValueChange={props.onValueChange ?? (() => {})}
      className="flex flex-col flex-1 min-h-0"
    >
      <TabsList className="w-full overflow-x-auto flex-nowrap">
        {TABS.map(([v, label]) => (
          <TabsTrigger key={v} value={v} className="text-xs h-7 flex-1 whitespace-nowrap">
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {TABS.map(([v, label]) => (
        <TabsContent key={v} value={v} className="m-0">
          <div data-testid={`body-${v}`}>{label}</div>
        </TabsContent>
      ))}
    </Tabs>,
  );
}

/** 整 token 比，不用 substring（见文件头第 1 条）。 */
const toks = (el: Element) => new Set(el.className.trim().split(/\s+/));
const listOf = (c: HTMLElement) => c.querySelector('[role="tablist"]')!;
const tabsOf = (c: HTMLElement) => [...c.querySelectorAll('[role="tab"]')];
const activePanelOf = (c: HTMLElement) => c.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"]')!;
const tabAt = (c: HTMLElement, v: string) => tabsOf(c).find((t) => t.id.endsWith(`-trigger-${v}`))!;

describe("ui/tabs：装配出来该有的指认关系", () => {
  it("每格 tab 的 aria-controls 指的到面板，面板的 aria-labelledby 又指回它（双向都对得上号）", () => {
    const { container } = panel();
    const tabs = tabsOf(container);
    expect(tabs.length).toBe(5);
    for (const t of tabs) {
      const controls = t.getAttribute("aria-controls")!;
      // 用属性选择器而不是 `#id`：Radix 的 id 里带 `_r_0_` 这类字符，jsdom 的 CSS.escape 不可靠
      const target = container.querySelector<HTMLElement>(`[id="${controls}"]`);
      expect(target, `前置：aria-controls=${controls} 指的节点要在`).toBeTruthy();
      expect(target!.getAttribute("role")).toBe("tabpanel");
      expect(target!.getAttribute("aria-labelledby")).toBe(t.id);
    }
  });

  it("活动的那一格只有一只：aria-selected 与 data-state 两处一起指同一个 value", () => {
    const { container } = panel({ value: "notes" });
    const on = tabsOf(container).filter((t) => t.getAttribute("data-state") === "active");
    expect(on.length).toBe(1);
    expect(on[0].getAttribute("aria-selected")).toBe("true");
    expect(tabAt(container, "notes")).toBe(on[0]);
    expect(tabsOf(container).filter((t) => t.getAttribute("aria-selected") === "true").length).toBe(1);
    expect(activePanelOf(container)).toHaveTextContent("笔记");
  });

  it("value 是唯一真相：点另一格只把新值交回调用方，面板不许自己跳", async () => {
    const seen: string[] = [];
    const { container } = panel({ onValueChange: (v) => seen.push(v) });
    await userEvent.click(tabAt(container, "book"));
    // 实测回报两次：Radix 默认 activationMode="automatic"，聚焦那一跳（onFocus）与按下那一跳
    // （onMouseDown）各报一次。那是 Radix 的账不是这只壳的，所以这里判"报的是哪个值"，不判次数。
    expect(seen.length, "前置：那一下真回报了").toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["book"]));
    // value 还在 "qa"：面板必须仍是问答那一格（受控；跳了就是壳里偷装了内部状态）
    expect(container.querySelectorAll("[data-testid]").length).toBe(1);
    expect(activePanelOf(container)).toHaveTextContent("问答");
  });

  it("调用方把 value 换掉，tab 与面板两处一起跟着变（两个相反的值都取样）", () => {
    const { container, unmount } = panel({ value: "qa" });
    expect(activePanelOf(container)).toHaveTextContent("问答");
    expect(tabAt(container, "qa").getAttribute("data-state")).toBe("active");
    unmount();
    const other = panel({ value: "book" });
    expect(activePanelOf(other.container)).toHaveTextContent("全书分析");
    expect(tabAt(other.container, "book").getAttribute("data-state")).toBe("active");
    expect(tabAt(other.container, "qa").getAttribute("data-state")).toBe("inactive");
  });

  it("切走的 Tab 一个字都不留在 DOM 里（五份内容同时挂着会撑破那只 ScrollArea）", () => {
    const { container } = panel({ value: "chapter" });
    expect(container.querySelectorAll("[data-testid]").length).toBe(1);
    expect(activePanelOf(container)).toHaveTextContent("本章分析");
    // 实测的形状：另外四只面板元素还在（带 hidden）但里面是空的——所以判的是内容个数
    const off = [...container.querySelectorAll('[role="tabpanel"]')].filter((p) => p.getAttribute("data-state") === "inactive");
    expect(off.length).toBe(4);
    expect(off.every((p) => p.hasAttribute("hidden"))).toBe(true);
    expect(off.reduce((n, p) => n + p.childElementCount, 0)).toBe(0);
  });
});

describe("ui/tabs：className 是合并不是顶掉（而且必须真走 tailwind-merge）", () => {
  it("TabsList：调用点那三条追加进来，壳自带的八条一条不少（这里没有同族冲突）", () => {
    const { container } = panel();
    const cls = toks(listOf(container));
    for (const c of ["w-full", "overflow-x-auto", "flex-nowrap"]) expect(cls.has(c), `调用点的 ${c} 要在`).toBe(true);
    for (const c of [
      "inline-flex",
      "h-10",
      "items-center",
      "justify-center",
      "rounded-md",
      "bg-muted",
      "p-1",
      "text-muted-foreground",
    ]) {
      expect(cls.has(c), `不冲突的默认类 ${c} 不许丢`).toBe(true);
    }
  });

  it("TabsTrigger：text-xs 真把 text-sm 顶掉了，h-7/flex-1 追加，焦点环与 active 那三条还在", () => {
    const { container } = panel();
    const cls = toks(tabAt(container, "qa"));
    expect(cls.has("text-xs")).toBe(true);
    expect(cls.has("text-sm")).toBe(false);
    expect(cls.has("h-7")).toBe(true);
    expect(cls.has("flex-1")).toBe(true);
    // 调用点重复给了 whitespace-nowrap：合并要去重，同族只留最后一份
    expect([...tabAt(container, "qa").className.split(/\s+/)].filter((c) => c === "whitespace-nowrap").length).toBe(1);
    for (const c of [
      "px-3",
      "py-1.5",
      "font-medium",
      "ring-offset-background",
      "focus-visible:ring-2",
      "disabled:opacity-50",
      "data-[state=active]:shadow-sm",
    ]) {
      expect(cls.has(c), `不冲突的默认类 ${c} 不许丢`).toBe(true);
    }
  });

  it("TabsContent：m-0 真把自带的 mt-2 消掉了（这条就是调用点五处 m-0 唯一的落点）", () => {
    const { container } = panel();
    const cls = toks(activePanelOf(container));
    expect(cls.has("m-0")).toBe(true);
    expect(cls.has("mt-2")).toBe(false);
    for (const c of ["ring-offset-background", "focus-visible:outline-none", "focus-visible:ring-2", "focus-visible:ring-offset-2"]) {
      expect(cls.has(c), `不冲突的默认类 ${c} 不许丢`).toBe(true);
    }
  });

  it("调用点什么都不给时，壳自带的默认类一字不少（反向取样：合并不能实现成只留调用点的）", () => {
    const { container } = render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">甲</TabsTrigger>
        </TabsList>
        <TabsContent value="a">内容</TabsContent>
      </Tabs>,
    );
    expect([...container.querySelectorAll("[class]")].length, "前置：三只有默认类的元素都渲染出来了").toBeGreaterThanOrEqual(3);
    const list = toks(listOf(container));
    expect(list.has("h-10") && list.has("bg-muted") && list.has("p-1")).toBe(true);
    const trig = toks(tabAt(container, "a"));
    expect(trig.has("text-sm") && trig.has("px-3") && trig.has("whitespace-nowrap")).toBe(true);
    const cont = toks(activePanelOf(container));
    expect(cont.has("mt-2")).toBe(true);
    // 不许把 undefined / null 漏进 class 属性里
    for (const el of [listOf(container), tabAt(container, "a"), activePanelOf(container)]) {
      expect(el.className).not.toMatch(/undefined|null/);
    }
  });

  it("Root 那只 div 一字不加默认类：调用点那句 flex flex-col flex-1 min-h-0 原样落在它身上", () => {
    const { container, unmount } = panel();
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe("DIV");
    expect(toks(root)).toEqual(new Set(["flex", "flex-col", "flex-1", "min-h-0"]));
    expect(root.dataset.orientation).toBe("horizontal");
    unmount();
    const bare = render(
      <Tabs defaultValue="a">
        <TabsList><TabsTrigger value="a">甲</TabsTrigger></TabsList>
      </Tabs>,
    );
    // Tabs 是 TabsPrimitive.Root 的直接别名：不传就不该长出任何东西
    expect((bare.container.firstElementChild as HTMLElement).className).toBe("");
  });
});

describe("ui/tabs：value 走 {...props}、ref 转交、壳里不插层", () => {
  it("五格各自的 value 真到了 Radix 手里：id 各带自己的 value 且互不相同", () => {
    const { container } = panel();
    const ids = tabsOf(container).map((t) => t.id);
    expect(new Set(ids).size).toBe(5);
    TABS.forEach(([v]) => expect(ids.some((id) => id.endsWith(`-trigger-${v}`)), `value=${v} 要落在 id 上`).toBe(true));
    const panelIds = [...container.querySelectorAll('[role="tabpanel"]')].map((p) => p.id);
    expect(new Set(panelIds).size).toBe(5);
    TABS.forEach(([v]) => expect(panelIds.some((id) => id.endsWith(`-content-${v}`))).toBe(true));
  });

  it("tablist 的直接孩子就是那五格（壳里包一层会同时打断键盘漫游与角色树）", () => {
    const { container } = panel();
    const kids = [...listOf(container).children];
    expect(kids.length).toBe(5);
    expect(kids.map((k) => k.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON", "BUTTON", "BUTTON"]);
    expect(kids.every((k) => k.getAttribute("role") === "tab")).toBe(true);
  });

  it("面板里直接就是调用点给的那只 div，壳没在中间垫东西", () => {
    const { container } = panel();
    const first = activePanelOf(container).firstElementChild as HTMLElement;
    expect(first.getAttribute("data-testid")).toBe("body-qa");
  });

  it("三只 forwardRef 都转交（对象式与函数式）：拿到的就是那只带角色的元素", () => {
    // 本仓当前没人给这三只挂 ref；这一条判的是壳的对外契约（导出的类型面写着 ComponentRef），
    // 悄悄改成普通函数组件的话，下一只消费它的界面才会发现节点是 null。
    const refs = {
      list: React.createRef<HTMLDivElement>(),
      trig: React.createRef<HTMLButtonElement>(),
      cont: React.createRef<HTMLDivElement>(),
    };
    const obj = render(
      <Tabs defaultValue="a">
        <TabsList ref={refs.list}>
          <TabsTrigger value="a" ref={refs.trig}>
            甲
          </TabsTrigger>
        </TabsList>
        <TabsContent value="a" ref={refs.cont}>
          内容
        </TabsContent>
      </Tabs>,
    );
    expect(refs.list.current).toBe(listOf(obj.container));
    expect(refs.trig.current).toBe(tabAt(obj.container, "a"));
    expect(refs.cont.current).toBe(activePanelOf(obj.container));
    obj.unmount();

    const fn: Record<string, Element | null> = { list: null, trig: null, cont: null };
    const got = render(
      <Tabs defaultValue="b">
        <TabsList
          ref={(n) => {
            fn.list = n;
          }}
        >
          <TabsTrigger
            value="b"
            ref={(n) => {
              fn.trig = n;
            }}
          >
            乙
          </TabsTrigger>
        </TabsList>
        <TabsContent
          value="b"
          ref={(n) => {
            fn.cont = n;
          }}
        >
          内容2
        </TabsContent>
      </Tabs>,
    );
    // 对象式与函数式是两条分开写的路，只转一边另一边静默失灵
    expect(fn.list).toBe(listOf(got.container));
    expect(fn.trig).toBe(tabAt(got.container, "b"));
    expect((fn.trig as HTMLElement).textContent).toBe("乙");
    expect(fn.cont).toBe(activePanelOf(got.container));
  });

  it("三只的 displayName 跟着 Radix 走（报错栈与 DevTools 里认得出是谁）", () => {
    // 低配一条：这三行坏了不影响界面，只影响"读栈时看不出来是哪只壳"。
    // 判它是因为它是这个文件里唯一没有任何可观察后果、却最容易被"精简"掉的三行。
    expect(TabsList.displayName).toBe(TabsPrimitive.TabsList.displayName);
    expect(TabsTrigger.displayName).toBe(TabsPrimitive.TabsTrigger.displayName);
    expect(TabsContent.displayName).toBe(TabsPrimitive.TabsContent.displayName);
    expect(TabsList.displayName).toBe("TabsList");
  });
});

/**
 * 判别力台账（2026-09-27 本机，`npx vitest run src/components/ui/__tests__/tabs-shell.test.tsx`）。
 * 基线：`src/components/ui/tabs.tsx` = sha256 `c7f8c732…`（1882 字节），**产品代码一行没动**：
 * 17 刀每刀之后 `cp` 回基线并 `cmp` + 重核 sha，全部回到同一个值。
 * 判据短号按文件里的书写顺序 J1..J15；**没有一刀 0 红**。
 *
 *  K1 List 的 `cn(默认, className)` 写成 `className ?? 默认` → **1 红**（J6）
 *  K2 Trigger 同样写法 → **1 红**（J7）
 *  K3 Content 的 `cn(...)` 换成模板串裸拼接 → **1 红**（J8）
 *     ★这条才是"必须真走 tailwind-merge"的独立证据：裸拼接让 `mt-2` 与 `m-0` 同时留着。
 *  K4 Content 摘掉自带那串默认类（`cn(className)`）→ **2 红**（J9 目标；J8 连带——
 *     同一行既管"顶掉同族"也管"不冲突的还在"，一句判据两头都要）
 *  K5 `const Tabs = TabsPrimitive.Root` 换成带 `relative overflow-hidden` 的壳 → **1 红**（J10）
 *  K6 Content 加 `forceMount` → **2 红**（J5 目标；J3 连带，它数的是同一批 data-testid）
 *  K7 List 里给 children 插一层 `<div>` → **1 红**（J12）
 *  K8 Content 里给 children 插一层 `<div>` → **1 红**（J13）
 *  K9 Trigger 摘掉 `{...props}` → **8 红**（J11 是目标，其余 7 条是连带：`value` 一丢，
 *     `tabAt()` 直接取不到节点，红里大半是 TypeError 而不是断言。）
 *  K10 Content 摘掉 `{...props}` → **10 红**（同一条路的另一处，连带为主）
 *  K11/K12/K13 分别摘掉 List / Content / Trigger 的 `ref={ref}` → **各 1 红**（J14，
 *     三只各下一刀，红在同一条判据的三段不同断言上）
 *  K14 List 的 `displayName` 改成 `"X"` → **1 红**（J15）。Trigger/Content 那两行是同一条路的
 *     另两处，未各下一刀（前三条断言两侧同时变 undefined 会假绿，所以判据自己补了
 *     `toBe("TabsList")` 这一条绝对值——刀能咬住靠的就是它）。
 *  K15 **List 摘掉 `{...props}` → 9 红**（这一把推翻了我写在文件头上的原判断：我按
 *     "调用点只给 className"推断那行是空转、准备列入"不判"；实测 `children` 也走它，
 *     摘掉之后五格直接不存在。台账里留着这条，是因为"我以为判不到的格子其实判得到"
 *     比"这刀红了几条"更值得记。）
 *  K16 Root 吃掉 `onValueChange`（转发时写死 undefined）→ **1 红**（J3 的回报半，独立刀）
 *  K17 Root 不吃 `value`（改成内部 `defaultValue="qa"` 的半受控）→ **4 红**（J3+J4 目标，
 *     J2/J5 连带）
 *
 * 没有自己独立刀的三条：J1、J2 与 J4 的"tab 那半"。它们与 K9/K10/K17 共用同一条
 * `{...props}`／`value` 的路，红里都是连带——写在明处，不当已单独验收。
 */
