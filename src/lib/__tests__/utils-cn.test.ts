/**
 * `lib/utils` 的 `cn` 首次有直接判据（地板第 1 档·共用小内核档）。
 *
 * 4 行、一只出口，却是全仓最粗的一根水管：**12 只文件从 `@/lib/utils` 取水，
 * `cn(` 调用点 37 处**（实测）。前面那几档薄壳（`ui/tabs`、`ui/card`、`ui/separator`、
 * `ui/progress`、`ui/button`…）各自判过"我这一行 `cn(默认, className)` 要真的合并"，
 * 但**合并这件事本身是不是合并**——一直没人从源头看过：那几档都是拿 `cn` 当已知正确的。
 * 全仓也没有一只测试文件直接 import 过这只文件（实测 grep `lib/utils` 在 `__tests__` 里 0 命中）。
 *
 * 判这个文件替 37 个调用点定的四件事：
 * 1) **后面的赢**：调用点一律写 `cn(默认类, 覆盖类)`，所以"后压前"是全仓共同的约定。
 *    摘掉 `twMerge` 就只剩 `clsx` 的拼接——两条冲突的类一起进 `class`，谁生效交给 CSS
 *    文件里的先后顺序，症状是"改了没反应"或"某台设备上换个写法就变样"。
 * 2) **不冲突的一条不许少**：`relative w-full overflow-hidden` 这些同串里各管一件事的，
 *    合并不能把它们当冲突吃掉（`ui/card`、`ui/progress` 那几档的"默认类不许丢"就靠这个）。
 * 3) **falsy 与数组/对象写法照 clsx 的语义走**：调用点大量写 `cn("x", cond && "y")`，
 *    `false`/`undefined`/`null` 必须整条丢掉，不能留下 `class="false undefined"` 这种字面。
 * 4) **空调用给空串**：`className={cn(...)}` 直接进 DOM，`undefined` 会变成
 *    `class="undefined"`（`ui/progress` 那档也判过"不许出现 undefined 字面"）。
 *
 * 有意不判：tailwind-merge **内部**的分组规则细节（哪些类互相冲突、`p-6 pt-0` 谁赢）——
 * 那是第三方库的行为，判它等于把它的版本语义钉成我们的契约；这里只判"这一层有没有真的
 * 把 clsx 的输出交给 twMerge"，具体分组各取一对最常见的冲突类当证据。
 * 调用点各自的合并结果（薄壳的默认类被谁盖掉）在各自那几档已经逐条判过。
 */

import { describe, it, expect } from "vitest";

import { cn } from "../utils";

/** 按空格切成整 token 再比——`toContain` 会让 `hover:bg-primary/90` 混成 `bg-primary`。 */
const toks = (s: string) => new Set(s.trim().split(/\s+/).filter(Boolean));

describe("cn：后面的类顶掉前面冲突的", () => {
  it("1 同一组的冲突类只留后面那只（调用点一律写 cn(默认, 覆盖)）", () => {
    for (const [a, b, winner] of [
      ["h-4", "h-2", "h-2"],
      ["p-6", "p-5", "p-5"],
      ["text-sm", "text-2xl", "text-2xl"],
      ["bg-card", "bg-primary/5", "bg-primary/5"],
    ] as [string, string, string][]) {
      const cls = toks(cn(a, b));
      expect(cls.has(winner), `${a} + ${b} 要留 ${winner}`).toBe(true);
      expect(cls.has(a), `${a} + ${b} 不许把 ${a} 留在串里`).toBe(false);
      expect(cls.size, `${a} + ${b} 合并后只剩一个 token`).toBe(1);
    }
  });

  it("2 参数顺序就是优先级：反过来的同一对类，赢家跟着换", () => {
    expect(toks(cn("h-2", "h-4")).has("h-4")).toBe(true);
    expect(toks(cn("h-2", "h-4")).has("h-2")).toBe(false);
  });

  it("3 不冲突的一条不许少（默认类那串就是这么活下来的）", () => {
    const cls = toks(cn("rounded-lg border bg-card text-card-foreground shadow-sm", "p-6"));
    for (const c of ["rounded-lg", "border", "bg-card", "text-card-foreground", "shadow-sm", "p-6"]) {
      expect(cls.has(c), `不冲突的 ${c} 不许被吃掉`).toBe(true);
    }
  });
});

