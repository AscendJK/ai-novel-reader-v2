/**
 * `ui/progress` 的"自己那份契约"判据（地板第 1 档·薄壳档）。
 *
 * 23 行、四只文件用它、6 处（实测）：`NovelBuildWindow.tsx:77`（导入进度）、
 * `BookSelect.tsx:638`（解析进度）、`NovelCard.tsx:107`（书架卡片上的阅读进度）、
 * `ChapterTab.tsx:159`（本章/批量生成的进度）。前四档里它是唯一一只**自己算样式**的壳：
 * 条子的长度不是类，是 `transform: translateX(...)`。
 *
 * 判这个文件替调用点做的四个决定：
 * 1) **`value` 是具名解构、只喂给那条 transform**：所以 `value || 0` 这个"没给就当 0"是
 *    壳自己定的（`total ? pct : undefined` 两处直接传 undefined 进来）。
 * 2) **`cn(默认, className)` 合并**：四处调用点全在压高度——`h-2`、`h-1.5`、`h-1 flex-1`
 *    要顶掉壳自带的 `h-4`，而 `relative w-full overflow-hidden rounded-full bg-secondary`
 *    这些不冲突的一字不能少；丢了 `overflow-hidden` 症状是"条子的圆角头露出轨道"。
 * 3) **Indicator 是 Root 唯一的直接孩子、类写死**：调用点改不到它（没有出口），所以
 *    `bg-primary`/`transition-all` 全靠这 5 行自己守住；插一层就打断 `flex-1`。
 * 4) **Root 用的是 Radix 的 progress 原语**：`role="progressbar"` 是它给的——四处调用点
 *    一句 aria 都没写，界面上"这是一根进度条"这件事只剩这一条可依。
 *
 * 两格写在明处：
 * - 头两格（`aria-valuenow` 永远是空的、NaN 该当"还不知道"）**已经在 2026-09-27 修掉并立成判据**
 *   （P8、P9），下面那段"改口"记的就是这件事；这一栏只剩最后一格仍然是判不到的。
 * - **"条子看起来走了多少"jsdom 量不到**：`transform` 的实际渲染、`h-1` 在多高的设备上看得清吗、
 *   `overflow-hidden` 有没有真裁住圆角——都归浏览器层；e2e 目前没有一句碰过这只壳（实测
 *   `e2e/specs` 里 `progressbar` 0 命中），已记账。
 *
 * **7 条判据、8 把刀**只是修之前那份台账；今天动过产品代码之后是 **9 条判据、10 把刀**
 * （短号 P1..P9 / N1..N2 与在新基线上重打的 V1..V8，逐条读数记在文件末尾）。
 *
 * 这一档在 2026-09-27 **动过产品代码**（制作人点头修报上去的三处缺陷，这是第一处）：原先 `value`
 * 被具名解构之后没有交给 Root，`aria-valuenow` 永远是空的——读屏认得出"这是个进度条"，
 * 却永远读不出它现在是百分之几。上面第 1、4 两格因此各多了一条判据（P8、P9）。
 * **顺带把我先前报错了的一句改口**：我说过"NaN 会让 transform 非法 → 浏览器忽略 → 条子显示满格"，
 * **实测不成立**——源码是 `100 - (value || 0)`，而 `NaN` 是假值，`NaN || 0` 得 0，画的本来就是空条。
 * 真会出事的是"把脏值递给原语"那一格：Radix 只比 `typeof value === "number"`，NaN 恰好是 number，
 * 它会开发期喊 `Invalid prop value NaN` 再按 indeterminate 处理。所以这一层先归一成 `undefined`，
 * 四个调用点一起兜住，而不是挨个去补算式；这一格只有刀 N2 咬得住（摘掉归一化 → P9 红）。
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { Progress } from "../progress";

const toks = (el: Element) => new Set(el.className.trim().split(/\s+/).filter(Boolean));
const rootOf = (container: HTMLElement) => container.firstElementChild as HTMLElement;
const barOf = (container: HTMLElement) => rootOf(container).firstElementChild as HTMLElement;
const transformOf = (container: HTMLElement) => barOf(container).getAttribute("style") ?? "";

describe("ui/progress：条子的长度由 value 决定", () => {
  it("0 / 50 / 100 三个值各给一条不同的位移（受控的每一格都要有相反的值）", () => {
    for (const [value, want] of [
      [0, "translateX(-100%)"],
      [50, "translateX(-50%)"],
      [100, "translateX(-0%)"],
    ] as [number, string][]) {
      const { container, unmount } = render(<Progress value={value} />);
      expect(transformOf(container), `value=${value}`).toContain(want);
      unmount();
    }
  });

  it("value 没给（调用点写 total ? pct : undefined）→ 当成 0，不许当成 100", () => {
    const { container } = render(<Progress value={undefined} />);
    expect(transformOf(container)).toContain("translateX(-100%)");
  });

  it("条子是 Root 唯一的直接孩子，类写死那五条（调用点没有出口改它）", () => {
    const { container } = render(<Progress value={40} />);
    const root = rootOf(container);
    expect(root.children.length).toBe(1);
    const cls = toks(barOf(container));
    for (const c of ["h-full", "w-full", "flex-1", "bg-primary", "transition-all"]) {
      expect(cls.has(c), `Indicator 的 ${c} 要在`).toBe(true);
    }
    expect(transformOf(container)).toContain("translateX(-60%)");
  });
});

describe("ui/progress：Root 的类与角色", () => {
  it("调用点压高度（h-2 / h-1.5 / h-1 flex-1）顶掉 h-4，其余默认一条不少", () => {
    for (const extra of ["h-2", "h-1.5", "h-1 flex-1"]) {
      const { container, unmount } = render(<Progress value={30} className={extra} />);
      const cls = toks(rootOf(container));
      expect(cls.has(extra.split(" ")[0]), `${extra} 要生效`).toBe(true);
      expect(cls.has("h-4")).toBe(false);
      for (const c of ["relative", "w-full", "overflow-hidden", "rounded-full", "bg-secondary"]) {
        expect(cls.has(c), `不冲突的默认类 ${c} 不许丢`).toBe(true);
      }
      if (extra.includes("flex-1")) expect(cls.has("flex-1")).toBe(true);
      unmount();
    }
  });

  it("不传 className 时默认那六条一字不少（反向取样）", () => {
    const { container } = render(<Progress value={10} />);
    const cls = toks(rootOf(container));
    for (const c of ["relative", "h-4", "w-full", "overflow-hidden", "rounded-full", "bg-secondary"]) {
      expect(cls.has(c), `默认的 ${c} 要在`).toBe(true);
    }
    expect(rootOf(container).className).not.toMatch(/undefined|null/);
  });

  it("Root 走的是 Radix 的 progress 原语：role=progressbar（四处调用点都没写 aria，只剩这条可依）", () => {
    const { container } = render(<Progress value={20} />);
    expect(rootOf(container).getAttribute("role")).toBe("progressbar");
  });

  it("Root 要带上 aria-valuenow：读屏才读得出现在是百分之几", () => {
    for (const [value, want] of [
      [0, "0"],
      [35, "35"],
      [100, "100"],
    ] as [number, string][]) {
      const { container, unmount } = render(<Progress value={value} />);
      expect(rootOf(container).getAttribute("aria-valuenow"), `value=${value}`).toBe(want);
      unmount();
    }
  });

  it("value 不是有限数（没给，或 0÷0 那种 NaN）时这个属性要缺席，也不许把脏值递给原语", () => {
    // Radix 的校验是 `typeof value === "number"`，而 NaN 恰好是 number——不先归一，原语会
    // 当场 `console.error("Invalid prop value NaN …")`（真机就是这一句把退出码打成 1）。
    // `ChapterTab.tsx:160` 那句 (current/total)*100 在排队那一拍（任务初值 {current:0,total:0}，
    // 见 ai-task-queue.ts:152）就是这条形状，所以归一化留在这一层：四个调用点一起兜住。
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const bad of [undefined, NaN]) {
        const { container, unmount } = render(<Progress value={bad} />);
        expect(rootOf(container).hasAttribute("aria-valuenow"), `value=${bad} 不许进 aria`).toBe(false);
        expect(transformOf(container), `value=${bad} 时条子该空着`).toContain("translateX(-100%)");
        unmount();
      }
      const shouted = spy.mock.calls.map((c) => String(c[0])).join(" | ");
      expect(shouted, "递给原语的值要让 Radix 当场报警——说明归一化没做").not.toMatch(/Invalid prop/);
    } finally {
      spy.mockRestore();
    }
  });

  it("ref 转交（对象式）拿到的就是那只 progressbar；displayName 跟着 Radix", () => {
    // 本仓没人给它挂 ref；判的是对外契约。
    const ref = React.createRef<HTMLDivElement>();
    const { container } = render(<Progress ref={ref} value={20} />);
    expect(ref.current).toBe(rootOf(container));
    expect(ref.current!.getAttribute("role")).toBe("progressbar");
    expect(Progress.displayName).toBe(ProgressPrimitive.Root.displayName);
  });
});

/**
 * 判别力台账（2026-09-27 本机，`CI=1 npx vitest run src/components/ui/__tests__/progress-shell.test.tsx`；
 * 红名一律从落盘日志数）。
 *
 * **这一档今天动了产品代码**：修的就是"读屏读不出百分比"那一条。改前基线 `fc63de8d…`（758 字节）
 * 是 V1..V8 那八刀的取证盘；改后基线 `566871c7…`（1181 字节）是现在这份，
 * **V1..V8 全部在改后基线上重打了一遍**（产品代码一变，旧读数只能算历史），另加 N1、N2 两把新刀。
 * 每刀之后 `cp` 回基线并 `cmp` + 重核 sha；十刀跑完 `git diff` 只剩判据这一只文件。
 *
 * 九条判据（按书写顺序）：
 *  P1 0/50/100 各给一条不同位移    P2 没给 value 当 0 不当 100   P3 条子是 Root 唯一直接孩子、类写死
 *  P4 调用点压高度顶掉 h-4、其余默认不少    P5 不传 className 时默认六条一字不少
 *  P6 Root 走 Radix 原语（role=progressbar）  P7 ref 转交 + displayName
 *  P8 Root 要带 aria-valuenow（新）    P9 不是有限数就当"不知道"，也不许把脏值递给原语（新）
 *
 *  刀                                    旧基线 → 新基线           红名
 *  V1 `|| 0` 写成 `|| 100`             2 → **3 红**（P1 P2 P9）
 *  V2 transform 写死 translateX(-100%)    2 → **2 红**（P1 P3）
 *  V3 `cn(默认, x)` → `x ?? 默认`          1 → **1 红**（P4）
 *  V4 默认里摘掉 overflow-hidden          2 → **2 红**（P4 P5）
 *  V5 Indicator 摘掉 bg-primary           1 → **1 红**（P3）
 *  V6 Indicator 外套一层 div              3 → **4 红**（P1 P2 P3 P9，位移读不到了）
 *  V7 放弃原语（Root 与 Indicator 都换 div）2 → **3 红**（P6 P7 P8）
 *  V8 摘掉 ref={ref}                      1 → **1 红**（P7）
 *  N1 摘掉交给 Root 的那个 value           — → **1 红**（P8）  这一把就是"修之前"那个形状
 *  N2 摘掉归一化（`shown = value`）         — → **1 红**（P9）
 *     N2 第一次跑是 **0 红**：Radix 收到 NaN 会 `console.error("Invalid prop value NaN")` 再按
 *     indeterminate 处理，于是"aria-valuenow 缺席"与"条子空着"两条断言照样绿，只有退出码变 1。
 *     **靠退出码归因不算判住**——把这一格改成显式 spy 断言（不许喊 Invalid prop）之后，
 *     N2 才真的指着 P9 红一条。
 *
 * 还有一格判不到，写在账上：`ChapterTab.tsx:160` 自己算出 NaN 这件事，在归一化落地之后与
 * "调用点直接给 undefined"从界面上完全同形（都成空条、都没有 aria-valuenow），jsdom 量不出差别，
 * 所以那句算式今天没动，兜底放在这一层。
 */
