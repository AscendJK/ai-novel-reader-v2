/**
 * 章节总结的"原文没送全"要能过本地落库这一关
 *
 * agent 早就算出了 `metadata.usedFallback / truncated`，`saveChapterSummary` 却整个丢掉，
 * 于是 `MiniCard` 上那两行提示对章节总结是死代码（全书总结反而一直在传 usedFallback）。
 * 而真正的静默点在 `saveSummary`：它不是整对象入库，是**逐字段白名单**——新字段不加进那一行，
 * 前端全改对了也照样丢，且丢得无声无息。所以这里直接钉这一行。
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { loadSummaries, saveSummary } from "../repositories";
import { setCurrentUser } from "../database";

const USER = "summary-metadata-user";
const NOVEL = "book-1";

function record(id: string, over: Record<string, unknown> = {}) {
  return {
    id, novelId: NOVEL, chapterId: `${id}-ch`, chapterTitle: "第三章",
    content: "一份总结", tokensUsed: 12, createdAt: 1, updatedAt: 2, type: "chapter",
    ...over,
  } as never;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sync-username", USER);
  setCurrentUser(USER);
});

async function one(id: string) {
  const all = await loadSummaries(NOVEL);
  return all.find((s) => s.id === id) as unknown as Record<string, unknown>;
}

describe("总结记录的两个降级标记", () => {
  // 变异：从 `saveSummary` 的 put 白名单里删掉 truncated → 前两条红（读回 undefined）
  it("truncated 与 usedFallback 都要写进去、也要读得回来", async () => {
    await saveSummary(record("s-both", { truncated: true, usedFallback: true }));
    const r = await one("s-both");
    expect(r.truncated).toBe(true);
    expect(r.usedFallback).toBe(true);
  });

  it("只截断、没降级到精简模式时两个值不许互相顶替", async () => {
    await saveSummary(record("s-trunc-only", { truncated: true, usedFallback: false }));
    const r = await one("s-trunc-only");
    expect(r.truncated).toBe(true);
    expect(r.usedFallback).toBe(false);
  });

  it("重存同一条时新值必须覆盖旧值（否则一次截断会永久挂在卡片上）", async () => {
    await saveSummary(record("s-flip", { truncated: true, usedFallback: true }));
    await saveSummary(record("s-flip", { truncated: false, usedFallback: false }));
    const r = await one("s-flip");
    expect(r.truncated).toBe(false);
    expect(r.usedFallback).toBe(false);
  });

  it("没带标记的历史记录读出来是 undefined，不许写成 false 冒充「没截断」", async () => {
    await saveSummary(record("s-plain"));
    const r = await one("s-plain");
    expect(r.truncated).toBeUndefined();
  });
});
