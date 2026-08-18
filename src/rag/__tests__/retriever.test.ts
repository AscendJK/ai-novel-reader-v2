/**
 * Retriever (TF-IDF) 纯逻辑测试
 * 无 DOM 依赖，纯 JS 实现
 */
import { describe, it, expect, vi } from "vitest";
import { Retriever } from "../retriever";

describe("Retriever", () => {
  const docs = [
    { id: "0", content: "今天天气真不错适合出去散步" },
    { id: "1", content: "明天可能会下雨记得带伞" },
    { id: "2", content: "人工智能正在改变世界格局" },
    { id: "3", content: "深度学习是人工智能的重要分支" },
    { id: "4", content: "天气好的时候适合户外运动" },
  ];

  describe("buildAsync", () => {
    it("构建成功返回 Retriever 实例", async () => {
      const r = await Retriever.buildAsync(docs);
      expect(r).toBeInstanceOf(Retriever);
    });

    it("空文档列表构建成功", async () => {
      const r = await Retriever.buildAsync([]);
      expect(r).toBeInstanceOf(Retriever);
    });

    it("搜索空 retriever 返回空数组", async () => {
      const r = await Retriever.buildAsync([]);
      expect(r.search("test")).toEqual([]);
    });

    it("搜索返回 topK 结果并按分数降序排列", async () => {
      const r = await Retriever.buildAsync(docs);
      const results = r.search("天气", 3);
      expect(results).toHaveLength(3);
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
    });

    it("不传 topK 时默认返回 10 条", async () => {
      const r = await Retriever.buildAsync(docs);
      const results = r.search("天气");
      expect(results).toHaveLength(5); // 总共只有 5 条
    });

    it("空查询返回空数组", async () => {
      const r = await Retriever.buildAsync(docs);
      expect(r.search("")).toEqual([]);
    });

    it("天气相关查询应该优先返回天气相关文档", async () => {
      const r = await Retriever.buildAsync(docs);
      const results = r.search("天气散步");
      // 包含"天气"的文档应该排在前面
      const weatherDocs = ["0", "4"];
      const topIds = results.slice(0, 2).map(r => r.id);
      expect(topIds).toContain("0");
      expect(topIds).toContain("4");
    });

    it("AI 相关查询应该优先返回 AI 相关文档", async () => {
      const r = await Retriever.buildAsync(docs);
      const results = r.search("人工智能深度学习");
      const aiDocs = ["2", "3"];
      const topIds = results.slice(0, 2).map(r => r.id);
      expect(topIds).toContain("2");
      expect(topIds).toContain("3");
    });

    it("调用 onProgress 回调", async () => {
      const onProgress = vi.fn();
      await Retriever.buildAsync(docs, onProgress);
      expect(onProgress).toHaveBeenCalled();
    });
  });

  describe("fromCache / toCache", () => {
    it("toCache 返回序列化数据", async () => {
      const r = await Retriever.buildAsync(docs);
      const cache = r.toCache();
      expect(cache.vectorsBuffer).toBeInstanceOf(ArrayBuffer);
      expect(cache.vectorsBuffer.byteLength).toBeGreaterThan(0);
      expect(cache.extraData).toBeDefined();
      expect(typeof cache.extraData).toBe("string");
    });

    it("fromCache 重建的 retriever 搜索结果一致", async () => {
      const r1 = await Retriever.buildAsync(docs);
      const cache = r1.toCache();
      const r2 = Retriever.fromCache(docs, cache.vectorsBuffer, cache.extraData);

      const results1 = r1.search("天气");
      const results2 = r2.search("天气");
      // 浮点精度损失（Float64→Float32→Float64），结果顺序应一致
      expect(results1).toHaveLength(results2.length);
      expect(results1.map(r => r.id)).toEqual(results2.map(r => r.id));
      for (let i = 0; i < results1.length; i++) {
        expect(Math.abs(results1[i].score - results2[i].score)).toBeLessThan(0.1);
      }
    });

    it("fromCache 重建后搜索不同关键词", async () => {
      const r1 = await Retriever.buildAsync(docs);
      const cache = r1.toCache();
      const r2 = Retriever.fromCache(docs, cache.vectorsBuffer, cache.extraData);

      const results = r2.search("人工智能");
      expect(results).toHaveLength(5);
      expect(results[0].score).toBeGreaterThan(0);
    });
  });

  describe("buildDocsIfNeeded", () => {
    it("docs 不为空时跳过构建", async () => {
      const r = new Retriever(docs);
      // 先构建
      await r.buildDocsIfNeeded();
      const results1 = r.search("天气");
      // 再次调用不应重复构建
      await r.buildDocsIfNeeded();
      const results2 = r.search("天气");
      expect(results2).toEqual(results1);
    });

    it("chunks 为空时跳过构建", async () => {
      const r = new Retriever([]);
      await r.buildDocsIfNeeded();
      expect(r.search("test")).toEqual([]);
    });
  });

  describe("搜索结果一致性", () => {
    it("相同查询返回相同结果", async () => {
      const r = await Retriever.buildAsync(docs);
      const r1 = r.search("人工智能");
      const r2 = r.search("人工智能");
      expect(r1).toEqual(r2);
    });

    it("分数在 0~1 之间", async () => {
      const r = await Retriever.buildAsync(docs);
      const results = r.search("天气");
      for (const res of results) {
        expect(res.score).toBeGreaterThanOrEqual(0);
        expect(res.score).toBeLessThanOrEqual(1);
      }
    });
  });
});