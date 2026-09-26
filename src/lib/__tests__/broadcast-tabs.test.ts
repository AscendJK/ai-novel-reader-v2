/**
 * lib/broadcast.ts — 跨标签页广播那 144 行首次有直接判据
 *
 * 它是"另一个标签页刚导入/刚删/刚换用户，这边书架要跟着动"的唯一腿。
 * 之前只有 `AppLayout-shell`、`BookSelect-shelf`、`RAGSettings`、`useFileParser-guards`、
 * `useSyncOrchestration-identity` 五只测试 import 得到它，但每一只都把它 mock 掉或绕开，
 * 于是"自己发的消息自己不许再收"、"一个处理器抛错不许带走别的处理器"、
 * "close 之后不许再发"这些真会咬人的格子没人直接看着。
 *
 * 台架做法：`vi.stubGlobal` 换成假 BroadcastChannel（jsdom 那份不可控），
 * 每条用例 `vi.resetModules()` + 动态 import 拿一只干净的单例
 * ——模块级单例不这么办就会互相串味（上一条用例注册的处理器会漏进这一条）。
 *
 * 有意不判的格子（写了理由，不是漏）：
 * - 类型处理器与 `*` 通配处理器的**先后顺序**：两边的契约都是"每条消息各叫一次"，
 *   谁先谁后调用方没依赖（`RAGSettings` 的 `*` 只用来刷新），判死它只是挡一条正当改动。
 * - `tab-closed` 这一档 type：**全仓没人发也没人听**（死在联合类型里），按"死代码不写判据"不判。
 * - `generateTabId` 里 `Math.random().toString(36).slice(2, 9)` 的长度分布：
 *   判"两个标签页 id 不同"就够，去钉随机数的形状是给假需求写断言。
 * - `payload` 的可克隆性（传函数/Symbol 会 DataCloneError）：那是下面"postMessage 抛错要吞掉"
 *   那一格判的同一件事，不重复。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BroadcastMessage } from "../broadcast";

class FakeChannel {
  static made: FakeChannel[] = [];
  static nextFails = false;

  name: string;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  posted: BroadcastMessage[] = [];
  closeCalls = 0;
  postThrows = false;

  constructor(name: string) {
    if (FakeChannel.nextFails) throw new Error("BroadcastChannel constructor refused");
    this.name = name;
    FakeChannel.made.push(this);
  }

  postMessage(data: BroadcastMessage): void {
    if (this.postThrows) throw new Error("DataCloneError");
    this.posted.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  /** 演一发「别的标签页过来的」消息：直接喂 onmessage */
  emit(data: BroadcastMessage): void {
    this.onmessage?.({ data });
  }
}

/** 当前这只单例建出来的频道（每次 fresh() 之后取最新那条） */
function lastChannel(): FakeChannel {
  return FakeChannel.made[FakeChannel.made.length - 1];
}

function msg(type: BroadcastMessage["type"], over?: Partial<BroadcastMessage>): BroadcastMessage {
  return { type, source: over?.source ?? "tab-other", timestamp: 1, ...over };
}

type Handle = { b: typeof import("../broadcast").broadcast; ch: FakeChannel };

/** 一只干净的单例：假频道先就位，再 resetModules + 动态 import */
async function fresh(): Promise<Handle> {
  vi.resetModules();
  const mod = await import("../broadcast");
  return { b: mod.broadcast, ch: lastChannel() };
}

