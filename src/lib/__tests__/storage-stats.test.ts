// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * 存储统计（设置页「存储管理」那六格）。
 *
 * 为什么单独钉：`StorageManager.tsx:172` 用 `cat.cleanable` 决定**要不要出现那枚清理按钮**，
 * 所以这张表上"哪几格可清"就是数据丢失的边界；而 `content-length` 缺失时"最多读 5 个 body"
 * 是防止把整只大模型读进内存的那道闸（`storage-stats.ts:126-141`）。这两件事此前一行判据都没有。
 */
vi.mock("@/rag/rag-cache-utils", () => ({ computeRagCacheSize: vi.fn(async () => 1024) }));
vi.mock("@/tts/tts-cache", () => ({ computeTTSCacheSize: vi.fn(async () => 2048) }));
vi.mock("@/rag/model-loader", () => ({ getTransformersCacheInfo: vi.fn(async () => ({ bytes: 0, count: 0 })) }));

import { getStorageBreakdown, formatBytes } from "@/lib/storage-stats";
import { setCurrentUser, getUserDB, sharedDB } from "@/db/database";
import { computeRagCacheSize } from "@/rag/rag-cache-utils";
import { computeTTSCacheSize } from "@/tts/tts-cache";

const USER = "storage-stats-user";
const cat = (id: string) => {
  const c = breakdown.categories.find((x) => x.id === id);
  if (!c) throw new Error(`分类 ${id} 不见了`);
  return c;
};
let breakdown: Awaited<ReturnType<typeof getStorageBreakdown>>;

/** 一只假 Cache Storage：`len` 给 content-length 头，不给的就走 body 读取（用来数读了几次） */
let bodyReads = 0;
function stubCaches(buckets: Record<string, Array<{ url: string; len?: number }>>) {
  bodyReads = 0;
  const open = async (name: string) => {
    const items = buckets[name] ?? [];
    const requests = items.map((i) => ({ url: `https://x/${i.url}` }));
    return {
      keys: async () => requests,
      match: async (req: { url: string }) => {
        const item = items.find((i) => `https://x/${i.url}` === req.url);
        if (!item) return undefined;
        return {
          headers: { get: (h: string) => (h.toLowerCase() === "content-length" && item.len ? String(item.len) : null) },
          clone: () => ({ arrayBuffer: async () => { bodyReads++; return new ArrayBuffer(4096); } }),
        };
      },
    };
  };
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    writable: true,
    value: { keys: async () => Object.keys(buckets), open },
  });
}

const originalEstimate = navigator.storage?.estimate;
function stubEstimate(value: { usage: number; quota: number } | null) {
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    writable: true,
    value: { estimate: value === null ? undefined : async () => value },
  });
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem("sync-username", USER);
  setCurrentUser(USER);
  const udb = getUserDB();
  await Promise.all([udb.novels.clear(), udb.chapters.clear(), udb.summaries.clear(), udb.notes.clear(), udb.maps.clear(), udb.graphs.clear()]);
  await sharedDB.settings.clear();
  vi.mocked(computeRagCacheSize).mockResolvedValue(1024);
  vi.mocked(computeTTSCacheSize).mockResolvedValue(2048);
  stubEstimate({ usage: 12345, quota: 99999 });
});

afterEach(() => {
  // 每一发的 beforeEach 都会重新 stubEstimate，这里只要把 navigator.storage 交还原样
  Object.defineProperty(navigator, "storage", { configurable: true, writable: true, value: { estimate: originalEstimate } });
});

