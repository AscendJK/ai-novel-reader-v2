/**
 * `ui/separator` 的"自己那份契约"判据（地板第 1 档·薄壳档）。
 *
 * 24 行的 shadcn 薄壳，全仓四个文件用它、15 处（实测）：`ApiSettings` 五处、
 * `RAGSettings` 三处、`StorageManager`、`ExportPanel`——全是设置页里"两段之间那根线"。
 * 这里不判 Radix 的行为，只判这个文件替调用点做的三个决定：
 *
 * 1) **默认是"装饰性横线"**：`orientation = "horizontal"` 与 `decorative = true` 都是壳里
 *    给的默认值。decorative 为真时这根线**不该**被读屏当成一个可导航的 separator 角色——
 *    15 处调用点一句都没提 decorative，界面上就是这么定的。
 * 2) **厚度类跟着 orientation 走**（壳里那句三元）：横排 `h-[1px] w-full`、竖排 `h-full w-[1px]`。
 *    **本仓 15 处全是横排**（实测：没有一处传 `orientation`），所以竖排那一支是走不到的分支——
 *    判它不是判某个界面的现状，是判**这个文件自己那句话的一致性**：谁把 `orientation` 传给
 *    Radix 而类还留在横排那两条上，竖线就变成一根 1px 高、整幅宽的横线（几乎看不见，
 *    而 DOM 里"确实是竖排"）。删掉三元硬编码横排也能过这 15 处，但那会把 Radix 的
 *    `orientation` 变成骗人的 API——留着的理由要有人看着，就是这条。
 * 3) **`cn` 合并**：调用点唯一加的东西是 `my-4`（`RAGSettings.tsx:192/249` 等四处），
 *    壳自带的 `shrink-0 bg-border` 必须留着——丢了 `bg-border` 症状是"线没了但间距还在"，
 *    而界面看着还是"两段分开"。
 *
 * 三格写在明处（两格"不判"＋一格"为什么这两支还是要判"）：
 * - **`{...props}` 那行本仓只有 `id`/`aria-*` 这类才会走到**：`className` 是具名解构，
 *   `decorative`/`orientation` 也是——15 处调用点传进去的只有 `className`（实测），
 *   所以这一行没有可判的产品形状，也不给它编判据。
 * - **`decorative={false}` 与 `orientation="vertical"` 两支在产品里都走不到**（实测：15 处
 *   全默认）。判它们判的是**这只壳自己声明了的 API 要兑现**——props 类型里写着这两个名字，
 *   传了却没换（类还留在横排、role 还被吞掉）就是这只壳在骗人。跟"给某个界面补判据"是两回事，
 *   读数里也分开标（S2/S3 是契约刀，S1/S4 才是现状刀）。
 * - **那根线到底多粗、能不能看见**：`h-[1px]` 在真浏览器上的实际像素（DPR、缩放、
 *   `border` 叠加）jsdom 量不到；设置页里"分隔线在不在"目前也没有浏览器层判据（实测
 *   `e2e/specs/d-settings.spec.ts` 没碰过 separator），已记账。
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

import { Separator } from "../separator";

const toks = (el: Element) => new Set(el.className.trim().split(/\s+/).filter(Boolean));

describe("ui/separator：默认那根线是什么", () => {
  it("默认横排：厚度类是 h-[1px] w-full，竖排那两条一个字都不许串进来", () => {
    const { container } = render(<Separator />);
    const el = container.firstElementChild as HTMLElement;
    const cls = toks(el);
    expect(cls.has("h-[1px]") && cls.has("w-full")).toBe(true);
    expect(cls.has("h-full") || cls.has("w-[1px]")).toBe(false);
    expect(el.getAttribute("data-orientation")).toBe("horizontal");
  });

  it("默认当装饰用：这根线不该被读屏当成一个可跳到的分隔件", () => {
    const { container } = render(<Separator />);
    const el = container.firstElementChild as HTMLElement;
    // 实测：decorative 为真时 Radix 不给 role="separator"，也不给 aria-orientation
    expect(el.getAttribute("role")).not.toBe("separator");
    expect(el.hasAttribute("aria-orientation")).toBe(false);
  });

  it("显式要当「真分隔件」用时要换得过来（壳里 decorative 只是默认值，不是写死）", () => {
    const { container, unmount } = render(<Separator decorative={false} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("role")).toBe("separator");
    // 实测：Radix 只在竖排时写 aria-orientation（横排就是 ARIA 的默认值，不写）
    expect(el.getAttribute("data-orientation")).toBe("horizontal");
    expect(el.hasAttribute("aria-orientation")).toBe(false);
    unmount();

    const both = render(<Separator decorative={false} orientation="vertical" />);
    const v = both.container.firstElementChild as HTMLElement;
    expect(v.getAttribute("role")).toBe("separator");
    expect(v.getAttribute("aria-orientation")).toBe("vertical");
  });
});

describe("ui/separator：orientation 与厚度类同源", () => {
  it("传 vertical：类整支换成 h-full w-[1px]，横排那两条一个字不留", () => {
    const { container } = render(<Separator orientation="vertical" />);
    const el = container.firstElementChild as HTMLElement;
    const cls = toks(el);
    expect(cls.has("h-full") && cls.has("w-[1px]")).toBe(true);
    expect(cls.has("h-[1px]") || cls.has("w-full")).toBe(false);
    // orientation 也得真的交给 Radix（属性与类是两件事，只改一边就是一种坏法）
    expect(el.getAttribute("data-orientation")).toBe("vertical");
  });

  it("className 是合并不是顶掉：调用点那句 my-4 加进来，shrink-0 与 bg-border 还在", () => {
    // 15 处调用点唯一加的东西就是这个（RAGSettings.tsx:192/249、StorageManager、ExportPanel）
    const { container } = render(<Separator className="my-4" />);
    const cls = toks(container.firstElementChild as HTMLElement);
    expect(cls.has("my-4")).toBe(true);
    expect(cls.has("shrink-0")).toBe(true);
    expect(cls.has("bg-border")).toBe(true);
  });

  it("不传 className 时默认那两条一字不少（反向取样）", () => {
    const { container } = render(<Separator />);
    const cls = toks(container.firstElementChild as HTMLElement);
    expect(cls.has("shrink-0") && cls.has("bg-border")).toBe(true);
    expect(container.firstElementChild!.className).not.toMatch(/undefined|null/);
  });

  it("ref 转交（对象式）：拿到的就是那只带类的元素；displayName 跟着 Radix", () => {
    // 本仓没人给 Separator 挂 ref；判的是壳的对外契约（导出的类型面写着 ElementRef）。
    const ref = React.createRef<HTMLDivElement>();
    const { container } = render(<Separator ref={ref} />);
    expect(ref.current).toBe(container.firstElementChild);
    expect(ref.current!.getAttribute("data-orientation")).toBe("horizontal");
    expect(Separator.displayName).toBe(SeparatorPrimitive.Root.displayName);
  });
});

/**
 * 判别力台账（2026-09-27 本机，`CI=1 npx vitest run src/components/ui/__tests__/separator-shell.test.tsx`）。
 * 基线：`src/components/ui/separator.tsx` = sha256 `2f54b6d6…`，**产品代码一行没动**：
 * 五刀每刀之后 `cp` 回基线并 `cmp` + 重核 sha，最后一刀跑完 `git diff --numstat` 为空。
 * **没有一刀 0 红**；一刀作废重下（第一次把 `ref` 与 `decorative` 两行一起吃了，读数不算归属）。
 *
 *  S1 默认横排那两条厚度类（且竖排类不串进来）      S2 默认当装饰（没有 separator 角色）
 *  S3 显式 decorative=false 要换得过来（声明了的 API 要兑现）
 *  S4 vertical 时类整支换掉、data-orientation 也跟着    S5 className 合并（my-4 进、shrink-0/bg-border 留）
 *  S6 不传 className 时默认一字不少                  S7 ref 转交 + displayName
 *
 *  T1 三元写反（横排给竖排类）→ **2 红**（S1 S4）
 *  T2 `decorative={decorative}` 写成 `decorative`（写死）→ **1 红**（S3）
 *  T3 `cn(默认, className)` 写成 `className ?? 默认` → **1 红**（S5）
 *  T4 默认类里摘掉 `bg-border` → **2 红**（S5 S6）
 *  T5 摘掉 `ref={ref}` → **1 红**（S7）
 *
 * 没有独立刀的一格：S2 与 S7 的 displayName 那半。S2 与 T2 是同一条 `decorative` 的两面
 * （默认值对不对 / 显式值穿不穿得过去），T2 咬的是后一面；`SeparatorPrimitive.Root.displayName`
 * 那一行坏了只影响 DevTools 与报错栈，界面不变，未单独下刀。
 */
