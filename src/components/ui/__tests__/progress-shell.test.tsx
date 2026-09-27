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
 * 三格写在明处（都是实测）：
 * - **一条产品缺陷，本轮不判也不改，报制作人**：`value` 被具名解构之后**没有再交给
 *   `ProgressPrimitive.Root`**（`index.mjs:35` 的 `aria-valuenow={isNumber(value) ? value : undefined}`
 *   因此永远是 `undefined`）。读屏能认出"这是个 progressbar"，却永远读不出它现在是百分之几。
 *   判恒真的"它没有 aria-valuenow"等于把缺陷钉成现状，所以只在台账里记这一笔。
 * - **`value` 是 NaN 时不许画成满格**——那是上面那条解构的另一个后果。实测（临时探针，已删）：
 *   `value={0/0}` 时源码写进 `style` 的字符串确实是 `translateX(-NaN%)`，但 jsdom 和浏览器一样
 *   把这条非法声明丢了——`getAttribute("style")` 拿到 `null`、`style.transform` 拿到 `""`
 *   （同一只条子在 `value={0}` 时是 `translateX(-100%)`）。丢了 transform 就是停在默认位置＝**满宽**：
 *   0 步的进度显示成 100%。`ChapterTab.tsx:160` 那句 `(current / total) * 100` **没有护 total 为 0**
 *   （另两处都写了 `total ? … : undefined`），0/0 就是 NaN。这一格判不得：判"合法"会恒红，
 *   判"非法"（断言 transform 为空）是把缺陷钉成现状，报制作人定性后再动。
 * - **"条子看起来走了多少"jsdom 量不到**：`transform` 的实际渲染、`h-1` 在多高的设备上看得清吗、
 *   `overflow-hidden` 有没有真裁住圆角——都归浏览器层；e2e 目前没有一句碰过这只壳（实测
 *   `e2e/specs` 里 `progressbar` 0 命中），已记账。
 *
 * **7 条判据、8 把刀，逐条读数记在文件末尾**（短号 P1..P7 / V1..V8）。
 */

import { describe, it, expect } from "vitest";
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
 * 判别力台账（2026-09-27 本机，`CI=1 npx vitest run src/components/ui/__tests__/progress-shell.test.tsx`）。
 * 基线：`src/components/ui/progress.tsx` = sha256 `fc63de8d…`（758 字节），**产品代码一行没动**：
 * 八刀每刀之后 `cp` 回基线并 `cmp` + 重核 sha，最后一刀跑完 `git diff --numstat` 为空。
 * **没有一刀 0 红。** 判据短号 P1..P7 按书写顺序。
 *
 *  P1 0/50/100 各给一条不同位移   P2 value 没给当 0    P3 条子是 Root 唯一直接孩子、类写死
 *  P4 调用点压高度顶掉 h-4、其余默认不少            P5 不传 className 时默认六条一字不少
 *  P6 Root 走 Radix 原语（role=progressbar）        P7 ref 转交 + displayName
 *
 *  V1 `value || 0` 写成 `value || 100` → **2 红**（P1 P2）
 *  V2 位移写死 `translateX(-100%)` → **2 红**（P1 P3）
 *     ★注意 P2 在这一把是绿的：写死 -100% 恰好等于"没给 value"那格——所以 P1 那三条
 *     不同 value 的取样不是冗余，"整条永远空着"这种坏法只有相反值抓得住。
 *  V3 `cn(默认, className)` → `className ?? 默认` → **1 红**（P4）
 *  V4 默认里摘掉 `overflow-hidden` → **2 红**（P4 P5）
 *  V5 Indicator 的类里摘掉 `bg-primary` → **1 红**（P3）
 *  V6 Indicator 外面套一层 `div` → **3 红**（P3 目标；P1 P2 连带——位移读不到了）
 *  V7 放弃原语（Root 与 Indicator 都换成 `div`）→ **2 红**（P6 目标 + P7 连带）
 *     这一把必须两行一起改才跑得动：Radix 的 Indicator 离开 Root 的 context 会直接抛，
 *     所以它是"一个语义改动、两处字面改动"，不是两把刀。
 *  V8 摘掉 `ref={ref}` → **1 红**（P7）
 *
 * 两格记在账上而不是判据里（都是产品缺陷，报制作人定性，见文件头第三格）：
 * `value` 没有交给 Root，所以 `aria-valuenow` 永远是空的；`ChapterTab.tsx:160` 那句
 * `(current / total) * 100` 没护 `total === 0`，NaN 会让 transform 整条非法而被浏览器忽略，
 * 指示条停在默认位置＝**满格**。这两格判"现状"是把缺陷钉住、判"应有"是恒红，所以都不写。
 */
