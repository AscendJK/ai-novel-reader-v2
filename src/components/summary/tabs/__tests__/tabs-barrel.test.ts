/**
 * `summary/tabs` 这只桶的首次直接判据（地板第 1 档·桶档）。
 *
 * 9 行、5 只 re-export、全仓**只有一个人从桶里取水**：`SummaryPanel.tsx:27`
 * 一行取齐 `QATab, ChapterTab, BookTab, NotesTab, SearchTab`（实测 grep 桶路径只有这一处命中）。
 *
 * 为什么要给一只桶写判据：全仓唯一看着 `SummaryPanel` 的那一档
 * `SummaryPanel-internals.test.tsx:93` **把这只桶整只 `vi.mock` 掉了**（五只都换成桩）。
 * 也就是说"桶里这个名字指的是哪只真文件""桶少没少一只"这两件事，在那一档一条都判不到——
 * 这是跨薄壳里最隐蔽的一种：调用点的测试全绿，而真应用里 `SummaryPanel` 拿到的是 `undefined`，
 * 打开面板直接崩。账上已有同类的记录（`summary/shared` 那只桶两边都被整只 mock）。
 *
 * 判这两格：
 * 1. **从桶里拿到的就是那只具体文件里的同一个**（引用相等，且函数自身的 `name` 也对得上）——
 *    转手转错模块、`export { NotesTab as SearchTab }` 那种别名指错，都在这红。
 * 2. **出口集合恰好这 5 只，不多不少**——少一只是把 `SummaryPanel` 的水管拆了；
 *    多挂一只（没人从桶里取）在这红一次，逼那次改动去看一眼有没有真消费者。
 *    与 `summary/shared` 那只桶的区别记一下：那只 9 个出口只有 1 个有人取，按「死代码不写判据、
 *    给删的理由」删了 8 行；这只 5 行全有人在取，所以不删、只钉。
 *
 * 有意不判：五只 Tab 各自的行为（`QATab`／`ChapterTab`／`BookTab`／`NotesTab`／`SearchTab`
 * 那几档已经判过）；桶会不会造成循环依赖——那是打包器与 import 图的事，不是这 9 行定的。
 */

import { describe, it, expect } from "vitest";

import * as barrel from "../index";
import { QATab } from "../QATab";
import { ChapterTab } from "../ChapterTab";
import { BookTab } from "../BookTab";
import { NotesTab } from "../NotesTab";
import { SearchTab } from "../SearchTab";

const PAIRS: Array<[string, unknown]> = [
  ["QATab", QATab],
  ["ChapterTab", ChapterTab],
  ["BookTab", BookTab],
  ["NotesTab", NotesTab],
  ["SearchTab", SearchTab],
];

// 桶少一只时这里要拿得到 `undefined` 并干净地红，而不是抛 TypeError 把整条用例撞掉
const ns = barrel as Record<string, unknown>;

describe("summary/tabs 这只桶", () => {
  it("1 桶里五只都就是各自文件里的那一只（转手转错了模块就红）", () => {
    for (const [name, direct] of PAIRS) {
      expect(ns[name], name).toBe(direct);
    }
  });

  it("2 函数自己的名字就是出口名——别名指错时引用会跟着错，名字这一半也得对得上", () => {
    for (const [name] of PAIRS) {
      expect((ns[name] as { name?: string } | undefined)?.name, name).toBe(name);
    }
  });

  it("3 出口集合恰好这五只，不多不少（SummaryPanel 一行取齐五只）", () => {
    expect(Object.keys(barrel).sort()).toEqual(
      ["BookTab", "ChapterTab", "NotesTab", "QATab", "SearchTab"],
    );
  });
});

/**
 * 判别力台账（2026-09-27 本机，`CI=1 npx vitest run src/components/summary/tabs/__tests__/tabs-barrel.test.ts`，
 * 红名一律从落盘日志数）。基线：`src/components/summary/tabs/index.ts` = sha256 `9fbc5cd5…`（235 字节），
 * **产品代码一行没动**：四刀每刀之后 `cp` 回基线并 `cmp` + 重核 sha，最后一刀跑完
 * `git diff --numstat` 为空。**没有一刀 0 红。** 下面用「格」指代三条判据：
 * 格1＝引用同一只、格2＝函数自己的 name、格3＝出口集合恰好五只。
 *
 *  G1 删掉 `export { BookTab } from "./BookTab"`                → **3 红**（格1 格2 格3）
 *  G2 别名指错：`export { SearchTab } from "./SearchTab"` 改成
 *     `export { NotesTab as SearchTab } from "./NotesTab"`      → **2 红**（格1 格2）
 *  G3 桶里就地写第二份实现（`export const QATab = () => null`）  → **1 红**（格1）
 *     ★这一把只有格1 咬得住：名字仍是 `QATab`、出口集合仍是五只——"桶变成第二份实现"
 *       那一格全靠引用相等，格2 只在别名指错那种坏法里才出力。
 *  G4 顺手多挂一只没人从桶里取的（`export { DataMgr } from "../shared"`）→ **1 红**（格3）
 *
 * 对照取证（这一档真正要证明的是"桶被整只 mock 时没人看着"）：把 G1 那一刀原样再打一遍，
 * 跑 `src/components/summary/__tests__/` + `src/components/summary/tabs/`——**10 只文件 / 168 条**，
 * 只有本档这 3 条红。`SummaryPanel-internals.test.tsx` 拿着桩照常全绿，`BookTab` 自己的判据
 * 直接 import 真文件也照常全绿。这一刀打进真应用是"打开全书分析那一页就崩"，而原来的测试面
 * 一条都不报——这就是给一只 9 行的桶写判据的理由。
 *
 * 记一格取不出来的：没有一把刀只咬住格2（name）。在 re-export 里"指错模块"与"拼错名字"是
 * 同一次改动（`export { X as Y }`），所以格1 与格2 在 G2 那把一起红，分开取样分不出来。
 */
