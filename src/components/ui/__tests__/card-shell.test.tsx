/**
 * `ui/card` 的"自己那份契约"判据（地板第 1 档·薄壳档）。
 *
 * 全仓用得最多的一只壳：**14 个文件 import 它**（书架、登录、设置页三张、地图详情、
 * 笔记、问答、搜索、MiniCard、NovelBuildWindow、StorageManager……），壳本身 51 行、
 * 产品逻辑一行没有。所以这一档判的不是"某个界面"，而是**这 14 处共同踩着的那几块板**：
 *
 * 1) **六只出口渲染成什么元素**：`Card`/`CardHeader`/`CardContent` 是 div、`CardTitle` 是
 *    **h3**、`CardDescription` 是 p。改标签界面看着一模一样，塌掉的是读屏的标题导航与大纲
 *    （书架每张卡的标题都是 h3，页头是 h1/h2——层级是这只壳替全站定的）。
 * 2) **`cn` 合并、且必须真走 tailwind-merge**：状态色全靠调用点往 `Card` 上叠一条边框色
 *    （`border-primary`＝当前 API 提供商、`border-destructive`/`border-amber-500`＝书架那两条
 *    提示、`border-2 border-dashed`＋颜色＝拖放区）。`border`（宽度）与 `border-primary`
 *    （颜色）**不同族**，两条都得留；写成裸拼接或 `className ?? 默认` 的坏法是"要么线没了、
 *    要么颜色没换"，而卡片看着还是一张卡。
 * 3) **`{...props}` 透传**：`onClick`（整张卡是按钮：NovelCard 点开、ApiSettings 选提供商、
 *    BookSelect 的 onDragOver/onDrop）与 `data-testid`（PlaceDetail 那条浏览器判据的锚点）
 *    全走这一行。
 * 4) **壳里不插层**：`Card` 与四只子件都是 `/>` 自闭合，children 直接落进来；插一层 div 就会
 *    打断 `space-y-*`（Header 的 `space-y-1.5` 与调用点的 `space-y-4`）——症状是"标题与副标题
 *    挤在一起"，而结构没坏、看不出是谁的责任。
 * 5) **导出口正好五只**：`CardFooter` 全仓零取用（实测 grep：`<CardFooter` 0 处、import 0 处），
 *    本笔删掉；这条判据反过来把这次删除钉住——谁接回来就红。
 *
 * 三格量不到/不判，写在明处（都是实测）：
 * - **间距的真后果 jsdom 量不到**：`p-6` 与调用点的 `py-4`/`pb-2` 会**同时留在 class 里**
 *   （实测 `cn("p-6 pt-0","py-4")` → `["p-6","py-4"]`，而 `pt-0` 被拿掉），最终谁生效由
 *   Tailwind 生成表的先后决定，那是 CSS 层的事实、不是这只壳的。所以这一档只判
 *   "合并之后 token 集合是什么"，卡片内边距的像素后果归浏览器层。
 * - **`CardTitle` 上 `text-base`/`text-lg` 会连 `leading-none` 一起拿掉**：tailwind-merge 把
 *   font-size 与 line-height 算同一族（`ui/select` 那批记过同一件事）。判据按实测把
 *   `leading-none` 断成"不在"，**这不是缺陷也不是我们要保的效果**，别把它读成"标题行高可丢"。
 * - **`CardDescription` 的覆盖分支不判**：14 处调用点里它一次都没被传过 `className`
 *   （实测），只判"渲染成 p + 默认两条在"。给它写一条 `text-xs` 覆盖判据就是造一条走不到的分支。
 *
 * **一处上游笔误已修（2026-09-27，制作人点头那一批发下来的第三件）**：`CardTitle` 原先声明成
 * `forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>`——ref 的元素类型写着
 * paragraph，渲染的却是 h3，现已改成 `HTMLHeadingElement`。但要如实记一笔：**这一改动本身判不到**。
 * lib.dom 里 `HTMLHeadingElement` 与 `HTMLParagraphElement` 结构完全同形（都只比 `HTMLElement` 多一个
 * `align`），互相可赋值，所以把类型参数退回去（刀 K2）之后 `vitest` 14 条全绿、`npm run typecheck`
 * 也是退出 0——两道闸门没有一格能分辨改前改后。改它是因为**声明写着什么**就是这只壳的对外契约，
 * 不是因为它有症状（全仓此前没给这只标题挂过 ref，症状为零）。有症状、也有刀的那一半是
 * "h3 上到底转不转交 ref"（判据 J14／刀 K1）。
 *
 * **14 条判据、16 把刀，逐条读数记在文件末尾**（短号 J1..J14 / C1..C14 / K1..K2）。
 */

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import * as React from "react";

