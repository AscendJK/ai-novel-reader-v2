/**
 * useKeyboardShortcuts — 快捷键派发内核首次有直接判据
 *
 * 这只 hook 被 AppLayout（全局 t / Escape / Shift+?）与 ChapterContent（阅读方向键、
 * 空格、+/-、i）共用，而这两只调用点的测试都把整只 hook `vi.mock` 掉了，
 * 于是 34 行里没有任何一行被测试直接指着：装/摘、输入区让位、修饰键精确匹配、
 * 命中即止、when 放行、preventDefault 的时机，全都只是"看起来对"。
 *
 * 判据取自两张真实绑定表的口径：
 * - Ctrl+Shift+T（浏览器恢复标签页）与裸 Shift+T 都不许被「t」抢走
 * - 光标在搜索框里打 "t" 不许切主题
 * - 空格翻页只在字体面板关着、焦点不在按钮上时才让位（when 每键重问）
 *
 * 有意不判的格子（写了理由，不是漏）：
 * - ShortcutBinding.description：hook 从不读它，它只服务 ShortcutHelp。
 * - ctrl/shift/alt 显式写 false 与根本不写：`!!b.ctrl` 已把两者并成同一格，
 *   "有修饰键"与"无修饰键"两个方向各判一条即可，再来一条是等价断言。
 * - `useRef(bindings)` 的初值与同步 effect 的先后：首帧两者同值，没有能摘的刀。
 * - contenteditable 元素不在让位名单里：全仓零处 contentEditable，判它是给假需求写断言。
 * - 捕获阶段 / stopPropagation：调用方的事，不在这只 hook 的职责内。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts, type ShortcutBinding } from "../useKeyboardShortcuts";

function spyOnAdd() {
  return vi.spyOn(window, "addEventListener");
}
function spyOnRemove() {
  return vi.spyOn(window, "removeEventListener");
}

let addSpy: ReturnType<typeof spyOnAdd>;
let removeSpy: ReturnType<typeof spyOnRemove>;

/** 只数 keydown 这一类：别的监听（别的代码装的）不参与判据 */
function keydownAdded() {
  return addSpy.mock.calls.filter((c) => c[0] === "keydown").map((c) => c[1]);
}
function keydownRemoved() {
  return removeSpy.mock.calls.filter((c) => c[0] === "keydown").map((c) => c[1]);
}

