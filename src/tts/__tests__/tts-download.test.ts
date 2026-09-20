/**
 * TTS 资源下载器（lib/tts-download.mjs）
 *
 * 这里锁的是"整条下载通道会不会被永久卡住"和"半截包会不会被当成正经缓存"。
 * 两个失败都不报在当次下载上：断流时 reader.read() 永久挂起且不报错，而全服务器
 * 共享同一个下载 promise，卡住就只能重启后端；残缺文件不删，下一次 minSize 校验
 * 就可能把它放过。假上游负责把"永不 resolve""抛错""分片节奏"这些剧本演出来，
 * 另外再用真 socket 复现一次停流——假桩自补故障的话，光靠假上游是看不见的。
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error - 后端 JS 模块无类型声明
const mod = await import("../../../server/lib/tts-download.mjs");
const { createDownloader } = mod as {
  createDownloader: (o?: Record<string, unknown>) => (
    url: string, destPath: string, minSize?: number,
    onProgress?: ((pct: number) => void) | null, opts?: { signal?: AbortSignal }
  ) => Promise<void>;
};

const silent = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

/** 假 write stream：用真 EventEmitter，才演得出"drain 什么时候来 / 等多久" */
function fakeWs(behavior: { errorOnEnd?: Error; writeResult?: boolean } = {}) {
  const ws = Object.assign(new EventEmitter(), {
    chunks: [] as Buffer[],
    destroyed: false,
    ended: false,
    writes: 0,
    write(b: Uint8Array) {
      ws.writes++;
      ws.chunks.push(Buffer.from(b));
      return behavior.writeResult ?? true;      // false = "我队列满了，先别发"
    },
    end() {
      ws.ended = true;
      setImmediate(() => {
        if (behavior.errorOnEnd) ws.emit("error", behavior.errorOnEnd);
        else ws.emit("finish");
      });
    },
    destroy() { ws.destroyed = true; },
  });
  return ws;
}

type FakeWs = ReturnType<typeof fakeWs>;

function fakeFsImpl(opts: { errorOnEnd?: Error; created?: FakeWs[]; writeResult?: boolean } = {}) {
  const created = opts.created ?? [];
  const unlinked: string[] = [];
  const paths: string[] = [];
  const fsImpl = {
    createWriteStream: (p: string) => {
      paths.push(p);
      const ws = fakeWs({ errorOnEnd: opts.errorOnEnd, writeResult: opts.writeResult });
      created.push(ws);
      return ws;
    },
    unlinkSync: (p: string) => { unlinked.push(p); },
  };
  return { fsImpl, unlinked, created, paths };
}

type Step = { bytes?: Uint8Array; ms?: number; failWith?: Error; hang?: true };

/** 假上游：按剧本一帧帧给 body；hang 那一帧会尊重 AbortSignal（真 fetch 就是这样） */
function scriptedFetch(steps: Step[], { ok = true, status = 200, contentLength, stats }: { ok?: boolean; status?: number; contentLength?: number; stats?: { reads: number } } = {}) {
  return (_url: string, init?: { signal?: AbortSignal }) => {
    if (!ok) {
      return Promise.resolve({
        ok, status, headers: { get: () => null },
        body: { getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) }) },
      });
    }
    const signal = init?.signal;
    let i = 0;
    return Promise.resolve({
      ok, status,
      headers: { get: (n: string) => (n.toLowerCase() === "content-length" && contentLength != null ? String(contentLength) : null) },
      body: {
        getReader() {
          return {
            read(): Promise<{ done: boolean; value?: Uint8Array }> {
              if (stats) stats.reads++;
              const step = steps[i++];
              if (!step) return Promise.resolve({ done: true, value: undefined });
              if (step.failWith) return Promise.reject(step.failWith);
              if (step.hang) {
                return new Promise((_resolve, reject) => {
                  const onAbort = () => reject(new Error("AbortError: signal aborted"));
                  // 真 fetch 在"已经 abort 的流"上 read 会立刻 reject，不是等下一次 abort
                  if (signal?.aborted) { onAbort(); return; }
                  signal?.addEventListener("abort", onAbort);
                });
              }
              const bytes = step.bytes ?? new Uint8Array();
              if (!step.ms) return Promise.resolve({ done: false, value: bytes });
              // 延时帧也必须尊重 AbortSignal：真 fetch 在 abort 时会让在途的 read()
              // 直接 reject，桩要是只对 hang 那一帧模拟，"过早掐断"这类 bug 就看不见
              return new Promise((resolve, reject) => {
                const onAbort = () => {
                  clearTimeout(t);
                  reject(new Error("AbortError: signal aborted"));
                };
                const t = setTimeout(() => {
                  signal?.removeEventListener("abort", onAbort);
                  resolve({ done: false, value: bytes });
                }, step.ms);
                signal?.addEventListener("abort", onAbort);
              });
            },
          };
        },
      },
    });
  };
}

