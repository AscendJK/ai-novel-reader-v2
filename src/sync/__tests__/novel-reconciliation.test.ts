import { describe, it, expect } from "vitest";
import { shouldDownloadNovel, shouldDeleteLocalNovel } from "../novel-reconciliation";
import type { NovelRecord, ChapterRecord } from "@/db/database";

const novel = (over: Partial<NovelRecord> = {}): NovelRecord => ({
  id: "novel-1",
  title: "测试小说",
  fileName: "test.txt",
  fileFormat: "txt",
  totalChars: 1000,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const chapter = (over: Partial<ChapterRecord> = {}): ChapterRecord => ({
  id: "ch1",
  novelId: "novel-1",
  index: 0,
  title: "第一章",
  content: "内容",
  startOffset: 0,
  endOffset: 4,
  ...over,
});

describe("novel-reconciliation", () => {
  describe("shouldDownloadNovel", () => {
    it("本地无记录 → 需要下载（首次从服务器拉取）", () => {
      expect(shouldDownloadNovel(null, [])).toBe(true);
      expect(shouldDownloadNovel(undefined, undefined)).toBe(true);
    });

    it("本地有记录且有未软删章节 → 不需要下载", () => {
      expect(shouldDownloadNovel(novel(), [chapter()])).toBe(false);
      expect(shouldDownloadNovel(novel(), [chapter({ deleted: 5 }), chapter()])).toBe(false);
    });

    it("本地有记录但章节为空 → 需要下载（自愈）", () => {
      expect(shouldDownloadNovel(novel(), [])).toBe(true);
      expect(shouldDownloadNovel(novel(), null)).toBe(true);
      expect(shouldDownloadNovel(novel(), undefined)).toBe(true);
    });

    it("本地有记录但章节全部被软删 → 需要下载（目录自愈恢复）", () => {
      const softDeleted = [chapter({ deleted: 100 }), chapter({ id: "ch2", index: 1, deleted: 101 })];
      expect(shouldDownloadNovel(novel(), softDeleted)).toBe(true);
    });
  });

  describe("shouldDeleteLocalNovel", () => {
    it("永远不自动删除本地副本——本地数据只能由用户显式删除", () => {
      // 覆盖所有自动同步场景：join 失败、网络异常、服务器列表对比
      expect(shouldDeleteLocalNovel()).toBe(false);
      expect(shouldDeleteLocalNovel()).toBe(false);
    });
  });
});