import * as cardModule from "../card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../card";

/** 整 token 比，不用 substring（`border` 是 `border-primary` 的前缀、`p-6` 与 `py-6` 只差一个字符）。 */
const toks = (el: Element) => new Set(el.className.trim().split(/\s+/).filter(Boolean));

/** 一张书架卡：调用点原话（`NovelCard.tsx:54-69`）。 */
function shelfCard(props: Record<string, unknown> = {}) {
  return render(
    <Card data-testid="card" className="cursor-pointer transition-all hover:shadow-md hover:border-primary/50 group relative" {...props}>
      <CardHeader>
        <CardTitle>第二章 出城</CardTitle>
        <CardDescription>3.2 万字 · 已读完 40%</CardDescription>
      </CardHeader>
      <CardContent className="p-5">
        <div data-testid="row">正文那一行的预览</div>
      </CardContent>
    </Card>,
  );
}

describe("ui/card：五只出口渲染成什么元素", () => {
  it("外壳三只都是 div，标题是 h3，描述是 p（换掉标签界面看不出来，塌的是大纲）", () => {
    const { getByText, getByTestId } = shelfCard();
    const card = getByTestId("card");
    expect(card.tagName).toBe("DIV");
    expect(card.children[0].tagName).toBe("DIV");
    expect(card.children[1].tagName).toBe("DIV");
    expect(getByText("第二章 出城").tagName).toBe("H3");
    expect(getByText("3.2 万字 · 已读完 40%").tagName).toBe("P");
  });

  it("卡片标题在读屏里是真标题、层级 3（书架/设置页每一张都靠它导航）", () => {
    const { getByRole } = shelfCard();
    const title = getByRole("heading", { level: 3, name: "第二章 出城" });
    expect(title).toBeTruthy();
  });

  it("children 直接落在壳里，中间没有多出来的一层（space-y 是按直接孩子算的）", () => {
    const { getByTestId } = shelfCard();
    const card = getByTestId("card");
    expect([...card.children].map((c) => c.tagName)).toEqual(["DIV", "DIV"]);
    const header = card.children[0];
    const content = card.children[1];
    expect(header.contains(getByTestId("row"))).toBe(false);
    expect(content.firstElementChild).toBe(getByTestId("row"));
    // Header 的 space-y-1.5 是按"直接孩子"算的：壳里垫一层 div，标题与副标题就挤成一坨
    expect([...header.children].map((c) => c.tagName)).toEqual(["H3", "P"]);
    expect([...content.children].map((c) => c.getAttribute("data-testid"))).toEqual(["row"]);
  });
});

