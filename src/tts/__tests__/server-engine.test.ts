/**
 * `tts/server-engine.ts` 本体的直接判据（地板第 1 档）
 *
 * 这只文件是"服务端推理"那一档引擎的客户端腿：查状态、把一段文字交给服务器合成、
 * 把回来的 WAV 字节解成 Float32Array、停止时把排队里的活儿退掉。它的坏法全落在**听感与排队**上：
 * - 状态那一发：不许顺手触发下载；服务器版本旧／字段类型不对时要说清"为什么不能用"，
 *   而且这个函数**永远不许 reject**（设置页每次开机都调它，抛出去就是一片空白）。
 * - WAV 解码：格式／声道／采样率不对时不许"解出一点是一点"——那会变成一段噪音播出去；
 *   RIFF 的奇数长度块要按偶数对齐跳过；声明长度比实际长（下载截断）要按实际字节截。
 * - 超时那一发：必须转成 `ServerInferenceTimeoutError`，因为 `tts-manager.ts:1302` 拿
 *   `instanceof` 决定"这条错误可不可重试"。写成普通 Error 就是"卡死的队列被再顶三发"。
 * - 取消那一发：要真是 POST，且失败必须静默 resolve（不能让停止流程多一个未处理拒绝）。
 *
 * 未判 / 量不到（写清楚，别让"这只有测试了"盖住）：
 * - `SERVER_SYNTH_TIMEOUT_MS`（240 秒）没导出。这里判到的是"这一发**带着** signal"＋"超时文案里有
 *   240 秒"＋"超时错误要转类"。**"钟真走到 240 秒时 signal 会不会自己 abort"这一半判不到**，
 *   而且是实测过的，不是猜的：临时探针里 `vi.useFakeTimers()` + `advanceTimersByTimeAsync(240_001)`
 *   之后 `signal.aborted` 仍是 `false`，而同一发用真时钟等 60ms（`AbortSignal.timeout(30)`）就变 `true`
 *   ——jsdom 的 `AbortSignal.timeout` 不吃被替换掉的 `setTimeout`。所以 Y9 那一刀（把秒数写死成 120）
 *   是"文案与常量漂开"的哨兵，不是"时长正确"的证据。
 * - `console.log` 那两行耗时日志没判（纯观测）。
 * - 真生成音频的是服务端 Python；这里只判**客户端发什么、收什么、拒收什么**。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkServerInference,
  synthesizeServer,
  cancelServerInference,
  ServerInferenceTimeoutError,
} from "../server-engine";

const check = checkServerInference;
const synth = synthesizeServer;
const cancel = cancelServerInference;

type Init = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
type Call = { url: string; init?: Init };

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; init?: unknown }>,
  next: null as null | ((url: string, init?: unknown) => Promise<Response>),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: (url: string, init?: unknown) => {
    h.calls.push({ url, init });
    if (!h.next) throw new Error("用例没安排这一发的回应");
    return h.next(url, init);
  },
}));

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
function wavResponse(bytes: ArrayBuffer, status = 200): Response {
  return new Response(bytes, { status, headers: { "Content-Type": "audio/wav" } });
}
function failWith(err: Error): (url: string, init?: unknown) => Promise<Response> {
  return () => Promise.reject(err);
}
const lastCall = (): Call => h.calls[h.calls.length - 1] as Call;
const sentBody = (): Record<string, unknown> => JSON.parse(String(lastCall().init?.body));
/** 把 Float32 样本还原回整数刻度好比对（/32768 的逆） */
const asInts = (s: Float32Array): number[] => Array.from(s).map((v) => Math.round(v * 32768));

/* ---------------- 造 WAV：44 字节标准头，其余按用例需要拆 ---------------- */

const le32 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const le16 = (n: number): number[] => [n & 255, (n >> 8) & 255];
const tag = (s: string): number[] => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];

/** RIFF 约定：块长为奇数时后面补一个字节，下一个块才落在偶地址上 */
function chunk(id: string, payload: number[], declaredSize?: number): number[] {
  const out = [...tag(id), ...le32(declaredSize ?? payload.length), ...payload];
  if (payload.length % 2 === 1) out.push(0);
  return out;
}

