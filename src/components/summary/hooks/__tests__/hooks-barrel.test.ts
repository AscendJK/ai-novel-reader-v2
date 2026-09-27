/**
 * `summary/hooks` 这只桶的首次直接判据（地板第 1 档·桶档）。
 *
 * 7 行、3 只 re-export、全仓**只有一个人从桶里取水**：`SummaryPanel.tsx:26`
 * 一行取齐 `useNotes, useQA, useSearch`（实测 grep 桶路径只有这一处命中）。
 *
 * 为什么这只桶必须自己写判据：`SummaryPanel-internals.test.tsx:88` **把这只桶整只 `vi.mock` 掉了**
 * （三只都换成假 hook）。于是"桶里这只名字指的是哪只真 hook""桶少没少一只"这两件事在那一档
 * 一条都判不到——`SummaryPanel` 的测试全绿，真应用里 `useQA` 若是 `undefined`，打开面板直接崩。
 * 同职的 `summary/shared` 那只桶也是这个形状（账上记着：被整只 mock 的壳是最隐蔽的跨薄壳）。
 *
 * 判这三格与 `tabs` 那只桶同一口径：
 * 1. 从桶里拿到的就是那只文件里的**同一个函数引用**——桶里包一层壳（`useQA: (p) => inner(p)`）
 *    在这里红：引用不再是同一只，React 眼里就成了另一个 hook；
 * 2. 函数自己的 `name` 就是出口名（`export { useNotes as useQA }` 那种别名指错，名字这一半也得上）；
 * 3. 出口集合恰好这 3 只，不多不少——少一只是拆 `SummaryPanel` 的水管，
 *    多挂一只（没人从桶里取）在这里红一次，逼那次改动看一眼有没有真消费者。
 *
 * 有意不判：三只 hook 各自的行为（`useNotes`／`useQA`／`useSearch` 那几档已判过，
 * 含"忙时不许双发"和清理链）；桶会不会造成循环依赖——那是 import 图的事，不是这 7 行定的。
 */

import { describe, it, expect } from "vitest";

import * as barrel from "../index";
import { useNotes } from "../useNotes";
import { useQA } from "../useQA";
import { useSearch } from "../useSearch";

const PAIRS: Array<[string, unknown]> = [
  ["useNotes", useNotes],
  ["useQA", useQA],
  ["useSearch", useSearch],
];

// 桶少一只时这里要拿到 `undefined` 并干净地红，而不是抛 TypeError 把整条用例撞掉
const ns = barrel as Record<string, unknown>;

describe("summary/hooks 这只桶", () => {
  it("1 桶里三只都就是各自文件里的那一只函数（包一层壳或转错模块就红）", () => {
    for (const [name, direct] of PAIRS) {
      expect(ns[name], name).toBe(direct);
    }
  });

  it("2 函数自己的名字就是出口名——别名指错时引用会跟着错，名字这一半也得对得上", () => {
    for (const [name] of PAIRS) {
      expect((ns[name] as { name?: string } | undefined)?.name, name).toBe(name);
    }
  });

  it("3 出口集合恰好这三只，不多不少（SummaryPanel 一行取齐三只）", () => {
    expect(Object.keys(barrel).sort()).toEqual(["useNotes", "useQA", "useSearch"]);
  });
});

/**
 * 判别力台账（2026-09-27 本机，`CI=1 npx vitest run src/components/summary/hooks/__tests__/hooks-barrel.test.ts`，
 * 红名一律从落盘日志数）。基线：`src/components/summary/hooks/index.ts` = sha256 `b09dd70c…`（151 字节），
 * **产品代码一行没动**：四刀每刀之后 `cp` 回基线并 `cmp` + 重核 sha，最后一刀跑完
 * `git diff --numstat` 为空。**没有一刀 0 红。** 格1＝引用同一只、格2＝函数自己的 name、
 * 格3＝出口集合恰好三只。
 *
 *  J1 删掉 `export { useQA } from "./useQA"`                     → **3 红**（格1 格2 格3）
 *  J2 别名指错：`export { useSearch } from "./useSearch"` 改成
 *     `export { useNotes as useSearch } from "./useNotes"`       → **2 红**（格1 格2）
 *  J3 桶里包一层壳（`export const useQA = (...a) => impl(...a)`） → **1 红**（格1）
 *     一处语义改动、两处字面改动（加 import 别名 + 换成本地 const）；名字仍是 `useQA`、
 *     出口集合仍是三只，所以"包一层壳"这一格只有引用相等判得住——hook 尤其要紧：
 *     引用一变，`SummaryPanel` 里那就是另一个 hook 位。
 *  J4 顺手多挂一只没人从桶里取的（`export { useSummarizer } from "@/hooks/useSummarizer"`）
 *                                                               → **1 红**（格3）
 *
 * 对照取证：把 J1 那一刀原样再打一遍，跑整棵 `src/components/summary/`——**21 只文件 / 329 条**，
 * 只有本档这 3 条红。`SummaryPanel-internals.test.tsx` 里三只 hook 都是 `vi.mock` 出来的假货，
 * `useQA` 自己的判据（含"忙时不许双发"那档）直接 import 真文件，两边都照常全绿。
 * 这一刀打进真应用是"打开分析面板就崩"，原来的测试面一条都不报。
 *
 * 与 `tabs` 那只桶同一格取不出来的：没有一把刀只咬住格2——re-export 里指错模块与拼错名字
 * 是同一次改动，格1 与格2 在 J2 那把一起红。
 */
