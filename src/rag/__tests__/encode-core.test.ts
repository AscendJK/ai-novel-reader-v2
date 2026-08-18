/**
 * encode-core 测试
 * 核心编码逻辑：getEncoder 缓存、encoderCache 淘汰、encodeQueryCore 错误处理
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock transformers.js
const mockExtractor = vi.fn();
vi.mock("@xenova/transformers", () => {
  const MockEnv = {
    allowRemoteModels: true,
    useBrowserCache: false,
    allowLocalModels: false,
    remoteHost: "",
  };
  return {
    env: MockEnv,
    pipeline: vi.fn(async () => mockExtractor),
  };
});

// 清除所有模块缓存，使 encode-core 每次都重新导入
beforeEach(() => {
  vi.resetModules();
});

// Mock logger
vi.mock("@/lib/logger", () => ({
  ragLog: vi.fn(),
}));

// Mock engines
vi.mock("@/rag/engines", () => ({
  resolveModelKey: (key: string) => key,
}));

describe("encode-core 模块", () => {
  let encodeQueryCore: (text: string, engine: string, serverUrl: string) => Promise<Float32Array | null>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExtractor.mockReset();
    mockExtractor.mockResolvedValue({ data: new Float32Array([0.1, 0.2, 0.3]) });
    const mod = await import("../encode-core");
    encodeQueryCore = mod.encodeQueryCore;
  });

  describe("encodeQueryCore", () => {
    it("成功编码返回 Float32Array", async () => {
      const result = await encodeQueryCore("测试文本", "test-engine", "http://localhost:5173");
      expect(result).toBeInstanceOf(Float32Array);
      expect(result).toHaveLength(3);
      expect(result![0]).toBeCloseTo(0.1);
    });

    it("serverUrl 为空时返回 null", async () => {
      const result = await encodeQueryCore("测试文本", "test-engine", "");
      expect(result).toBeNull();
    });

    it("编码异常时返回 null", async () => {
      mockExtractor.mockRejectedValue(new Error("encode error"));
      const result = await encodeQueryCore("测试文本", "test-engine", "http://localhost:5173");
      expect(result).toBeNull();
    });

    it("重复调用使用缓存的 encoder", async () => {
      const { pipeline } = await import("@xenova/transformers");
      await encodeQueryCore("文本1", "test-engine", "http://localhost:5173");
      await encodeQueryCore("文本2", "test-engine", "http://localhost:5173");
      // pipeline 只应被调用一次（第二次命中缓存）
      expect(pipeline).toHaveBeenCalledTimes(1);
    });

    it("不同引擎使用不同的 encoder", async () => {
      const { pipeline } = await import("@xenova/transformers");
      await encodeQueryCore("文本1", "engine-a", "http://localhost:5173");
      await encodeQueryCore("文本2", "engine-b", "http://localhost:5173");
      expect(pipeline).toHaveBeenCalledTimes(2);
    });

    it("extractor 返回空数据时返回空 Float32Array", async () => {
      mockExtractor.mockResolvedValue({ data: null });
      const result = await encodeQueryCore("测试", "test-engine", "http://localhost:5173");
      expect(result).toBeInstanceOf(Float32Array);
      expect(result!.length).toBe(0);
    });
  });

  describe("encoder 缓存淘汰", () => {
    it("超过 MAX_ENCODERS=2 时淘汰最旧的", async () => {
      await encodeQueryCore("t1", "engine-a", "http://localhost:5173");
      await encodeQueryCore("t2", "engine-b", "http://localhost:5173");
      // 加入第三个，淘汰 engine-a
      await encodeQueryCore("t3", "engine-c", "http://localhost:5173");
      // 再调用 engine-a 应重新创建
      const { pipeline } = await import("@xenova/transformers");
      const callCountBefore = (pipeline as ReturnType<typeof vi.fn>).mock.calls.length;
      await encodeQueryCore("t4", "engine-a", "http://localhost:5173");
      expect((pipeline as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountBefore + 1);
    });
  });
});