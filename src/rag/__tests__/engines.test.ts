/**
 * engines 测试
 */

import { describe, it, expect } from "vitest";
import { isEmbeddingEngine, resolveModelKey, getEngineInfo, getEngineDisplayName, ENGINES } from "../engines";

describe("isEmbeddingEngine", () => {
  it("应该返回 false（tfidf 不是嵌入引擎）", () => {
    expect(isEmbeddingEngine("tfidf")).toBe(false);
  });

  it("应该返回 true（bge-small-zh 是嵌入引擎）", () => {
    expect(isEmbeddingEngine("Xenova/bge-small-zh-v1.5")).toBe(true);
  });

  it("应该返回 true（gte-small 是嵌入引擎）", () => {
    expect(isEmbeddingEngine("Xenova/gte-small")).toBe(true);
  });

  it("应该返回 true（自定义引擎是嵌入引擎）", () => {
    expect(isEmbeddingEngine("custom-engine")).toBe(true);
  });
});

describe("resolveModelKey", () => {
  it("应该返回空字符串（tfidf 没有模型）", () => {
    expect(resolveModelKey("tfidf")).toBe("");
  });

  it("应该返回已知引擎的 modelKey", () => {
    expect(resolveModelKey("Xenova/bge-small-zh-v1.5")).toBe("Xenova/bge-small-zh-v1.5");
  });

  it("应该返回未知引擎的原始 id", () => {
    expect(resolveModelKey("custom-engine")).toBe("custom-engine");
  });

  it("应该返回 GTE 的 modelKey", () => {
    expect(resolveModelKey("Xenova/gte-small")).toBe("Xenova/gte-small");
  });
});

describe("getEngineInfo", () => {
  it("应该返回已知引擎的信息", () => {
    const info = getEngineInfo("tfidf");
    expect(info).toBeDefined();
    expect(info?.id).toBe("tfidf");
    expect(info?.name).toContain("TF-IDF");
  });

  it("应该返回 undefined（未知引擎）", () => {
    const info = getEngineInfo("unknown-engine");
    expect(info).toBeUndefined();
  });

  it("应该返回 BGE 的信息", () => {
    const info = getEngineInfo("Xenova/bge-small-zh-v1.5");
    expect(info).toBeDefined();
    expect(info?.id).toBe("Xenova/bge-small-zh-v1.5");
    expect(info?.name).toContain("BGE");
  });
});

describe("getEngineDisplayName", () => {
  it("应该返回已知引擎的显示名称", () => {
    expect(getEngineDisplayName("tfidf")).toBe("TF-IDF（内置）");
  });

  it("应该返回未知引擎的简化名称", () => {
    expect(getEngineDisplayName("Xenova/custom-model")).toBe("custom-model");
  });

  it("应该返回没有斜杠的未知引擎名称", () => {
    expect(getEngineDisplayName("custom-engine")).toBe("custom-engine");
  });

  it("应该返回 BGE 的显示名称", () => {
    expect(getEngineDisplayName("Xenova/bge-small-zh-v1.5")).toContain("BGE");
  });
});

describe("ENGINES 常量", () => {
  it("应该包含 tfidf 引擎", () => {
    expect(ENGINES.tfidf).toBeDefined();
  });

  it("应该包含 bge 引擎", () => {
    expect(ENGINES["Xenova/bge-small-zh-v1.5"]).toBeDefined();
  });

  it("应该包含 gte 引擎", () => {
    expect(ENGINES["Xenova/gte-small"]).toBeDefined();
  });

  it("每个引擎都应该有必要的字段", () => {
    for (const [id, engine] of Object.entries(ENGINES)) {
      expect(engine.id).toBe(id);
      expect(engine.name).toBeDefined();
      expect(engine.description).toBeDefined();
      expect(engine.size).toBeDefined();
      expect(engine.modelKey).toBeDefined();
      expect(Array.isArray(engine.strengths)).toBe(true);
      expect(Array.isArray(engine.weaknesses)).toBe(true);
    }
  });
});
