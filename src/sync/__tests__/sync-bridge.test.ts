/**
 * sync-bridge 测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { dedupSummaries, dedupNotes } from "@/lib/dedup-utils";

describe("sync-bridge 相关工具函数", () => {
  describe("dedupSummaries", () => {
    beforeEach(() => {
      // 清理状态
    });

    it("应该保留最新的 summary", () => {
      const summaries = [
        { novelId: "1", chapterId: "1", type: "chapter", updatedAt: 100, content: "old" },
        { novelId: "1", chapterId: "1", type: "chapter", updatedAt: 200, content: "new" },
      ];

      const result = dedupSummaries(summaries);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("new");
    });

    it("应该保留不同 key 的 summaries", () => {
      const summaries = [
        { novelId: "1", chapterId: "1", type: "chapter", updatedAt: 100 },
        { novelId: "1", chapterId: "2", type: "chapter", updatedAt: 100 },
        { novelId: "1", chapterId: "1", type: "global", updatedAt: 100 },
      ];

      const result = dedupSummaries(summaries);

      expect(result).toHaveLength(3);
    });

    it("应该处理空数组", () => {
      expect(dedupSummaries([])).toEqual([]);
    });

    it("应该保留不同 novelId 的 summaries", () => {
      const summaries = [
        { novelId: "1", chapterId: "1", type: "chapter", updatedAt: 100 },
        { novelId: "2", chapterId: "1", type: "chapter", updatedAt: 100 },
      ];

      const result = dedupSummaries(summaries);

      expect(result).toHaveLength(2);
    });
  });

  describe("dedupNotes", () => {
    it("应该保留最新的 note", () => {
      const notes = [
        { id: "1", updatedAt: 100, content: "old" },
        { id: "1", updatedAt: 200, content: "new" },
      ];

      const result = dedupNotes(notes);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("new");
    });

    it("应该保留不同 id 的 notes", () => {
      const notes = [
        { id: "1", updatedAt: 100, content: "note1" },
        { id: "2", updatedAt: 100, content: "note2" },
      ];

      const result = dedupNotes(notes);

      expect(result).toHaveLength(2);
    });

    it("应该处理空数组", () => {
      expect(dedupNotes([])).toEqual([]);
    });
  });
});
