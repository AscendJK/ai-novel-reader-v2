/**
 * gatherChanges 的分批契约测试（round 2 批次 1 / R-01）
 *
 * 这里守的是"增量收集游标绝不能越过还没推的记录"这条不变量。
 * round 1 修分页死循环时把游标改成了"本批四表 updatedAt 的最大值"，而每张表
 * 各自截断 50 条——只要有一张表的一条新记录时间戳更大，游标就会跳过其他表
 * 尚未推送的积压，且水位随后提交 → 那些记录永久不再上行（无任何报错）。
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { gatherChanges, type GatherResult } from "../sync-bridge";
import { setCurrentUser, deleteUserDB, getUserDB } from "@/db/database";

const USER = "cursor-tester";
const BATCH = 50;

/** sync-client.ts 推进游标的方式：pushFloor = 上一批返回的保守游标，
 *  并把上一批推过的全部 id 加入排除集（见 settleAfterPush） */
function pushedIdsOf(gathered: GatherResult): Set<string> {
  const d = gathered.data;
  return new Set<string>([
    ...(d.summaries ?? []),
    ...(d.notes ?? []),
    ...(d.maps ?? []),
    ...(d.graphs ?? []),
  ].map((row) => row.id));
}

async function seed(
  rows: { summaries?: number[]; notes?: number[]; maps?: number[]; graphs?: number[] }
) {
  const udb = getUserDB();
  let n = 0;
  const put = async (table: "summaries" | "notes" | "maps" | "graphs", timestamps: number[]) => {
    for (const updatedAt of timestamps) {
      const id = `${table}-${n++}`;
      const base = { id, novelId: "novel-1", updatedAt, createdAt: 1, content: "c", data: {} as unknown };
      if (table === "summaries") await udb.summaries.put({ ...base, type: "chapter", chapterId: "c1" } as never);
      else if (table === "notes") await udb.notes.put({ ...base, chapterId: "c1", source: "user" } as never);
      else if (table === "maps") await udb.maps.put({ ...base, novelId: id } as never);
      else await udb.graphs.put({ ...base, novelId: id } as never);
    }
  };
  for (const key of ["summaries", "notes", "maps", "graphs"] as const) {
    if (rows[key]) await put(key, rows[key]!);
  }
}

const seq = (count: number, start: number, step = 1) =>
  Array.from({ length: count }, (_, i) => start + i * step);

beforeEach(async () => {
  localStorage.setItem("sync-username", USER);
  setCurrentUser(USER);
});

afterEach(async () => {
  await deleteUserDB(USER).catch(() => {});
  localStorage.removeItem("sync-username");
});

describe("gatherChanges 分批游标不变量", () => {
  it("两张表都有积压时，游标不得越过未推送的记录", async () => {
    // 51 条旧摘要（100..150）+ 1 条很新的地图（10000）
    await seed({ summaries: seq(51, 100), maps: [10000] });

    const first = await gatherChanges(0);
    expect(first.data.summaries).toHaveLength(BATCH);
    expect(first.hasMore).toBe(true);

    const second = await gatherChanges(first.maxUpdatedAt, pushedIdsOf(first));
    const ids = (second.data.summaries as { id: string }[]).map((s) => s.id);
    // 第 51 条摘要必须还能被收集到
    expect(ids).toContain("summaries-50");
  });

  it("游标推进后仍会重复取到未积压表的内容也不算错，但不得丢记录", async () => {
    // 摘要 120 条 + 笔记 3 条，笔记时间戳穿插在摘要之间
    await seed({ summaries: seq(120, 1000), notes: [1050, 1090, 5000] });

    const seen = new Set<string>();
    let floor = 0;
    let exclude: ReadonlySet<string> | undefined;
    for (let round = 0; round < 12; round++) {
      const g = await gatherChanges(floor, exclude);
      for (const s of g.data.summaries as { id: string }[]) seen.add(s.id);
      for (const s of g.data.notes as { id: string }[]) seen.add(s.id);
      if (!g.hasMore) break;
      exclude = pushedIdsOf(g);
      floor = g.maxUpdatedAt;
    }
    expect(seen.size).toBe(123); // 120 摘要 + 3 笔记，一条都不能少
  });

  it("同一毫秒超过一批时，靠边界排除集把剩余记录推完", async () => {
    await seed({ summaries: seq(BATCH + 10, 500, 0) }); // 全部 updatedAt=500

    const first = await gatherChanges(0);
    expect(first.data.summaries).toHaveLength(BATCH);
    const second = await gatherChanges(first.maxUpdatedAt, pushedIdsOf(first));
    expect((second.data.summaries as unknown[]).length).toBe(10);
    expect(second.hasMore).toBe(false);
  });

  it("恰好一批不算 hasMore，且此时游标就是本批真实最大值", async () => {
    await seed({ summaries: seq(BATCH, 200) });
    const exact = await gatherChanges(0);
    expect(exact.hasMore).toBe(false);
    expect(exact.maxUpdatedAt).toBe(200 + BATCH - 1);
  });

  it("软删记录仍要被收集（删除必须跨设备传播）", async () => {
    const udb = getUserDB();
    await udb.notes.put({
      id: "note-deleted", novelId: "novel-1", content: "c", source: "user",
      createdAt: 1, updatedAt: 700, deleted: 700,
    } as never);
    const g = await gatherChanges(0);
    const ids = (g.data.notes as { id: string }[]).map((n) => n.id);
    expect(ids).toContain("note-deleted");
  });
});
