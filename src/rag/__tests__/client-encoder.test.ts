/**
 * `src/rag/client-encoder.ts`：13 行的主线程兜底腿。
 *
 * 为什么要钉这么小的文件：它是 **Worker 起不来之后唯一还能算出查询向量的路**——
 * `worker-client.ts:102/106` 两处都汇到这里（`encodeQueryWithWorker` 的注释自己写着
 * "null = 彻底失败"），再往下就是 `embedding-retriever.search` 那句 `if (!qVec) return []`。
 * 全仓 17 笔改动碰过它，而碰到它的测试（`encode-core` / `model-loader` / 本批新加的
 * `embedding-retriever`）**都把这只文件桩掉**，所以"它到底把地址与引擎交给谁"从来没被答过。
 *
 * 它只替调用点做三件事，判据就按这三件下刀：① 地址用**生效的** serverUrl（不是裸配置值、
 * 也不是模块加载时抓的快照）；② 文本与引擎**原样**递下去（偷偷换默认模型 = 查询向量与
 * 库向量不在同一空间，检索会"看着能用其实全错"）；③ 失败就交回 null，不许包装成空向量。
 *
 * 夹具：`./encode-core` 与 `@/lib/api-client` 都换成记账的桩——core 那一层有自己的
 * 判据文件（`encode-core.test.ts`），地址解析那一层也是（`api-client.test.ts`），
 * 这里只判"这三样东西有没有按原样递到该去的地方"。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const s = vi.hoisted(() => ({
  core: vi.fn(),
  serverUrl: "http://127.0.0.1:8443",
}));

vi.mock("../encode-core", () => ({ encodeQueryCore: (...a: unknown[]) => s.core(...a) }));
vi.mock("@/lib/api-client", () => ({ getEffectiveServerUrl: () => s.serverUrl }));

const DEFAULT_ENGINE = "Xenova/bge-small-zh-v1.5";

beforeEach(() => {
  s.core.mockReset();
  s.serverUrl = "http://127.0.0.1:8443";
});

describe("encodeQuery（主线程兜底）", () => {
  it("把「生效地址」交给 core：不是空串，也不是别处再拼一份", async () => {
    const { encodeQuery } = await import("../client-encoder");
    s.core.mockResolvedValue(new Float32Array([0.5]));
    const v = await encodeQuery("第一段正文", DEFAULT_ENGINE);
    expect(s.core).toHaveBeenCalledWith("第一段正文", DEFAULT_ENGINE, "http://127.0.0.1:8443");
    expect(Array.from(v ?? [])).toEqual([0.5]);
  });

  it("地址要在每次调用时现取：换服务器之后再打一发，不许还拿着开机那一刻的", async () => {
    const { encodeQuery } = await import("../client-encoder");
    s.core.mockResolvedValue(new Float32Array([1]));
    await encodeQuery("第一次", DEFAULT_ENGINE);
    s.serverUrl = "http://192.168.1.20:8443";
    await encodeQuery("第二次", DEFAULT_ENGINE);
    expect(s.core.mock.calls[1]?.[2], "用户在设置页改了地址，兜底腿得跟着走").toBe("http://192.168.1.20:8443");
  });

  it("同源部署（地址就是当前源）也要把这份 origin 递下去，不许留空", async () => {
    const { encodeQuery } = await import("../client-encoder");
    s.serverUrl = "https://reader.example.com";
    s.core.mockResolvedValue(new Float32Array([1]));
    await encodeQuery("文本", DEFAULT_ENGINE);
    expect(s.core).toHaveBeenCalledWith("文本", DEFAULT_ENGINE, "https://reader.example.com");
  });

  it("引擎要原样递：偷偷换成默认模型，查询向量就跟库向量不在同一空间", async () => {
    const { encodeQuery } = await import("../client-encoder");
    s.core.mockResolvedValue(new Float32Array([1]));
    await encodeQuery("文本", "Xenova/gte-small");
    expect(s.core.mock.calls[0]?.[1]).toBe("Xenova/gte-small");
  });

  it("文本一个字符都不许动：首尾空白也是用户在搜索框里输入的内容", async () => {
    const { encodeQuery } = await import("../client-encoder");
    s.core.mockResolvedValue(new Float32Array([1]));
    await encodeQuery("  剑徒  ", DEFAULT_ENGINE);
    expect(s.core.mock.calls[0]?.[0]).toBe("  剑徒  ");
  });

  it("core 算不出来就交回 null，不许包装成空向量——上面靠 null 判「彻底失败」", async () => {
    const { encodeQuery } = await import("../client-encoder");
    s.core.mockResolvedValue(null);
    expect(await encodeQuery("文本", DEFAULT_ENGINE)).toBeNull();
  });

  it("core 抛出来的是异常时不许在这里被咽成「算不出来」", async () => {
    // encodeQueryCore 自己 catch 了常规失败，能抛到这里的只剩它管不到的那类
    // （比如主线程根本没有 WASM）。咽掉的话上层只会看到"搜不到"，看不到"这台机器算不了"。
    const { encodeQuery } = await import("../client-encoder");
    s.core.mockRejectedValue(new Error("WebAssembly 不可用"));
    await expect(encodeQuery("文本", DEFAULT_ENGINE)).rejects.toThrow("WebAssembly 不可用");
  });
});
