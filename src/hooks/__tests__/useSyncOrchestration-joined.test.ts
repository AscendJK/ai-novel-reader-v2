// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * `syncJoinedNovels` 的两条"绝不删本地、绝不让删掉的书复活"策略（覆盖地板第 2 档第二批）。
 *
 * 为什么值得单独钉：这两条各写着一整段历史教训的注释，而症状都是**用户数据没了**——
 * - join 请求是 fire-and-forget，后端重启/网络闪断都会让服务器 `joined=false` 而本地数据
 *   完整；旧实现在这里软删本地副本，于是小说连同摘要/笔记/地图/图谱全部丢失且不会重下。
 * - `novels` 行不在而章节墓碑在 = 用户明确删过这本书；旧实现把它当"没本地化过"重新下载，
 *   删掉的书整本复活、墓碑被清。
 *
 * IndexedDB 用真的（fake-indexeddb），因为要判的就是"库里那几行还在不在"；
 * 只有网络与模型下载是桩。
 */

type FakeResp = { ok: boolean; status: number; json: () => Promise<unknown> };
// 签名要写全：不带参数类型的话调用记录是空元组，
// 下面 `mock.calls.filter(([u, i]) => ...)` 与 mockImplementation 都过不了 tsc
const apiFetch = vi.hoisted(() => vi.fn<(url: string, init?: { method?: string }) => Promise<FakeResp>>()
  .mockImplementation(async () => ({ ok: false, status: 599, json: async () => [] })));
vi.mock("@/lib/api-client", () => ({ apiFetch, getEffectiveServerUrl: () => "" }));
vi.mock("@/sync/pending-leave", () => ({ flushPendingLeaves: vi.fn(async () => undefined) }));
vi.mock("@/sync/sync-bridge", () => ({ gatherChanges: vi.fn(), applyServerData: vi.fn(async () => undefined) }));
vi.mock("@/rag/index", () => ({ buildIndex: vi.fn(), retrieveRelevantWithDetails: vi.fn(), getBGEMeta: () => null }));
vi.mock("@/rag/model-loader", () => ({ downloadModel: vi.fn(async () => undefined) }));
vi.mock("@/lib/toast-store", () => ({ showToast: vi.fn() }));
vi.mock("@/lib/broadcast", () => ({ broadcast: { send: vi.fn(), on: vi.fn(), close: vi.fn() } }));
vi.mock("@/lib/ai-task-queue", () => ({ cancelAllAiTasks: vi.fn() }));
vi.mock("@/lib/ai-state", () => ({ getAiRunning: () => false }));
vi.mock("@/stores/api-store", () => ({
  useAPIStore: Object.assign((s: (x: { loadFromDB: () => Promise<void> }) => unknown) => s({ loadFromDB: async () => undefined }), {
    getState: () => ({ loadFromDB: async () => undefined }),
  }),
}));

import { useSyncOrchestration } from "@/hooks/useSyncOrchestration";
import { getUserDB, setCurrentUser } from "@/db/database";
import { useNovelStore } from "@/stores/novel-store";

const USER = "orch-joined-user";
const CHAPTER = (id: string, index: number, extra: Record<string, unknown> = {}) => ({
  id, novelId: extra.novelId ?? "srv-1", index, title: `第${index + 1}章`, content: "正文。".repeat(30),
  startOffset: 0, endOffset: 60, ...extra,
});

/** 让 apiFetch 按剧本回话：服务器侧的书单 + 每本书的章节 */
function serve(novels: Array<Record<string, unknown>>, chaptersByNovel: Record<string, unknown[]> = {}) {
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith("/api/novels?")) {
      return { ok: true, status: 200, json: async () => novels };
    }
    if (method === "GET" && /\/api\/novels\/([^/]+)\/chapters$/.test(url)) {
      const id = url.match(/\/api\/novels\/([^/]+)\/chapters$/)![1];
      return { ok: true, status: 200, json: async () => chaptersByNovel[id] ?? [] };
    }
    return { ok: true, status: 200, json: async () => ({ novelId: url.split("/")[3] }) };
  });
}

async function run() {
  const { result } = renderHook(() => useSyncOrchestration({ onSyncReady: vi.fn(), setLocalUsers: vi.fn() }));
  await act(async () => { await result.current.syncJoinedNovels(); });
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem("sync-username", USER);
  setCurrentUser(USER);
  vi.clearAllMocks();
  serve([]);
  const db = getUserDB();
  await Promise.all([db.novels.clear(), db.chapters.clear(), db.summaries.clear(), db.notes.clear(), db.maps.clear(), db.graphs.clear()]);
  useNovelStore.setState({ novels: [], currentNovel: null, readingPositions: {} });
});