beforeEach(() => {
  addSpy = spyOnAdd();
  removeSpy = spyOnRemove();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Field = "input" | "textarea" | "select" | "div" | "button" | "window";

/** 每种落点各建一个真元素并留在 DOM 里，事件按浏览器的路子冒泡到 window */
function targetFor(kind: Field): EventTarget {
  if (kind === "window") return window;
  const el = document.createElement(kind);
  document.body.appendChild(el);
  return el;
}

/** 发一次真 keydown，返回值＝这一键有没有被吃掉（preventDefault 过） */
function press(opts: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean; on?: Field }): boolean {
  const el = targetFor(opts.on ?? "div");
  const ev = new KeyboardEvent("keydown", {
    key: opts.key,
    ctrlKey: !!opts.ctrl,
    shiftKey: !!opts.shift,
    altKey: !!opts.alt,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function bind(key: string, action: () => void, extra?: Partial<ShortcutBinding>): ShortcutBinding {
  return { key, action, description: `测试-${key}`, ...extra };
}

describe("装与摘", () => {
  it("挂上 window 的 keydown：按绑定的键就派发一次", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", a)]));
    expect(keydownAdded()).toHaveLength(1);
    expect(press({ key: "t" })).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("卸载后不再动作，且摘掉的就是当初挂上的那一个 handler", () => {
    const a = vi.fn();
    const { unmount } = renderHook(() => useKeyboardShortcuts([bind("t", a)]));
    unmount();
    expect(press({ key: "t" })).toBe(false);
    expect(a).not.toHaveBeenCalled();
    expect(keydownRemoved()).toHaveLength(1);
    expect(keydownRemoved()[0]).toBe(keydownAdded()[0]);
  });

  it("绑定表换了三张身份，监听仍只挂一次（handler 引用必须稳定）", () => {
    const a = vi.fn();
    const { rerender } = renderHook(
      ({ list }: { list: ShortcutBinding[] }) => useKeyboardShortcuts(list),
      { initialProps: { list: [bind("t", a)] } },
    );
    rerender({ list: [bind("t", a)] });
    rerender({ list: [bind("t", a), bind("y", a)] });
    rerender({ list: [] });
    expect(keydownAdded()).toHaveLength(1);
  });

  it("两个实例并存：各挂各的，卸载一个不影响另一个还在收键", () => {
    const shelfSide = vi.fn();
    const readerSide = vi.fn();
    const one = renderHook(() => useKeyboardShortcuts([bind("t", shelfSide)]));
    renderHook(() => useKeyboardShortcuts([bind("t", readerSide)]));
    expect(keydownAdded()).toHaveLength(2);

    one.unmount();
    expect(keydownRemoved()).toHaveLength(1);
    press({ key: "t" });
    expect(shelfSide).not.toHaveBeenCalled();
    expect(readerSide).toHaveBeenCalledTimes(1);
  });

  it("空表也照样挂监听：这张表随时可能被换成非空，不该因为当下没键就不装", () => {
    renderHook(() => useKeyboardShortcuts([]));
    expect(keydownAdded()).toHaveLength(1);
    expect(press({ key: "t" })).toBe(false);
  });

  it("只认 keydown：keyup / keypress 上的同一个键不动作", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", a)]));
    const el = targetFor("div") as HTMLElement;
    el.dispatchEvent(new KeyboardEvent("keyup", { key: "t", bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keypress", { key: "t", bubbles: true, cancelable: true }));
    expect(a).not.toHaveBeenCalled();
  });
});

describe("永远读最新那一张表", () => {
  it("rerender 换了 action：同一个键跑新 action，旧的不再被叫", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = renderHook(
      ({ list }: { list: ShortcutBinding[] }) => useKeyboardShortcuts(list),
      { initialProps: { list: [bind("t", stale)] } },
    );
    rerender({ list: [bind("t", fresh)] });
    press({ key: "t" });
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });

  it("rerender 换表：旧键既不派发也不吞，新键立刻可用", () => {
    const gone = vi.fn();
    const added = vi.fn();
    const { rerender } = renderHook(
      ({ list }: { list: ShortcutBinding[] }) => useKeyboardShortcuts(list),
      { initialProps: { list: [bind("Escape", gone)] } },
    );
    rerender({ list: [bind("f", added)] });
    expect(press({ key: "Escape" })).toBe(false);
    expect(gone).not.toHaveBeenCalled();
    expect(press({ key: "f" })).toBe(true);
    expect(added).toHaveBeenCalledTimes(1);
  });

  it("when 每次按键都重新问一次，不许把第一次的答案留给后面", () => {
    let gate = false;
    const when = vi.fn(() => gate);
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind(" ", a, { when })]));

    expect(press({ key: " " })).toBe(false);
    expect(when).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();

    gate = true;
    expect(press({ key: " " })).toBe(true);
    expect(when).toHaveBeenCalledTimes(2);
    expect(a).toHaveBeenCalledTimes(1);
  });
});

describe("光标在输入区就该让位", () => {
  it("<input> 里按键：不派发、不吞键（搜索框打 t 不许切主题）", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", a)]));
    expect(press({ key: "t", on: "input" })).toBe(false);
    expect(a).not.toHaveBeenCalled();
  });

  it("<textarea> 里按键：不派发、不吞键（笔记里打 i 不许切沉浸）", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("i", a)]));
    expect(press({ key: "i", on: "textarea" })).toBe(false);
    expect(a).not.toHaveBeenCalled();
  });

  it("<select> 里按键：不派发、不吞键（引擎下拉上不抢键）", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", a)]));
    expect(press({ key: "t", on: "select" })).toBe(false);
    expect(a).not.toHaveBeenCalled();
  });

  it("反向对照：同一个键在 div / button / window 上照常动作", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", a)]));
    press({ key: "t", on: "div" });
    press({ key: "t", on: "button" });
    press({ key: "t", on: "window" });
    expect(a).toHaveBeenCalledTimes(3);
  });

  it("让位只对当前这一键：输入框里按过之后，正文里再按仍动作", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", a)]));
    press({ key: "t", on: "input" });
    press({ key: "t" });
    expect(a).toHaveBeenCalledTimes(1);
  });
});