describe("cn：clsx 那一半的语义", () => {
  it("4 false / undefined / null / 空串整条丢掉，结果里不许留字面量", () => {
    // 调用点满仓都写 `cn("x", cond && "y")`，所以这里要留一个真值分支和一个假值分支
    const active = true;
    const out = cn("text-sm", false, undefined, null, "", active && "font-semibold", !active && "gone");
    expect(out).toBe("text-sm font-semibold");
    expect(toks(out).has("false")).toBe(false);
    expect(toks(out).has("undefined")).toBe(false);
    expect(toks(out).has("null")).toBe(false);
  });

  it("5 数组与对象写法照 clsx 展开（调用点里有 className={cn([...])} 的写法）", () => {
    expect(cn(["a", ["b", { c: true, d: false }]])).toBe("a b c");
  });

  it("6 一个参数都不给时是空串，不是 undefined（className 直接进 DOM）", () => {
    const out = cn();
    expect(out).toBe("");
    expect(typeof out).toBe("string");
  });
});

describe("cn：token 原样透传", () => {
  it("7 带变体、斜杠透明度、任意值的类不被改写", () => {
    const keep = ["hover:bg-primary/90", "data-[state=active]:bg-accent", "w-[calc(100%-2rem)]", "border-b"];
    const cls = toks(cn(...keep));
    for (const c of keep) expect(cls.has(c), `${c} 要原样在`).toBe(true);
    expect(cls.size).toBe(keep.length);
  });

  it("8 同一个类给两遍只留一次（重复不是冲突，但也不该翻倍）", () => {
    expect(cn("p-6", "p-6")).toBe("p-6");
  });
});

/**
 * 判别力台账（2026-09-27 本机，`CI=1 npx vitest run src/lib/__tests__/utils-cn.test.ts`，
 * 红名一律从落盘日志数）。基线：`src/lib/utils.ts` = sha256 `4acbc716…`（169 字节），
 * **产品代码一行没动**：六刀每刀之后 `cp` 回基线并 `cmp` + 重核 sha，最后一刀跑完
 * `git diff --numstat` 为空。**没有一刀 0 红。** 判据短号 1..8 按书写顺序。
 *
 *  M1 摘掉 twMerge（`return clsx(inputs)`）                → **3 红**（1 2 8）
 *  M2 摘掉 clsx（`return twMerge(inputs.join(" "))`）      → **2 红**（4 5）
 *  M3 参数反序（`clsx(inputs.reverse())`）                 → **3 红**（1 2 4）
 *  M4 只取第一个参数（`clsx(inputs[0])`）                  → **5 红**（1 2 3 4 7）
 *  M5 空调用回 `undefined`（`inputs.length ? … : undefined`）→ **1 红**（6）
 *  M6 顺手"清理"方括号（`.replace(/\[[^\]]*\]/g, "")`）     → **1 红**（7）
 *     模拟"给任意值语法加一道 sanitize"那类改动。判据 7 由 M4/M6 咬住，只咬 7 的是 M6。
 *
 * 对照取证（这一档为什么还得写：那几档薄壳本来就依赖 `cn`）。把 M1 那一刀原样打进**全量**
 * `CI=1 npx vitest run`——**186 只文件 / 2565 条里 18 条红，散在 9 只文件**：
 * `card-shell` 4、`tabs-shell` 2、`select-label` 2、`button-variants` 2、`badge-variants` 2、
 * `textarea-shell` 1、`progress-shell` 1、`input-shell` 1，加上本档 3。
 * 也就是说 `cn` 坏了会有人报警，**但报的是别人家的名字**——修的人得从"卡片高度没了"倒推回
 * `lib/utils`。这一档把归因摆在源头：坏 `cn` 直接指着 `cn` 红，其余 15 条是连带。
 *
 * 过程账：判据 4 的夹具在十刀取完读数之后加了一条假值分支（`!active && "gone"`，为了让
 * `cond && "y"` 两种取值都取样）。按账上的规矩把咬住判据 4 的三把（M2 M3 M4）原样重打，
 * 读数一字不变（2 红 / 3 红 / 5 红）；`true && …` 那种字面量写法会被 `no-constant-binary-expression`
 * 拦下，所以真值分支走的是变量 `active`。
 */