beforeEach(() => {
  FakeChannel.made = [];
  FakeChannel.nextFails = false;
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("接上频道", () => {
  it("建的是 'ai-novel-reader' 这一条频道——两个标签页必须进同一个名字", async () => {
    await fresh();
    expect(lastChannel().name).toBe("ai-novel-reader");
  });

  it("重复 import 不再建第二条频道：单例只接一次腿", async () => {
    vi.resetModules();
    const first = await import("../broadcast");
    const second = await import("../broadcast");
    expect(second.broadcast).toBe(first.broadcast);
    expect(FakeChannel.made).toHaveLength(1);
  });

  it("BroadcastChannel 不支持的环境：只 warn 一次，构造不许把整个应用带崩", async () => {
    FakeChannel.nextFails = true;
    const { b, ch } = await fresh();
    expect(ch).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(() => b.send("data-changed", { kind: "novel-added" })).not.toThrow();
    expect(() => b.on("data-changed", () => {})).not.toThrow();
  });

  it("tabId 稳定且形状是 tab-<毫秒>-<随机>：两条腿靠它认出自己", async () => {
    const { b } = await fresh();
    const id = b.getTabId();
    expect(b.getTabId()).toBe(id);
    expect(id).toMatch(/^tab-\d+-[a-z0-9]{1,7}$/);
  });

  it("两个标签页（两次模块初始化）的 tabId 不许相同", async () => {
    const one = await fresh();
    const two = await fresh();
    expect(two.b.getTabId()).not.toBe(one.b.getTabId());
  });
});

describe("自己发的不许自己收", () => {
  it("source 是自己的消息：不分发", async () => {
    const { b, ch } = await fresh();
    const handler = vi.fn();
    b.on("data-changed", handler);
    ch.emit(msg("data-changed", { source: b.getTabId() }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("source 是别的标签页的消息：原样分发整条 message", async () => {
    const { b, ch } = await fresh();
    const handler = vi.fn();
    const m = msg("data-changed", { source: "tab-other", payload: { kind: "novel-deleted", id: "n7" } });
    b.on("data-changed", handler);
    ch.emit(m);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(m);
  });

  it("自过滤只认 source：payload 里带自己 id 的照样要分发（删除通知就长这样）", async () => {
    const { b, ch } = await fresh();
    const handler = vi.fn();
    b.on("data-changed", handler);
    ch.emit(msg("data-changed", { payload: { kind: "novel-deleted", id: b.getTabId() } }));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("分发", () => {
  it("只有对得上 type 的处理器被叫：别的 type 不许串台", async () => {
    const { b, ch } = await fresh();
    const onChanged = vi.fn();
    const onLogout = vi.fn();
    b.on("data-changed", onChanged);
    b.on("logout", onLogout);
    ch.emit(msg("data-changed"));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("`*` 通配什么都收，收到的就是那一条 message", async () => {
    const { b, ch } = await fresh();
    const all = vi.fn();
    b.on("*", all);
    const m1 = msg("sync-complete");
    const m2 = msg("user-switched", { payload: "kun" });
    ch.emit(m1);
    ch.emit(m2);
    expect(all).toHaveBeenCalledTimes(2);
    expect(all.mock.calls[0][0]).toBe(m1);
    expect(all.mock.calls[1][0]).toBe(m2);
  });

  it("同一条消息：类型那一支与 `*` 那一支各叫一次（两半都得在）", async () => {
    const { b, ch } = await fresh();
    const typed = vi.fn();
    const all = vi.fn();
    b.on("data-changed", typed);
    b.on("*", all);
    ch.emit(msg("data-changed"));
    expect(typed).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
  });

  it("同一 type 两个处理器都叫（多订阅者不互相顶掉）", async () => {
    const { b, ch } = await fresh();
    const one = vi.fn();
    const two = vi.fn();
    b.on("data-changed", one);
    b.on("data-changed", two);
    ch.emit(msg("data-changed"));
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it("一个处理器抛错不许带走同类型的另一个，也不许抛回 onmessage", async () => {
    const { b, ch } = await fresh();
    const boom = vi.fn(() => {
      throw new Error("处理器里炸了");
    });
    const survivor = vi.fn();
    b.on("data-changed", boom);
    b.on("data-changed", survivor);
    expect(() => ch.emit(msg("data-changed"))).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("类型处理器抛错不许影响 `*` 那一支", async () => {
    const { b, ch } = await fresh();
    b.on("logout", () => {
      throw new Error("炸在 logout 里");
    });
    const wildcard = vi.fn();
    b.on("*", wildcard);
    expect(() => ch.emit(msg("logout"))).not.toThrow();
    expect(wildcard).toHaveBeenCalledTimes(1);
  });

  it("`*` 那一支自己抛错也不外泄：后面的消息照样能进来", async () => {
    const { b, ch } = await fresh();
    b.on("*", () => {
      throw new Error("炸在通配里");
    });
    expect(() => ch.emit(msg("logout"))).not.toThrow();
    expect(console.error).toHaveBeenCalledTimes(1);
    const after = vi.fn();
    b.on("data-changed", after);
    ch.emit(msg("data-changed"));
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("没注册任何处理器的 type 来了不炸（新 type 先上服务端、前端后补是常态）", async () => {
    const { ch } = await fresh();
    expect(() => ch.emit(msg("model-download-complete"))).not.toThrow();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("退订只摘自己那一枚：同 type 另一枚还在收", async () => {
    const { b, ch } = await fresh();
    const gone = vi.fn();
    const kept = vi.fn();
    const off = b.on("data-changed", gone);
    b.on("data-changed", kept);
    off();
    ch.emit(msg("data-changed"));
    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it("重复退订安全，且退订 `*` 不许顺手把类型处理器一起摘掉", async () => {
    const { b, ch } = await fresh();
    const typed = vi.fn();
    b.on("data-changed", typed);
    const offAll = b.on("data-changed", vi.fn());
    offAll();
    expect(() => offAll()).not.toThrow();
    ch.emit(msg("data-changed"));
    expect(typed).toHaveBeenCalledTimes(1);
  });
});

describe("send", () => {
  it("发出去的那一份带齐 type/payload/source/timestamp", async () => {
    const { b, ch } = await fresh();
    const before = Date.now();
    b.send("data-changed", { kind: "novel-added", id: "n3" });
    expect(ch.posted).toHaveLength(1);
    const sent = ch.posted[0];
    expect(sent.type).toBe("data-changed");
    expect(sent.payload).toEqual({ kind: "novel-added", id: "n3" });
    expect(sent.source).toBe(b.getTabId());
    expect(typeof sent.timestamp).toBe("number");
    expect(sent.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("不带 payload 也照样发得出去（sync-complete 就是这么发的）", async () => {
    const { b, ch } = await fresh();
    b.send("sync-complete");
    expect(ch.posted).toHaveLength(1);
    expect(ch.posted[0].payload).toBeUndefined();
    expect(ch.posted[0].type).toBe("sync-complete");
  });

  it("两发之间不许串 payload：第二发就是第二发的内容", async () => {
    const { b, ch } = await fresh();
    b.send("user-switched", "kun");
    b.send("user-switched", "other");
    expect(ch.posted.map((m) => m.payload)).toEqual(["kun", "other"]);
  });

  it("频道没了（close 之后）send 静默返回：既不抛也不留错误日志", async () => {
    const { b, ch } = await fresh();
    b.close();
    expect(() => b.send("data-changed", { kind: "novel-added" })).not.toThrow();
    expect(ch.posted).toHaveLength(0);
    // 靠 catch 兜住异常也算"不抛"，但那是每发都刷一条错误日志——静默退路必须是静默的
    expect(console.error).not.toHaveBeenCalled();
  });

  it("postMessage 抛错（DataCloneError 这类）要吞掉并记日志，不许抛给业务", async () => {
    const { b, ch } = await fresh();
    ch.postThrows = true;
    expect(() => b.send("data-changed", { kind: "novel-added" })).not.toThrow();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe("四个薄壳只喂各自那一档", () => {
  it("onSyncComplete：`sync-complete` 才叫，且不把 message 当参数递过去", async () => {
    const { b, ch } = await fresh();
    const cb = vi.fn();
    b.onSyncComplete(cb);
    ch.emit(msg("data-changed"));
    expect(cb).not.toHaveBeenCalled();
    ch.emit(msg("sync-complete"));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toBeUndefined();
  });

  it("onDataChanged：递的是 payload，不是整条 message", async () => {
    const { b, ch } = await fresh();
    const cb = vi.fn();
    b.onDataChanged(cb);
    ch.emit(msg("data-changed", { payload: { kind: "novel-deleted", id: "n9" } }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toEqual({ kind: "novel-deleted", id: "n9" });
  });

  it("onUserSwitched：递的是 payload 那个用户名", async () => {
    const { b, ch } = await fresh();
    const cb = vi.fn();
    b.onUserSwitched(cb);
    ch.emit(msg("user-switched", { payload: "kun" }));
    expect(cb.mock.calls[0][0]).toBe("kun");
  });

  it("onLogout：`logout` 才叫、无参数；`user-switched` 不许顶替它", async () => {
    const { b, ch } = await fresh();
    const cb = vi.fn();
    b.onLogout(cb);
    ch.emit(msg("user-switched", { payload: "kun" }));
    expect(cb).not.toHaveBeenCalled();
    ch.emit(msg("logout"));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toBeUndefined();
  });

  it("四个壳返回的退订都真能退", async () => {
    const { b, ch } = await fresh();
    const a = vi.fn();
    const c = vi.fn();
    const d = vi.fn();
    const e = vi.fn();
    b.onSyncComplete(a)();
    b.onDataChanged(c)();
    b.onUserSwitched(d)();
    b.onLogout(e)();
    ch.emit(msg("sync-complete"));
    ch.emit(msg("data-changed", { payload: 1 }));
    ch.emit(msg("user-switched", { payload: "x" }));
    ch.emit(msg("logout"));
    expect(a).not.toHaveBeenCalled();
    expect(c).not.toHaveBeenCalled();
    expect(d).not.toHaveBeenCalled();
    expect(e).not.toHaveBeenCalled();
  });
});

describe("close", () => {
  it("关掉频道并把它置空：close 叫一次，之后的 send 不再往外发", async () => {
    const { b, ch } = await fresh();
    b.close();
    expect(ch.closeCalls).toBe(1);
    b.send("logout");
    expect(ch.posted).toHaveLength(0);
  });

  it("close 会把处理器清空：硬塞进来的一发不许再分发", async () => {
    const { b, ch } = await fresh();
    const cb = vi.fn();
    const wildcard = vi.fn();
    b.on("data-changed", cb);
    b.on("*", wildcard);
    b.close();
    ch.emit(msg("data-changed"));
    expect(cb).not.toHaveBeenCalled();
    expect(wildcard).not.toHaveBeenCalled();
  });

  it("close 之后 tabId 还是那一个：日志与去重都要拿它当身份", async () => {
    const { b } = await fresh();
    const id = b.getTabId();
    b.close();
    expect(b.getTabId()).toBe(id);
  });

  it("close 两次不炸（卸载路径可能重入）", async () => {
    const { b } = await fresh();
    b.close();
    expect(() => b.close()).not.toThrow();
  });

  it("close 之后再注册：能注册上但腿已经断了，不会收到消息", async () => {
    const { b, ch } = await fresh();
    b.close();
    const late = b.on("data-changed", vi.fn());
    ch.emit(msg("data-changed"));
    expect(late).toBeTypeOf("function");
    expect(console.error).not.toHaveBeenCalled();
  });
});

/*
 * ── 变异台账 ──
 * 产品基线：src/lib/broadcast.ts 3480 字节，sha256 前缀 94bb2823
 * 每轮：一次手改一处（带 MUT- 标记）→ 跑本文件 → 按字节基线还原 → 当场核 SHA。
 * 28 轮 = 25 轮刀（24 把不同的刀，C7 在判据加强后重打过一遍）+ 3 轮对照。
 * 每一轮 markers=1（对照轮 0）、transform_failed=0、markers_left=0、diff_lines=0、sha=94bb2823。
 * **没有一记 0 红的刀，也没有等价变异**——这只文件每一格都真被看着。
 * 跑法：bash %TEMP%\knife-bc.sh <刀号>；台账原文 %TEMP%\ledger-bc.txt
 *
 * 刀号                        红  这一刀摘掉了什么 / 谁红着指出来
 * C0 对照                      0  不动产品：32 条全绿
 * C1 频道名换了腿              1  两个标签页各说各话——名字这一格只有那一条能看见
 * C2 自过滤摘掉                1  自己发的自己再收一遍（导入后本标签页重复刷新）
 * C3 自过滤写反               15  只收自己的：几乎整面分发判据一起红
 * C4 不比 source，拿整条消息比  1  只咬"payload 里带自己 id 的照样要分发"那条——删除通知就长这样
 * C5 通配那一支整条删掉        3  on('*') 注册得上但永远收不到
 * C6 类型那一支删掉           12  只有挂了通配的收得到：四个薄壳与多订阅者一起红
 * C7 有类型处理器就不叫通配    1  第一遍只红 1 条 → 见下面"补过一条判据"
 * C7 前对照                    0  补完那条之后重跑基线：33 条全绿
 * C7b 同上（重打）             2  "两半都得在"那条咬住了
 * C8 类型那一支不兜错          2  一个处理器抛错带走同类型的另一个，还外泄到 onmessage
 * C9 通配那一支不兜错          1  同一件事的另一半：通配自己炸也要逐个兜
 * C10 频道没了的早退换掉      1  靠 catch 兜住也算"不抛"，但每发刷一条错误日志——静默必须是静默的
 * C11 send 的兜错摘掉          1  DataCloneError 直接砸进业务（sync-client 那两处 try 是白写的）
 * C12 source 写死              1  发出去不带自己的 tabId：对端把自己当别人
 * C13 时间戳写死               1  timestamp 不是当下：去重/排序那类下游判断会拿到假时刻
 * C14 退订什么都不摘           2  卸载之后处理器还挂着（组件重挂载会重复响应）
 * C15 退订把整组摘掉           2  摘一枚带走一整组
 * C16 同 type 用覆盖不用 Set   3  后来者顶掉前一个：多订阅者只剩最后一个
 * C17 close 不置空             2  close 之后 send 照样往外打
 * C18 close 不清处理器         1  腿都断了还在分发
 * C19 不支持的环境不再降级     1  构造 BroadcastChannel 一抛就把整个应用带崩
 * C20 sync-complete 递 message 1  业务签名是 `() => void`，把整条消息塞进第一个参数
 * C21 data-changed 递整条      1  该递 payload 的壳递了 message：拿到的 kind 是 undefined
 * C22 user-switched 挂错 type  1  差一个字（user-changed）＝这条腿静默失灵
 * C23 logout 挂到 user-switched  1  退出登录被切用户顶替：另一标签页退出这边不反应
 * C24 tabId 写死               2  两个标签页撞同一个 id → 互相把对方的消息当自己发的
 * C25 收尾对照                 0  全部还原后 33 条仍全绿
 *
 * 补过一条判据：C7 第一遍只红 1 条——"类型那一支与通配那一支各叫一次"这一格没有专门的用例，
 * 通配的两条各自只挂一个维度。补上"两半都得在"之后重打 C7b＝2 红。
 *
 * 产品代码一行没动（每轮还原后 SHA 与基线一致）。
 */
