import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { shouldDownloadNovel, shouldDeleteLocalNovel, rekeyNovelOwnedRows } from "../novel-reconciliation";
import { getUserDB, setCurrentUser, deleteUserDB, type MapRecord } from "@/db/database";
import type { NovelRecord, ChapterRecord } from "@/db/database";

const novel = (over: Partial<NovelRecord> = {}): NovelRecord => ({
  id: "novel-1",
  title: "测试小说",
  fileName: "test.txt",
  fileFormat: "txt",
  totalChars: 1000,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const chapter = (over: Partial<ChapterRecord> = {}): ChapterRecord => ({
  id: "ch1",
  novelId: "novel-1",
  index: 0,
  title: "第一章",
  content: "内容",
  startOffset: 0,
  endOffset: 4,
  ...over,
});

describe("novel-reconciliation", () => {
  describe("shouldDownloadNovel", () => {
    it("本地无记录 → 需要下载（首次从服务器拉取）", () => {
      expect(shouldDownloadNovel(null, [])).toBe(true);
      expect(shouldDownloadNovel(undefined, undefined)).toBe(true);
    });

    it("本地有记录且有未软删章节 → 不需要下载", () => {
      expect(shouldDownloadNovel(novel(), [chapter()])).toBe(false);
      expect(shouldDownloadNovel(novel(), [chapter({ deleted: 5 }), chapter()])).toBe(false);
    });

    it("本地有记录但章节为空 → 需要下载（自愈）", () => {
      expect(shouldDownloadNovel(novel(), [])).toBe(true);
      expect(shouldDownloadNovel(novel(), null)).toBe(true);
      expect(shouldDownloadNovel(novel(), undefined)).toBe(true);
    });

    it("本地有记录但章节全部被软删 → 需要下载（目录自愈恢复）", () => {
      const softDeleted = [chapter({ deleted: 100 }), chapter({ id: "ch2", index: 1, deleted: 101 })];
      expect(shouldDownloadNovel(novel(), softDeleted)).toBe(true);
    });
  });

  describe("shouldDeleteLocalNovel", () => {
    it("永远不自动删除本地副本——本地数据只能由用户显式删除", () => {
      // 覆盖所有自动同步场景：join 失败、网络异常、服务器列表对比
      expect(shouldDeleteLocalNovel()).toBe(false);
      expect(shouldDeleteLocalNovel()).toBe(false);
    });
  });
});

/**
 * 认亲重键时 maps/graphs 的主键迁移（round 2 批次 1b / R-15）。
 * 这两张表用 novelId 当主键，只改字段不改键会让整本书的地图在界面上消失。
 */
const mapRow = (over: Partial<MapRecord> = {}): MapRecord => ({
  id: "local-old",
  novelId: "local-old",
  data: { places: ["酒馆"] },
  createdAt: 1,
  updatedAt: 10,
  ...over,
});

describe("rekeyNovelOwnedRows", () => {
  const USER = "rekey-user";

  beforeEach(() => {
    localStorage.setItem("sync-username", USER);
    setCurrentUser(USER);
  });

  afterEach(async () => {
    await deleteUserDB(USER).catch(() => {});
    localStorage.removeItem("sync-username");
  });

  it("按新 novelId 能取到地图行，旧键不再残留", async () => {
    const udb = getUserDB();
    await udb.maps.put(mapRow());

    await rekeyNovelOwnedRows(udb.maps, await udb.maps.where("novelId").equals("local-old").toArray(), "server-new", "maps");

    expect(await udb.maps.get("server-new")).toMatchObject({ novelId: "server-new", data: { places: ["酒馆"] } });
    expect(await udb.maps.get("local-old")).toBeUndefined();
    expect(await udb.maps.toArray()).toHaveLength(1);
  });

  it("空集合不做任何写入", async () => {
    const udb = getUserDB();
    await rekeyNovelOwnedRows(udb.maps, [], "server-new", "maps");
    expect(await udb.maps.toArray()).toHaveLength(0);
  });

  it("异常出现多行时折叠成一行而不是互相覆盖成脏数据", async () => {
    const udb = getUserDB();
    const rows = [mapRow({ id: "a", novelId: "a", updatedAt: 5 }), mapRow({ id: "b", novelId: "b", updatedAt: 9 })];
    for (const r of rows) await udb.maps.put(r);

    await rekeyNovelOwnedRows(udb.maps, rows, "server-new", "maps");

    const after = await udb.maps.toArray();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe("server-new");
  });
});
