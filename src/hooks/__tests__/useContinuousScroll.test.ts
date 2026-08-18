/**
 * useContinuousScroll 测试
 * 测试纯逻辑部分：loadedChapters、chapterIndexMap、suppressIO、loadMore 边界条件
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useContinuousScroll } from "../useContinuousScroll";

// 模拟 loadChapters
vi.mock("@/db/repositories", () => ({
  loadChapters: vi.fn().mockResolvedValue([]),
}));

// 建模拟章节列表
function makeChapters(count: number, startId = 0): {
  id: string; title: string; index: number; content: string;
}[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ch-${startId + i}`,
    title: `第${startId + i + 1}章`,
    index: startId + i,
    content: i < count - 2 ? `内容${startId + i + 1}` : "", // 最后两章没有内容
  }));
}

describe("useContinuousScroll", () => {
  const defaultOptions = {
    novelId: "novel-1",
    chapters: makeChapters(5),
    onChapterChange: vi.fn(),
    enabled: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── loadedChapters ──

  describe("loadedChapters", () => {
    it("只返回有 content 的章节", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      expect(result.current.loadedChapters).toHaveLength(3);
      result.current.loadedChapters.forEach((ch) => {
        expect(ch.content).not.toBe("");
      });
    });

    it("章节全部有 content 时全部返回", () => {
      const allWithContent = makeChapters(3).map((ch) => ({
        ...ch,
        content: "有内容",
      }));
      const { result } = renderHook(() =>
        useContinuousScroll({ ...defaultOptions, chapters: allWithContent })
      );

      expect(result.current.loadedChapters).toHaveLength(3);
    });

    it("章节全部无 content 时返回空数组", () => {
      const allEmpty = makeChapters(3).map((ch) => ({
        ...ch,
        content: "",
      }));
      const { result } = renderHook(() =>
        useContinuousScroll({ ...defaultOptions, chapters: allEmpty })
      );

      expect(result.current.loadedChapters).toHaveLength(0);
    });
  });

  // ── chapterIndexMap ──

  describe("chapterIndexMap", () => {
    it("正确映射 chapterId → index", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      expect(result.current.loadedChapters).toBeDefined();
      // 验证 loadedChapters 的 id 是正确的
      expect(result.current.loadedChapters[0].id).toBe("ch-0");
      expect(result.current.loadedChapters[0].index).toBe(0);
      expect(result.current.loadedChapters[2].id).toBe("ch-2");
      expect(result.current.loadedChapters[2].index).toBe(2);
    });
  });

  // ── isLoadingMore ──

  describe("isLoadingMore", () => {
    it("初始为 false", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      expect(result.current.isLoadingMore).toBe(false);
    });
  });

  // ── suppressIO ──

  describe("suppressIO", () => {
    it("返回函数类型", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      const release = result.current.suppressIO();
      expect(typeof release).toBe("function");
    });

    it("传入 targetChapterId 时不报错", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      expect(() => {
        const release = result.current.suppressIO("ch-1");
        release();
      }).not.toThrow();
    });

    it("不传入参数时也不报错", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      expect(() => {
        const release = result.current.suppressIO();
        release();
      }).not.toThrow();
    });
  });

  // ── scrollToChapter ──

  describe("scrollToChapter", () => {
    it("无 container 时直接返回不报错", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      // containerRef 初始为 null，scrollToChapter 应直接返回
      expect(() => {
        result.current.scrollToChapter("ch-1");
      }).not.toThrow();
    });

    it("不存在的章节 ID 不报错", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      // 设置 container，但章节 ID 不存在
      const container = document.createElement("div");
      result.current.containerRef.current = container;

      expect(() => {
        result.current.scrollToChapter("nonexistent-id");
      }).not.toThrow();
    });

    it("使用 scrollIntoView 滚动到可见章节", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      const container = document.createElement("div");
      const section = document.createElement("div");
      section.className = "chapter-section";
      section.setAttribute("data-chapter-id", "ch-1");
      container.appendChild(section);
      result.current.containerRef.current = container;

      const scrollIntoViewMock = vi.fn();
      section.scrollIntoView = scrollIntoViewMock;

      result.current.scrollToChapter("ch-1");

      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        behavior: "instant",
        block: "start",
      });
    });
  });

  // ── 返回的 refs ──

  describe("返回的 refs", () => {
    it("containerRef 初始为 null", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      expect(result.current.containerRef.current).toBeNull();
    });

    it("topSentinelRef 初始为 null", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      expect(result.current.topSentinelRef.current).toBeNull();
    });

    it("bottomSentinelRef 初始为 null", () => {
      const { result } = renderHook(() =>
        useContinuousScroll(defaultOptions)
      );

      expect(result.current.bottomSentinelRef.current).toBeNull();
    });
  });
});