/**
 * 同步上行的"收集"与"落库"（批次 G / src/db + sync-bridge 的接缝）
 *
 * 这里刻意不用 mock 拦掉 Dexie：gatherChanges 依赖的正是"这四张表都声明了 updatedAt
 * 索引"这件事——它跨文件（表在 database.ts 声明、查询在 sync-bridge.ts 写），类型检查看不见，
 * 少一个索引真机上是 NotFoundError，而测试里如果桩掉表就永远发现不了。
 * 同理，"API 密钥只存浏览器、永不上传"这条硬规则也只由这里的一行 filter 守着。
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sharedDB, setCurrentUser, deleteUserDB, getUserDB } from "../database";
import { gatherChanges, applyServerData } from "@/sync/sync-bridge";
import { userKey } from "@/lib/user-utils";

const USER = "sync-bridge-user";
const OTHER = "someone-else";

const summary = (id: string, updatedAt: number) => ({
  id, chapterId: `${id}-ch`, chapterTitle: "第一章", novelId: "book-1",
  content: `总结 ${id}`, tokensUsed: 1, createdAt: 1, updatedAt, type: "chapter",
});
const note = (id: string, updatedAt: number) => ({
  id, novelId: "book-1", chapterId: `${id}-ch`, chapterTitle: "第一章",
  content: `笔记 ${id}`, source: "user" as const, sourceLabel: "手动", createdAt: 1, updatedAt,
});
const stamped = (table: string, id: string, updatedAt: number) => ({
  id, novelId: "book-1", data: { table, id }, createdAt: 1, updatedAt,
});

async function seed(spec: {
  summaries?: { count: number; base?: number };
  notes?: { count: number; base?: number };
  maps?: { count: number; base?: number };
  graphs?: { count: number; base?: number };
}) {
  const udb = getUserDB();
  const put = async (table: "summaries" | "notes" | "maps" | "graphs", n: number, base: number, make: (id: string, t: number) => object) => {
    const rows = Array.from({ length: n }, (_, i) => make(`${table}-${i}`, base + i));
    // 四张表的 Table 联合类型不能让 bulkPut 直接调（TS 会拒绝联合签名），按表名取再断言
    await (udb[table] as { bulkPut: (rows: object[]) => Promise<unknown> }).bulkPut(rows);
  };
  await put("summaries", spec.summaries?.count ?? 0, spec.summaries?.base ?? 1, summary);
  await put("notes", spec.notes?.count ?? 0, spec.notes?.base ?? 1, note);
  await put("maps", spec.maps?.count ?? 0, spec.maps?.base ?? 1, (id, t) => stamped("maps", id, t));
  await put("graphs", spec.graphs?.count ?? 0, spec.graphs?.base ?? 1, (id, t) => stamped("graphs", id, t));
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem("sync-username", USER);
  setCurrentUser(USER);
  await sharedDB.settings.clear();
});

afterEach(async () => {
  localStorage.clear();
  await deleteUserDB(USER);
  await deleteUserDB(OTHER);
});

describe("gatherChanges 用真实索引收集四张表", () => {
  it("四张表都能按 updatedAt 收集（少一个索引真机上是 NotFoundError）", async () => {
    await seed({ summaries: { count: 2 }, notes: { count: 2 }, maps: { count: 1 }, graphs: { count: 1 } });
    const r = await gatherChanges(0);
    expect(r.data.summaries).toHaveLength(2);
    expect(r.data.notes).toHaveLength(2);
    expect(r.data.maps).toHaveLength(1);
    expect(r.data.graphs).toHaveLength(1);
  });

  it("增量路径 where(\"updatedAt\") 同样走得通，并且包含游标本身", async () => {
    await seed({ summaries: { count: 5 } });
    // seed 出的 updatedAt 是 1..5；游标 3 这条必须也被取到——用严格大于会把
    // "游标停在时间戳上、该时间戳还有没推过的记录"这种情形永久跳过
    const r = await gatherChanges(3);
    expect(r.data.summaries!.map((s) => s.id).sort()).toEqual(["summaries-2", "summaries-3", "summaries-4"]);
  });

  it("平局边界：游标停在某个时间戳时，同时间戳里没推过的记录还要能被取到", async () => {
    const udb = getUserDB();
    await udb.summaries.bulkPut([summary("a", 10), summary("b", 10), summary("c", 20)] as never[]);
    const r = await gatherChanges(10, new Set(["a", "b"]));
    expect(r.data.summaries!.map((s) => s.id)).toEqual(["c"]);
  });
});

describe("分批游标不许越过还没推送的积压", () => {
  it("只有一张表被截断时，下一批起点是该表的批内最大值，不是四表并集最大值", async () => {
    // summaries 60 条（updatedAt 1..60，第一批 50 条会被截断）；notes 3 条时间戳更大但没被截断
    await seed({ summaries: { count: 60, base: 1 }, notes: { count: 3, base: 500 } });
    const r = await gatherChanges(0);
    expect(r.hasMore).toBe(true);
    expect(r.data.summaries).toHaveLength(50);
    // 并集最大值是 notes 的 502 —— 拿它当游标会直接跳过 summaries 的 51..60，水位一提交就永久不上行
    expect(r.maxUpdatedAt).toBe(50);
  });

  it("两张表都被截断时取二者批内最大值的最小值（保守）", async () => {
    // 两张表都被截断：summaries 批内最大 50，maps 批内最大 1049。取 50 才安全
    await seed({ summaries: { count: 60, base: 1 }, maps: { count: 55, base: 1000 } });
    const r = await gatherChanges(0);
    expect(r.data.summaries).toHaveLength(50);
    expect(r.data.maps).toHaveLength(50);
    expect(r.maxUpdatedAt).toBe(50);
  });

  it("没有任何表被截断时，游标就是本批真实最大值", async () => {
    await seed({ summaries: { count: 4 }, notes: { count: 2 } });
    const r = await gatherChanges(0);
    expect(r.hasMore).toBe(false);
    expect(r.maxUpdatedAt).toBe(4);
  });
});

describe("上行内容的边界：密钥与遗留键都不许出去", () => {
  it("API 提供商配置与激活指针绝不进 settings（密钥只存浏览器）", async () => {
    await sharedDB.settings.bulkPut([
      { key: `api-providers:${USER}`, value: { providers: [{ apiKey: "sk-SECRET-DO-NOT-SYNC" }] } },
      { key: `api-active-provider:${USER}`, value: "p1" },
      { key: `reading-theme:${USER}`, value: "sepia" },
    ] as never[]);
    const r = await gatherChanges(0);
    expect(Object.keys(r.data.settings!)).toEqual([`reading-theme:${USER}`]);
    expect(JSON.stringify(r.data.settings)).not.toContain("sk-SECRET-DO-NOT-SYNC");
    expect(JSON.stringify(r.data.settings)).not.toContain("api-providers");
  });

  it("人物图谱已迁到 graphs 表，旧的 character-graph: 设置键不再上行", async () => {
    await sharedDB.settings.put({ key: `character-graph:${USER}`, value: { nodes: [] } } as never);
    const r = await gatherChanges(0);
    expect(r.data.settings!["character-graph:" + USER]).toBeUndefined();
  });

  it("阅读进度取的是带用户名后缀的那份，不碰别人的", async () => {
    localStorage.setItem(userKey("novel-reader-positions"), JSON.stringify({ "book-1": { chapter: 3, updatedAt: 5 } }));
    localStorage.setItem(`novel-reader-positions:${OTHER}`, JSON.stringify({ "book-1": { chapter: 99, updatedAt: 9 } }));
    localStorage.setItem(`novel-reader-positions`, JSON.stringify({ "book-1": { chapter: 7, updatedAt: 7 } }));
    const r = await gatherChanges(0);
    expect(r.data.progress?.readingPositions).toEqual({ "book-1": { chapter: 3, updatedAt: 5 } });
  });

  it("进度键是坏 JSON 时按空进度上行，而不是让整个收集抛错", async () => {
    localStorage.setItem(userKey("novel-reader-positions"), "{ 不是 JSON");
    const r = await gatherChanges(0);
    expect(r.data.progress?.readingPositions).toEqual({});
  });
});

describe("applyServerData 的命名空间隔离", () => {
  it("服务器下发的普通设置键必须落到带用户名后缀的键上", async () => {
    await applyServerData({ settings: { "reading-theme": "dark" } } as never);
    expect(await sharedDB.settings.get(`reading-theme:${USER}`)).toBeTruthy();
    expect(await sharedDB.settings.get("reading-theme")).toBeUndefined();
  });

  it("已经带本用户后缀的键不重复加后缀", async () => {
    await applyServerData({ settings: { [`reading-theme:${USER}`]: "green" } } as never);
    expect(await sharedDB.settings.get(`reading-theme:${USER}`)).toEqual({ key: `reading-theme:${USER}`, value: "green" });
    expect(await sharedDB.settings.get(`reading-theme:${USER}:${USER}`)).toBeUndefined();
  });

  it("下发的记录按 updatedAt 谁新听谁的，本地更新的不能被旧数据盖掉", async () => {
    const udb = getUserDB();
    await udb.summaries.put(summary("s1", 100) as never);
    await applyServerData({ summaries: [summary("s1", 50)] } as never);
    expect((await udb.summaries.get("s1"))!.content).toBe("总结 s1");
    await applyServerData({ summaries: [{ ...summary("s1", 200), content: "服务器新总结" }] } as never);
    expect((await udb.summaries.get("s1"))!.content).toBe("服务器新总结");
  });

  it("合并写回时保留本地独有字段，不被下发的裸对象整体覆盖", async () => {
    const udb = getUserDB();
    await udb.notes.put({ ...note("n1", 10), sourceLabel: "本地标注" } as never);
    await applyServerData({ notes: [{ id: "n1", novelId: "book-1", chapterId: "c", chapterTitle: "t", content: "新内容", source: "user", updatedAt: 20 }] } as never);
    const after = await udb.notes.get("n1");
    expect(after!.content).toBe("新内容");
    expect(after!.sourceLabel).toBe("本地标注");
  });
});
