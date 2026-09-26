/**
 * `ui/scroll-area` 的"自己那份契约"判据（地板第 1 档·薄壳档）。
 *
 * 这只壳产品逻辑一行都没有，但它比 `select`/`label` 多一样东西：**一段命令式的 DOM 改写**
 * （`useFixViewportDisplay`）。翻它的历史就是六笔同一件事：`0a5d594` 加 `max-w-full` →
 * `5c9c00d` 改 display → `e2e9021` 换成全局 CSS → `8ee5aee` 再换回 ref → `57ceab8` 补上漏掉的
 * 内层 → 之后还跟着两笔 lint/清理。**一条 bug 修了六次、方案换了三种**，而这一档之前全仓
 * 一句判据都没有——所以这里判的就是"最后这次修出来的形状别再悄悄退回去"。
 *
 * 只判这个文件替调用点做的四个决定（用它的只有 `ChapterNav.tsx:119` 与
 * `SummaryPanel.tsx:352` 两处，都是 `className="flex-1"` 塞进 flex 列里）：
 * 1) **两层 `display:table` 都要按平**：Radix 的 Viewport 里硬编码了一只
 *    `style={{minWidth:"100%", display:"table"}}` 的包裹层（实测在本仓依赖
 *    `@radix-ui/react-scroll-area/dist/index.mjs:130`），table 自动布局按内容宽度撑开，
 *    症状是"面板被内容撑破"。外层 Viewport 与内层包裹**各写一次**，缺哪半都还会溢
 *    （`57ceab8` 就是补后一半的那笔）。
 * 2) **改写要发生在 DOM 挂上之后**：所以是 effect 里拿 `rootRef.current` 去 query。
 *    render 期那只 ref 还是 null，两层一个都改不到——症状与"没写这段"一模一样。
 * 3) **`className` 与其余 props 是合并/透传，不是顶掉**：两处都挂 `flex-1`，
 *    `ChapterNav` 还挂 `style={{minHeight:0}}`（flex 列里不写 minHeight:0 就不肯收缩）。
 *    写成 `className ?? 默认` 的症状是 `overflow-hidden` 一起丢掉，而界面看着还是那只列表。
 * 4) **`forwardRef` 与自带那一只滚动条**：外部 ref（对象式与函数式）都要拿得到 Root，
 *    且拿到之后覆盖照样生效；自带那一只只有竖排（横排那一支跟着导出口一起删了，见下面第 3 条）。
 *
 * 三格量不到/量到别处，写在明处（都是实测，不是"没想到"）：
 * - **"会不会真撑破"jsdom 判不了**：它没有表格自动布局，`clientWidth`/`scrollWidth` 恒 0。
 *   这一档只判"那两层 style 被写成了什么"，后果由浏览器层 **B25** 判（`e2e/specs/b3-read-modes.spec.ts`：
 *   目录里一条 40 多字的标题，产品形状 192/192 不溢、内层退回 table 变 192/584）。
 *   那边还量出一条：**把外层那两行整个删掉，B25 照绿**——所以"撑破"这一半的账记在内层那一只，
 *   外层这两条判据管的是"这一层有没有被按平"这个形状本身。
 * - **Thumb 与 Corner 在 jsdom 里整只不存在**：默认 `type="hover"` 时 Radix 连滚动条那一层
 *   都不挂载（实测 `querySelectorAll('[data-orientation]')` 为 0），`type="always"` 之下滚动条
 *   元素有了、里面却是空的（Thumb 要 `hasThumb`），Corner 要"横竖两只都在"才出现。
 *   所以这一档只判方向那一组类——拿一条永远为假的"元素不存在"去判是假判据。
 * - ~~**`ScrollBar` 这个导出口在本仓零调用**~~：**2026-09-26 删了**（`chore` 见本笔提交）。
 *   删的理由不是"它没人用所以碍事"，是**留着就得一直判一条产品走不到的分支**：`orientation` 那两道
 *   条件里横排那一支、以及外部 `className` 合并，全仓没有任何调用点能触发（实测 grep：除本测试文件
 *   外无人 import，而本文件自己也只是拿它造现场）。与 `de9203e` 删 `createSimpleAgent` 同一个理由。
 *   现在它是本文件的内部件、只画竖排；原来短号 11（显式横排）与 12（滚动条类追加）那两条判据随之
 *   作废，换成一条"整只壳里只有竖排这一条"——**它反过来把这次删除钉住**：谁把横排那一支接回来就红
 *   （S3 实测 2 红）。
 *
 * **14 刀逐条读数**（2026-09-25，`src/components/ui/scroll-area.tsx` 一行一处、跑完立刻还原，
 * 还原后 SHA256 全部回到 `d608742f…4da0`；"红了哪几条"用下面的短号，1=内层 2=外层 3=两只不同节点
 * 4=追加后仍在 5=className 合并 6=style 透传 7=props 透传 8=外部 ref 9=children 落点
 * 10=默认竖排 11=显式横排 12=滚动条类追加）：
 * - 摘掉内层 `display` 那一行 → 1/3/4/8 红；把内层 `minWidth` 写回 `"100%"` → 1/4 红
 *   （两句分开判是因为**Radix 给的那份就是 `display:table` + `minWidth:100%` 两个键**，
 *   按掉一个另一个还在；至于"没按平到底会不会真撑破"，jsdom 量不到，见上面第 1 条）。
 * - 摘掉外层 `display` → 2/3/8 红；外层 `minWidth` 写回 `"100%"` → 只有 2 红。
 * - 内层选择器 `"div"` → `"section"`（找不到那只包裹）→ 1/3/4/8 红。
 * - 让那段改写在挂载之后根本不执行（effect 换成不参与渲染的表达式）→ 1/2/3/4/8 红。
 * - `{children}` 从 Viewport 里挪到外面 → 只有 9 红（其余全绿：改写照样落在那只空包裹上）。
 * - `cn(默认, className)` 写成 `className ?? 默认` → 只有 5 红。
 * - 摘掉 `{...props}` → **10 条红**，但这一把不是独立刀：`data-testid` 与 `type`/`style` 同走这一行，
 *   红里多数是连带。**6（style 透传）没有自己独立的刀**——它与 7 共用 `{...props}` 那一条路，
 *   "只丢 style 不丢别的"只能在调用点侧造出来，这句写在明处、不当已验收。
 * - `composedRef` 里函数式 ref 不转交（`ref(node)` → `void ref`）→ 只有 8 红。
 * - ~~ScrollBar 默认方向 `vertical` → `horizontal` → 10/11/12 全红；横排分支的条件写反 → 10/11 红；
 *   横排分支带上默认类 → 只有 11 红；ScrollBar 的 `className` 参数整个丢掉 → 只有 12 红~~
 *   ——这四把是 09-25 打在旧形状（`d608742f…`）上的读数，**09-26 随导出口一起作废**，见上面第 3 条。
 *   替换成下面 S1/S2/S3 三把，打在删除后的新基线 `e1de4eee…`（2932 字节 / 11 条全绿）上：
 * - **S1** 不画自带那只滚动条 → **3 红**（竖排类那条、"只有竖排这一条"那条，外加"其余 props 透传"
 *   那条数 `[data-orientation]` 个数的）。
 * - **S2** 竖排那一组类换成横排那一组（`h-full w-2.5 border-l` → `h-2.5 flex-col border-t`）
 *   → **只有竖排类那条红**：`data-orientation` 由 Radix 自己写，跟我们的类无关，所以"只有竖排"
 *   那条抓的是**只有一只**，类有没有串由前一条管——两半各管一件事，缺一半就有一种坏法没人看。
 * - **S3** 把删掉的横排那一支原样接回来（内部再造一只 `orientation="horizontal"`）
 *   → **2 红**（"只有竖排这一条" + props 透传那条的个数）。这一把就是这次删除的守门刀。
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import * as React from "react";

import { ScrollArea } from "../scroll-area";

const VIEWPORT = "[data-radix-scroll-area-viewport]";

/** 一只壳 + 一行可认的内容；`extra` 放调用点会传的那几样（className / style / ref / type）。 */
function shell(extra: Record<string, unknown> = {}) {
  return render(
    <ScrollArea data-testid="area" {...extra}>
      <div data-testid="row">很长很长的一章标题</div>
    </ScrollArea>
  );
}

