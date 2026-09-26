/**
 * `worker-client.ts` 主线程侧代理的判据（地板第 1 档）。
 *
 * 这只文件管的是"离线编码到底在哪个线程跑、跑不成怎么收场"。它最值钱的一条不是
 * 回包配对，而是**两种失败的分工**（`:84-87` 与 `:90-92` 那两段注释各自写着理由）：
 * - **业务性失败**（模型没缓存、服务器没配）只让**这一发**回退主线程，Worker 必须留着。
 *   把它当故障永久禁用，后果是"之后每一次查询都退回主线程，反复加载一个注定失败的模型
 *   并且把 UI 卡住"——这一格没有报错，只是慢慢变卡。
 * - **基础设施故障**（`worker.onerror` / `postMessage` 抛）才置 `workerFailed`、terminate、
 *   本次会话不再尝试 Worker。
 * - **用户取消**（AbortError）两种都不是：直接返回 null，Worker 一根手指都不许碰。
 *
 * 还有一条口径值得钉：`embedding-retriever.ts:300` 拿的是
 * `encodeQueryWithWorker(...).catch(() => null)`，而这只函数自己的约定是"失败以 null 落地、
 * 不 reject"（`:56` 的注释）。所以取消／故障／业务失败三条路都必须**resolve**，
 * 返回值要么是 Float32Array、要么是 null。
 *
 * **本档刻意没判的两格**（写在前面，别让"这只有测试了"盖住）：
 * ① 成功回程**不摘** abort 监听（`:72` 那次 `addEventListener` 只在 `postMessage` 抛的路径上
 *    被 `removeEventListener` 撤回来）——`{ once: true }` 只在真触发时自动摘。所以每次"发出去
 *    且顺利回来"的查询会在 signal 上留一个闭包。量了一下后果：调用方那一发是
 *    `AbortSignal.timeout(...)`/一次性 controller（`useQA`／检索链都是每发新建），闭包只装
 *    一个 number 与两个已结算的回调，**不构成长期堆积**，所以本批只把事实记在这里、
 *    不立"必须摘掉"的判据，也不动产品。将来若出现"一个 signal 发很多趟"的调用方，这条要重看。
 * ② 主线程 `encodeQuery` 自己**抛**（不是返回 null）时会 reject 出去——现在唯一调用方
 *    `.catch(() => null)` 兜得住，所以不给这个形状写判据（写了就等于把"允许 reject"钉进契约）。
 *
 * ## 变异台账见文件末尾（同一批：每刀手改一处、跑完 `cp` 字节还原并核 SHA256）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------- 依赖桩
const deps = vi.hoisted(() => ({
  serverUrl: "http://srv.test",
  logs: [] as string[],
  main: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  getEffectiveServerUrl: () => deps.serverUrl,
}));
vi.mock("@/lib/logger", () => ({
  ragLog: (m: string) => {
    deps.logs.push(m);
  },
}));
vi.mock("../client-encoder", () => ({
  encodeQuery: (text: string, engine: string) => deps.main(text, engine),
}));

// ---------------------------------------------------------------- Worker 桩
type MsgHandler = (e: MessageEvent) => void;
type ErrHandler = (ev: { message: string }) => void;

class FakeWorker {
  static constructed = 0;
  static live: FakeWorker[] = [];
  /** 下一发 postMessage 直接抛（模拟结构化克隆失败 / Worker 已经死了） */
  static throwNextPost = false;
  onmessage: MsgHandler | null = null;
  onerror: ErrHandler | null = null;
  posted: Record<string, unknown>[] = [];
  terminated = 0;
  url: string;
  opts: unknown;

  constructor(url: string | URL, opts: unknown) {
    this.opts = opts;
    // 产品传进来的是 `new URL(...)`，这里统一成字符串再判（不然 toContain 拿到的是对象）
    this.url = String(url);
    FakeWorker.constructed += 1;
    FakeWorker.live.push(this);
  }

  postMessage(msg: Record<string, unknown>) {
    if (FakeWorker.throwNextPost) {
      FakeWorker.throwNextPost = false;
      throw new Error("DataCloneError");
    }
    this.posted.push(msg);
  }

  terminate() {
    this.terminated += 1;
  }

  /** 回程：走 onmessage（测试自己造 MessageEvent，jsdom 没有可用的 Worker） */
  emit(msg: unknown) {
    this.onmessage?.({ data: msg } as MessageEvent);
  }

  fail(message = "worker 崩了") {
    this.onerror?.({ message });
  }

  /** 屏上最新一发请求的 id（postMessage 载荷里那个） */
  lastId(): number {
    return this.posted[this.posted.length - 1]?.id as number;
  }
}

