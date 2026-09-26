/**
 * SummaryPanel 共享组件导出
 *
 * 只转手 `DataMgr` 这一格——`SummaryPanel.tsx:25` 从这儿拿它，`SummaryPanel-internals.test.tsx`
 * 也整只 mock 这个面。其余 8 行 re-export 全仓没人从桶里取（调用点都直接 import 各自那只文件），
 * 已按「死代码不写判据、给删的理由」删掉；出口集合由 `__tests__/shared-barrel.test.ts` 钉着。
 */

export { DataMgr } from "./DataMgr";
