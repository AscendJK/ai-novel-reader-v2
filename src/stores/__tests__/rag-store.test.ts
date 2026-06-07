/**
 * rag-store 测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useRAGStore } from "../rag-store";

describe("rag-store", () => {
  beforeEach(() => {
    // 重置 store
    useRAGStore.setState({
      engine: "bge-small-zh",
      cachedKeys: new Set(),
      lruKeys: new Set(),
      ragCacheSizeBytes: 0,
      cacheSizeMB: 100,
      topKDefault: 15,
    });
  });

  describe("setEngine", () => {
    it("应该设置引擎", () => {
      useRAGStore.getState().setEngine("gte-small");
      expect(useRAGStore.getState().engine).toBe("gte-small");
    });
  });

  describe("addCachedKey / removeCachedKey", () => {
    it("应该添加缓存 key", () => {
      useRAGStore.getState().addCachedKey("novel-1-bge");
      expect(useRAGStore.getState().cachedKeys.has("novel-1-bge")).toBe(true);
    });

    it("应该移除缓存 key", () => {
      useRAGStore.getState().addCachedKey("novel-1-bge");
      useRAGStore.getState().removeCachedKey("novel-1-bge");
      expect(useRAGStore.getState().cachedKeys.has("novel-1-bge")).toBe(false);
    });
  });

  describe("addLruKey / removeLruKey", () => {
    it("应该添加 LRU key", () => {
      useRAGStore.getState().addLruKey("novel-1-bge");
      expect(useRAGStore.getState().lruKeys.has("novel-1-bge")).toBe(true);
    });

    it("应该移除 LRU key", () => {
      useRAGStore.getState().addLruKey("novel-1-bge");
      useRAGStore.getState().removeLruKey("novel-1-bge");
      expect(useRAGStore.getState().lruKeys.has("novel-1-bge")).toBe(false);
    });
  });

  describe("updateRagCacheSize", () => {
    it("应该更新缓存大小", () => {
      useRAGStore.getState().updateRagCacheSize(1024 * 1024);
      expect(useRAGStore.getState().ragCacheSizeBytes).toBe(1024 * 1024);
    });
  });

  describe("setCacheSizeMB", () => {
    it("应该设置缓存大小限制", () => {
      useRAGStore.getState().setCacheSizeMB(200);
      expect(useRAGStore.getState().cacheSizeMB).toBe(200);
    });

    it("应该限制在 100-500 范围内", () => {
      useRAGStore.getState().setCacheSizeMB(50);
      expect(useRAGStore.getState().cacheSizeMB).toBe(100);

      useRAGStore.getState().setCacheSizeMB(600);
      expect(useRAGStore.getState().cacheSizeMB).toBe(500);
    });
  });

  describe("getTopK", () => {
    it("应该返回配置的 topK", () => {
      const result = useRAGStore.getState().getTopK(100);
      // 根据 topKTiers 配置返回
      expect(result).toBeGreaterThan(0);
    });

    it("应该根据 chunk 数量返回不同的 topK", () => {
      const result1 = useRAGStore.getState().getTopK(10);
      const result2 = useRAGStore.getState().getTopK(1000);
      // 更多的 chunks 应该允许更大的 topK
      expect(result2).toBeGreaterThanOrEqual(result1);
    });
  });
});