const buf = (...nums: number[]) => Float32Array.from(nums).buffer;
const okMsg = (id: number, ...nums: number[]) => ({ type: "encode-result", id, ok: true, data: buf(...nums) });
const failMsg = (id: number, error?: string) => ({ type: "encode-result", id, ok: false, error });

/** 挂住／结算／拒绝三种收尾分开判——"超时"与"报错"是完全不同的坏法 */
async function settle<T>(p: Promise<T>, ms = 60) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<"hang">((r) => {
    timer = setTimeout(() => r("hang"), ms);
  });
  // 两个分支都写成 then(onOk, onErr)：这样 reject 也算"已被处理"，
  // 不会在跑别的断言时顺带甩出一条 unhandled rejection 污染读数。
  const raced = await Promise.race([
    p.then(
      (value) => ({ status: "ok" as const, value }),
      (error: unknown) => ({ status: "reject" as const, error })
    ),
    hang,
  ]);
  clearTimeout(timer);
  return raced;
}

let load: () => Promise<typeof import("../worker-client")>;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("Worker", FakeWorker);
  FakeWorker.constructed = 0;
  FakeWorker.live = [];
  FakeWorker.throwNextPost = false;
  deps.serverUrl = "http://srv.test";
  deps.logs = [];
  deps.main = vi.fn();
  // 模块级状态（worker / workerFailed / pending / nextId）没有导出的复位口，
  // 所以每条用例都靠 resetModules + 动态 import 拿一份干净的模块实例。
  load = async () => import("../worker-client");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ================================================================ 懒创建与复用
describe("Worker 是懒创建的，而且整个模块只有一只", () => {
  it("只 import 不 spawn（离线编码不是每次开书都要用）", async () => {
    await load();
    expect(FakeWorker.constructed).toBe(0);
  });

  it("第一次真的要用才 spawn 一发", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(new Float32Array([1]));
    const p = encodeQueryWithWorker("令狐冲", "bge", undefined);
    expect(FakeWorker.constructed).toBe(1);
    FakeWorker.live[0].emit(okMsg(FakeWorker.live[0].lastId(), 7));
    await p;
  });

  it("第二发复用同一只（不许每发新建一个线程）", async () => {
    const { encodeQueryWithWorker } = await load();
    const first = encodeQueryWithWorker("第一问", "bge");
    const id1 = FakeWorker.live[0].lastId();
    FakeWorker.live[0].emit(okMsg(id1, 1));
    await first;
    const second = encodeQueryWithWorker("第二问", "bge");
    const id2 = FakeWorker.live[0].lastId();
    FakeWorker.live[0].emit(okMsg(id2, 2));
    await second;
    expect(FakeWorker.constructed).toBe(1);
    expect(FakeWorker.live[0].posted).toHaveLength(2);
  });

  it("spawn 的是那只编码 worker，且按 ES module 起", async () => {
    const { encodeQueryWithWorker } = await load();
    const p = encodeQueryWithWorker("x", "bge");
    const w = FakeWorker.live[0];
    expect(w.url).toContain("encode.worker");
    expect(w.opts).toEqual({ type: "module" });
    w.emit(okMsg(w.lastId(), 1));
    await p;
  });

  it("发出去的载荷：type/id/text/engine 各就各位，serverUrl 现取", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.serverUrl = "http://from-store.test";
    const p = encodeQueryWithWorker("黑木崖", "bge-small");
    const w = FakeWorker.live[0];
    expect(w.posted[0]).toEqual({
      type: "main",
      id: 1,
      text: "黑木崖",
      engine: "bge-small",
      serverUrl: "http://from-store.test",
    });
    w.emit(okMsg(1, 1));
    await p;
  });

  it("地址换了下一发跟着换（写死＝换服务器之后 worker 还在打旧地址）", async () => {
    const { encodeQueryWithWorker } = await load();
    const p1 = encodeQueryWithWorker("一", "bge");
    FakeWorker.live[0].emit(okMsg(1, 1));
    await p1;
    deps.serverUrl = "http://second.test";
    const p2 = encodeQueryWithWorker("二", "bge");
    FakeWorker.live[0].emit(okMsg(2, 1));
    await p2;
    expect(FakeWorker.live[0].posted[0].serverUrl).toBe("http://srv.test");
    expect(FakeWorker.live[0].posted[1].serverUrl).toBe("http://second.test");
  });

  it("id 一发送一号（重复 id 会让两发抢同一份回包）", async () => {
    const { encodeQueryWithWorker } = await load();
    const a = encodeQueryWithWorker("一", "bge");
    const b = encodeQueryWithWorker("二", "bge");
    const w = FakeWorker.live[0];
    expect(w.posted.map((m) => m.id)).toEqual([1, 2]);
    w.emit(okMsg(1, 1));
    w.emit(okMsg(2, 2));
    await Promise.all([a, b]);
  });

  it("回程按 id 配对：乱序回话各回各家", async () => {
    const { encodeQueryWithWorker } = await load();
    const a = encodeQueryWithWorker("一", "bge");
    const b = encodeQueryWithWorker("二", "bge");
    const w = FakeWorker.live[0];
    w.emit(okMsg(2, 20, 21));
    w.emit(okMsg(1, 10, 11));
    expect(Array.from((await a)!)).toEqual([10, 11]);
    expect(Array.from((await b)!)).toEqual([20, 21]);
  });
});

