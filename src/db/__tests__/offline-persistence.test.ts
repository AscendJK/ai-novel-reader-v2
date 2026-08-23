/**
 * 离线数据持久化集成测试
 *
 * 复现用户报告的场景：离线模式下重新登录或刷新浏览器后，本地小说的
 * 目录数据不应丢失。
 *
 * 测试思路：
 * 1. 用 fake-indexeddb 模拟浏览器 IndexedDB（与 Dexie 无缝集成）
 * 2. saveNovel 写入后，"刷新" = 关闭并重建数据库连接（等同浏览器刷新
 *    后重新打开 IndexedDB）→ 数据必须仍在
 * 3. "重登" = 数据库实例重建 + loadAllNovels 从 IndexedDB 恢复
 * 4. 历史误删（章节被软删）时，shouldDownloadNovel 判定需要重新下载
 *    → 自愈机制可恢复目录
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveNovel, loadNovel, loadAllNovels, deleteNovel } from "../repositories";
import { setCurrentUser, deleteUserDB } from "../database";
import { shouldDownloadNovel } from "@/sync/novel-reconciliation";
import type { Novel } from "@/parsers/types";

function makeNovel(id: string, chapterCount: number, title = `小说${id}`): Novel {
  return {
    id,
    title,
    author: "测试作者",
    fileName: `${id}.txt`,
    fileFormat: "txt",
    totalChars: chapterCount * 100,
    chapterCount,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-ch${i}`,
      novelId: id,
      index: i,
      title: `第${i + 1}章`,
      content: `第${i + 1}章内容`.repeat(20),
      startOffset: i * 100,
      endOffset: (i + 1) * 100,
    })),
  };
}

const USER = "alice";

beforeEach(async () => {
  localStorage.setItem("sync-username", USER);
  setCurrentUser(USER);
});

afterEach(async () => {
  await deleteUserDB(USER).catch(() => {});
  localStorage.removeItem("sync-username");
});

describe("离线刷新/重登后的数据持久化", () => {
  it("saveNovel 写入后，重建数据库连接（模拟刷新）数据仍在", async () => {
    const novel = makeNovel("n1", 5);
    await saveNovel(novel);

    // 模拟浏览器刷新：关闭旧连接并重建（IndexedDB 数据本身保留）
    setCurrentUser(USER);

    const loaded = await loadNovel("n1");
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("小说n1");
    expect(loaded!.chapters).toHaveLength(5); // 章节目录完整
    expect(loaded!.chapters[0].title).toBe("第1章");
  });

  it("模拟重登：清空内存 store 后 loadAllNovels 从 IndexedDB 恢复", async () => {
    const novel = makeNovel("n1", 3);
    await saveNovel(novel);

    // 模拟 handleLogin 中 setState({ novels: [] }) 清空内存后，从 IndexedDB 重新加载
    setCurrentUser(USER);
    const restored = await loadAllNovels();
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe("n1");
    expect(restored[0].chapters).toHaveLength(3);
  });

  it("多本小说刷新后全部保留", async () => {
    await saveNovel(makeNovel("n1", 2));
    await saveNovel(makeNovel("n2", 4));
    setCurrentUser(USER);
    const restored = await loadAllNovels();
    expect(restored.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
  });
});

describe("软删与自愈判定", () => {
  it("deleteNovel 软删章节后目录消失（历史 bug 现象），但 shouldDownloadNovel 判定需要自愈下载", async () => {
    const novel = makeNovel("n1", 3);
    await saveNovel(novel);

    // 历史 bug 路径：deleteNovel 被误触发 → 章节软删 → 目录空
    await deleteNovel("n1");

    const loaded = await loadNovel("n1");
    expect(loaded).toBeNull(); // 目录消失（bug 现象）

    // 自愈判定：novel 记录还在但章节全被软删 → 需要从服务器重新下载
    const { getUserDB } = await import("../database");
    const db = getUserDB();
    const existing = await db.novels.get("n1");
    const chapters = await db.chapters.where("novelId").equals("n1").toArray();
    expect(existing).not.toBeNull();
    expect(chapters.length).toBe(3);
    expect(chapters.every((c) => c.deleted)).toBe(true);
    expect(shouldDownloadNovel(existing, chapters)).toBe(true);
  });

  it("正常数据 shouldDownloadNovel 判定为不需要下载", async () => {
    const novel = makeNovel("n1", 2);
    await saveNovel(novel);
    const { getUserDB } = await import("../database");
    const db = getUserDB();
    const existing = await db.novels.get("n1");
    const chapters = await db.chapters.where("novelId").equals("n1").toArray();
    expect(shouldDownloadNovel(existing, chapters)).toBe(false);
  });
});