function wav(o: {
  riff?: string;
  wave?: string;
  format?: number;
  channels?: number;
  sampleRate?: number;
  between?: number[][];
  samples?: number[];
  declaredData?: number;
  dataTail?: number;
  omitData?: boolean;
} = {}): ArrayBuffer {
  const head = [...tag(o.riff ?? "RIFF"), ...le32(0), ...tag(o.wave ?? "WAVE")];
  const fmt = chunk("fmt ", [
    ...le16(o.format ?? 1),
    ...le16(o.channels ?? 1),
    ...le32(o.sampleRate ?? 24000),
    ...le32(48000),
    ...le16(2),
    ...le16(16),
  ]);
  const pcm = (o.samples ?? []).flatMap((v) => le16(v));
  const data = o.omitData ? [] : chunk("data", pcm, o.declaredData);
  const tail = o.dataTail ? [o.dataTail] : [];
  return new Uint8Array([...head, ...fmt, ...(o.between ?? []).flat(), ...data, ...tail]).buffer;
}

beforeEach(() => {
  h.calls.length = 0;
  h.next = null;
});

/* ------------------------------------------------------------------ */

describe("状态那一发：只查不用，且永远不许抛出去", () => {
  it("查可用性只打状态接口——不许顺手把模型下载叫起来", async () => {
    h.next = () => Promise.resolve(json({ serverInference: { supported: true, ready: true, reason: "" } }));
    const st = await check();
    expect(h.calls).toHaveLength(1);
    expect(lastCall().url).toBe("/api/rag/tts/status");
    // 不带 init 才是真的"只问一句"；带上 method 就等于改成了顺手要做点什么
    expect(lastCall().init).toBeUndefined();
    expect(st).toEqual({ supported: true, ready: true, reason: "" });
  });

  it("三个字段原样透传，reason 缺失要补空串（不许给界面留 undefined）", async () => {
    h.next = () => Promise.resolve(json({ serverInference: { supported: true, ready: false } }));
    expect(await check()).toEqual({ supported: true, ready: false, reason: "" });
  });

  it("supported 不是布尔就不许当真：按「版本过旧」处理", async () => {
    h.next = () => Promise.resolve(json({ serverInference: { supported: "true", ready: true, reason: "x" } }));
    expect(await check()).toEqual({
      supported: false,
      ready: false,
      reason: "服务器版本过旧，不支持服务端推理",
    });
  });

  it("整个字段都没有（旧后端）要明说是版本过旧，不许含糊成「不支持」了事", async () => {
    h.next = () => Promise.resolve(json({ ok: true }));
    expect(await check()).toEqual({
      supported: false,
      ready: false,
      reason: "服务器版本过旧，不支持服务端推理",
    });
  });

  it("HTTP 非 2xx 时原因是状态码，不是「无法连接服务器」——两件事得分开", async () => {
    h.next = () => Promise.resolve(new Response("boom", { status: 503 }));
    expect((await check()).reason).toBe("HTTP 503");
  });

  it("连不上时把原因原样接上；抛的不是 Error 也要有话说；两种都不许 reject", async () => {
    h.next = failWith(new Error("证书还没受信"));
    expect(await check()).toEqual({ supported: false, ready: false, reason: "证书还没受信" });
    h.next = failWith("nope" as unknown as Error);
    expect(await check()).toEqual({ supported: false, ready: false, reason: "无法连接服务器" });
  });
});

