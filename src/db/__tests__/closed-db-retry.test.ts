/**
 * 数据库被关闭后的重试守卫（round 3 R-78）
 *
 * loadSummaries 的注释自称"与 loadAllNovelMeta 相同的兜底"，实际写的是 `if (db2)`：
 * getUserDB() 永不返回假值（要么给实例要么抛错），条件恒真。所以当拿回来的还是
 * **同一个已关闭实例**时，重试会原地递归直到 RangeError 崩页面，而不是退化成空列表。
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { loadSummaries, saveSummary } from "../repositories";
import { getUserDB, setCurrentUser } from "../database";

const USER = "closed-retry-user";

describe("loadSummaries 的关闭重试守卫", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("sync-username", USER);
    setCurrentUser(USER);
  });

  it("实例仍是同一个已关闭库时返回空列表，不原地递归", async () => {
    await saveSummary({
      id: "s1", novelId: "n1", chapterId: "c1", chapterTitle: "第一章",
      content: "总结", tokensUsed: 1, createdAt: 1, updatedAt: 1, type: "chapter",
    });
    const closed = getUserDB();
    await closed.close();

    await expect(loadSummaries("n1")).resolves.toEqual([]);
  });
});