// ================================================================ 回包形状
describe("回包怎么认：不是给我的一条就不许动我的账", () => {
  it("ok:true 把 ArrayBuffer 还原成 Float32Array 交给调用方", async () => {
    const { encodeQueryWithWorker } = await load();
    const p = encodeQueryWithWorker("一", "bge");
    const w = FakeWorker.live[0];
    w.emit(okMsg(1, 0.5, -0.25));
    const got = await p;
    expect(got).toBeInstanceOf(Float32Array);
    expect(Array.from(got!)).toEqual([0.5, -0.25]);
    expect(deps.main).not.toHaveBeenCalled();
  });

  it("type 不对的包忽略：这一发仍挂着，等对的那条", async () => {
    const { encodeQueryWithWorker } = await load();
    const p = encodeQueryWithWorker("一", "bge");
    const w = FakeWorker.live[0];
    w.emit({ type: "progress", id: 1, ok: true, data: buf(9) });
    expect(await settle(p)).toBe("hang");
    w.emit(okMsg(1, 3));
    expect(Array.from((await p)!)).toEqual([3]);
  });

  it("没有 id 的包忽略（拿 undefined 去查 pending 会误结算别的发）", async () => {
    const { encodeQueryWithWorker } = await load();
    const p = encodeQueryWithWorker("一", "bge");
    const w = FakeWorker.live[0];
    w.emit({ type: "encode-result", ok: true, data: buf(9) });
    w.emit({ type: "encode-result", id: null, ok: false, error: "x" });
    expect(await settle(p)).toBe("hang");
    w.emit(okMsg(1, 4));
    expect(Array.from((await p)!)).toEqual([4]);
  });

  it("未知 id 的回包忽略，且不许抛（迟到的旧结果不能砸了在飞的那发）", async () => {
    const { encodeQueryWithWorker } = await load();
    const first = encodeQueryWithWorker("一", "bge");
    const w = FakeWorker.live[0];
    w.emit(okMsg(1, 1));
    await first;
    const second = encodeQueryWithWorker("二", "bge");
    expect(() => w.emit(okMsg(1, 999))).not.toThrow();
    expect(await settle(second)).toBe("hang");
    w.emit(okMsg(2, 2));
    expect(Array.from((await second)!)).toEqual([2]);
  });

  it("ok:true 却没带 data：不许把 undefined 交出去，按业务失败回退主线程", async () => {
    const { encodeQueryWithWorker } = await load();
    const mainVec = new Float32Array([1, 2]);
    deps.main.mockResolvedValue(mainVec);
    const p = encodeQueryWithWorker("一", "bge");
    const w = FakeWorker.live[0];
    w.emit({ type: "encode-result", id: 1, ok: true });
    expect(await p).toBe(mainVec);
    expect(deps.main).toHaveBeenCalledTimes(1);
  });

  it("业务失败（ok:false）这一发回退主线程，拿主线程的结果", async () => {
    const { encodeQueryWithWorker } = await load();
    const mainVec = new Float32Array([5]);
    deps.main.mockResolvedValue(mainVec);
    const p = encodeQueryWithWorker("一", "bge");
    FakeWorker.live[0].emit(failMsg(1, "模型未缓存"));
    expect(await p).toBe(mainVec);
    expect(deps.main).toHaveBeenCalledWith("一", "bge");
  });

  it("失败原因进日志，且带那句「本次回退主线程」", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(new Float32Array([1]));
    const p = encodeQueryWithWorker("一", "bge");
    FakeWorker.live[0].emit(failMsg(1, "服务器未配置"));
    await p;
    const joined = deps.logs.join("\n");
    expect(joined).toContain("服务器未配置");
    expect(joined).toContain("本次回退主线程");
  });

  it("ok:false 也没写 error：日志不许报 undefined 给人看", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(new Float32Array([1]));
    const p = encodeQueryWithWorker("一", "bge");
    FakeWorker.live[0].emit({ type: "encode-result", id: 1, ok: false });
    await p;
    expect(deps.logs.join("\n")).toContain("encode failed");
  });
});