describe("WAV 解码：解错了就是一段噪音，所以宁可拒收", () => {
  it("样本是 16-bit 小端有符号除以 32768，采样率从头上取", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [0, 16384, -16384, 32767] })));
    const r = await synth("甲");
    expect(asInts(r.samples)).toEqual([0, 16384, -16384, 32767]);
    expect(r.samples[3]).toBe(32767 / 32768);
    expect(r.sampleRate).toBe(24000);
  });

  it("样本顺序不许乱（念倒了对不上字幕与逐段高亮）", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [1000, -2000, 3000, -4000] })));
    const r = await synth("甲");
    expect(asInts(r.samples)).toEqual([1000, -2000, 3000, -4000]);
  });

  it("少于 44 字节的响应不许当静音播出去，要指名说「文件过短」", async () => {
    h.next = () => Promise.resolve(wavResponse(new Uint8Array(20).buffer));
    await expect(synth("甲")).rejects.toThrow(/文件过短/);
  });

  it("RIFF／WAVE 头不对（比如拿回一段别的格式）要拒收", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [1], riff: "OggS" })));
    await expect(synth("甲")).rejects.toThrow(/RIFF\/WAVE/);
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [1], wave: "MP4L" })));
    await expect(synth("甲")).rejects.toThrow(/RIFF\/WAVE/);
  });

  it("非 PCM 编码（float32 的格式号 3）要说不支持，不许把浮点字节当整数硬解", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [1, 2, 3], format: 3 })));
    await expect(synth("甲")).rejects.toThrow(/不支持的编码格式 3/);
  });

  it("双声道要拒收（硬解会把两个声道咬在一起念）", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [1, 2, 3, 4], channels: 2 })));
    await expect(synth("甲")).rejects.toThrow(/不支持的声道数 2/);
  });

  it("采样率是 0 要拒收（后面拿它换算时长会除零）", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [1, 2], sampleRate: 0 })));
    await expect(synth("甲")).rejects.toThrow(/非法采样率/);
  });

  it("fmt 与 data 之间的奇数长度扩展块要按偶数对齐跳过，data 还在后面", async () => {
    const odd = chunk("LIST", [1, 2, 3]);
    expect(odd).toHaveLength(12);
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [500, 600], between: [odd] })));
    const r = await synth("甲");
    expect(asInts(r.samples)).toEqual([500, 600]);
  });

  it("找不到 data 块要报错，不许回一段零长度音频让用户以为「没声音」", async () => {
    // 拿一只 LIST 块把长度抬过 44 字节的门槛，否则先红在"文件过短"那一句上、量不到这里
    h.next = () => Promise.resolve(wavResponse(wav({ omitData: true, between: [chunk("LIST", [1, 2, 3, 4])] })));
    await expect(synth("甲")).rejects.toThrow(/未找到 data chunk/);
  });

  it("声明长度比实际长（下载截断）时按实际字节截，不许越界读抛 RangeError", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [1000, 2000], declaredData: 100 })));
    const r = await synth("甲");
    expect(asInts(r.samples)).toEqual([1000, 2000]);
  });

  it("落单的最后半个样本丢掉（一个样本两个字节，凑不出来就别凑）", async () => {
    h.next = () =>
      Promise.resolve(wavResponse(wav({ samples: [1000], declaredData: 3, dataTail: 7 })));
    const r = await synth("甲");
    expect(r.samples).toHaveLength(1);
    expect(asInts(r.samples)).toEqual([1000]);
  });
});