describe("ui/card：className 是合并，而且必须真走 tailwind-merge", () => {
  it("状态色卡：调用点那条 border-primary 与壳的 border 是不同族，两条都得留（线还在、颜色换了）", () => {
    const { container } = render(
      <Card className="cursor-pointer transition-colors hover:bg-accent/50 border-primary" data-testid="api">
        提供商
      </Card>,
    );
    const cls = toks(container.firstElementChild as HTMLElement);
    expect(cls.has("border")).toBe(true);
    expect(cls.has("border-primary")).toBe(true);
    for (const c of ["rounded-lg", "bg-card", "text-card-foreground", "shadow-sm"]) {
      expect(cls.has(c), `不冲突的默认类 ${c} 不许丢`).toBe(true);
    }
  });

  it("拖放区：border-2 顶掉壳那条 border、bg-primary/5 顶掉 bg-card（同族各让一次），圆角与阴影不动", () => {
    // 调用点原话（BookSelect.tsx:555-557 拖拽那一支）：整张卡既要加粗虚线框、又要染上主色。
    const { container } = render(
      <Card className="border-2 border-dashed transition-colors cursor-pointer border-primary bg-primary/5">拖这里</Card>,
    );
    const cls = toks(container.firstElementChild as HTMLElement);
    expect(cls.has("border")).toBe(false);
    expect(cls.has("bg-card")).toBe(false);
    for (const c of ["border-2", "border-dashed", "border-primary", "bg-primary/5"]) {
      expect(cls.has(c), `调用点的 ${c} 要在`).toBe(true);
    }
    for (const c of ["rounded-lg", "shadow-sm", "text-card-foreground"]) {
      expect(cls.has(c), `不冲突的默认类 ${c} 不许丢`).toBe(true);
    }
  });

  it("CardTitle：调用点给的 text-lg/text-base 顶掉 text-2xl，font-semibold/tracking-tight 留下", () => {
    // PlaceDetail.tsx:67 用 text-lg，ApiSettings.tsx:90/147 用 text-base——两处各取一次。
    for (const size of ["text-lg", "text-base"]) {
      const { container, unmount } = render(<CardTitle className={size}>地点名</CardTitle>);
      const cls = toks(container.firstElementChild as HTMLElement);
      expect(cls.has(size)).toBe(true);
      expect(cls.has("text-2xl")).toBe(false);
      // 实测：tailwind-merge 把 font-size 与 line-height 算同一族，leading-none 被一并带走。
      // 这不是我们要保的效果，也不是缺陷——按现状断，别再读成"标题行高可丢"。
      expect(cls.has("leading-none")).toBe(false);
      expect(cls.has("font-semibold") && cls.has("tracking-tight")).toBe(true);
      unmount();
    }
  });

  it("CardContent：p-5 把整条 p-6 与 pt-0 都顶掉；py-4 只顶掉 pt-0，拿不走 p-6（两个相反的值各取样）", () => {
    const p5 = render(<CardContent className="p-5">甲</CardContent>);
    const a = toks(p5.container.firstElementChild as HTMLElement);
    expect(a.has("p-5")).toBe(true);
    expect(a.has("p-6") || a.has("pt-0")).toBe(false);
    p5.unmount();

    const py4 = render(<CardContent className="py-4 space-y-2">乙</CardContent>);
    const b = toks(py4.container.firstElementChild as HTMLElement);
    expect(b.has("py-4") && b.has("space-y-2")).toBe(true);
    expect(b.has("pt-0")).toBe(false);
    expect(b.has("p-6")).toBe(true);
  });

  it("CardHeader：pb-2 与 p-6 同时留（PlaceDetail），p-2 pb-0.5 换成整族（MiniCard）", () => {
    const place = render(<CardHeader className="pb-2">详情头</CardHeader>);
    const a = toks(place.container.firstElementChild as HTMLElement);
    expect(a.has("p-6") && a.has("pb-2")).toBe(true);
    expect(a.has("flex") && a.has("flex-col") && a.has("space-y-1.5")).toBe(true);
    place.unmount();

    const mini = render(<CardHeader className="p-2 pb-0.5">迷你卡头</CardHeader>);
    const b = toks(mini.container.firstElementChild as HTMLElement);
    expect(b.has("p-2") && b.has("pb-0.5")).toBe(true);
    expect(b.has("p-6")).toBe(false);
  });

  it("调用点什么都不给时，五只自带的默认类一字不少（反向取样：合并不能实现成只留调用点的）", () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>标题</CardTitle>
          <CardDescription>描述</CardDescription>
        </CardHeader>
        <CardContent>内容</CardContent>
      </Card>,
    );
    const [card, header, content] = [...container.querySelectorAll("div")].slice(0, 3).map(toks);
    const title = toks(container.querySelector("h3") as Element);
    const desc = toks(container.querySelector("p") as Element);
    for (const c of ["rounded-lg", "border", "bg-card", "text-card-foreground", "shadow-sm"]) expect(card.has(c)).toBe(true);
    for (const c of ["flex", "flex-col", "space-y-1.5", "p-6"]) expect(header.has(c)).toBe(true);
    for (const c of ["text-2xl", "font-semibold", "leading-none", "tracking-tight"]) expect(title.has(c)).toBe(true);
    for (const c of ["text-sm", "text-muted-foreground"]) expect(desc.has(c)).toBe(true);
    for (const c of ["p-6", "pt-0"]) expect(content.has(c)).toBe(true);
    for (const node of [...container.querySelectorAll("*")]) {
      expect(node.className.toString()).not.toMatch(/undefined|null/);
    }
  });
});