describe("服务器说 joined=false 时", () => {
  it("本地数据完整的书一条都不许删，只补一次幂等 join", async () => {
    const db = getUserDB();
    await db.novels.put({ id: "srv-1", title: "本地已有的书", fileName: "a.txt", fileFormat: "txt", totalChars: 100, createdAt: 1 } as never);
    await db.chapters.bulkPut([CHAPTER("srv-1-ch0", 0), CHAPTER("srv-1-ch1", 1)] as never);
    serve([{ id: "srv-1", title: "本地已有的书", fileName: "a.txt", fileFormat: "txt", totalChars: 100, chapterCount: 2, createdAt: 1, joined: false }]);

    await run();

    expect(await db.novels.get("srv-1"), "本地已有的书被 joined=false 抹掉了").toBeTruthy();
    expect(await db.chapters.where("novelId").equals("srv-1").count()).toBe(2);
    const joins = apiFetch.mock.calls.filter(([u, i]) => /\/join$/.test(u) && (i as { method?: string })?.method === "POST");
    expect(joins).toHaveLength(1);
  });

  it("join 补不上（服务器 500）也要保留本地副本，下次再试", async () => {
    const db = getUserDB();
    await db.novels.put({ id: "srv-2", title: "另一本", fileName: "b.txt", fileFormat: "txt", totalChars: 50, createdAt: 1 } as never);
    await db.chapters.bulkPut([CHAPTER("srv-2-ch0", 0, { novelId: "srv-2" })] as never);
    serve([{ id: "srv-2", title: "另一本", fileName: "b.txt", fileFormat: "txt", totalChars: 50, chapterCount: 1, createdAt: 1, joined: false }]);
    apiFetch.mockImplementation(async (url: string) => (
      /\/join$/.test(url)
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => [{ id: "srv-2", title: "另一本", fileName: "b.txt", fileFormat: "txt", totalChars: 50, chapterCount: 1, createdAt: 1, joined: false }] }
    ));

    await run();

    expect(await db.novels.get("srv-2")).toBeTruthy();
    expect(await db.chapters.where("novelId").equals("srv-2").count()).toBe(1);
  });
});

describe("章节墓碑", () => {
  it("novels 行不在而章节墓碑在 = 用户删过这本书：绝不重新下载", async () => {
    const db = getUserDB();
    // deleteNovel 的形状：硬删 novel 行 + 章节留着 deleted 标记
    await db.chapters.bulkPut([CHAPTER("srv-3-ch0", 0, { novelId: "srv-3", deleted: true })] as never);
    serve([{ id: "srv-3", title: "已被我删掉的书", fileName: "c.txt", fileFormat: "txt", totalChars: 80, chapterCount: 1, createdAt: 1, joined: true }]);

    await run();

    expect(apiFetch.mock.calls.some(([u]) => /\/api\/novels\/srv-3\/chapters$/.test(u)), "删掉的书被整本重新拉回来了").toBe(false);
    expect(await db.novels.get("srv-3")).toBeUndefined();
  });

  it("记录与章节都不存在（从没本地化过）才走下载，并且要上屏", async () => {
    const db = getUserDB();
    serve(
      [{ id: "srv-4", title: "另一台设备导入的书", fileName: "d.txt", fileFormat: "txt", totalChars: 60, chapterCount: 2, createdAt: 1, joined: true }],
      { "srv-4": [CHAPTER("srv-4-ch0", 0, { novelId: "srv-4" }), CHAPTER("srv-4-ch1", 1, { novelId: "srv-4" })] },
    );

    await run();

    expect(await db.novels.get("srv-4")).toBeTruthy();
    expect(await db.chapters.where("novelId").equals("srv-4").count()).toBe(2);
    expect(useNovelStore.getState().novels.map((n) => n.id)).toContain("srv-4");
  });
});

describe("同名书的认亲", () => {
  it("同 title 且 totalChars 相同 → 重键到服务器 id，摘要/笔记的 chapterId 跟着改", async () => {
    const db = getUserDB();
    await db.novels.put({ id: "local-9", title: "两台设备各导入一本", fileName: "e.txt", fileFormat: "txt", totalChars: 120, createdAt: 1 } as never);
    await db.chapters.bulkPut([CHAPTER("lc0", 0, { novelId: "local-9" }), CHAPTER("lc1", 1, { novelId: "local-9" })] as never);
    await db.summaries.bulkPut([
      { id: "sm1", novelId: "local-9", chapterId: "lc1", chapterTitle: "第2章", content: "第二章的总结", createdAt: 1, updatedAt: 1, type: "chapter" },
    ] as never);
    await db.notes.bulkPut([
      { id: "nt1", novelId: "local-9", chapterId: "lc0", chapterTitle: "第1章", content: "第一条笔记", source: "user", createdAt: 1, updatedAt: 1 },
    ] as never);
    serve([{ id: "srv-9", title: "两台设备各导入一本", fileName: "e.txt", fileFormat: "txt", totalChars: 120, chapterCount: 2, createdAt: 1, joined: true }]);

    await run();

    expect(await db.novels.get("local-9"), "认亲后本地 id 应当消失").toBeUndefined();
    const summary = await db.summaries.get("sm1");
    expect(summary?.novelId).toBe("srv-9");
    expect(summary?.chapterId, "章节重键后摘要指向旧 chapterId → 按章查询永远落空").toBe("srv-9-ch1");
    const note = await db.notes.get("nt1");
    expect(note?.chapterId).toBe("srv-9-ch0");
    expect(await db.chapters.get("srv-9-ch1")).toBeTruthy();
  });

  it("同 title 但 totalChars 不同 = 两本不同的书，不许合并（各留各的）", async () => {
    const db = getUserDB();
    await db.novels.put({ id: "local-10", title: "同名不同内容", fileName: "f.txt", fileFormat: "txt", totalChars: 999, createdAt: 1 } as never);
    await db.chapters.bulkPut([CHAPTER("lc10", 0, { novelId: "local-10" })] as never);
    serve([{ id: "srv-10", title: "同名不同内容", fileName: "f.txt", fileFormat: "txt", totalChars: 1234, chapterCount: 1, createdAt: 1, joined: true }]);

    await run();

    expect(await db.novels.get("local-10"), "凭 title 就合并会把两本书的数据搅在一起").toBeTruthy();
    expect(await db.novels.get("srv-10"), "服务器那本走下载分支，不该被当成同一本").toBeTruthy();
  });
});
