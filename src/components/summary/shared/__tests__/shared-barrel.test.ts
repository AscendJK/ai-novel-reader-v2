/**
 * `summary/shared` 这只桶——只留有人在用的那一格，并把"只留这一格"钉住
 *
 * 为什么要判一只 14 行的桶：它是 `SummaryPanel.tsx:25` 拿 `DataMgr` 的那条路，也是
 * `SummaryPanel-internals.test.tsx:106` 整只 `vi.mock` 的那个面（跨薄壳里最隐蔽的一种——
 * 壳自己没人看着，两边都从它取水）。
 *
 * 但其余 8 行 re-export **全仓没有一个人从桶里取**：`MarkdownRenderer`／`MiniCard`／`Row`／
 * `SubItem`／`DataMgr` 之外的那些名字，调用点都是直接 import 各自那只文件（grep 只有上面两处
 * 命中桶路径）。按「死代码不写判据、给删的理由」，那 8 行删掉；这里只判留下来的那一格：
 * 1. 桶里拿到的 `DataMgr` 必须就是 `./DataMgr` 那一只（同一个函数引用，不是转手转错了模块）；
 * 2. 桶的运行时出口集合恰好是 `{ DataMgr }`。这条是给"下次有人顺手再挂两个 export"准备的：
 *    挂在桶上不等于有人在用，而在这里会让它红一次，逼那次改动看一眼有没有真消费者。
 *
 * 有意不判：`DataMgr` 自己的行为（删除链、回执、按 type 落库）在 `DataMgr-rows.test.tsx` 那一档。
 */
import { describe, it, expect } from "vitest";
import * as barrel from "../index";
import { DataMgr as direct } from "../DataMgr";

describe("summary/shared 这只桶", () => {
  it("1. 从桶里拿到的就是 ./DataMgr 那一只，不是转手转错了模块", () => {
    expect(barrel.DataMgr).toBe(direct);
    // 名字也要对得上：`export { Row as DataMgr }` 这种指错，光看引用相等抓不住拼错的那一半
    expect(barrel.DataMgr.name).toBe("DataMgr");
  });

  it("2. 出口集合恰好是 DataMgr 一个", () => {
    // 类型出口（`export type { … }`）在运行时不存在，所以这里数到的是"真有人在用的那几格"
    expect(Object.keys(barrel).sort()).toEqual(["DataMgr"]);
  });
});