describe("ui/card：props 穿过去、ref 转交、导出口就这五只", () => {
  it("onClick 与 data-testid 走 {...props}：整张卡是按钮（点开书、选提供商），也是浏览器判据的锚点", () => {
    const seen: string[] = [];
    const { getByTestId } = shelfCard({ onClick: () => seen.push("card") });
    fireEvent.click(getByTestId("card"));
    expect(seen).toEqual(["card"]);
    expect(getByTestId("card")).toHaveAttribute("data-testid", "card");
    // 摘掉那行的症状是"点卡片没反应"，而界面完全一样
    const other = render(<Card onDragOver={(e) => e.preventDefault()} data-testid="drop" />);
    expect(other.getByTestId("drop")).toBeTruthy();
  });

  it("五只都转交 ref（对象式与函数式）：拿到的就是那只带类的元素", () => {
    // 本仓没人给这五只挂 ref；判的是对外契约（类型面写着 forwardRef，悄悄改成普通函数组件
    // 要等下一只消费它的界面才发现节点是 null）。
    const obj = React.createRef<HTMLDivElement>();
    const one = render(<Card ref={obj}>甲</Card>);
    expect(obj.current).toBe(one.container.firstElementChild);
    obj.current!.classList.add("probe-mark");
    expect(toks(obj.current as Element).has("probe-mark")).toBe(true);
    one.unmount();

    let node: HTMLDivElement | null = null;
    const two = render(
      <CardContent
        ref={(n) => {
          node = n;
        }}
      >
        乙
      </CardContent>,
    );
    expect(node).toBe(two.container.firstElementChild);
  });

  it("CardTitle 转交 ref，而且 ref 那一头的元素类型与它真渲染的那个一致（h3）", () => {
    // 上游笔误是 `forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>`：
    // 类型参数写着 paragraph，渲染的却是 h3。已经改成 HTMLHeadingElement（制作人点头那一批发下来的
    // 三件事之一）。**要说清的是：这一格的两半里只有运行时那一半判得住。**
    // 类型那一半实测判不到——改之前 `npm run typecheck` 退出 0，改之后还是 0：lib.dom 里
    // `HTMLHeadingElement` 与 `HTMLParagraphElement` 结构上完全同形（都只比 `HTMLElement` 多一个
    // `align`），互相可赋值，所以 `createRef<HTMLHeadingElement>()` 挂到写着 paragraph 的 ref 上
    // tsc 一声不响。读数与那把"只回退类型参数"的刀记在文件末尾（K2）。
    // 下面断的是"ref 到底转不转交、落在哪只元素上"——这一半有刀（K1：摘掉 h3 上的 `ref={ref}`）。
    const titleRef = React.createRef<HTMLHeadingElement>();
    render(<CardTitle ref={titleRef}>第三章 关门</CardTitle>);
    expect(titleRef.current, "ref 根本没落到标题上").toBeTruthy();
    expect(titleRef.current!.tagName).toBe("H3");
    expect(titleRef.current!.textContent).toBe("第三章 关门");
  });

  it("这个文件只导出五只：CardFooter 全仓零取用，本笔删掉了", () => {
    expect(Object.keys(cardModule).sort()).toEqual([
      "Card",
      "CardContent",
      "CardDescription",
      "CardHeader",
      "CardTitle",
    ]);
    expect((cardModule as Record<string, unknown>).CardFooter).toBeUndefined();
  });

  it("五只的 displayName 与出口名一致（报错栈与 DevTools 里认得出是哪只子件）", () => {
    // 低配一条：坏了不影响界面。判它是因为"精简掉这几行"是全仓最常见的手滑。
    const named: [string, { displayName?: string }][] = [
      ["Card", Card],
      ["CardHeader", CardHeader],
      ["CardTitle", CardTitle],
      ["CardDescription", CardDescription],
      ["CardContent", CardContent],
    ];
    for (const [name, comp] of named) expect(comp.displayName, name).toBe(name);
  });
});

