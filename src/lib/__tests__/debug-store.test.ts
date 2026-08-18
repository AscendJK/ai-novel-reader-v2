/**
 * debug-store 模块测试
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addDebugEntry,
  clearDebugEntries,
  subscribeDebugStore,
  getDebugEntries,
  getDebugLogLines,
  appendDebugLog,
} from "../debug-store";

describe("debug-store", () => {
  beforeEach(() => {
    clearDebugEntries();
  });

  describe("addDebugEntry", () => {
    let unsub: (() => void) | null = null;
    afterEach(() => { unsub?.(); unsub = null; });

    it("没有订阅者时不做任何操作", () => {
      addDebugEntry({
        query: "test",
        results: [{ content: "r1", score: 0.9 }],
        engine: "tfidf",
        duration: 0.5,
      });
      expect(getDebugEntries()).toHaveLength(0);
    });

    it("有订阅者时添加条目", () => {
      unsub = subscribeDebugStore(() => {});
      addDebugEntry({
        query: "test",
        results: [{ content: "r1", score: 0.9 }],
        engine: "tfidf",
        duration: 0.5,
      });
      expect(getDebugEntries()).toHaveLength(1);
    });

    it("最多保留 10 条，新条目在最前面", () => {
      unsub = subscribeDebugStore(() => {});
      for (let i = 0; i < 15; i++) {
        addDebugEntry({
          query: `q${i}`,
          results: [{ content: "r", score: 1.0 }],
          engine: "tfidf",
        });
      }
      const entries = getDebugEntries();
      expect(entries).toHaveLength(10);
      expect(entries[0].query).toBe("q14");
      expect(entries[9].query).toBe("q5");
    });

    it("主动设置 id 和 time", () => {
      unsub = subscribeDebugStore(() => {});
      addDebugEntry({
        query: "test",
        results: [{ content: "r", score: 0.8 }],
        engine: "bge",
      });
      const entry = getDebugEntries()[0];
      expect(entry.id).toBeGreaterThan(0);
      expect(entry.time).toBeGreaterThan(0);
    });

    it("触发订阅者通知", () => {
      const listener = vi.fn();
      unsub = subscribeDebugStore(listener);
      addDebugEntry({
        query: "test",
        results: [],
        engine: "tfidf",
      });
      expect(listener).toHaveBeenCalled();
    });
  });

  describe("clearDebugEntries", () => {
    let unsub: (() => void) | null = null;
    afterEach(() => { unsub?.(); unsub = null; });

    it("清空所有条目和日志", () => {
      unsub = subscribeDebugStore(() => {});
      addDebugEntry({
        query: "test",
        results: [{ content: "r", score: 0.9 }],
        engine: "tfidf",
      });
      clearDebugEntries();
      expect(getDebugEntries()).toHaveLength(0);
      expect(getDebugLogLines()).toHaveLength(0);
    });

    it("触发订阅者通知", () => {
      const listener = vi.fn();
      unsub = subscribeDebugStore(listener);
      clearDebugEntries();
      expect(listener).toHaveBeenCalled();
    });
  });

  describe("subscribeDebugStore", () => {
    it("unsubscribe 后监听器不再被调用", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeDebugStore(listener);
      unsubscribe();
      addDebugEntry({
        query: "test",
        results: [],
        engine: "tfidf",
      });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("appendDebugLog", () => {
    it("追加日志行", () => {
      appendDebugLog("line1");
      appendDebugLog("line2");
      const lines = getDebugLogLines();
      expect(lines).toContain("line1");
      expect(lines).toContain("line2");
    });

    it("最多保留 500 行", () => {
      for (let i = 0; i < 510; i++) {
        appendDebugLog(`line${i}`);
      }
      const lines = getDebugLogLines();
      expect(lines.length).toBeLessThanOrEqual(500);
      expect(lines[0]).toBe("line10");
      expect(lines[lines.length - 1]).toBe("line509");
    });
  });

  describe("getDebugEntries / getDebugLogLines", () => {
    it("返回的数组是只读引用（可追加新条目）", () => {
      const unsub = subscribeDebugStore(() => {});
      const entries1 = getDebugEntries();
      addDebugEntry({
        query: "test",
        results: [],
        engine: "tfidf",
      });
      const entries2 = getDebugEntries();
      expect(entries1).toBe(entries2);
      unsub();
    });
  });
});