describe("修饰键一格都不能差", () => {
  it("没声明 ctrl 的「t」：Ctrl+t 不许派发（浏览器新标签页让路）", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", a)]));
    expect(press({ key: "t", ctrl: true })).toBe(false);
    expect(a).not.toHaveBeenCalled();
  });

  it("声明 ctrl 的绑定：带 Ctrl 才派发，裸按同一键不许派发", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("s", a, { ctrl: true })]));
    expect(press({ key: "s" })).toBe(false);
    expect(a).not.toHaveBeenCalled();
    expect(press({ key: "s", ctrl: true })).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("没声明 shift 的「t」：Shift+T 与大写 T 都不许派发（Ctrl+Shift+T 恢复标签页要留给浏览器）", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", a)]));
    expect(press({ key: "t", shift: true })).toBe(false);
    expect(press({ key: "T", shift: true })).toBe(false);
    expect(press({ key: "t", ctrl: true, shift: true })).toBe(false);
    // CapsLock 开着打出来的就是大写 T、且不带任何修饰键：这一格和"按着 Shift"不是一回事。
    // 键名一旦改成忽略大小写，只有这一条看得见
    expect(press({ key: "T" })).toBe(false);
    expect(a).not.toHaveBeenCalled();
  });

  it("声明 shift 的「?」：带 Shift 才派发，不带不许派发", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("?", a, { shift: true })]));
    expect(press({ key: "?" })).toBe(false);
    expect(a).not.toHaveBeenCalled();
    expect(press({ key: "?", shift: true })).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("没声明 alt 的绑定遇 Alt+t 不许派发；声明 alt 的要 Alt+t 才派发", () => {
    const plain = vi.fn();
    const withAlt = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts([bind("t", plain), bind("k", withAlt, { alt: true })]),
    );
    expect(press({ key: "t", alt: true })).toBe(false);
    expect(press({ key: "k" })).toBe(false);
    expect(plain).not.toHaveBeenCalled();
    expect(withAlt).not.toHaveBeenCalled();
    expect(press({ key: "k", alt: true })).toBe(true);
    expect(withAlt).toHaveBeenCalledTimes(1);
  });

  it("修饰键全带的组合要一格不差：Ctrl+Shift+Alt+t 才算这一条", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", a, { ctrl: true, shift: true, alt: true })]));
    expect(press({ key: "t", ctrl: true, shift: true })).toBe(false);
    expect(press({ key: "t", ctrl: true, alt: true })).toBe(false);
    expect(press({ key: "t", shift: true, alt: true })).toBe(false);
    expect(a).not.toHaveBeenCalled();
    expect(press({ key: "t", ctrl: true, shift: true, alt: true })).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
  });
});