/**
 * 判别力台账（2026-09-27 本机，`CI=1 npx vitest run src/components/ui/__tests__/card-shell.test.tsx`）。
 * 三个基线（同一只 51 行的壳，两笔产品改动）：
 *  ① 原样 `76dc70ca…`／1804 字节 → 本档第一轮**唯一的改动是删掉死出口 `CardFooter`**（6 行＋1 个导出口名）
 *  ② 删之后 `f2679c7c…`／1529 字节 —— 第一轮 14 把刀（C1..C14）全打在这份上，每刀之后 `cp` 回基线并
 *     `cmp` + 重核 sha，**没有一刀 0 红**
 *  ③ 同日第二笔：`CardTitle` 的 `forwardRef` 第一个类型参数 paragraph → heading（一行），
 *     新基线 `1c91c958…`／1527 字节 —— J14 与 K1、K2 打在这份上，同样每刀之后 `cp` + `cmp` + 重核 sha。
 * 每一刀的读数旁边标的是"红了几条判据"；K2 是唯一一把 0 红的，那一格判不到，理由写在文件头。
 * 判据短号 J1..J14 按文件里的书写顺序；"连带"指红名里那些不是本刀目标的条目。
 *
 *  J1 标签（div/h3/p）  J2 真 heading level 3  J3 children 落点不插层
 *  J4 状态色 border+border-primary  J5 拖放区 border-2/bg-primary/5 各让一族
 *  J6 Title text-lg/base 顶 text-2xl  J7 Content p-5/py-4 两种覆盖  J8 Header pb-2/p-2 pb-0.5
 *  J9 反向：五只默认一字不少  J10 onClick+data-testid 透传  J11 ref 转交
 *  J12 导出口正好五只  J13 五只 displayName
 *  J14 CardTitle 的 ref 落到真渲染的那只元素上（h3）
 *
 *  C1 Card 的 `cn(默认, className)` 写成 `className ?? 默认` → **2 红**（J4 J5）
 *  C2 CardTitle 的 `h3` 换成 `div` → **3 红**（J1 J2 目标；J9 连带——它按 `querySelector("h3")` 取）
 *  C3 CardDescription 的 `p` 换成 `div` → **2 红**（J1 目标；J9 连带，同一个道理）
 *  C4 CardContent 的 `cn(...)` 换成模板串裸拼接 → **1 红**（J7）
 *  C5 Card 摘掉 `{...props}` → **5 红**（J10 J3 目标；J1/J2/J9 连带——children 与 data-testid
 *     一起没了，整棵树取不到）
 *  C6 CardContent 摘掉 `ref={ref}` → **1 红**（J11 函数式那半）
 *  C7 Card 默认类里摘掉 `border` → **2 红**（J4 J9）
 *  C8 CardHeader 给 children 垫一层 `div` → **2 红**（J3 目标：Header 的直接孩子不再是 H3+P；
 *     J9 连带：`querySelectorAll("div")` 的第 3 只变成了那只垫层）
 *  C9 CardContent 摘掉自带默认类（`cn(className)`）→ **2 红**（J9 目标；J7 连带）
 *  C10 Card 摘掉 `ref={ref}` → **1 红**（J11 对象式那半）
 *  C11 Card 的 displayName 改成 `"X"` → **1 红**（J13）
 *  C12 **把删掉的 CardFooter 原样接回来 → 1 红**（J12）——这次删除的守门刀
 *  C13 CardHeader 的 `cn(...)` 换成裸拼接 → **1 红**（J8）
 *  C14 CardTitle 的 `cn(...)` 换成裸拼接 → **1 红**（J6）
 *  K1 `CardTitle` 的 h3 摘掉 `ref={ref}` → **1 红**（J14）。同一次 `tsc` 退出 2、1 个错误：
 *     `ref` 那个形参没人用了（TS6133）——那是这把刀的副产品，不算判据的牙。
 *  K2 **只**把类型参数退回 `HTMLParagraphElement`（＝改前那一份字节）→ **0 红、`tsc` 退出 0**
 *     ＝"类型参数写错"那一格判不到的取证；理由与为什么不删这条判据都写在文件头。
 *
 * 一把作废重下：C8 第一次写成了坏语法（`{...props}` 落在 children 之后），那条读数没取，
 * 直接 `cp` 还原后重下——坏刀不算牙。
 * 没各下刀的两处（写在明处）：`CardHeader`/`CardDescription` 两只的 `ref` 与 `CardTitle` 之外那几只的
 * `displayName` 各只下了一处（J11 走 Card+Content、J13 走 Card、J14 走 CardTitle 的 ref）——
 * 同一条路的另几处，症状一样，不再各补一把刀。
 */