describe("六格的账", () => {
  it("只有 RAG 索引、TTS 模型、嵌入模型三格允许挂清理按钮", async () => {
    breakdown = await getStorageBreakdown();
    expect(breakdown.categories.map((c) => c.id)).toEqual([
      "user-data", "rag-index", "tts-cache", "embedding-models", "pwa-cache", "config",
    ]);
    expect(breakdown.categories.filter((c) => c.cleanable).map((c) => c.id)).toEqual([
      "rag-index", "tts-cache", "embedding-models",
    ]);
    // 反向那半句才是这条判据的意义：小说数据/PWA 资源/配置不许有清理入口
    expect(cat("user-data").cleanable).toBe(false);
    expect(cat("pwa-cache").cleanable).toBe(false);
    expect(cat("config").cleanable).toBe(false);
  });

  it("没登录时说的是「未登录」，不许把「没读到」写成「没有数据」", async () => {
    localStorage.removeItem("sync-username");
    breakdown = await getStorageBreakdown();
    expect(cat("user-data").detail).toBe("未登录");
    expect(cat("user-data").bytes).toBe(0);
  });

  it("章节全文按 UTF-16 两字节算，明细里的本/章/条数要数得对", async () => {
    const udb = getUserDB();
    await udb.novels.put({ id: "b1", title: "一本" } as never);
    // 每章 100 字 → 100*2 + 300(RECORD_OVERHEAD) = 500；两章 1000，再加小说条目 300
    await udb.chapters.bulkPut([
      { id: "c1", novelId: "b1", index: 0, title: "一", content: "字".repeat(100) },
      { id: "c2", novelId: "b1", index: 1, title: "二", content: "字".repeat(100) },
    ] as never);
    await udb.summaries.put({ id: "s1", novelId: "b1", chapterId: "c1", content: "总结" } as never);

    breakdown = await getStorageBreakdown();
    expect(cat("user-data").detail).toBe("1 本小说 · 2 章 · 1 条总结 · 0 条笔记");
    // 与 `storage-stats.ts` 的算法一一对上：章节 (100*2+300)×2、总结 (2*2+300+200)、小说条目 300
    expect(cat("user-data").bytes).toBe(2 * (100 * 2 + 300) + (2 * 2 + 300 + 200) + 300);
  });

  it("子统计炸了不许把整张表带走（那一格记 0，其余照算）", async () => {
    vi.mocked(computeRagCacheSize).mockRejectedValue(new Error("共享库被别的标签页占了"));
    breakdown = await getStorageBreakdown();
    expect(cat("rag-index").bytes).toBe(0);
    expect(cat("tts-cache").bytes).toBe(2048);
    expect(breakdown.categories).toHaveLength(6);
  });

  it("嵌入模型只算 transformers-cache，workbox 与其余缓存合并进「应用静态资源」", async () => {
    stubCaches({
      "transformers-cache": [{ url: "m1", len: 10 }, { url: "m2", len: 20 }],
      "workbox-v1": [{ url: "a", len: 5 }],
      "别的什么缓存": [{ url: "b", len: 7 }],
    });
    breakdown = await getStorageBreakdown();
    expect(cat("embedding-models").bytes).toBe(30);
    expect(cat("embedding-models").detail).toBe("2 个文件");
    expect(cat("pwa-cache").bytes).toBe(12);
    expect(cat("pwa-cache").detail).toBe("2 个文件");
  });

  it("没有 content-length 时最多读 5 个 body 估算（不许把整只模型读进内存）", async () => {
    stubCaches({ "transformers-cache": Array.from({ length: 40 }, (_, i) => ({ url: `w${i}` })) });
    breakdown = await getStorageBreakdown();
    expect(bodyReads).toBe(5);
    expect(cat("embedding-models").bytes).toBe(5 * 4096);
    // 条目数还是如实报 40：限制的是"读多少 body"，不是"报多少文件"
    expect(cat("embedding-models").detail).toBe("40 个文件");
  });

  it("顶部那行用的是浏览器 estimate，不许拿分类之和冒充", async () => {
    breakdown = await getStorageBreakdown();
    expect(breakdown.usage).toBe(12345);
    expect(breakdown.quota).toBe(99999);
    expect(breakdown.support).toBe(true);
    const sum = breakdown.categories.reduce((n, c) => n + c.bytes, 0);
    expect(sum).not.toBe(12345);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [-1, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1024 * 1024, "1.0 MB"],
    [380 * 1024 * 1024, "380.0 MB"],
    [1024 * 1024 * 1024, "1.00 GB"],
  ])("%i → %s", (input, out) => {
    expect(formatBytes(input)).toBe(out);
  });

  it("NaN / undefined 不许写出「NaN MB」这种字", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(undefined as unknown as number)).toBe("0 B");
  });
});
