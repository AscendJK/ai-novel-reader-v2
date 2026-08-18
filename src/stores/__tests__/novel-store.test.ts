/**
 * novel-store 测试
 * Zustand store，直接测试状态和方法
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useNovelStore, shallow } from "../novel-store";
import type { Novel } from "@/parsers/types";

// 创建模拟小说
function makeNovel(id: string, title: string, chapterCount = 3): Novel {
  return {
    id,
    title,
    author: "作者",
    fileName: `${id}.txt`,
    fileFormat: "txt" as const,
    totalChars: 10000,
    chapterCount,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-ch-${i}`,
      novelId: id,
      index: i,
      title: `第${i + 1}章`,
      content: `内容${i + 1}`,
      startOffset: i * 10,
      endOffset: (i + 1) * 10,
    })),
  };
}

const novel1 = makeNovel("novel-1", "测试小说1", 3);
const novel2 = makeNovel("novel-2", "测试小说2", 2);

// ── shallow 工具函数 ──

describe("shallow", () => {
  it("相同引用返回 true", () => {
    const obj = { a: 1 };
    expect(shallow(obj, obj)).toBe(true);
  });

  it("相同值返回 true", () => {
    expect(shallow({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });

  it("不同值返回 false", () => {
    expect(shallow({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("不同键返回 false", () => {
    expect(shallow({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("null/非对象处理", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(shallow(null as any, null as any)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(shallow(null as any, { a: 1 })).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(shallow({ a: 1 }, null as any)).toBe(false);
  });

  it("原始值比较", () => {
    expect(shallow(1, 1)).toBe(true);
    expect(shallow(1, 2)).toBe(false);
  });
});

// ── 初始状态 ──

describe("初始状态", () => {
  beforeEach(() => {
    useNovelStore.setState({
      currentNovel: null,
      novels: [],
      selectedChapterId: null,
      readingPositions: {},
    });
  });

  it("初始状态正确", () => {
    const state = useNovelStore.getState();
    expect(state.currentNovel).toBeNull();
    expect(state.novels).toEqual([]);
    expect(state.selectedChapterId).toBeNull();
    expect(state.readingPositions).toEqual({});
  });
});

// ── setCurrentNovel ──

describe("setCurrentNovel", () => {
  beforeEach(() => {
    localStorage.clear();
    useNovelStore.setState({
      currentNovel: null,
      novels: [novel1, novel2],
      selectedChapterId: null,
      readingPositions: {},
    });
  });

  it("设为 null 时清空 currentNovel 和 selectedChapterId", () => {
    useNovelStore.getState().setCurrentNovel(null);
    const state = useNovelStore.getState();
    expect(state.currentNovel).toBeNull();
    expect(state.selectedChapterId).toBeNull();
  });

  it("设置小说时选中第一个章节", () => {
    useNovelStore.getState().setCurrentNovel(novel1);
    const state = useNovelStore.getState();
    expect(state.currentNovel?.id).toBe("novel-1");
    expect(state.selectedChapterId).toBe("novel-1-ch-0");
  });

  it("有阅读位置时恢复到对应章节", () => {
    useNovelStore.setState({
      readingPositions: {
        "novel-1": { chapterId: "novel-1-ch-1", chapterIndex: 1 },
      },
    });
    useNovelStore.getState().setCurrentNovel(novel1);
    const state = useNovelStore.getState();
    expect(state.selectedChapterId).toBe("novel-1-ch-1");
  });

  it("阅读位置中的章节不存在时选中第一章", () => {
    useNovelStore.setState({
      readingPositions: {
        "novel-1": { chapterId: "novel-1-ch-999", chapterIndex: 999 },
      },
    });
    useNovelStore.getState().setCurrentNovel(novel1);
    const state = useNovelStore.getState();
    expect(state.selectedChapterId).toBe("novel-1-ch-0");
  });
});

// ── setSelectedChapter ──

describe("setSelectedChapter", () => {
  beforeEach(() => {
    localStorage.clear();
    useNovelStore.setState({
      currentNovel: novel1,
      novels: [novel1],
      selectedChapterId: null,
      readingPositions: {},
    });
  });

  it("更新 selectedChapterId", () => {
    useNovelStore.getState().setSelectedChapter("novel-1-ch-1");
    expect(useNovelStore.getState().selectedChapterId).toBe("novel-1-ch-1");
  });

  it("无 currentNovel 时只更新 selectedChapterId", () => {
    useNovelStore.setState({ currentNovel: null });
    useNovelStore.getState().setSelectedChapter("ch-1");
    expect(useNovelStore.getState().selectedChapterId).toBe("ch-1");
  });

  it("传入 scrollTop 时保存到阅读位置", () => {
    useNovelStore.getState().setSelectedChapter("novel-1-ch-1", 100);
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    expect(pos.chapterId).toBe("novel-1-ch-1");
    expect(pos.chapterIndex).toBe(1);
    expect(pos.scrollTop).toBe(100);
  });
});

// ── addNovel ──

describe("addNovel", () => {
  beforeEach(() => {
    useNovelStore.setState({ novels: [] });
  });

  it("添加不重复的小说", () => {
    useNovelStore.getState().addNovel(novel1);
    expect(useNovelStore.getState().novels).toHaveLength(1);
    expect(useNovelStore.getState().novels[0].id).toBe("novel-1");
  });

  it("重复添加不生效", () => {
    useNovelStore.getState().addNovel(novel1);
    useNovelStore.getState().addNovel(novel1);
    expect(useNovelStore.getState().novels).toHaveLength(1);
  });

  it("添加不同小说", () => {
    useNovelStore.getState().addNovel(novel1);
    useNovelStore.getState().addNovel(novel2);
    expect(useNovelStore.getState().novels).toHaveLength(2);
  });
});

// ── removeNovel ──

describe("removeNovel", () => {
  beforeEach(() => {
    useNovelStore.setState({
      novels: [novel1, novel2],
      currentNovel: null,
      readingPositions: {
        "novel-1": { chapterId: "novel-1-ch-0", chapterIndex: 0 },
        "novel-2": { chapterId: "novel-2-ch-0", chapterIndex: 0 },
      },
    });
  });

  it("删除小说", () => {
    useNovelStore.getState().removeNovel("novel-1");
    expect(useNovelStore.getState().novels).toHaveLength(1);
    expect(useNovelStore.getState().novels[0].id).toBe("novel-2");
  });

  it("删除小说同时删除阅读位置", () => {
    useNovelStore.getState().removeNovel("novel-1");
    expect(useNovelStore.getState().readingPositions["novel-1"]).toBeUndefined();
    expect(useNovelStore.getState().readingPositions["novel-2"]).toBeDefined();
  });

  it("删除当前小说时清空 currentNovel", () => {
    useNovelStore.setState({ currentNovel: novel1 });
    useNovelStore.getState().removeNovel("novel-1");
    expect(useNovelStore.getState().currentNovel).toBeNull();
  });

  it("删除非当前小说不影响 currentNovel", () => {
    useNovelStore.setState({ currentNovel: novel1 });
    useNovelStore.getState().removeNovel("novel-2");
    expect(useNovelStore.getState().currentNovel?.id).toBe("novel-1");
  });
});

// ── getReadingPosition ──

describe("getReadingPosition", () => {
  beforeEach(() => {
    useNovelStore.setState({
      readingPositions: {
        "novel-1": { chapterId: "ch-1", chapterIndex: 1 },
      },
    });
  });

  it("存在时返回阅读位置", () => {
    const pos = useNovelStore.getState().getReadingPosition("novel-1");
    expect(pos).toEqual({ chapterId: "ch-1", chapterIndex: 1 });
  });

  it("不存在时返回 null", () => {
    const pos = useNovelStore.getState().getReadingPosition("nonexistent");
    expect(pos).toBeNull();
  });
});

// ── saveReadingPosition ──

describe("saveReadingPosition", () => {
  beforeEach(() => {
    useNovelStore.setState({
      readingPositions: {
        "novel-1": { chapterId: "ch-0", chapterIndex: 0, scrollTop: 0 },
      },
    });
  });

  it("保存阅读位置", () => {
    useNovelStore.getState().saveReadingPosition("novel-1", "ch-1", 1, 100);
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    expect(pos.chapterId).toBe("ch-1");
    expect(pos.chapterIndex).toBe(1);
    expect(pos.scrollTop).toBe(100);
  });

  it("无变化时跳过更新", () => {
    useNovelStore.getState().saveReadingPosition("novel-1", "ch-0", 0, 0);
    // 应该仍然是初始状态，不会被修改
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    expect(pos.chapterId).toBe("ch-0");
  });

  it("只更新 scrollTop 时保留其他字段", () => {
    useNovelStore.getState().saveReadingPosition(
      "novel-1", "ch-1", 1, 200, 50
    );
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    expect(pos.chapterId).toBe("ch-1");
    expect(pos.chapterIndex).toBe(1);
    expect(pos.scrollTop).toBe(200);
    expect(pos.chapterOffset).toBe(50);
  });
});

// ── saveScrollTop ──

describe("saveScrollTop", () => {
  beforeEach(() => {
    useNovelStore.setState({
      currentNovel: novel1,
      readingPositions: {
        "novel-1": { chapterId: "ch-0", chapterIndex: 0, scrollTop: 0 },
      },
    });
  });

  it("更新滚动位置", () => {
    useNovelStore.getState().saveScrollTop(200);
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    expect(pos.scrollTop).toBe(200);
  });

  it("无 currentNovel 时跳过", () => {
    useNovelStore.setState({ currentNovel: null });
    useNovelStore.getState().saveScrollTop(200);
    // readingPositions 不应变化
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    expect(pos.scrollTop).toBe(0);
  });

  it("无现有位置时跳过", () => {
    useNovelStore.setState({ readingPositions: {} });
    useNovelStore.getState().saveScrollTop(200);
    expect(useNovelStore.getState().readingPositions["novel-1"]).toBeUndefined();
  });

  it("无变化时跳过", () => {
    useNovelStore.getState().saveScrollTop(0);
    const pos = useNovelStore.getState().readingPositions["novel-1"];
    expect(pos.scrollTop).toBe(0); // 不变
  });
});

// ── addChapters ──

describe("addChapters", () => {
  const novelWithPartialContent = makeNovel("novel-1", "测试", 5);
  // 清空部分章节的内容
  novelWithPartialContent.chapters = novelWithPartialContent.chapters.map((ch, i) => ({
    ...ch,
    content: i < 2 ? ch.content : "", // 只有前两章有内容
  }));

  beforeEach(() => {
    useNovelStore.setState({
      currentNovel: null,
    });
  });

  it("无 currentNovel 时跳过", () => {
    useNovelStore.getState().addChapters([{ id: "new-ch", novelId: "novel-1", index: 0, title: "新章", content: "内容", startOffset: 0, endOffset: 2 }]);
    expect(useNovelStore.getState().currentNovel).toBeNull();
  });

  it("更新现有章节内容", () => {
    useNovelStore.setState({ currentNovel: novelWithPartialContent });
    const newChapter = {
      ...novelWithPartialContent.chapters[2],
      content: "新加载的内容",
    };
    useNovelStore.getState().addChapters([newChapter]);
    const updatedChapter = useNovelStore.getState().currentNovel!.chapters[2];
    expect(updatedChapter.content).toBe("新加载的内容");
    // 标题不变
    expect(updatedChapter.title).toBe("第3章");
  });

  it("添加新章节", () => {
    useNovelStore.setState({ currentNovel: novelWithPartialContent });
    const newChapter = {
      id: "novel-1-ch-5",
      novelId: "novel-1",
      index: 5,
      title: "第6章",
      content: "新章节内容",
      startOffset: 50,
      endOffset: 60,
    };
    useNovelStore.getState().addChapters([newChapter]);
    expect(useNovelStore.getState().currentNovel!.chapters).toHaveLength(6);
  });

  it("按 index 排序", () => {
    useNovelStore.setState({ currentNovel: { ...novel1, chapters: [] } });
    const ch1 = { id: "ch-1", novelId: "novel-1", index: 1, title: "第2章", content: "内容", startOffset: 0, endOffset: 2 };
    const ch0 = { id: "ch-0", novelId: "novel-1", index: 0, title: "第1章", content: "内容", startOffset: 0, endOffset: 2 };
    useNovelStore.getState().addChapters([ch1, ch0]);
    const chapters = useNovelStore.getState().currentNovel!.chapters;
    expect(chapters[0].index).toBe(0);
    expect(chapters[1].index).toBe(1);
  });
});