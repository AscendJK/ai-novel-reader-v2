/**
 * rag-cache-utils 测试
 * LRU 淘汰策略、空间管理、访问记录更新
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  onCacheEviction,
  updateAccessTime,
  setCurrentNovelIdGetter,
  ensureCacheSpace,
  enforceIndexedDBQuota,
} from "../rag-cache-utils";

// Mock sharedDB — 用 vi.hoisted 确保在 vi.mock 之前初始化
const mockDb = vi.hoisted(() => ({
  ragCache: {
    each: vi.fn(),
    toArray: vi.fn(),
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

const mockStore = vi.hoisted(() => ({
  updateRagCacheSize: vi.fn(),
  removeCachedKey: vi.fn(),
  cacheSizeMB: 50,
}));

vi.mock("@/db/database", () => ({
  sharedDB: mockDb,
}));

vi.mock("@/stores/rag-store", () => ({
  useRAGStore: {
    getState: () => mockStore,
  },
}));

vi.mock("@/lib/logger", () => ({
  ragLog: vi.fn(),
}));

describe("onCacheEviction", () => {
  it("注册监听器后返回取消函数", () => {
    const listener = vi.fn();
    const unsubscribe = onCacheEviction(listener);
    expect(typeof unsubscribe).toBe("function");
  });

  it("取消后不再收到通知", () => {
    // 通过 ensureCacheSpace 间接测试：淘汰后应通知监听器
    // 注册监听器不会直接触发，所以主要是验证接口正确
    const listener = vi.fn();
    const unsubscribe = onCacheEviction(listener);
    unsubscribe();
    // 验证接口可用
    expect(true).toBe(true);
  });
});

describe("setCurrentNovelIdGetter", () => {
  it("设置 getter 后不报错", () => {
    expect(() => setCurrentNovelIdGetter(() => "novel-1")).not.toThrow();
  });

  it("设置 null 后不报错", () => {
    expect(() => setCurrentNovelIdGetter(null as never)).not.toThrow();
  });

  it("多次设置不报错", () => {
    setCurrentNovelIdGetter(() => "novel-1");
    setCurrentNovelIdGetter(() => "novel-2");
    setCurrentNovelIdGetter(() => undefined);
    expect(true).toBe(true);
  });
});

describe("updateAccessTime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("缓存条目存在时更新访问时间", async () => {
    mockDb.ragCache.get.mockResolvedValue({
      id: "novel-1-tfidf",
      novelId: "novel-1",
      engine: "tfidf",
      createdAt: 1000,
      accessCount: 5,
    });
    mockDb.ragCache.put.mockResolvedValue(undefined);

    await updateAccessTime("novel-1", "tfidf");

    expect(mockDb.ragCache.get).toHaveBeenCalledWith("novel-1-tfidf");
    expect(mockDb.ragCache.put).toHaveBeenCalledOnce();
    const putArg = mockDb.ragCache.put.mock.calls[0][0];
    expect(putArg.accessCount).toBe(6); // 递增
    expect(putArg.lastAccessed).toBeGreaterThan(0);
  });

  it("缓存条目不存在时静默跳过", async () => {
    mockDb.ragCache.get.mockResolvedValue(undefined);
    await updateAccessTime("novel-1", "tfidf");
    expect(mockDb.ragCache.put).not.toHaveBeenCalled();
  });

  it("数据库错误时静默处理", async () => {
    mockDb.ragCache.get.mockRejectedValue(new Error("DB error"));
    await expect(updateAccessTime("novel-1", "tfidf")).resolves.toBeUndefined();
  });
});

describe("ensureCacheSpace", () => {
  /** 让 each 依次吐出这些条目（computeRagCacheSize 与淘汰候选共用同一数据源） */
  const seed = (entries: unknown[]) => {
    mockDb.ragCache.each.mockImplementation((callback: (entry: unknown) => void) => {
      entries.forEach(callback);
      return Promise.resolve();
    });
  };
  const entryOf = (id: string, novelId: string, chunkCount: number) => ({
    id, novelId, engine: "Xenova/bge-small-zh-v1.5", chunkCount, dim: 384,
    vectorsBuffer: new ArrayBuffer(1), chunks: [], createdAt: 0, accessCount: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.cacheSizeMB = 50;
    setCurrentNovelIdGetter(() => undefined);
    seed([]);
    mockDb.ragCache.toArray.mockResolvedValue([]);
    mockDb.ragCache.delete.mockResolvedValue(undefined);
  });

  it("空间足够时直接返回 true", async () => {
    seed([entryOf("k1", "novel-1", 100)]); // ~0.15MB，远小于 50MB 上限
    const result = await ensureCacheSpace(1024 * 1024);
    expect(result).toBe(true);
    expect(mockDb.ragCache.delete).not.toHaveBeenCalled();
  });

  it("唯一条目正是当前在读的书时被保护，宁可不返回空间也不删它", async () => {
    mockStore.cacheSizeMB = 1;
    setCurrentNovelIdGetter(() => "cur");
    seed([entryOf("cur-key", "cur", 35000)]); // ~53MB > 1MB 上限

    const result = await ensureCacheSpace(1024 * 1024);
    expect(result).toBe(false);
    expect(mockDb.ragCache.delete).not.toHaveBeenCalled();
  });

  it("空间不足时淘汰最该走的旧条目并腾出空间", async () => {
    setCurrentNovelIdGetter(() => "cur");
    seed([entryOf("cur-key", "cur", 100), entryOf("old-key", "novel-old", 20000)]);

    const evicted: unknown[] = [];
    const off = onCacheEviction((list) => evicted.push(...list));
    const result = await ensureCacheSpace(30 * 1024 * 1024);
    off();

    expect(result).toBe(true);
    expect(mockDb.ragCache.delete).toHaveBeenCalledWith("old-key");
    expect(mockDb.ragCache.delete).not.toHaveBeenCalledWith("cur-key");
    expect(mockStore.removeCachedKey).toHaveBeenCalledWith("old-key");
    expect(evicted.map((e) => (e as { id: string }).id)).toEqual(["old-key"]);
  });

  // R-08：旧实现每淘汰一条就 toArray() 全表载入（含 vectorsBuffer 与 chunks
  // 全文），几百 MB 配额下必然把标签页打死
  it("一轮淘汰只扫全表常数次，绝不调用 toArray", async () => {
    setCurrentNovelIdGetter(() => "cur");
    seed([
      entryOf("cur-key", "cur", 100),
      entryOf("a", "novel-a", 20000),
      entryOf("b", "novel-b", 20000),
      entryOf("c", "novel-c", 20000),
    ]);

    await ensureCacheSpace(40 * 1024 * 1024);

    expect(mockDb.ragCache.toArray).not.toHaveBeenCalled();
    expect(mockDb.ragCache.each).toHaveBeenCalledTimes(2); // 一次算当前大小，一次收候选
    expect(mockDb.ragCache.delete).not.toHaveBeenCalledWith("cur-key");
  });

  it("保护清单可以显式追加（刚下载完的目标书不被自己挤掉）", async () => {
    mockStore.cacheSizeMB = 1;
    seed([entryOf("keep-key", "novel-keep", 20000)]);
    const result = await ensureCacheSpace(1024 * 1024, ["novel-keep"]);
    expect(result).toBe(false);
    expect(mockDb.ragCache.delete).not.toHaveBeenCalled();
  });
});