const viewportOf = (root: HTMLElement) => root.querySelector<HTMLElement>(VIEWPORT)!;
/** Radix 硬编码那只 `display:table` 的包裹层 */
const tableWrapOf = (root: HTMLElement) => viewportOf(root).querySelector<HTMLElement>("div")!;

describe("ScrollArea：两层 display:table 都要按平（这一件事历史上修过六次）", () => {
  it("内层包裹：display 从 table 按成 block、minWidth 从 100% 按成 0", () => {
    const { getByTestId } = shell();
    const wrap = tableWrapOf(getByTestId("area"));
    expect(wrap.style.display).toBe("block");
    expect(wrap.style.minWidth).toBe("0px");
  });

  it("外层 Viewport 同样被按平（只按内层不够，那正是 57ceab8 之前缺的一半）", () => {
    const { getByTestId } = shell();
    const viewport = viewportOf(getByTestId("area"));
    expect(viewport.style.display).toBe("block");
    expect(viewport.style.minWidth).toBe("0px");
  });

  it("两层是同一次改写里的两只不同节点（少写一层不会由另一层代劳）", () => {
    const { getByTestId } = shell();
    const viewport = viewportOf(getByTestId("area"));
    const wrap = tableWrapOf(getByTestId("area"));
    expect(wrap).not.toBe(viewport);
    expect(viewport.contains(wrap)).toBe(true);
    expect(viewport.style.display).toBe("block");
    expect(wrap.style.display).toBe("block");
  });

  it("children 追加一章之后覆盖还在，没被下一次 render 写回 table", () => {
    const rows = ["第一章", "第二章"];
    const { getByTestId, rerender } = render(
      <ScrollArea data-testid="area">
        <div data-testid="row">第一章</div>
      </ScrollArea>
    );
    expect(tableWrapOf(getByTestId("area")).style.display).toBe("block");
    rerender(
      <ScrollArea data-testid="area">
        {rows.map((t) => (
          <div key={t} data-testid={`row-${t}`}>
            {t}
          </div>
        ))}
      </ScrollArea>
    );
    // React 只按自己那份 style 对象里有的键 diff（`display`/`minWidth` 值没变 → 不回写），
    // 所以命令式覆盖是"一次生效、后续 render 不动"。哪天有人把改写挪进 render 期、
    // 或给内层补一个会变的 style 键，这一条会替我们响。
    const wrap = tableWrapOf(getByTestId("area"));
    expect(wrap.style.display).toBe("block");
    expect(wrap.style.minWidth).toBe("0px");
    expect(screen.getByTestId("row-第二章")).toBeTruthy();
  });
});

