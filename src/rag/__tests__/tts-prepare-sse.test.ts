/**
 * `/tts/prepare` 的 SSE 处理器（server/lib/tts-prepare-sse.mjs）
 *
 * 跑在真 `node:http` + 真 fetch 上（只绑 127.0.0.1，不出本机）：这条流的病全在连接层——
 * 收不到帧、流不结束、往已断开的连接写会抛——桩化的 res 只能数我们调用了几次 write，
 * 数不出客户端拿不拿得到。所以下面用 setup 里留的那只真 fetch（`__nodeFetch`），
 * 只有两只 ensure 是假的：它们各自的判据在 tts-resource-gate.mjs 和 tts-assemble.mjs。
 */
import { describe, it, expect } from "vitest";
import http from "node:http";
import { Readable } from "node:stream";

// @ts-expect-error - 后端 JS 模块无类型声明
const mod = await import("../../../server/lib/tts-prepare-sse.mjs");
const { createTtsPrepareHandler } = mod as {
  createTtsPrepareHandler: (deps: { ensureWasmReady: Ensure; ensureModelReady: Ensure }) =>
    (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
};

type Progress = ((step: string, detail: string) => void) | undefined;
type Ensure = (onProgress?: Progress, opts?: { signal?: AbortSignal; force?: boolean }) => Promise<void>;
interface Frame { type: string; step?: string; detail?: string; message?: string; success?: boolean }
interface Call { force: boolean; signal?: AbortSignal; progress: Progress }

function mkEnsures(impl: Partial<Record<"wasm" | "model", (c: Call) => Promise<void>>> = {}) {
  const calls: Record<"wasm" | "model", Call[]> = { wasm: [], model: [] };
  const make = (which: "wasm" | "model"): Ensure => async (progress, opts) => {
    const c: Call = { force: !!opts?.force, signal: opts?.signal, progress };
    calls[which].push(c);
    await (impl[which] ?? (async () => {}))(c);
  };
  return { calls, ensure: { ensureWasmReady: make("wasm"), ensureModelReady: make("model") } };
}

async function start(
  deps: { ensureWasmReady: Ensure; ensureModelReady: Ensure },
  instrument?: (res: http.ServerResponse) => void,
) {
  const server = http.createServer((req, res) => {
    instrument?.(res);
    void createTtsPrepareHandler(deps)(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}/api/rag/tts/prepare`,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** 读完整条 SSE：帧 + 响应头 + 流是否真的收尾了 */
async function readFrames(url: string, opts: { stopAfter?: number } = {}) {
  // setup 里那只 fetch 桩是给业务请求准备的；这条用例要的是真 socket
  const nodeFetch = (globalThis as unknown as { __nodeFetch: typeof fetch }).__nodeFetch;
  const resp = await nodeFetch(url);
  const headers = {
    contentType: resp.headers.get("content-type") || "",
    cacheControl: resp.headers.get("cache-control") || "",
  };
  const frames: Frame[] = [];
  let buf = "";
  let ended = false;
  // 给这条流一只天花板：不收尾的用例要在 2.5 秒内报"流没结束"，而不是拖到 vitest 的 5 秒超时
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2500);
  try {
    for await (const chunk of Readable.fromWeb(
      resp.body as import("node:stream/web").ReadableStream,
      { signal: ac.signal },
    )) {
      buf += (chunk as Buffer).toString("utf8");
      let i = buf.indexOf("\n\n");
      while (i >= 0) {
        for (const line of buf.slice(0, i).split("\n")) {
          if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
        }
        buf = buf.slice(i + 2);
        i = buf.indexOf("\n\n");
      }
      // 客户端走到第 N 帧就拔线：服务端那边必须察觉（判 res 的 close，不是 req 的）
      if (opts.stopAfter && frames.length >= opts.stopAfter) {
        await resp.body?.cancel();
        return { frames, headers, ended };
      }
    }
    ended = true;
  } catch { /* 主动 cancel / 天花板到点之后 undici 会抛，帧已经收齐了 */ }
  finally { clearTimeout(timer); }
  return { frames, headers, ended };
}

const steps = (frames: Frame[]) => frames.filter((f) => f.type === "step").map((f) => `${f.step}|${f.detail}`);

describe("正常一路", () => {
  it("进度帧按用户看得懂的顺序到齐，最后 done，并且流会结束", async () => {
    const { ensure } = mkEnsures();
    const srv = await start(ensure);
    try {
      const { frames, headers, ended } = await readFrames(srv.base);
      expect(headers.contentType, "不是 event-stream，浏览器不会当流读").toContain("text/event-stream");
      expect(headers.cacheControl, "SSE 被缓存住=所有人看到同一份旧进度").toContain("no-cache");
      expect(steps(frames)).toEqual([
        "开始|检查 TTS 资源...",
        "WASM 引擎|检查中...",
        "WASM 引擎|就绪 ✓",
        "语音模型|检查中...",
        "语音模型|就绪 ✓",
      ]);
      expect(frames.at(-1)).toEqual({ type: "done", success: true });
      expect(ended, "res 没 end：EventSource 会一直挂着，前端停在最后一格").toBe(true);
    } finally { await srv.close(); }
  });

  it("下载过程中的每一步都转发给这一路客户端，且排在「就绪」前面", async () => {
    const { calls, ensure } = mkEnsures({
      model: async (c) => {
        c.progress?.("下载分卷 1/4", "kokoro.7z.001");
        c.progress?.("解压中", "7z 解压...");
      },
    });
    const srv = await start(ensure);
    try {
      const { frames } = await readFrames(srv.base);
      const list = steps(frames);
      expect(list).toContain("模型: 下载分卷 1/4|kokoro.7z.001");
      expect(list).toContain("模型: 解压中|7z 解压...");
      expect(list.indexOf("模型: 解压中|7z 解压..."), "进度跑到「就绪」后面就是假进度")
        .toBeLessThan(list.indexOf("语音模型|就绪 ✓"));
      expect(calls.wasm).toHaveLength(1);
    } finally { await srv.close(); }
  });

  it("force=true 要传到两段下载（用户点「重新下载」），默认是 false", async () => {
    const { calls, ensure } = mkEnsures();
    const srv = await start(ensure);
    try {
      await readFrames(srv.base);
      await readFrames(`${srv.base}?force=true`);
      expect(calls.wasm.map((c) => c.force), "force 没传下去=按钮点了没反应").toEqual([false, true]);
      expect(calls.model.map((c) => c.force)).toEqual([false, true]);
    } finally { await srv.close(); }
  });
});

describe("坏在半路", () => {
  it("WASM 就绪、模型失败：先报成功的那半，再报 error，然后收尾", async () => {
    const { ensure } = mkEnsures({ model: async () => { throw new Error("上次下载失败，请 30 秒后重试"); } });
    const srv = await start(ensure);
    try {
      const { frames, ended } = await readFrames(srv.base);
      expect(steps(frames)).toContain("WASM 引擎|就绪 ✓");
      expect(frames.at(-1)).toEqual({ type: "error", message: "上次下载失败，请 30 秒后重试" });
      expect(ended, "出错不 end：前端收不到流结束，进度条永远停在那").toBe(true);
    } finally { await srv.close(); }
  });

  it("第一段就失败：不会再假装跑第二段", async () => {
    const { calls, ensure } = mkEnsures({ wasm: async () => { throw new Error("7z 未安装"); } });
    const srv = await start(ensure);
    try {
      const { frames } = await readFrames(srv.base);
      expect(frames.at(-1)).toEqual({ type: "error", message: "7z 未安装" });
      expect(calls.model, "WASM 都没成就去下 322MB 模型").toEqual([]);
    } finally { await srv.close(); }
  });
});

describe("客户端断开", () => {
  it("下载中关页面：掐掉这一路自己的下载，之后不再往这条流里写", async () => {
    let release: () => void = () => {};
    const written: string[] = [];
    const { calls, ensure } = mkEnsures({
      model: (c) => new Promise<void>((r) => {
        release = r;
        c.signal?.addEventListener("abort", () => r());
      }),
    });
    const srv = await start(ensure, (res) => {
      const raw = res.write.bind(res);
      res.write = ((chunk: unknown) => { written.push(String(chunk)); return raw(chunk as string); }) as typeof res.write;
    });
    try {
      // 停在第 4 帧（"语音模型|检查中..."）：这一刻服务端已经起了模型那一趟，客户端才走人
      const { frames, ended } = await readFrames(srv.base, { stopAfter: 4 });
      expect(frames).toHaveLength(4);
      expect(ended, "客户端走了不等于服务端收尾了").toBe(false);
      await expect
        .poll(() => calls.model[0]?.signal?.aborted === true, { timeout: 3000 })
        .toBe(true);
      // 断开之后下载器还在推进度、那一趟也已经完了：都不许再往这条流里写一帧
      const after = written.length;
      calls.model[0]?.progress?.("下载分卷 2/4", "kokoro.7z.002");
      release();
      await new Promise((r) => setTimeout(r, 150));
      expect(written.slice(after), "往已经没人读的流里写字节：下一帧就是 throw").toEqual([]);
    } finally { await srv.close(); }
  });

  it("第一段还在下就走：别再起第二段那 322MB", async () => {
    let releaseWasm: () => void = () => {};
    const { calls, ensure } = mkEnsures({
      wasm: (c) => new Promise<void>((r) => {
        releaseWasm = r;
        c.signal?.addEventListener("abort", () => r());
      }),
    });
    const srv = await start(ensure);
    try {
      // 第 2 帧 = "WASM 引擎|检查中..."，此刻 wasm 那一趟还挂着
      await readFrames(srv.base, { stopAfter: 2 });
      await expect.poll(() => calls.wasm[0]?.signal?.aborted === true, { timeout: 3000 }).toBe(true);
      releaseWasm();
      await new Promise((r) => setTimeout(r, 150));
      expect(calls.model, "没人等结果了还去下模型：几百 MB 白花").toEqual([]);
    } finally { await srv.close(); }
  });

  it("正常写完的那次收尾 close 不算断开", async () => {
    // res.end() 之后 Node 还会 emit 一次 close。把它当"客户端跑了"会让 sendEvent
    // 从此静默、并 abort 一只没人等的信号——下一次真断开就分不出这两种情况了。
    const { calls, ensure } = mkEnsures();
    const srv = await start(ensure);
    try {
      const { frames, ended } = await readFrames(srv.base);
      expect(frames.at(-1)?.type).toBe("done");
      expect(ended).toBe(true);
      await new Promise((r) => setTimeout(r, 150));
      const aborted = [...calls.wasm, ...calls.model].map((c) => c.signal?.aborted);
      expect(aborted, "成功收尾被判成了断开").toEqual([false, false]);
    } finally { await srv.close(); }
  });
});
