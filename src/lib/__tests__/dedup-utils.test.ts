/**
 * dedup-utils 测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { dedupSummaries, dedupNotes } from "../dedup-utils";

describe("dedupSummaries", () => {
  beforeEach(() => {
    // 清理状态
  });

  it("应该保留最新的 summary（按 updatedAt）", () => {
    const summaries = [
      { novelId: "1", chapterId: "1", type: "chapter", updatedAt: 100, content: "old" },
      { novelId: "1", chapterId: "1", type: "chapter", updatedAt: 200, content: "new" },
    ];

    const result = dedupSummaries(summaries);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("new");
    expect(result[0].updatedAt).toBe(200);
  });

  it("应该保留最新的 summary（按 createdAt）", () => {
    const summaries = [
      { novelId: "1", chapterId: "1", type: "chapter", createdAt: 100, content: "old" },
      { novelId: "1", chapterId: "1", type: "chapter", createdAt: 200, content: "new" },
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

  it("应该处理只有一个 summary 的情况", () => {
    const summaries = [
      { novelId: "1", chapterId: "1", type: "chapter", updatedAt: 100 },
    ];

    const result = dedupSummaries(summaries);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(summaries[0]);
  });
});

describe("dedupNotes", () => {
  it("应该保留最新的 note（按 updatedAt）", () => {
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
