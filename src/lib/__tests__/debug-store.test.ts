/**
 * debug-store 模块测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
      // 这里只判"追加成功、旧行还在"。行首必须有时刻是另一格，见下面那个 describe
      expect(lines.some((l) => l.endsWith("line1"))).toBe(true);
      expect(lines.some((l) => l.endsWith("line2"))).toBe(true);
    });

    it("最多保留 500 行", () => {
      for (let i = 0; i < 510; i++) {
        appendDebugLog(`line${i}`);
      }
      const lines = getDebugLogLines();
      expect(lines.length).toBeLessThanOrEqual(500);
      expect(lines[0].endsWith("line10")).toBe(true);
      expect(lines[lines.length - 1].endsWith("line509")).toBe(true);
    });
  });

  /**
   * 时间线的时刻（09-28 台架量出来的那一格）。
   *
   * 为什么改口径：原来 `appendDebugLog` 把行**原样**存（老判据钉的就是 `toContain("line1")`
   * 这种逐字相等），只有"检索"那一行自己手工拼了个 `[3:59:32 PM]`——于是导出文本里
   * 「朗读现场」与事件行一个时刻都没有，而"我按下导出"是全篇唯一的绝对时刻。
   * 熄屏前后两行相减才是"那 90 秒里发生了什么"，所以时刻必须由 store 统一给，
   * 而不是每个生产者自己想起来才写一遍（写一遍的就双戳，没写的就没戳）。
   */
  describe("每一行都要有时刻（导出的时间线没有时刻轴就等于一堆并列的句子）", () => {
    afterEach(() => { vi.useRealTimers(); clearDebugEntries(); });

    it("探针那条入口：行首就是 [hh:mm:ss]", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 28, 13, 4, 5));
      appendDebugLog("朗读现场 engine=server chunk=3/12");
      expect(getDebugLogLines()[0]).toBe("[13:04:05] 朗读现场 engine=server chunk=3/12");
    });

    it("24 小时制且零填充：下午一点写成 13:04:05，不跟浏览器 locale 变成 1:04:05 PM", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 28, 13, 4, 5));
      appendDebugLog("x");
      expect(getDebugLogLines()[0].slice(0, 10)).toBe("[13:04:05]");
      vi.setSystemTime(new Date(2026, 8, 28, 0, 0, 7));
      appendDebugLog("y");
      expect(getDebugLogLines()[1].slice(0, 10), "午夜那一格最容易退回 12 小时制").toBe("[00:00:07]");
    });

    it("已经自带时刻的行不许再加第二枚（logger 转写来的行本来就有）", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 28, 15, 20, 30));
      appendDebugLog("[15:20:29 LOG] [TTS] ▶ chunk 1/9");
      const line = getDebugLogLines()[0];
      expect(line, "同一行两枚时刻，读的人要先猜哪个才是事件发生的时间").toBe("[15:20:29 LOG] [TTS] ▶ chunk 1/9");
      expect(line.match(/^\[\d{2}:\d{2}:\d{2}/g)?.length ?? 0).toBeLessThanOrEqual(1);
    });

    it("检索那一行只许有一枚时刻（它以前自己手工拼过一遍）", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 28, 9, 8, 7));
      const unsub = subscribeDebugStore(() => {});
      addDebugEntry({ query: "洛阳", results: [{ content: "r", score: 1 }], engine: "bge", duration: 0.5 });
      unsub();
      const line = getDebugLogLines()[0];
      expect(line.startsWith("[09:08:07] 检索:"), line).toBe(true);
      expect((line.match(/\d{2}:\d{2}:\d{2}/g) ?? []).length, `这一行里冒出了两枚时刻：${line}`).toBe(1);
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