describe("ScrollArea：调用点传进来的东西要照原样穿过去", () => {
  it("className 是合并不是顶掉（两处都挂 flex-1，默认那两条不能丢）", () => {
    const { getByTestId } = shell({ className: "flex-1" });
    const area = getByTestId("area");
    expect(area.className).toContain("flex-1");
    expect(area.className).toContain("relative");
    expect(area.className).toContain("overflow-hidden");
  });

  it("style 透传到 Root：ChapterNav 那句 minHeight:0 就是靠它（丢了 flex 列里不肯收缩）", () => {
    const { getByTestId } = shell({ style: { minHeight: 0 } });
    expect(getByTestId("area").style.minHeight).toBe("0px");
  });

  it("其余 props 也透传到 Radix Root：type=always 才看得见自带那只滚动条", () => {
    // 默认形状下 Radix 不挂滚动条那一层（见文件头那条实测），所以这一条同时钉住两件事：
    // `{...props}` 没被摘掉，以及"滚动条存在与否"不该拿默认形状去判。
    const hover = shell();
    expect(hover.getByTestId("area").querySelectorAll("[data-orientation]").length).toBe(0);
    hover.unmount();
    const always = shell({ type: "always" });
    expect(always.getByTestId("area").querySelectorAll("[data-orientation]").length).toBe(1);
  });

  it("外部 ref 两半都要：对象式与函数式都拿到 Root，且拿到之后覆盖照样生效", () => {
    const obj = React.createRef<HTMLDivElement>();
    render(
      <ScrollArea ref={obj}>
        <div>甲</div>
      </ScrollArea>
    );
    expect(obj.current).not.toBe(null);
    expect(obj.current!.querySelector(VIEWPORT)).not.toBe(null);

    let fnNode: HTMLDivElement | null = null;
    render(
      <ScrollArea
        ref={(n) => {
          fnNode = n;
        }}
      >
        <div>乙</div>
      </ScrollArea>
    );
    // `composedRef` 里"写内部那只"与"转给外部那只"是两件事，只写一边另一边静默失灵
    expect(fnNode).not.toBe(null);
    expect(fnNode!.querySelector(VIEWPORT)).not.toBe(null);
    // 拿得到节点 ≠ 改得动：内部那只仍要把两层都按平
    expect(viewportOf(fnNode!).style.display).toBe("block");
    expect(tableWrapOf(fnNode!).style.display).toBe("block");
  });

  it("children 落在 Viewport 里面，没被挪到壳外", () => {
    const { getByTestId } = shell();
    expect(getByTestId("row").closest(VIEWPORT)).not.toBe(null);
  });
});

describe("ScrollArea：自带那只滚动条只有竖排这一条", () => {
  it("竖排那一组类（h-full w-2.5 border-l），且横排那组类一个字都不许串进来", () => {
    const { getByTestId } = shell({ type: "always" });
    const bar = getByTestId("area").querySelector<HTMLElement>('[data-orientation="vertical"]')!;
    expect(bar.className).toContain("h-full");
    expect(bar.className).toContain("w-2.5");
    expect(bar.className).toContain("border-l");
    expect(bar.className).toContain("touch-none");
    expect(bar.className).not.toContain("flex-col");
    expect(bar.className).not.toContain("border-t");
  });

  it("整只壳里只有这一条滚动条：横排那一支在产品里走不到（2026-09-26 删掉了导出口）", () => {
    const { getByTestId } = shell({ type: "always" });
    const area = getByTestId("area");
    expect([...area.querySelectorAll("[data-orientation]")].map((n) => n.getAttribute("data-orientation")))
      .toEqual(["vertical"]);
    expect(area.querySelector('[data-orientation="horizontal"]')).toBeNull();
  });
});
