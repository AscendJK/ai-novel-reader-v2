/**
 * `encode.worker.ts` 的消息协议（覆盖地板补的那只）
 *
 * 这只文件在 2026-09-22 的地板重算里是 **src 层唯一真裸的运行时模块**：单测不可达、
 * 浏览器层的加载记录也够不到它（Worker 是 `new Worker(new URL(...))`，不在页面模块图里）。
 * 而它的契约只有一条容错空间——`worker-client.ts:35` 按 `msg.id` 配对回程，
 * 回程丢了 id 就是**调用方的 promise 永久悬空**（症状：离线检索一直转圈），
 * 而"失败也要回话"决定主线程能不能回退（`worker-client.ts:84-87`）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const core = vi.hoisted(() => ({ encodeQueryCore: vi.fn() }));
vi.mock("../encode-core", () => ({ encodeQueryCore: core.encodeQueryCore }));

type Posted = { payload: Record<string, unknown>; opts?: { transfer?: Transferable[] } };
type Handler = (e: MessageEvent) => void;

let posted: Posted[] = [];
let onmessage: Handler | null = null;

async function loadWorker() {
  posted = [];
  onmessage = null;
  const fakeSelf: { onmessage: Handler | null; postMessage: (p: Record<string, unknown>, o?: { transfer?: Transferable[] }) => void } = {
    onmessage: null,
    postMessage: (payload, opts) => {
      posted.push({ payload, opts });
    },
  };
  vi.stubGlobal("self", fakeSelf);
  vi.resetModules();
  await import("../encode.worker");
  onmessage = fakeSelf.onmessage;
  expect(onmessage, "worker 模块没在 self 上挂 onmessage").toBeTruthy();
  return fakeSelf;
}

function send(data: unknown) {
  onmessage!({ data } as MessageEvent);
}

/** 等回程落到 postMessage（core 那条 promise 链要过几个微任务） */
async function settle() {
  await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
  return posted[0].payload;
}

beforeEach(async () => {
  core.encodeQueryCore.mockReset();
  await loadWorker();
});

describe("编码 Worker 的回程协议", () => {
  it("成功：带回同一个 id、data 是 Float32Array、dim 是长度，buffer 走 transfer", async () => {
    const vec = new Float32Array([0.25, -0.5, 1]);
    core.encodeQueryCore.mockResolvedValue(vec);
    send({ type: "main", id: 7, text: "令狐冲练剑", engine: "Xenova/bge-small-zh-v1.5", serverUrl: "http://x" });

    const msg = await settle();
    expect(msg).toMatchObject({ type: "encode-result", id: 7, ok: true, dim: 3 });
    expect(msg.data).toBeInstanceOf(Float32Array);
    expect(Array.from(msg.data as Float32Array)).toEqual([0.25, -0.5, 1]);
    // 结构拷贝会让每次查询多复制一份向量；这条注释里写着"用 transfer"，就得真带上
    expect(posted[0].opts?.transfer?.[0]).toBe(vec.buffer);
  });

  it("编码抛错：必须回 ok:false 并带上原文，让主线程回退而不是静默悬空", async () => {
    core.encodeQueryCore.mockRejectedValue(new Error("模型没缓存"));
    send({ type: "main", id: 3, text: "a", engine: "e", serverUrl: "s" });
    expect(await settle()).toEqual({ type: "encode-result", id: 3, ok: false, error: "模型没缓存" });
  });

  it("编码返回 null/undefined：不许报成 ok:true（调用方会退化成一句「encode failed」丢掉真原因）", async () => {
    core.encodeQueryCore.mockResolvedValue(null);
    send({ type: "main", id: 9, text: "a", engine: "e", serverUrl: "s" });
    const msg = await settle();
    expect(msg.ok).toBe(false);
    expect(msg.error).toContain("null");
    expect(msg.id).toBe(9);
  });

  it("非 main 消息不许触发编码，也不许回话（回程会配对到不存在的 id 上）", async () => {
    send({ type: "ping", id: 11 });
    await Promise.resolve();
    expect(core.encodeQueryCore).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });

  it("缺 text/engine/serverUrl 时按空串编码，不许拿 undefined 去炸 core", async () => {
    core.encodeQueryCore.mockResolvedValue(new Float32Array([1]));
    send({ type: "main", id: 12 });
    await settle();
    expect(core.encodeQueryCore).toHaveBeenCalledWith("", "", "");
  });
});
