/**
 * 书架加载链路集成测试
 * 模拟"用户已登录（localStorage 有 sync-username）→ IndexedDB 有小说数据
 * → loadAllNovelMeta()/loadAllNovels() 应返回数据"的场景，
 * 复现/验证"刷新后书架消失"问题。
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveNovel, loadAllNovelMeta, loadAllNovels } from "../repositories";
import { setCurrentUser, deleteUserDB } from "../database";
import type { Novel } from "@/parsers/types";

function makeNovel(id: string, title: string, chapterCount = 3): Novel {
  const now = Date.now();
  return {
    id,
    title,
    author: "作者",
    fileName: `${id}.txt`,
    fileFormat: "txt" as const,
    totalChars: 10000,
    chapterCount,
    createdAt: now,
    updatedAt: now,
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-ch-${i}`,
      novelId: id,
      index: i,
      title: `第${i + 1}章`,
      content: `内容${i + 1}`,
      startOffset: i * 10,
      endOffset: (i + 1) * 10,
    })),
  };
}

const USER = "test-user";

describe("书架加载链路（刷新场景）", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("sync-username", USER);
    setCurrentUser(USER);
  });

  afterEach(async () => {
    localStorage.clear();
    try { await deleteUserDB(USER); } catch { /* ignore */ }
  });

  it("已登录 + IndexedDB 有数据时 loadAllNovelMeta 返回书架", async () => {
    await saveNovel(makeNovel("n1", "小说1", 3));
    await saveNovel(makeNovel("n2", "小说2", 2));

    const meta = await loadAllNovelMeta();
    expect(meta.map((m) => m.id).sort()).toEqual(["n1", "n2"]);
    expect(meta.find((m) => m.id === "n1")?.chapterCount).toBe(3);
  });

  it("已登录 + IndexedDB 有数据时 loadAllNovels 返回完整小说", async () => {
    await saveNovel(makeNovel("n1", "小说1", 3));

    const novels = await loadAllNovels();
    expect(novels).toHaveLength(1);
    expect(novels[0].chapters).toHaveLength(3);
  });

  it("模拟刷新：重建数据库连接后仍能读到书架数据", async () => {
    await saveNovel(makeNovel("n1", "小说1", 3));

    // 模拟刷新：关闭旧连接，重新 setCurrentUser（新 Dexie 实例 + 同一 IndexedDB）
    setCurrentUser(USER);
    const meta = await loadAllNovelMeta();
    expect(meta.map((m) => m.id)).toContain("n1");
  });

  it("竞态：loadAllNovelMeta 读取期间 setCurrentUser 重复初始化不应抛 DatabaseClosedError", async () => {
    await saveNovel(makeNovel("n1", "小说1", 3));

    // 书架加载已启动（拿到当前实例引用，异步读取中）
    const metaPromise = loadAllNovelMeta();
    // 读取进行中，另一流程再次 setCurrentUser 同一用户
    // （模拟重新登录/重复初始化）—— 修复前会 close 正在使用的旧实例
    setCurrentUser(USER);
    const meta = await metaPromise;
    // 书架必须仍然读到数据，而不是 DatabaseClosedError 后返回 []
    expect(meta.map((m) => m.id)).toContain("n1");
  });

  it("竞态：切换用户时旧库读取不被新库关闭打断（不抛 DatabaseClosedError）", async () => {
    await saveNovel(makeNovel("n1", "小说1", 3));

    // 旧用户书架加载启动
    const metaPromise = loadAllNovelMeta();
    // 用户切换到新账号（会关闭旧库实例）
    setCurrentUser("another-user");
    // 不抛 DatabaseClosedError：重试后返回当前用户（新用户）的书架数据
    const meta = await metaPromise;
    expect(Array.isArray(meta)).toBe(true);
    // 当前用户已切换，书架读的是新用户库（空）
    const newMeta = await loadAllNovelMeta();
    expect(newMeta).toEqual([]);
    await deleteUserDB("another-user");
  });
});