const chunk = (s: string) => new Uint8Array(Buffer.from(s));
const repeat = (n: number) => new Uint8Array(n);

function downloader(overrides: Record<string, unknown> = {}) {
  return createDownloader({ logger: silent, headerTimeoutMs: 5000, stallMs: 100, ...overrides });
}

describe("正常路径", () => {
  it("内容按序落盘、进度按 content-length 递增、结束才返回", async () => {
    const { fsImpl, created, paths } = fakeFsImpl();
    const steps: Step[] = [{ bytes: chunk("AAAA") }, { bytes: chunk("BBBB") }];
    const dl = downloader({ fetchImpl: scriptedFetch(steps, { contentLength: 8 }), fsImpl });
    const pct: number[] = [];
    await dl("https://x/part1", "/tmp/part1", 1, (p) => pct.push(p));
    expect(paths).toEqual(["/tmp/part1"]);
    expect(created[0].chunks.map((c) => c.toString())).toEqual(["AAAA", "BBBB"]);
    expect(pct).toEqual([50, 100]);
    expect(created[0].ended).toBe(true);
    expect(created[0].destroyed).toBe(false);
  });

  it("没有 content-length 时不报进度（否则前端会显示 NaN%）", async () => {
    const { fsImpl } = fakeFsImpl();
    const onProgress = vi.fn();
    const dl = downloader({ fetchImpl: scriptedFetch([{ bytes: chunk("xx") }]), fsImpl });
    await dl("https://x/a", "/tmp/a", 1, onProgress);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("看门狗是「空闲」超时而不是总时长：每 40ms 来一片、共 200ms，100ms 看门狗不该掐", async () => {
    const { fsImpl } = fakeFsImpl();
    const steps: Step[] = Array.from({ length: 5 }, () => ({ bytes: repeat(10), ms: 40 }));
    const dl = downloader({ fetchImpl: scriptedFetch(steps, { contentLength: 50 }), fsImpl, stallMs: 100 });
    const t0 = Date.now();
    await dl("https://x/slow", "/tmp/slow", 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
  });
});

describe("停流与失败必须掐断并清理", () => {
  it("响应体停住：到点必须 abort，而不是永久挂在 read() 上", async () => {
    const { fsImpl, unlinked, created } = fakeFsImpl();
    const steps: Step[] = [{ bytes: repeat(10) }, { hang: true }];
    const dl = downloader({ fetchImpl: scriptedFetch(steps, { contentLength: 1000 }), fsImpl, stallMs: 60 });
    const t0 = Date.now();
    await expect(dl("https://x/stalled", "/tmp/stalled", 1024)).rejects.toThrow(/aborted/);
    expect(Date.now() - t0).toBeLessThan(2000);            // 真被看门狗掐掉
    expect(created[0].destroyed).toBe(true);
    expect(unlinked).toEqual(["/tmp/stalled"]);            // 半截文件必须删
  });

  it("响应头到手却一个字节都不发：第一次 read() 就得被看门狗管住", async () => {
    const { fsImpl, unlinked, created } = fakeFsImpl();
    const dl = downloader({ fetchImpl: scriptedFetch([{ hang: true }], { contentLength: 1000 }), fsImpl, stallMs: 60 });
    const t0 = Date.now();
    await expect(dl("https://x/no-first-byte", "/tmp/no-first-byte", 1024)).rejects.toThrow(/aborted/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(created[0].destroyed).toBe(true);
    expect(unlinked).toEqual(["/tmp/no-first-byte"]);
  });

  it("上游中途抛错：错误原样上抛，不许被换成没信息的「下载失败」", async () => {
    const { fsImpl, unlinked } = fakeFsImpl();
    const err = new Error("ECONNRESET");
    const dl = downloader({ fetchImpl: scriptedFetch([{ bytes: repeat(5) }, { failWith: err }]), fsImpl });
    await expect(dl("https://x/reset", "/tmp/reset", 1024)).rejects.toThrow("ECONNRESET");
    expect(unlinked).toEqual(["/tmp/reset"]);
  });

  it("写盘失败也要删掉残缺文件并把错误抛出去", async () => {
    const { fsImpl, unlinked, created } = fakeFsImpl({ errorOnEnd: new Error("ENOSPC") });
    const dl = downloader({ fetchImpl: scriptedFetch([{ bytes: repeat(2048) }]), fsImpl });
    await expect(dl("https://x/full", "/tmp/full", 1024)).rejects.toThrow("ENOSPC");
    expect(unlinked).toEqual(["/tmp/full"]);
    expect(created[0].destroyed).toBe(true);
  });

  it("HTTP 非 2xx 直接失败，连文件都不创建", async () => {
    const { fsImpl, created, unlinked } = fakeFsImpl();
    const dl = downloader({ fetchImpl: scriptedFetch([], { ok: false, status: 404 }), fsImpl });
    await expect(dl("https://x/gone", "/tmp/gone", 1024)).rejects.toThrow("下载失败: HTTP 404");
    expect(created).toHaveLength(0);
    expect(unlinked).toHaveLength(0);
  });

  it("响应头超时：拿不到头就不许再等", async () => {
    const fetchImpl = (_u: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("AbortError: headers")));
      });
    const dl = downloader({ fetchImpl, fsImpl: fakeFsImpl().fsImpl, headerTimeoutMs: 60 });
    await expect(dl("https://x/slow-headers", "/tmp/slow-headers", 1024)).rejects.toThrow(/headers/);
  });

  it("字节数不足 minSize 时报出实际字节数（半截包不能当缓存）", async () => {
    const { fsImpl, unlinked } = fakeFsImpl();
    const dl = downloader({ fetchImpl: scriptedFetch([{ bytes: repeat(10) }], { contentLength: 10 }), fsImpl });
    await expect(dl("https://x/tiny", "/tmp/tiny", 1024)).rejects.toThrow("下载的文件太小 (10 字节)");
    expect(unlinked).toEqual([]);   // 与抽出前一致：这条在 try 之外，交由上层清理
  });
});

describe("背压：盘写不动时不许一直从网络读", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("write() 返回 false 就停下来等 drain（不理会会把整卷 80MB 堆进堆外内存）", async () => {
    const stats = { reads: 0 };
    const created: FakeWs[] = [];
    const { fsImpl } = fakeFsImpl({ created, writeResult: false });
    const steps: Step[] = [{ bytes: repeat(10) }, { bytes: repeat(10) }, { bytes: repeat(10) }];
    const dl = downloader({ fetchImpl: scriptedFetch(steps, { contentLength: 30, stats }), fsImpl, stallMs: 60000 });
    const p = dl("https://x/bp", "/tmp/bp", 1);
    await sleep(20);
    expect(stats.reads).toBe(1);            // 第一帧没落盘，就不该再要第二帧
    const ws = created[0];
    ws.emit("drain");
    await sleep(20);
    expect(stats.reads).toBe(2);
    ws.emit("drain");
    await sleep(20);
    expect(stats.reads).toBe(3);
    ws.emit("drain");
    await expect(p).resolves.toBeUndefined();
    expect(stats.reads).toBe(4);            // 第 4 次读到 done
    expect(ws.writes).toBe(3);
  });

  it("等 drain 期间流报错：必须当场失败并删掉残缺文件，绝不能挂死", async () => {
    const created: FakeWs[] = [];
    const { fsImpl, unlinked } = fakeFsImpl({ created, writeResult: false });
    const dl = downloader({ fetchImpl: scriptedFetch([{ bytes: repeat(10) }, { bytes: repeat(10) }], { contentLength: 20 }), fsImpl, stallMs: 60000 });
    const p = dl("https://x/eio", "/tmp/eio", 1);
    await sleep(20);
    created[0].emit("error", new Error("EIO"));
    await expect(p).rejects.toThrow("EIO");
    expect(unlinked).toEqual(["/tmp/eio"]);   // 半截文件不能留给下次当缓存
    expect(created[0].destroyed).toBe(true);
  });

  it("盘一直写不动、网络也不再发：看门狗必须还能掐断它（等 drain 不等于脱离看门狗）", async () => {
    const created: FakeWs[] = [];
    const { fsImpl, unlinked } = fakeFsImpl({ created, writeResult: false });
    // 第一帧把 write 卡住；此后上游也没有第二帧
    const stats = { reads: 0 };
    const dl = downloader({
      fetchImpl: scriptedFetch([{ bytes: repeat(10) }, { hang: true }], { contentLength: 1000, stats }),
      fsImpl, stallMs: 60,
    });
    const t0 = Date.now();
    const p = dl("https://x/wedged", "/tmp/wedged", 1024);
    // 全程没人发 drain、也没人 abort 调用方 signal：唯一的出路是空闲看门狗
    await expect(p).rejects.toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(created[0].destroyed).toBe(true);
    expect(unlinked).toEqual(["/tmp/wedged"]);
  });
});

