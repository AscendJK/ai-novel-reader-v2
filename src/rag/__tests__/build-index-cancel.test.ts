/**
 * 共享构建与"单个调用方取消"的隔离测试（补批次 4 的 R-31 DoD 缺口）
 *
 * 同一 (novelId, engine) 只应有一份真实构建：多个入口（预取、UI 手动、检索降级）
 * 会并发调 buildAndPollRAGIndex。旧实现把发起者的 signal 交给了共享任务，
 * 于是第一个取消的人（最常见是预取）连带 reject 掉所有人正在等的同一份构建。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = { build: 0, status: 0, index: 0 };
let pollsUntilReady = 3;

function indexBinary(chunkCount = 2, dim = 4): ArrayBuffer {
  const chunksBytes = new TextEncoder().encode(
    JSON.stringify([
      { id: "0", content: "第一段内容", chapterIndex: 0 },
      { id: "1", content: "第二段内容", chapterIndex: 1 },
    ])
  );
  const buf = new ArrayBuffer(12 + chunksBytes.length + chunkCount * dim * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, chunksBytes.length, true);
  dv.setUint32(4, dim, true);
  dv.setUint32(8, chunkCount, true);
  new Uint8Array(buf, 12, chunksBytes.length).set(chunksBytes);
  return buf;
}

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(async (path: string) => {
    const json = (obj: unknown) => ({ ok: true, status: 200, json: async () => obj });
    if (path.endsWith("/build")) {
      calls.build++;
      return json({ status: "building" });
    }
    if (path.includes("/status")) {
      calls.status++;
      const ready = calls.status > pollsUntilReady;
      return json(ready
        ? { status: "ready" }
        : { status: "building", current: calls.status, total: pollsUntilReady + 1 });
    }
    if (path.includes("/index")) {
      calls.index++;
      return { ok: true, status: 200, arrayBuffer: async () => indexBinary() };
    }
    throw new Error(`测试未预置的路径: ${path}`);
  }),
}));

const putMock = vi.fn(async () => undefined);
vi.mock("@/db/database", () => ({
  sharedDB: { ragCache: { put: () => putMock() } },
}));
vi.mock("../rag-cache-utils", () => ({
  enforceIndexedDBQuota: vi.fn(async () => undefined),
}));
vi.mock("@/lib/quota-guard", () => ({
  withQuotaRetry: (op: () => Promise<unknown>) => op(),
  isQuotaError: () => false,
}));
vi.mock("@/stores/rag-store", () => ({
  useRAGStore: { getState: () => ({ addCachedKey: vi.fn() }) },
}));

import { buildAndPollRAGIndex } from "../build-index";

const NOVEL = "novel-1";
const ENGINE = "Xenova/bge-small-zh-v1.5";
const flush = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  calls.build = 0; calls.status = 0; calls.index = 0;
  pollsUntilReady = 3;
  putMock.mockClear();
});

describe("R-31 共享构建的取消隔离", () => {
  const opts = (signal?: AbortSignal, onProgress?: (p: unknown) => void) => ({
    novelId: NOVEL, engine: ENGINE, signal, onProgress,
    pollInterval: 10, timeout: 20000, maxFailCount: 5,
  });

  it("同一 novelId+engine 并发两次只触发一次构建", async () => {
    const p1 = buildAndPollRAGIndex(opts());
    const p2 = buildAndPollRAGIndex(opts());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls.build).toBe(1);
    expect(calls.index).toBe(1);
    expect(r1).toEqual({ cacheKey: `${NOVEL}-${ENGINE}`, chunkCount: 2, dim: 4 });
    expect(r2).toBe(r1);                       // 同一份结果的同一个对象
    expect(putMock).toHaveBeenCalledTimes(1);  // 只落一次缓存
  }, 20000);

  it("一个等待者取消只让它自己退出；共享构建继续为其余等待者跑完", async () => {
    const abortA = new AbortController();
    const progressB = vi.fn();
    const pA = buildAndPollRAGIndex(opts(abortA.signal));
    const pB = buildAndPollRAGIndex(opts(undefined, progressB));

    await flush(25);               // 让两个都进入轮询
    abortA.abort();

    await expect(pA).rejects.toThrow(/取消/);
    const rB = await pB;
    expect(rB.chunkCount).toBe(2);
    expect(calls.build).toBe(1);
    expect(progressB).toHaveBeenCalled();      // B 的进度订阅未因 A 取消而失效
  }, 20000);

  it("先取消再加入的第三个等待者仍能拿到同一份构建的结果", async () => {
    const c1 = new AbortController();
    const p1 = buildAndPollRAGIndex(opts(c1.signal));
    await flush(20);
    c1.abort();
    await expect(p1).rejects.toThrow(/取消/);

    const p3 = buildAndPollRAGIndex(opts());
    const r3 = await p3;
    expect(r3.chunkCount).toBe(2);
    expect(calls.build).toBe(1);               // 取消没有把共享任务一起带走
  }, 20000);

  it("构建以 error 收尾时所有等待者都拿到该错误（不再有人被吊住）", async () => {
    const p1 = buildAndPollRAGIndex(opts());
    const p2 = buildAndPollRAGIndex(opts());
    // 服务端在轮询里报 error：两次等待都应以同一错误失败
    let seen = 0;
    const { apiFetch } = await import("@/lib/api-client");
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path.endsWith("/build")) return { ok: true, status: 200, json: async () => ({ status: "building" }) } as unknown as Response;
      if (path.includes("/status")) {
        seen++;
        return { ok: true, status: 200, json: async () => ({ status: "error", error: `炸了 ${seen}` }) } as unknown as Response;
      }
      return { ok: true, status: 200, arrayBuffer: async () => indexBinary() } as unknown as Response;
    });
    await expect(p1).rejects.toThrow(/炸了|失败|超时|取消/);
    await expect(p2).rejects.toThrow(/炸了|失败|超时|取消/);
  }, 25000);
});
