import { describe, it, expect, beforeEach } from "vitest";

const TTS_POS_KEY = "novel-reader-tts-position";

function savePosition(novelId: string, chapterIndex: number, paragraph: number) {
  try {
    localStorage.setItem(TTS_POS_KEY, JSON.stringify({ novelId, chapterIndex, paragraph }));
  } catch { /* ignore */ }
}

function loadPosition(novelId: string, chapterIndex: number): number | null {
  try {
    const raw = localStorage.getItem(TTS_POS_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (pos.novelId === novelId && pos.chapterIndex === chapterIndex) return pos.paragraph;
  } catch { /* ignore */ }
  return null;
}

describe("TTS 位置保存/恢复", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("保存位置后可以恢复", () => {
    savePosition("novel-1", 2, 15);
    expect(loadPosition("novel-1", 2)).toBe(15);
  });

  it("没有保存的位置返回 null", () => {
    expect(loadPosition("novel-1", 0)).toBeNull();
  });

  it("小说 ID 不匹配返回 null", () => {
    savePosition("novel-1", 0, 10);
    expect(loadPosition("novel-999", 0)).toBeNull();
  });

  it("章节索引不匹配返回 null", () => {
    savePosition("novel-1", 0, 10);
    expect(loadPosition("novel-1", 5)).toBeNull();
  });

  it("保存新位置覆盖旧位置", () => {
    savePosition("novel-1", 0, 10);
    savePosition("novel-1", 0, 20);
    expect(loadPosition("novel-1", 0)).toBe(20);
  });

  it("段落索引为 0 可以正确保存和恢复", () => {
    savePosition("novel-1", 0, 0);
    expect(loadPosition("novel-1", 0)).toBe(0);
  });

  it("只保存最后一个位置（单 key 设计）", () => {
    // 位置存储使用单个 localStorage key，新位置覆盖旧位置
    // 这是设计如此：TTS 只追踪一个"当前朗读位置"
    savePosition("novel-1", 0, 10);
    savePosition("novel-2", 0, 20);
    // novel-1 的位置被覆盖了
    expect(loadPosition("novel-1", 0)).toBeNull();
    expect(loadPosition("novel-2", 0)).toBe(20);
  });

  it("同一小说不同章节，后者覆盖前者", () => {
    savePosition("novel-1", 0, 10);
    savePosition("novel-1", 1, 20);
    // 章节 0 的位置被覆盖
    expect(loadPosition("novel-1", 0)).toBeNull();
    expect(loadPosition("novel-1", 1)).toBe(20);
  });
});