// ================================================================ 两种失败的分工
describe("业务失败只废这一发，基础设施故障才永久停用 Worker", () => {
  it("业务失败之后：Worker 没被 terminate、也没被换成新的", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(new Float32Array([1]));
    const p = encodeQueryWithWorker("一", "bge");
    const w = FakeWorker.live[0];
    w.emit(failMsg(1, "模型未缓存"));
    await p;
    expect(w.terminated).toBe(0);
    expect(FakeWorker.constructed).toBe(1);
    expect(FakeWorker.live).toHaveLength(1);
  });

  it("业务失败之后下一发仍走 Worker（永久禁用＝之后每发都退回主线程反复加载模型）", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(new Float32Array([1]));
    const p1 = encodeQueryWithWorker("一", "bge");
    const w = FakeWorker.live[0];
    w.emit(failMsg(1, "模型未缓存"));
    await p1;
    const p2 = encodeQueryWithWorker("二", "bge");
    expect(w.posted).toHaveLength(2);
    w.emit(okMsg(2, 8));
    expect(Array.from((await p2)!)).toEqual([8]);
    // 主线程只为第一发跑过一次，第二发不必再兜
    expect(deps.main).toHaveBeenCalledTimes(1);
  });

  it("worker.onerror：在飞的每一发各自拿到「Worker error」，且都回退到主线程结果", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockImplementation(async (t: string) => new Float32Array([t.length]));
    const a = encodeQueryWithWorker("一", "bge");
    const b = encodeQueryWithWorker("第二", "bge");
    const w = FakeWorker.live[0];
    w.fail("崩了");
    expect(Array.from((await a)!)).toEqual([1]);
    expect(Array.from((await b)!)).toEqual([2]);
    expect(deps.main).toHaveBeenCalledTimes(2);
    // 两发各自走一遍 catch，terminate 只许发生一次（靠的是 catch 末尾那句 worker = null）
    expect(w.terminated).toBe(1);
  });

  it("worker.onerror：terminate 一次、本次会话不再尝试 Worker", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(new Float32Array([0]));
    const a = encodeQueryWithWorker("一", "bge");
    const w = FakeWorker.live[0];
    w.fail();
    await a;
    expect(w.terminated).toBe(1);
    const b = await encodeQueryWithWorker("二", "bge");
    expect(b).toBeInstanceOf(Float32Array);
    expect(FakeWorker.constructed).toBe(1);
    expect(FakeWorker.live).toHaveLength(1);
    expect(w.posted).toHaveLength(1);
  });

  it("postMessage 抛（结构化克隆失败）也算基础设施故障：这一发仍有结果，Worker 收摊", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(new Float32Array([3]));
    FakeWorker.throwNextPost = true;
    const got = await encodeQueryWithWorker("一", "bge");
    const w = FakeWorker.live[0];
    expect(Array.from(got!)).toEqual([3]);
    expect(w.terminated).toBe(1);
    const after = await encodeQueryWithWorker("二", "bge");
    expect(Array.from(after!)).toEqual([3]);
    expect(FakeWorker.constructed).toBe(1);
    // 这一发根本没再往 Worker 写过东西
    expect(w.posted).toHaveLength(0);
  });

  it("故障落地要留一句可查的日志（屏幕上没有报错，只有这一条）", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(new Float32Array([0]));
    const p = encodeQueryWithWorker("一", "bge");
    FakeWorker.live[0].fail("离线模型加载炸了");
    await p;
    expect(deps.logs.join("\n")).toContain("离线模型加载炸了");
    expect(deps.logs.join("\n")).toContain("降级主线程");
  });

  it("主线程也拿不到向量：以 null 落地，不许 reject 给调用方", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(null);
    const p = encodeQueryWithWorker("一", "bge");
    FakeWorker.live[0].emit(failMsg(1, "模型未缓存"));
    const r = await settle(p);
    expect(r).toEqual({ status: "ok", value: null });
  });
});