describe("生成那一发：发什么、超时怎么说、服务端给的原因要留下", () => {
  it("一个字都没有（清洗完也没剩）不发请求，直接说不为空", async () => {
    await expect(synth("")).rejects.toThrow(/文本为空/);
    // 只剩 U+FFFD（损坏的小说源数据）：清洗之后是空，照样不许往外发
    await expect(synth(String.fromCharCode(0xfffd, 0xfffd))).rejects.toThrow(/文本为空/);
    expect(h.calls, "空文本一次都不该往外发").toHaveLength(0);
  });

  it("发出去的是清洗之后的文本，不是界面上那串脏字", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [1] })));
    await synth("他说：“你好。”");
    expect(sentBody().text).toBe("他说：你好。");
    expect(h.calls).toHaveLength(1);
    expect(lastCall().url).toBe("/api/rag/tts/synthesize");
    expect(lastCall().init?.method).toBe("POST");
  });

  it("音色号三档都要变成数字：数字串照转、坏值回 45、没给也回 45", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [1] })));
    await synth("甲", { voice: "17" });
    expect(sentBody().sid).toBe(17);
    await synth("甲", { voice: "abc" });
    expect(sentBody().sid).toBe(45);
    await synth("甲");
    expect(sentBody().sid).toBe(45);
  });

  it("语速没给要按 1.0 发，给了就原样发（与设置页那枚倍速同源）", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [1] })));
    await synth("甲");
    expect(sentBody().speed).toBe(1);
    await synth("甲", { speed: 1.75 });
    expect(sentBody().speed).toBe(1.75);
  });

  it("这一发必须带着超时信号走（不带的话服务端僵死时播放链永远停在「生成中」）", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [1] })));
    await synth("甲");
    const signal = lastCall().init?.signal;
    expect(signal, "没带 signal 就等于这一发可以永远挂着").toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("超时转成 ServerInferenceTimeoutError（重试判定认的是这个类），文案给秒数并留着原错", async () => {
    const original = Object.assign(new Error("Timeout expired"), { name: "TimeoutError" });
    h.next = failWith(original);
    const err = await synth("甲").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerInferenceTimeoutError);
    expect((err as Error).message).toContain("240 秒");
    expect((err as { cause?: unknown }).cause).toBe(original);
  });

  it("名字是 AbortError 也按超时处理（现状），不许退成普通失败去重试", async () => {
    h.next = failWith(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(synth("甲")).rejects.toBeInstanceOf(ServerInferenceTimeoutError);
  });

  it("普通网络错要原样抛出去，不许冒充「服务端超时」", async () => {
    const net = new TypeError("Failed to fetch");
    h.next = failWith(net);
    const err = await synth("甲").catch((e: unknown) => e);
    expect(err).toBe(net);
    expect(err).not.toBeInstanceOf(ServerInferenceTimeoutError);
  });

  it("服务端给了原因就用它的原话；没给才退回状态码；非 JSON 也不许炸在解析上", async () => {
    h.next = () => Promise.resolve(json({ error: "服务端推理队列已满，请稍后再试" }, 503));
    await expect(synth("甲")).rejects.toThrow("服务端推理队列已满，请稍后再试");
    h.next = () => Promise.resolve(json({}, 500));
    await expect(synth("甲")).rejects.toThrow("HTTP 500");
    h.next = () => Promise.resolve(new Response("<html>502</html>", { status: 502 }));
    await expect(synth("甲")).rejects.toThrow("HTTP 502");
  });

  it("成功时把 WAV 字节解成交给播放链，不许拿 json() 当音频", async () => {
    h.next = () => Promise.resolve(wavResponse(wav({ samples: [0, 8192], sampleRate: 22050 })));
    const r = await synth("甲");
    expect(r.sampleRate).toBe(22050);
    expect(Array.from(r.samples)).toEqual([0, 0.25]);
  });
});

describe("停止朗读时那一发取消", () => {
  it("取消要 POST 到 cancel 端点（服务端靠它立刻放掉队列位）", async () => {
    h.next = () => Promise.resolve(json({ cancelled: 2 }));
    await cancel();
    expect(lastCall().url).toBe("/api/rag/tts/cancel");
    expect(lastCall().init?.method).toBe("POST");
  });

  it("取消失败必须静默成功——停止流程不许因此多一个未处理拒绝", async () => {
    h.next = failWith(new Error("离线了"));
    await expect(cancel()).resolves.toBeUndefined();
  });
});

