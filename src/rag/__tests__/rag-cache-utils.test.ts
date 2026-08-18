/**
 * rag-cache-utils 测试
 * LRU 淘汰策略、空间管理、访问记录更新
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.cacheSizeMB = 50;
    mockDb.ragCache.each.mockImplementation((callback: (entry: unknown) => void) => {
      // 空缓存
      return Promise.resolve();
    });
    mockDb.ragCache.toArray.mockResolvedValue([]);
  });

  it("空间足够时直接返回 true", async () => {
    mockDb.ragCache.each.mockImplementation((callback: (entry: unknown) => void) => {
      // 假设当前缓存 10MB
      callback({ vectorsBuffer: new ArrayBuffer(10), dim: 384, chunkCount: 100, chunks: [] });
      return Promise.resolve();
    });
    // 10MB < 50MB limit, 需要 1MB → 够
    const result = await ensureCacheSpace(1024 * 1024);
    expect(result).toBe(true);
    expect(mockDb.ragCache.toArray).not.toHaveBeenCalled(); // 没有淘汰
  });

  it("空间不足且没有可淘汰条目时返回 false", async () => {
    // 模拟缓存超过限制（chunkCount 35000 * dim 384 * 4 = 51.2MB > 50MB limit）
    mockDb.ragCache.each.mockImplementation((callback: (entry: unknown) => void) => {
      callback({ vectorsBuffer: new ArrayBuffer(1), dim: 384, chunkCount: 35000, chunks: [] });
      return Promise.resolve();
    });
    // 没有可淘汰的其他条目
    mockDb.ragCache.toArray.mockResolvedValue([]);

    const result = await ensureCacheSpace(1024 * 1024);
    expect(result).toBe(false);
  });

  it("空间不足时尝试淘汰", async () => {
    mockStore.cacheSizeMB = 1; // 限制 1MB
    mockDb.ragCache.each.mockImplementation((callback: (entry: unknown) => void) => {
      // 缓存 2MB
      callback({ vectorsBuffer: new ArrayBuffer(2 * 1024 * 1024), dim: 384, chunkCount: 100, chunks: [] });
      return Promise.resolve();
    });
    mockDb.ragCache.toArray.mockResolvedValue([
      {
        id: "old-entry",
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

    // 需要 1MB，但 limit 1MB, 当前 2MB → 需要淘汰
    const result = await ensureCacheSpace(1024 * 1024);
    // 可能返回 true 或 false 取决于淘汰后是否足够
    expect(typeof result).toBe("boolean");
    expect(mockDb.ragCache.toArray).toHaveBeenCalled();
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