// ================================================================ 取消
describe("用户取消既不是业务失败也不是故障：只废这一发", () => {
  it("进来就已经取消：null，不 spawn、不回退主线程", async () => {
    const { encodeQueryWithWorker } = await load();
    const c = new AbortController();
    c.abort();
    const got = await encodeQueryWithWorker("一", "bge", { signal: c.signal });
    expect(got).toBeNull();
    expect(FakeWorker.constructed).toBe(0);
    expect(deps.main).not.toHaveBeenCalled();
  });

  it("在飞时取消：这一发 null，Worker 一根手指都不许碰", async () => {
    const { encodeQueryWithWorker } = await load();
    const c = new AbortController();
    const p = encodeQueryWithWorker("一", "bge", { signal: c.signal });
    const w = FakeWorker.live[0];
    c.abort();
    expect(await p).toBeNull();
    expect(w.terminated).toBe(0);
    expect(FakeWorker.constructed).toBe(1);
    expect(deps.main).not.toHaveBeenCalled();
  });

  it("取消之后迟到的回包不许把结果交出去（也不许顺手跑主线程）", async () => {
    const { encodeQueryWithWorker } = await load();
    const c = new AbortController();
    const p = encodeQueryWithWorker("一", "bge", { signal: c.signal });
    const w = FakeWorker.live[0];
    c.abort();
    await p;
    expect(() => w.emit(okMsg(1, 7))).not.toThrow();
    expect(deps.main).not.toHaveBeenCalled();
  });

  it("只取消其中一发：另一发照常拿自己的向量", async () => {
    const { encodeQueryWithWorker } = await load();
    const c1 = new AbortController();
    const c2 = new AbortController();
    const a = encodeQueryWithWorker("一", "bge", { signal: c1.signal });
    const b = encodeQueryWithWorker("二", "bge", { signal: c2.signal });
    const w = FakeWorker.live[0];
    c1.abort();
    expect(await a).toBeNull();
    w.emit(okMsg(2, 6));
    expect(Array.from((await b)!)).toEqual([6]);
  });

  it("取消之后下一发仍走 Worker（把取消当故障＝一次点击废掉整条离线腿）", async () => {
    const { encodeQueryWithWorker } = await load();
    const c = new AbortController();
    const a = encodeQueryWithWorker("一", "bge", { signal: c.signal });
    const w = FakeWorker.live[0];
    c.abort();
    await a;
    const b = encodeQueryWithWorker("二", "bge");
    expect(w.posted).toHaveLength(2);
    w.emit(okMsg(2, 9));
    expect(Array.from((await b)!)).toEqual([9]);
    expect(FakeWorker.constructed).toBe(1);
  });

  it("业务失败之后才取消：这一发 null，不回退主线程", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(new Float32Array([1]));
    const c = new AbortController();
    const p = encodeQueryWithWorker("一", "bge", { signal: c.signal });
    const w = FakeWorker.live[0];
    w.emit(failMsg(1, "模型未缓存"));
    c.abort();
    expect(await p).toBeNull();
    expect(deps.main).not.toHaveBeenCalled();
  });

  it("基础设施故障之后才取消：null，不去跑注定重复的主线程", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(new Float32Array([1]));
    const c = new AbortController();
    const p = encodeQueryWithWorker("一", "bge", { signal: c.signal });
    const w = FakeWorker.live[0];
    w.fail();
    c.abort();
    expect(await p).toBeNull();
    expect(deps.main).not.toHaveBeenCalled();
  });

  it("已经永久停用 Worker 之后，取消的那发仍是 null（不再回头试 Worker）", async () => {
    const { encodeQueryWithWorker } = await load();
    deps.main.mockResolvedValue(new Float32Array([1]));
    const dead = encodeQueryWithWorker("一", "bge");
    FakeWorker.live[0].fail();
    await dead;
    const c = new AbortController();
    c.abort();
    const got = await encodeQueryWithWorker("二", "bge", { signal: c.signal });
    expect(got).toBeNull();
    expect(FakeWorker.constructed).toBe(1);
    expect(deps.main).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================ 变异台账
 * 27 刀全部打在基线 `00a55ae6…`（4371 字节 / 31 条全绿，**产品代码一行没动**）。
 * 每刀手改一处、跑完立刻 `cp` 字节备份还原并核 SHA256；27 轮固定读数都是
 * `markers=1 / transform_failed=0 / skipped=0 / markers_left=0 / diff_lines=0 / restored_sha=00a55ae6`。
 * 这一只的坏法有**两种完全不同的形状**：红在断言上、以及**挂到超时**（promise 永不 settle），
 * 下面每刀都标了是哪一种。
 *
 * - **回程协议**：W1 摘掉 `type !== "encode-result"`＝1 红；W3 未知 id 不再提前返回＝2 红
 *   （迟到包在 `onmessage` 里抛 TypeError，两条"迟到不许砸场"的判据一起咬）；W5 回程改成先来先配
 *   （不按 id）＝2 红；W6 不把 ArrayBuffer 还原成 Float32Array＝8 红（`Array.from` 拿到 ArrayBuffer
 *   只剩空数组，一串用例连带塌）；W4 id 写死成 1＝**8 红，其中 6 条是挂到超时**——第二发永远等不到
 *   自己的回包，因为第一发把那个键占掉了。
 * - **两种失败的分工（这一只的决定性格）**：W7 业务失败也置 `workerFailed`＝1 红、W8 业务失败也
 *   terminate＝2 红、W22 成功那一发也去跑主线程＝2 红、W18「永久停用」那道闸失效＝2 红（两条超时）、
 *   W12 `onerror` 不 reject 在飞的发＝4 红且**全是超时**（这一刀的真实症状是"一直转圈"而不是报错）、
 *   W20 `terminate` 之后不置空引用＝1 红（第二发的 catch 会再 terminate 一次，计数从 1 变 2——
 *   这条断言是 W19 跑成 0 红之后**现加**的，加完先重跑一次对照确认 31 条仍全绿才继续）。
 * - **取消那一族（三道检查各一刀）**：W13 摘入口那道＝1 红（超时）、W14 摘业务失败之后那道＝1 红、
 *   W15 摘落到主线程之前那道＝1 红、W9 取消也当故障＝2 红、W23 摘掉 `signal?.` 的可选链＝**15 红**
 *   （不带 signal 才是常态：检索那一发就没有）。
 * - **接线、文案与记账**：W10 serverUrl 写死＝2 红、W11 不懒创建（模块加载即 spawn）＝2 红、
 *   W16 丢掉 `encode failed` 兜底＝1 红、W17 回退时参数顺序颠倒＝1 红、W24 日志丢掉「本次回退主线程」
 *   ＝1 红、W25 故障不记日志＝1 红。
 * - **五笔等价变异（0 红，逐笔写清为什么）**：① W2 摘掉 `msg.id == null`——id 恒是 1..N 的数字，
 *   `pending.get(undefined)` 本来就取不到东西，这道判断是防御不是活路；② W19 摘掉 `{ once: true }`
 *   ——abort 事件只发一次，`once` 只负责自动摘监听，这一层没有可观察后果（就是上面「刻意没判的①」
 *   那格，两笔互证）；③ W21 `onerror` 里不置 `workerFailed`——`catch` 里那句
 *   `if (!workerFailed) workerFailed = true` 与它是**同职双闸**，单摘任何一边都等价；④⑤ W26
 *   （`onerror` 不 `pending.clear()`）与 W27（取消时不 `pending.delete(id)`）——那些 promise 已经
 *   settle，条目留着只是多占一个闭包。
 *
 * 两笔过程账（免得下次有人把 0 红当成"判据没牙"）：
 * 甲 **W13 与 W17 各踩了一次"编辑把上下文一起吃掉"**：W13 第一版把 `if (opts?.signal?.aborted)`
 *    和紧跟的 `if (!workerFailed) {` 一起换成了注释＝花括号不配平，跑之前 `git diff` 核出来是
 *    "删 2 加 1"，补回那道 opener 才成为单行改动；W17 第一版同理吞掉了 `}` `}` 两行。
 *    **规则**：每刀跑之前先看 `git diff` 的增删行数与预期一致（这里应当是 1/1 或 1/2），
 *    不看就直接跑＝下一轮的 `markers` 与 `transform_failed` 都救不了归因。
 * 乙 W19 那刀 0 红没有放过去，而是**顺着它找出了真正没判的一格**（两发在飞时 terminate 只发生一次），
 *    补断言 → 重跑对照（0 刀，`markers=0 / reds=0` 且 `restored_sha` 仍是 `00a55ae6`）→ 再打 W20＝1 红。
 */
