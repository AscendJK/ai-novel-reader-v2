/**
 * parsers/utils 测试
 * uuid() 和 createNovel()
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { uuid, createNovel } from "../utils";

describe("uuid", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const originalCrypto = globalThis.crypto;

  afterEach(() => {
    // 恢复全局 crypto
    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      writable: true,
      configurable: true,
    });
  });

  it("返回符合 UUID v4 格式的字符串", () => {
    const id = uuid();
    expect(id).toMatch(UUID_RE);
  });

  it("每次调用返回不同的值", () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuid()));
    expect(ids.size).toBe(100);
  });

  it("crypto.randomUUID 可用时使用它", () => {
    const mock = vi.fn(() => "00000000-0000-4000-8000-000000000000");
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: mock },
      writable: true,
      configurable: true,
    });
    expect(uuid()).toBe("00000000-0000-4000-8000-000000000000");
    expect(mock).toHaveBeenCalledOnce();
  });

  it("crypto.randomUUID 抛出异常时降级到 fallback", () => {
    const mock = vi.fn(() => { throw new Error("crypto unavailable"); });
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: mock },
      writable: true,
      configurable: true,
    });
    const id = uuid();
    expect(id).toMatch(UUID_RE);
    expect(mock).toHaveBeenCalledOnce();
  });

  it("crypto 不存在时降级到 fallback", () => {
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const id = uuid();
    expect(id).toMatch(UUID_RE);
  });

  it("crypto.randomUUID 不存在时降级到 fallback", () => {
    Object.defineProperty(globalThis, "crypto", {
      value: {},
      writable: true,
      configurable: true,
    });
    const id = uuid();
    expect(id).toMatch(UUID_RE);
  });
});

describe("createNovel", () => {
  const parseResult = {
    title: "测试小说",
    author: "测试作者",
    totalChars: 1000,
    chapters: [
      { title: "第一章", content: "第一章内容" },
      { title: "第二章", content: "第二章内容" },
      { title: "", content: "无标题章节内容" },
    ],
  };

  it("返回正确的 Novel 结构", () => {
    const novel = createNovel(parseResult as never, "test.txt", "txt");
    expect(novel.id).toBeDefined();
    expect(novel.id.length).toBeGreaterThan(0);
    expect(novel.title).toBe("测试小说");
    expect(novel.author).toBe("测试作者");
    expect(novel.fileName).toBe("test.txt");
    expect(novel.fileFormat).toBe("txt");
    expect(novel.totalChars).toBe(1000);
    expect(novel.chapterCount).toBe(3);
    expect(novel.chapters).toHaveLength(3);
    expect(novel.createdAt).toBeGreaterThan(0);
    expect(novel.updatedAt).toBeGreaterThan(0);
  });

  it("每个章节都有唯一的 ID", () => {
    const novel = createNovel(parseResult as never, "test.txt", "txt");
    const ids = novel.chapters.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("章节 index 从 0 开始递增", () => {
    const novel = createNovel(parseResult as never, "test.txt", "txt");
    expect(novel.chapters[0].index).toBe(0);
    expect(novel.chapters[1].index).toBe(1);
    expect(novel.chapters[2].index).toBe(2);
  });

  it("所有章节的 novelId 与小说 ID 一致", () => {
    const novel = createNovel(parseResult as never, "test.txt", "txt");
    for (const ch of novel.chapters) {
      expect(ch.novelId).toBe(novel.id);
    }
  });

  it("无标题章节使用默认标题", () => {
    const novel = createNovel(parseResult as never, "test.txt", "txt");
    expect(novel.chapters[0].title).toBe("第一章");
    expect(novel.chapters[2].title).toBe("第3章");
  });

  it("startOffset/endOffset 正确", () => {
    const novel = createNovel(parseResult as never, "test.txt", "txt");
    expect(novel.chapters[0].startOffset).toBe(0);
    expect(novel.chapters[0].endOffset).toBe("第一章内容".length);
  });

  it("标题为空时使用文件名", () => {
    const novel = createNovel(
      { ...parseResult, title: "" } as never,
      "《我的小说》.txt",
      "txt"
    );
    expect(novel.title).toBe("我的小说");
  });

  it("只传文件名作为标题", () => {
    const novel = createNovel(
      { ...parseResult, title: "" } as never,
      "novel.txt",
      "txt"
    );
    expect(novel.title).toBe("novel");
  });

  it("支持 epub 格式", () => {
    const novel = createNovel(parseResult as never, "test.epub", "epub");
    expect(novel.fileFormat).toBe("epub");
  });

  it("没有章节时返回空数组", () => {
    const novel = createNovel(
      { ...parseResult, chapters: [] } as never,
      "test.txt",
      "txt"
    );
    expect(novel.chapters).toHaveLength(0);
    expect(novel.chapterCount).toBe(0);
  });
});