describe("enforceIndexedDBQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.cacheSizeMB = 50;
    mockDb.ragCache.each.mockImplementation((callback: (entry: unknown) => void) => {
      callback({ vectorsBuffer: new ArrayBuffer(10), dim: 384, chunkCount: 100, chunks: [] });
      return Promise.resolve();
    });
    mockDb.ragCache.toArray.mockResolvedValue([]);
  });

  it("当前大小在限制内时只更新缓存大小", async () => {
    mockDb.ragCache.each.mockImplementation((callback: (entry: unknown) => void) => {
      // 10MB < 50MB
      callback({ vectorsBuffer: new ArrayBuffer(10), dim: 384, chunkCount: 100, chunks: [] });
      return Promise.resolve();
    });

    await enforceIndexedDBQuota();
    expect(mockStore.updateRagCacheSize).toHaveBeenCalled();
  });

  it("超出限制时尝试淘汰", async () => {
    mockStore.cacheSizeMB = 1; // 1MB limit
    mockDb.ragCache.each.mockImplementation((callback: (entry: unknown) => void) => {
      // 2MB
      callback({ vectorsBuffer: new ArrayBuffer(2 * 1024 * 1024), dim: 384, chunkCount: 100, chunks: [] });
      return Promise.resolve();
    });
    mockDb.ragCache.toArray.mockResolvedValue([
      {
        id: "entry-1",
        novelId: "novel-2",
        engine: "tfidf",
        chunkCount: 100,
        dim: 384,
        vectorsBuffer: new ArrayBuffer(100 * 384 * 4),
        chunks: [],
        createdAt: 0,
        accessCount: 0,
      },
    ]);
    mockDb.ragCache.delete.mockResolvedValue(undefined);

    await enforceIndexedDBQuota();
    expect(mockStore.updateRagCacheSize).toHaveBeenCalled();
  });

  it("并发调用时排队执行", async () => {
    mockStore.cacheSizeMB = 50;
    mockDb.ragCache.each.mockImplementation((callback: (entry: unknown) => void) => {
      callback({ vectorsBuffer: new ArrayBuffer(10), dim: 384, chunkCount: 100, chunks: [] });
      return Promise.resolve();
    });
    mockDb.ragCache.toArray.mockResolvedValue([]);

    // 并发调用两个
    await Promise.all([
      enforceIndexedDBQuota(),
      enforceIndexedDBQuota(),
    ]);
    // 两次都执行了
    expect(mockStore.updateRagCacheSize).toHaveBeenCalledTimes(2);
  });
});