/**
 * 降级标记要过得了服务端那一趟（真 SQLite，不桩）
 *
 * 本地存住了不算数：同步下来是**整行覆盖**（`sync-bridge.ts` 用服务端那份 put 回本地），
 * 服务端没有这一列 → 读回 undefined → 卡片上那行提示第一次同步之后就永远消失，
 * 症状变成"提示时有时无"。而 better-sqlite3 对多出来的键是静默忽略（实测），
 * 所以前端加了字段、服务端没加列时**一句错都不会报**——只能靠这条往返判据抓。
 *
 * 用的就是 `sync-handler.test.ts` 那套：内存 SQLite + 直接 import 后端模块。
 */
import { describe, it, expect } from "vitest";

(globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env!.NOVEL_READER_DB_PATH = ":memory:";
// @ts-expect-error - 后端 JS 模块无类型声明，测试仅验证运行时语义
const handler = await import("../../../server/sync-handler.js");
// @ts-expect-error - 同上
const db = await import("../../../server/database.js");

const now = () => Date.now();

function seedNovel(novelId: string) {
  db.insertNovel({
    id: novelId, title: "笑傲测试", author: null, fileName: "t.txt", fileFormat: "txt",
    totalChars: 100, chapterCount: 1, createdAt: now(), updatedAt: now(),
  });
}

function pushed(username: string, novelId: string, over: Record<string, unknown>) {
  handler.mergeAndSave(username, {
    summaries: [{
      id: `s-${username}`, novelId, chapterId: "c1", chapterTitle: "第三章",
      content: "一份总结", tokensUsed: 12, createdAt: now(), type: "chapter",
      ...over,
    }],
  }, 0);
  return db.gatherSyncData(username, 0).summaries.find((s: { id: string }) => s.id === `s-${username}`);
}

describe("总结的 truncated / usedFallback 过服务端", () => {
  it("两个布尔原样回来（不许变成 0/1 或 undefined）", () => {
    const username = `m1-${now()}`;
    const novelId = `n-${username}`;
    seedNovel(novelId);
    const row = pushed(username, novelId, { updatedAt: now(), truncated: true, usedFallback: true });
    expect(row.truncated).toBe(true);
    expect(row.usedFallback).toBe(true);
  });

  it("重新同步一份不截断的版本时，旧值必须被覆盖掉", () => {
    const username = `m2-${now()}`;
    const novelId = `n-${username}`;
    seedNovel(novelId);
    // 先证"真到过 true"，否则"读回 false"可能只是字段整个没下发（下行别名被摘掉就是这个形状）
    expect(pushed(username, novelId, { updatedAt: 1000, truncated: true, usedFallback: true }).truncated).toBe(true);
    const row = pushed(username, novelId, { updatedAt: 2000, truncated: false, usedFallback: false });
    expect(row.truncated, "一次截断不该永久挂在卡片上").toBe(false);
    expect(row.usedFallback).toBe(false);
  });

  it("老客户端不带这两个字段时按 false 存，读回不许是 undefined 之外的一切真值", () => {
    const username = `m3-${now()}`;
    const novelId = `n-${username}`;
    seedNovel(novelId);
    const row = pushed(username, novelId, { updatedAt: now() });
    expect(row.truncated).toBe(false);
    expect(row.usedFallback).toBe(false);
  });
});