describe("命中即止与 when 放行", () => {
  it("同一个键两条绑定：只有第一条动作（命中即 return）", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", first), bind("t", second)]));
    press({ key: "t" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("第一条 when 为假要放行给第二条，不许就地终止", () => {
    const gated = vi.fn();
    const fallback = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts([bind("t", gated, { when: () => false }), bind("t", fallback)]),
    );
    expect(press({ key: "t" })).toBe(true);
    expect(gated).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("候选的 when 全为假：整次按键既不派发也不吞", () => {
    const a = vi.fn();
    const b = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts([bind("t", a, { when: () => false }), bind("t", b, { when: () => false })]),
    );
    expect(press({ key: "t" })).toBe(false);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("when 放行后又撞上下一条同键绑定：由那一条动作", () => {
    const gated = vi.fn();
    const next = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts([
        bind("ArrowRight", gated, { when: () => false }),
        bind("PageDown", next),
        bind("ArrowRight", next),
      ]),
    );
    expect(press({ key: "ArrowRight" })).toBe(true);
    expect(gated).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("不在表里的键一口都不吞：浏览器的默认行为照常", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", a)]));
    expect(press({ key: "y" })).toBe(false);
    expect(press({ key: "Tab" })).toBe(false);
    expect(press({ key: "F5" })).toBe(false);
    expect(a).not.toHaveBeenCalled();
  });

  it("命中时正好吞掉这一键：一次 keydown 只派发一次、只 preventDefault 一次", () => {
    const a = vi.fn();
    renderHook(() => useKeyboardShortcuts([bind("t", a), bind("t", a)]));
    const el = targetFor("div") as HTMLElement;
    const ev = new KeyboardEvent("keydown", { key: "t", bubbles: true, cancelable: true });
    let prevented = 0;
    const origin = ev.preventDefault.bind(ev);
    ev.preventDefault = () => {
      prevented += 1;
      origin();
    };
    el.dispatchEvent(ev);
    expect(prevented).toBe(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("产品里那两张真实绑定表的口径", () => {
  it("AppLayout 三条：t / Escape / Shift+? 各只对号入座的按键让路", () => {
    const theme = vi.fn();
    const close = vi.fn();
    const help = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts([
        bind("t", theme, { description: "切换主题" }),
        bind("Escape", close, { description: "关闭弹窗" }),
        bind("?", help, { shift: true, description: "显示快捷键帮助" }),
      ]),
    );
    expect(press({ key: "t" })).toBe(true);
    expect(press({ key: "Escape" })).toBe(true);
    expect(press({ key: "?", shift: true })).toBe(true);
    expect(theme).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(help).toHaveBeenCalledTimes(1);

    expect(press({ key: "t", ctrl: true, shift: true })).toBe(false);
    expect(press({ key: "T", shift: true })).toBe(false);
    expect(press({ key: "?" })).toBe(false);
    expect(theme).toHaveBeenCalledTimes(1);
    expect(help).toHaveBeenCalledTimes(1);
  });

  it("ChapterContent 的空格：字体面板开着、或焦点在按钮上就不翻页", () => {
    const goNext = vi.fn();
    let showFontPanel = false;
    renderHook(() =>
      useKeyboardShortcuts([
        {
          key: " ",
          action: goNext,
          description: "下一页",
          when: () => !showFontPanel && (document.activeElement?.tagName ?? "") !== "BUTTON",
        },
      ]),
    );

    const btn = targetFor("button") as HTMLButtonElement;
    btn.focus();
    expect(press({ key: " ", on: "button" })).toBe(false);
    expect(goNext).not.toHaveBeenCalled();

    btn.blur();
    expect(press({ key: " " })).toBe(true);
    expect(goNext).toHaveBeenCalledTimes(1);

    showFontPanel = true;
    expect(press({ key: " " })).toBe(false);
    expect(goNext).toHaveBeenCalledTimes(1);
  });

  it("翻页方向键：ArrowLeft 与 PageUp 各归各的 action，不许串", () => {
    const prev = vi.fn();
    const next = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts([
        bind("ArrowLeft", prev, { description: "上一页" }),
        bind("ArrowRight", next, { description: "下一页" }),
        bind("PageUp", prev, { description: "上一页" }),
        bind("PageDown", next, { description: "下一页" }),
      ]),
    );
    press({ key: "ArrowLeft" });
    press({ key: "PageUp" });
    press({ key: "ArrowRight" });
    press({ key: "PageDown" });
    expect(prev).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("字号 +/− 是两条不同绑定：按 + 不许顺手减字号", () => {
    const up = vi.fn();
    const down = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts([bind("+", up, { description: "增大字号" }), bind("-", down, { description: "减小字号" })]),
    );
    press({ key: "+" });
    expect(up).toHaveBeenCalledTimes(1);
    expect(down).not.toHaveBeenCalled();
    press({ key: "-" });
    expect(down).toHaveBeenCalledTimes(1);
    expect(up).toHaveBeenCalledTimes(1);
  });
});

/*
 * ── 变异台账 ──
 * 产品基线：src/hooks/useKeyboardShortcuts.ts 1136 字节，sha256 前缀 d929d915
 * 每轮：一次手改一处（带 MUT- 标记）→ 跑本文件 → 按字节基线还原 → 当场核 SHA。
 * 24 轮 = 22 刀 + 2 次对照（K0/K22，markers=0）。每刀一轮：markers=1、transform_failed=0、
 * markers_left=0、diff_lines=0、sha=d929d915；对照两轮：30 条全绿。
 * 跑法：bash %TEMP%\knife-ks.sh <刀号>；台账原文 %TEMP%\ledger-ks.txt
 *
 * 刀号                        红  这一刀摘掉了什么 / 谁红着指出来
 * K0 对照                      0  不动产品：30 条全绿
 * K1 删掉装监听               22  压根不 addEventListener —— 派发/引用稳定/两实例那一簇全红
 * K2 卸载不清理                6  cleanup 写成 () => {} —— 卸载后仍在收键；摘走的不是挂上的那个
 * K3 依赖写成 [bindings]       1  每次渲染重挂监听 —— 「换三张表仍只挂一次」红，且只它红
 * K4 读 bindings 不读 ref      2  陈旧闭包：rerender 换 action / 换表那两条红
 * K5 ref 同步依赖写空          2  表换了 ref 不换：同上两条红（与 K4 红同名，但刀标签不同＝归属不同格）
 * K6 让位名单少 input          2  搜索框里打 t 开始切主题
 * K7 让位名单少 textarea       1  笔记里打 i 开始切沉浸
 * K8 让位名单少 select         1  引擎下拉上开始抢键
 * K9 让位整行删掉              4  三种输入区一起红
 * K10 不比 Ctrl                3  Ctrl+t 开始派发；声明 ctrl 的裸按也开始派发
 * K11 不比 Shift               4  Shift+T / 裸 ? 开始派发，AppLayout 真表那条一起红
 * K12 不比 Alt                 2  Alt+t 开始派发，声明 alt 的漏判
 * K13 命中后不 return          2  一次按键派发多条；preventDefault 被叫两次
 * K14 when 为假改 return       2  不放行给下一条，"第一条让位第二条顶上"那两条红
 * K15 when 判断整条删掉        5  面板开着/焦点在按钮上照样翻页，连 when 都没被问过
 * K16 改成必须有 when         17  把"没写 when"当成"不让行"：绝大多数派发判据红
 * K17 命中不吞键              12  不 preventDefault：浏览器默认行为盖过来
 * K18 吞键挪到无条件          16  一进 handler 就吞：不匹配的键、输入框里的键全被吃掉
 * K19 键名忽略大小写           0  红＝0 —— 判据的洞：我把"大写 T"和"按着 Shift"混成一格了
 * K19b 同上（补 CapsLock 格）  1  补一条 key:"T" 且不带任何修饰键（CapsLock 真会这么打）之后红
 * K20 只扫表里第一条           6  when 放行没有下一棒了；方向键/字号那两张真表也红
 * K21 先动作后吞键             0  等价变异：preventDefault 只设标记，默认动作在派发结束之后，
 *                               顺序换了对浏览器没影响——不写判据假装判住了顺序
 * K22 复跑对照                 0  判据改动后（K19b 那条）重跑基线：30 条仍全绿
 *
 * 产品代码一行没动（每轮还原后 SHA 与基线一致）。
 */