describe("调用方取消", () => {
  it("外部 signal 取消时同样掐断、清理，并把监听摘掉", async () => {
    const { fsImpl, unlinked, created } = fakeFsImpl();
    const ac = new AbortController();
    const dl = downloader({ fetchImpl: scriptedFetch([{ hang: true }], { contentLength: 1000 }), fsImpl, stallMs: 60000 });
    const p = dl("https://x/cancel", "/tmp/cancel", 1024, null, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
    expect(created[0].destroyed).toBe(true);
    expect(unlinked).toEqual(["/tmp/cancel"]);
  });

  it("反复复用同一个 signal 下载多次，不能每次留一个 abort 监听器", async () => {
    // 全服务器共用一个 AbortController 去下载 4 个分卷 + 反复重试：只加不减就会把
    // MaxListeners 刷爆，而且每个旧闭包都引着那次下载的 buffer
    const added = vi.fn();
    const removed = vi.fn();
    const signal = { addEventListener: added, removeEventListener: removed } as unknown as AbortSignal;
    const dl = downloader({ fetchImpl: scriptedFetch([{ bytes: repeat(10) }]), fsImpl: fakeFsImpl().fsImpl });
    for (let i = 0; i < 30; i++) await dl("https://x/loop", "/tmp/loop", 0, null, { signal });
    expect(added).toHaveBeenCalledTimes(30);
    expect(removed).toHaveBeenCalledTimes(30);
  });
});

describe("真 socket 复现一次停流（防止假上游自补故障）", () => {
  const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "anr-dl-")), "part.bin");
  // 走 Node 真正的 fetch（setup.ts 把桩装成"没 mock 就抛"，这里要的是真实现）
  const realFetchImpl = (url: string, init?: unknown) =>
    (globalThis as unknown as { __nodeFetch: (u: string, i?: unknown) => Promise<unknown> }).__nodeFetch(url, init);

  function serve(handler: http.RequestListener) {
    const server = http.createServer(handler);
    return new Promise<{ url: (p: string) => string; close: () => void }>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        resolve({
          url: (p) => `http://127.0.0.1:${port}${p}`,
          close: () => { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); server.close(); },
        });
      });
    });
  }

  it("服务端发完响应头就不吭声：真 fetch 的 read() 会被看门狗掐断并删掉半截文件", async () => {
    const srv = await serve((_req, res) => {
      // connection: close —— 被 abort 的连接若被池化复用，会把下一个用例的 fetch 一起拖死
      res.writeHead(200, { "content-length": "100000", connection: "close" });
      res.write("部分内容");
      // 故意不再 send 任何数据，也不 end
    });
    const dest = tmpFile();
    const dl = downloader({ fetchImpl: realFetchImpl, stallMs: 150, headerTimeoutMs: 5000 });
    const t0 = Date.now();
    await expect(dl(srv.url("/part"), dest, 1024)).rejects.toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(fs.existsSync(dest)).toBe(false);   // 真 unlink 走的是真 fs
    srv.close();
  });

  it("真 socket 只回头、不给首字节：同样必须在看门狗时间内结束", async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "100", connection: "close" });
      res.flushHeaders();                       // 头到手，body 一个字节都不发
    });
    const dest = tmpFile();
    const dl = downloader({ fetchImpl: realFetchImpl, stallMs: 150, headerTimeoutMs: 5000 });
    const t0 = Date.now();
    await expect(dl(srv.url("/empty"), dest, 1024)).rejects.toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(fs.existsSync(dest)).toBe(false);
    srv.close();
  });

  it("真流式下载：字节数与进度都对", async () => {
    const body = Buffer.alloc(4096, 0x41);
    const srv = await serve((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.write(body.subarray(0, 2048));
      setTimeout(() => { res.end(body.subarray(2048)); }, 20);
    });
    const dest = tmpFile();
    const dl = downloader({ fetchImpl: realFetchImpl, stallMs: 2000 });
    const pct: number[] = [];
    await dl(srv.url("/part"), dest, 1024, (p) => pct.push(p));
    expect(fs.readFileSync(dest).length).toBe(4096);
    expect(pct[pct.length - 1]).toBe(100);
    srv.close();
    fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  });
});
