/**
 * SSE 流式响应读取（providers/stream.ts 的 readSSEData）
 *
 * 此前一条用例都没有。它管的是“模型说的话有没有完整到位”：分包边界处理错 → 事件被吞、
 * 正文缺一截；看门狗预算错 → 慢启动的思考模型被掐死，或连接黑洞时任务永远显示“生成中”；
 * finally 里若改成 await cancel() → 黑洞场景调用方永远出不来（round 2 R-55 就是这个）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readSSEData } from "../providers/stream";

const IDLE_TIMEOUT_MS = 90_000;
const FIRST_TOKEN_TIMEOUT_MS = 180_000;

const enc = new TextEncoder();
const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

type ReaderScript = {
  chunks: (string | Uint8Array)[];
  /** 读到第几块之后 read() 永不返回（模拟 NAT 静默丢包 / 半开 TCP） */
  hangAfter?: number;
  /** cancel() 永不 resolve：黑洞时用它钉住调用方 */
  cancelHangs?: boolean;
};

/** 只实现 readSSEData 真正用到的那一小块 ReadableStream 接口 */
function fakeStream(script: ReaderScript) {
  let i = 0;
  const reader = {
    cancelled: false,
    read(): Promise<{ done: boolean; value?: Uint8Array }> {
      if (script.hangAfter !== undefined && i >= script.hangAfter) {
        return new Promise(() => {
          /* 永不 resolve：只能等看门狗判死 */
        });
      }
      if (i >= script.chunks.length) return Promise.resolve({ done: true });
      const raw = script.chunks[i++];
      return Promise.resolve({ done: false, value: typeof raw === "string" ? enc.encode(raw) : raw });
    },
    cancel(): Promise<unknown> {
      reader.cancelled = true;
      // 黑洞场景 cancel() 自己不返回，且没有计时器替它兜底
      return script.cancelHangs
        ? new Promise(() => {
            /* 永不 resolve */
          })
        : Promise.resolve();
    },
  };
  const response = { body: { getReader: () => reader } } as unknown as Response;
  return { response, reader };
}

/** 假计时器下不能用 Promise.race 判“还在等”（已就绪的那支永远赢），只能记标志 */
function watch(promise: Promise<unknown>) {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    }
  );
  return state;
}

const toError = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);

afterEach(() => {
  vi.useRealTimers();
});

describe("readSSEData 分包与行解析", () => {
  it("事件被任意字节边界切断也能拼回来", async () => {
    const full = dataLine({ i: 1 }) + dataLine({ i: 2 });
    const bytes = enc.encode(full);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7)); // 足以劈开 data: 前缀和 JSON
    const { events, raw } = await readSSEData(fakeStream({ chunks }).response);
    expect(events).toEqual([{ i: 1 }, { i: 2 }]);
    expect(raw).toBe(full);
  });

  it("[DONE]、注释行与解不出 JSON 的行都不算事件，也不许抛", async () => {
    const { response } = fakeStream({
      chunks: [dataLine({ a: 1 }), "data: [DONE]\n", "data: 坏JSON\n", ": 注释\n", "\n"],
    });
    const { events } = await readSSEData(response);
    expect(events).toEqual([{ a: 1 }]);
  });

  it("流末尾不带换行的最后一行仍然算数（漏了它就少一段正文）", async () => {
    const { response } = fakeStream({ chunks: [dataLine({ tail: true }).trimEnd()] });
    const { events } = await readSSEData(response);
    expect(events).toEqual([{ tail: true }]);
  });

  it("多字节汉字正好被劈在两块之间时不丢字", async () => {
    const bytes = enc.encode(dataLine({ text: "剑在人在" }));
    const cut = bytes.indexOf(0xe5) + 1; // “剑”= E5 89 91，从中间劈开
    const { response } = fakeStream({ chunks: [bytes.subarray(0, cut), bytes.subarray(cut)] });
    const { events } = await readSSEData(response);
    expect(events).toEqual([{ text: "剑在人在" }]);
  });

  it("body 为空时给出可读错误，而不是在 getReader 上崩掉", async () => {
    await expect(readSSEData({ body: null } as unknown as Response)).rejects.toThrow(/没有可读的 body/);
  });
});

describe("readSSEData 空闲看门狗", () => {
  it("首块之前给 180 秒：思考模型出首字前的长时间静默是合法的", async () => {
    vi.useFakeTimers();
    const pending = toError(readSSEData(fakeStream({ chunks: [], hangAfter: 0 }).response));
    const state = watch(pending);

    await vi.advanceTimersByTimeAsync(FIRST_TOKEN_TIMEOUT_MS - 1_000);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending)?.message).toMatch(new RegExp(`${FIRST_TOKEN_TIMEOUT_MS / 1000}\\s*秒`));
  });

  it("收到首块之后预算缩到 90 秒：中途断流不许接着用 180 秒等", async () => {
    vi.useFakeTimers();
    const pending = toError(
      readSSEData(fakeStream({ chunks: [dataLine({ part: 1 })], hangAfter: 1 }).response)
    );
    const state = watch(pending);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1_000);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending)?.message).toMatch(new RegExp(`${IDLE_TIMEOUT_MS / 1000}\\s*秒`));
  });

  it("cancel() 自己卡住时调用方照样拿得到超时（finally 里 await cancel 会把任务永久钉在生成中）", async () => {
    vi.useFakeTimers();
    const pending = toError(
      readSSEData(fakeStream({ chunks: [], hangAfter: 0, cancelHangs: true }).response)
    );

    await vi.advanceTimersByTimeAsync(FIRST_TOKEN_TIMEOUT_MS + 1_000);
    expect((await pending)?.message).toMatch(/超时/); // 能取到值就说明没被 cancel 拖住
  });

  it("正常读完的流也会取消 reader（不留半开连接）", async () => {
    const { response, reader } = fakeStream({ chunks: [dataLine({ ok: 1 })] });
    await readSSEData(response);
    expect(reader.cancelled).toBe(true);
  });
});
