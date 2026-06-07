/**
 * RAG index 测试
 */

import { describe, it, expect } from "vitest";
import { normalizeChunks } from "../index";

describe("normalizeChunks", () => {
  it("应该将字符串数组转换为 Chunk 对象", () => {
    const input = ["hello", "world"];
    const result = normalizeChunks(input);

    expect(result).toEqual([
      { id: "0", content: "hello" },
      { id: "1", content: "world" },
    ]);
  });

  it("应该保留现有的 id", () => {
    const input = [{ id: "custom", content: "hello" }];
    const result = normalizeChunks(input);

    expect(result[0].id).toBe("custom");
    expect(result[0].content).toBe("hello");
  });

  it("应该处理混合输入", () => {
    const input = ["string", { content: "object" }];
    const result = normalizeChunks(input);

    expect(result).toEqual([
      { id: "0", content: "string" },
      { id: "1", content: "object" },
    ]);
  });

  it("应该处理空数组", () => {
    expect(normalizeChunks([])).toEqual([]);
  });

  it("应该为没有 id 的对象生成 id", () => {
    const input = [{ content: "test" }];
    const result = normalizeChunks(input);

    expect(result[0].id).toBe("0");
  });

  it("应该处理多个字符串", () => {
    const input = ["a", "b", "c", "d"];
    const result = normalizeChunks(input);

    expect(result).toHaveLength(4);
    expect(result[0].id).toBe("0");
    expect(result[1].id).toBe("1");
    expect(result[2].id).toBe("2");
    expect(result[3].id).toBe("3");
  });

  it("应该处理带 id 的对象", () => {
    const input = [
      { id: "first", content: "hello" },
      { id: "second", content: "world" },
    ];
    const result = normalizeChunks(input);

    expect(result[0].id).toBe("first");
    expect(result[1].id).toBe("second");
  });
});
