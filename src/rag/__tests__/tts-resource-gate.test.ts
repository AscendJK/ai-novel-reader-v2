/**
 * TTS 资源下载的"全服务器只下一趟"闸门（lib/tts-resource-gate.mjs）
 *
 * 这里锁的不是"这次下载成没成"，而是失败之后**还有没有下次**：三只状态（是否就绪、
 * 在跑的那趟 promise、上次失败时刻）收尾少一件，症状就是"以后所有人都再也下不了，
 * 只能重启后端"。这类死法没有任何用户可见的报错。
 * 闸门本身不碰时钟定时器（只把 now() 用在冷却比较上），所以这里可以放心用假时钟。
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";

type Progress = ((step: string, detail: string) => void) | undefined;
type Opts = { signal: AbortSignal; force: boolean };
type Download = (onProgress?: Progress, opts?: Opts) => Promise<void>;

// @ts-expect-error - 后端 JS 模块无类型声明
const mod = await import("../../../server/lib/tts-resource-gate.mjs");
const { createResourceGate } = mod as {
  createResourceGate: (o: {
    download: Download;
    cooldownMs?: number;
    now?: () => number;
  }) => { ensure: (onProgress?: Progress, opts?: { signal?: AbortSignal; force?: boolean }) => Promise<void> };
};

function harness(overrides: { cooldownMs?: number } = {}) {
  let clock = 1_000_000;
  const download: Mock<Download> = vi.fn(async () => {});
  const gate = createResourceGate({ download, now: () => clock, cooldownMs: overrides.cooldownMs ?? 30000 });
  return { gate, download, tick: (ms: number) => { clock += ms; } };
}

describe("一趟车", () => {
  it("成功后再要就直接返回，绝不重下（一次 322MB）", async () => {
    const h = harness();
    await h.gate.ensure();
    await h.gate.ensure();
    expect(h.download).toHaveBeenCalledTimes(1);
  });

  it("并发请求共享同一趟下载", async () => {
    const h = harness();
    let release: () => void = () => {};
    h.download.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const a = h.gate.ensure();
    const b = h.gate.ensure();
    expect(h.download).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([a, b]);
  });

  it("只有真正起跑那次的进度回调会被使用（后来者不能各推一份）", async () => {
    const h = harness();
    const first = vi.fn();
    const second = vi.fn();
    let release: () => void = () => {};
    h.download.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const a = h.gate.ensure(first);
    const b = h.gate.ensure(second);
    const cb = h.download.mock.calls[0][0];
    cb?.("下载中", "1/4");            // 模拟下载器推进度
    release();
    await Promise.all([a, b]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

describe("失败收尾：三件事一件都不能少", () => {
  it("失败后 promise 必须作废——冷却过了要能重新下载（不作废就是永久卡死）", async () => {
    const h = harness();
    h.download.mockRejectedValueOnce(new Error("文件头校验失败"));
    await expect(h.gate.ensure()).rejects.toThrow("文件头校验失败");
    h.tick(31_000);
    await h.gate.ensure();
    expect(h.download).toHaveBeenCalledTimes(2);
  });

  it("失败后 30 秒内不再重试（前端会自动点很多次）", async () => {
    const h = harness();
    h.download.mockRejectedValueOnce(new Error("停滞超时"));
    await expect(h.gate.ensure()).rejects.toThrow("停滞超时");
    await expect(h.gate.ensure()).rejects.toThrow("上次下载失败，请 30 秒后重试");
    expect(h.download).toHaveBeenCalledTimes(1);
    h.tick(29_999);
    await expect(h.gate.ensure()).rejects.toThrow(/30 秒后重试/);
    expect(h.download).toHaveBeenCalledTimes(1);
  });

  it("冷却时长改了就照新的报（文案与参数不许分叉）", async () => {
    const h = harness({ cooldownMs: 5000 });
    h.download.mockRejectedValueOnce(new Error("x"));
    await expect(h.gate.ensure()).rejects.toBeTruthy();
    await expect(h.gate.ensure()).rejects.toThrow("上次下载失败，请 5 秒后重试");
  });

  it("刚好到冷却时间的边界放行（判据是 <，不是 <=）", async () => {
    const h = harness();
    h.download.mockRejectedValueOnce(new Error("x"));
    await expect(h.gate.ensure()).rejects.toBeTruthy();
    h.tick(30_000);
    await h.gate.ensure();
    expect(h.download).toHaveBeenCalledTimes(2);
  });

  it("下载失败时掐掉内部下载（别留一只悬挂的 fetch 占着连接）", async () => {
    const h = harness();
    let seen: AbortSignal | undefined;
    h.download.mockImplementation((_p, opts) => { seen = opts?.signal; return Promise.reject(new Error("炸了")); });
    await expect(h.gate.ensure()).rejects.toThrow("炸了");
    expect(seen?.aborted).toBe(true);
  });

  it("下载成功时不去掐它（掐了就是把刚下完的连接算成失败）", async () => {
    const h = harness();
    let seen: AbortSignal | undefined;
    h.download.mockImplementation((_p, opts) => { seen = opts?.signal; return Promise.resolve(); });
    await h.gate.ensure();
    expect(seen?.aborted).toBe(false);
  });
});

describe("两条容易被顺手改坏的规则", () => {
  it("调用方的 signal 被刻意忽略：某个标签页离开设置页不该打断全服务器的下载", async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();                      // 页面已经走了
    await h.gate.ensure(vi.fn(), { signal: ac.signal });
    expect(h.download).toHaveBeenCalledTimes(1);
    expect(h.download.mock.calls[0][1]!.signal.aborted).toBe(false);  // 内部下载照常活着
  });

  it("下载进行中的 force 不许另起一趟（两份会写同一批临时文件互相踩坏）", async () => {
    const h = harness();
    let release: () => void = () => {};
    h.download.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const a = h.gate.ensure();
    const b = h.gate.ensure(undefined, { force: true });
    release();
    await Promise.all([a, b]);
    expect(h.download).toHaveBeenCalledTimes(1);
  });

  it("没有下载在跑时 force 会重下（用户点「重新下载」得真起作用）", async () => {
    const h = harness();
    await h.gate.ensure();
    await h.gate.ensure(undefined, { force: true });
    expect(h.download).toHaveBeenCalledTimes(2);
    expect(h.download.mock.calls[1][1]!.force).toBe(true);
  });
});