/* 变异台账（每刀手动一次一处、跑完 `cp` 字节备份还原并核 SHA256 回基线；读数是实跑的）：
 *
 *  基线 SHA256=bb502f9ae5db80057e0c466130a5bb321392c6a619ee2e4509192ad1d4a5fb1d，6789 字节。
 *  三十一刀每一刀的收尾行都是 `restored_sha=bb502f9a… markers_left=0 diff_lines=0`，
 *  且每轮 `transform_failed=0 skipped=0`（这两格必须核，不然"红=0"是刀没编译过）。
 *  用例共 29 条。
 *
 *  ── 状态那一发 ──
 *  S1  只多带一个 method                             「查可用性只打状态接口」              1 红
 *  S2  reason 缺失时留 undefined                      「三个字段原样透传」                  1 红
 *  S3  supported 不看类型（信 "true"）                 「supported 不是布尔就不许当真」      1 红
 *  S4  旧后端文案换成含糊一句                          「版本过旧」两条一起红                2 红
 *  S5  HTTP 状态码被混成「无法连接服务器」             「原因是状态码不是连不上」            1 红
 *  S6  catch 用 String(e)                             「状态码」＋「抛的不是 Error」        2 红
 *
 *  ── WAV 解码 ──
 *  W1  归一化分母 32768 → 32767                       刻度两条（样本值 / 成功解码）         2 红
 *  W2  样本按大端读                                    解出样本的用例全红                    6 红
 *  W3  过短门槛 44 → 12                                「文件过短」                          1 红
 *  W4  摘掉 RIFF／WAVE 头校验                          「头不对要拒收」                      1 红
 *  W5  格式号只挡大于 3（放过 3）                      「非 PCM 编码」                       1 红
 *  W6  声道数检查整行摘掉                              「双声道要拒收」                      1 红
 *  W7  采样率检查整行摘掉                              「采样率是 0 要拒收」                 1 红
 *  W8  奇数块不补齐                                    「奇数长度扩展块按偶数对齐」          1 红
 *  W9  没有 data 块也交空音频                          「找不到 data 块要报错」              1 红
 *  W10 去掉实际字节数的钳制                            「下载截断按实际字节截」              1 红
 *  W11 样本数不取整                                    「落单的半个样本丢掉」                1 红
 *
 *  ── 生成那一发 ──
 *  Y1  空文本判定只看未清洗的那串                       「一个字都不发请求」                  1 红
 *  Y2  请求体发的是未清洗的原文                         「发出去的是清洗之后的文本」          1 红
 *  Y3  sid 发成字符串                                  「音色号三档都要变成数字」            1 红
 *  Y4  摘掉 NaN 兜底                                   同上（坏值那一档）                   1 红
 *  Y5  没给语速时默认值改掉                             「语速没给要按 1.0 发」              1 红
 *  Y6  摘掉 AbortSignal.timeout                        「这一发必须带着超时信号走」          1 红
 *  Y7  超时退成普通 Error                              「转成 TimeoutError」＋「AbortError」 2 红
 *  Y8  AbortError 不再按超时                           「名字是 AbortError 也按超时」        1 红
 *  Y9  文案里的秒数写死成 120                          「转成 TimeoutError（文案给秒数）」   1 红
 *  Y10 丢掉服务端返回的 error 原话                     「用它的原话；没给才退回状态码」      1 红
 *  Y11 非 JSON 的失败原因改口成解析错                  同上（非 JSON 那一格）               1 红
 *  Y12 普通网络错也被包成超时                          「普通网络错要原样抛出去」            1 红
 *
 *  ── 取消 ──
 *  C1  取消那一发不带 POST                             「取消要 POST 到 cancel 端点」        1 红
 *  C2  取消失败不再静默                                「取消失败必须静默成功」              1 红
 *
 * 三版才打对的一刀（S1），前两版作废：
 * - 第一版把状态那一发整发改成 `POST /api/rag/tts/prepare`：它同时动了 url 和 method，
 *   红了也说不清是哪一半咬住的。判据第 121 行那条 `init` 为 undefined 才是这一刀的靶子。
 * - 第二版想着"只带上 method（不动 url）"，跑出来 `markers=2`（文件里留了两处 MUT 标记）＝两刀同盘，
 *   红 2 条不是一次改动的读数。清成单标记重打才是上面记的那 1 红。
 * - 教训同前一批：**跑刀命令里的 markers 与 transform_failed 两格不是仪式**，markers≠1 这一轮就作废。
 *
 * W2（大端读）一次红 6 条不是判据太宽：解码器是所有样本断言的公共咽喉，一处读反全片错位。
 * 这既是它的价值（改错立刻一片红）也是它的限度（单看这条分不出"只有它坏了"），所以小端这件事
 * 另外还由 W1（分母）、W10（钳制）、W11（取整）三刀各自钉住一格。
 *
 * 没打到的（诚实记）：
 * - Y6 只判到"带 signal"，判不到"240 秒真到点会 abort"——jsdom 的 `AbortSignal.timeout` 不吃假时钟
 *   （文件头部那条实测就是这个意思），所以时长那一半没有哨兵，Y9 是"文案与常量漂开"的哨兵。
 * - 两行 `console.log` 耗时日志没判（纯观测，摘掉没人红）。
 * - `decodeWav` 的 `arrayBuf.byteLength < 44` 之后仍信任 fmt 块在 12..36：畸形但够长的输入没造过样本。
 */
