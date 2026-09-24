/**
 * `src/components/tts/AudioPlayer.tsx`：播放栏自己那几格决定。
 *
 * 为什么要单独钉：这只 382 行的文件 2026-06 以来被改 22 笔，而**每个碰到它的测试都把它桩掉**
 * （`ChapterContent-internals.test.tsx:56` 一句 `vi.mock("@/components/tts/AudioPlayer")` 换成
 * 只印 chapterIndex 的空壳，理由是"真实现要 Web Audio"），三个 `useAudioPlayer-*` 测的是 hook
 * 不是栏；浏览器层只有 F5/F10 碰到"朗读出错"、F8 碰到"缓冲"。于是"改坏了会不会有东西红"
 * 这一问从来没被答过。这里把 `useAudioPlayer` 换成记参数的桩（hook 那一层有自己的判据文件），
 * `useTTSStore` 用真的——段数、倍速、预生成进度都由它持有。
 *
 * 刻意不重复浏览器层：F6 判"停止后栏收掉"、F5 判"服务器那句原因上屏"。这里判的是
 * 那两下按钮点不出来的算术与条件。
 *
 * 读到、没判也没改的一条现状：倒数到零那一发只 `clearInterval` + `stop()`，
 * **档位 `sleepTimer` 仍留在 15**（界面这格显示"0m"）。于是用户再按一次播放，
 * `sleepTimer > 0 && isPlaying` 会重新成立 → 又倒一整轮 15 分钟，而他这一轮并没有重新设过。
 * 这一条要改得先问制作人（"用完自动清档" vs "定时一直有效"是产品口径），所以只写在这里，不做成判据。
 *
 * 两处夹具形状要说清（都不是产品缺陷）：
 *  - `h.*` 的值在**渲染那一刻**才被读，所以改完桩状态必须真重渲染一次才算数；重渲染用同一次
 *    挂载的 `re()`，**不能靠 unmount+remount**——新挂载自己就会把 `elapsed` 归零，那样
 *    "收摊归零"那条永远空判（同一族坑记在测试口径里）。
 *  - `requestAnimationFrame` 在 jsdom 里不是假时钟的一部分，三处收尾（秒表归零、剩余时间初值、
 *    取消后清零）都挂在它上面 → 必须手动冲（`flushRaf`），不冲的话那些判据全都以"什么都没发生"
 *    的形状绿着。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

const { h, raf } = vi.hoisted(() => ({
  h: {
    play: vi.fn(),
    togglePause: vi.fn(),
    stop: vi.fn(),
    seekToParagraph: vi.fn(),
    skipPrepare: vi.fn(),
    isActive: false,
    isPaused: false,
    isPlaying: false,
    error: null as string | null,
    retryCount: 0,
    orderedParaIndices: [] as number[],
  },
  raf: { cbs: new Map<number, () => void>(), seq: 0 },
}));

vi.mock("@/hooks/useAudioPlayer", () => ({
  useAudioPlayer: () => ({
    play: h.play,
    togglePause: h.togglePause,
    stop: h.stop,
    isActive: h.isActive,
    isPaused: h.isPaused,
    isPlaying: h.isPlaying,
    error: h.error,
    retryCount: h.retryCount,
    seekToParagraph: h.seekToParagraph,
    skipPrepare: h.skipPrepare,
    orderedParaIndices: h.orderedParaIndices,
  }),
}));

import { AudioPlayer } from "../AudioPlayer";
import { useTTSStore, type TTSState } from "@/stores/tts-store";

/** `useTTSStore.setState` 的入参是全量 `TTSState`，运行时按 partial 合并，所以摆一格要过这只包装 */
type Patch = Partial<TTSState>;
const setStore = (p: Patch): void => { useTTSStore.setState(p as TTSState); };

const DEFAULTS: Patch = {
  generating: false,
  generateProgress: 0,
  prepareReady: 0,
  prepareTotal: 0,
  bufferedChunks: 0,
  engine: "webspeech",
  currentParagraph: 0,
  totalParagraphs: 0,
  playbackRate: 1.0,
  speed: 1.0,
  startRequested: 0,
};

/** 挂在组件树上的那把固定栏 */
const bar = (r: RenderResult) => r.container.querySelector<HTMLElement>('[class*="fixed bottom-0"]');
const text = (r: RenderResult) => r.container.textContent || "";
const byTitle = (r: RenderResult, t: string) => r.container.querySelector<HTMLElement>(`[title="${t}"]`);
const buttonNamed = (r: RenderResult, label: string) =>
  [...r.container.querySelectorAll("button")].find((b) => b.textContent === label) || null;

interface Mounted extends RenderResult {
  /** 用**同一份 props** 再渲染一次：让桩里改过的值真进到组件（新挂载会把组件内部 state 清零） */
  re: () => void;
}

function mount(store?: Patch, props?: Partial<{ content: string | null; title: string; noNav: boolean }>): Mounted {
  setStore(DEFAULTS);
  if (store) setStore(store);
  const el = (
    <AudioPlayer
      novelId="n1"
      chapterContent={props?.content === undefined ? "正文正文正文" : props.content}
      chapterIndex={3}
      chapterTitle={props?.title ?? "第三章"}
      onPrevChapter={props?.noNav ? undefined : () => undefined}
      onNextChapter={props?.noNav ? undefined : () => undefined}
    />
  );
  const r = render(el);
  return Object.assign(r, {
    re: () => {
      const again = (
        <AudioPlayer
          novelId="n1"
          chapterContent={props?.content === undefined ? "正文正文正文" : props.content}
          chapterIndex={3}
          chapterTitle={props?.title ?? "第三章"}
          onPrevChapter={props?.noNav ? undefined : () => undefined}
          onNextChapter={props?.noNav ? undefined : () => undefined}
        />
      );
      r.rerender(again as ReactElement);
    },
  });
}

/** 冲掉挂在 rAF 上的那三处收尾 */
function flushRaf(): void {
  act(() => {
    const all = [...raf.cbs.values()];
    raf.cbs.clear();
    all.forEach((f) => f());
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  raf.cbs.clear();
  raf.seq = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++raf.seq;
    raf.cbs.set(id, () => cb(0));
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { raf.cbs.delete(id); });
  Object.assign(h, {
    isActive: false, isPaused: false, isPlaying: false, error: null, retryCount: 0, orderedParaIndices: [],
  });
  h.play.mockClear();
  h.togglePause.mockClear();
  h.stop.mockClear();
  h.seekToParagraph.mockClear();
  h.skipPrepare.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("栏子什么时候露面", () => {
  it("什么都没开始：整条栏不渲染，连顶正文的占位那格都不许留", () => {
    const r = mount();
    expect(bar(r)).toBeNull();
    // 占位那格若排到 `return null` 之前，读完之后正文底部会永久空一截
    expect(r.container.querySelector("[aria-hidden]")).toBeNull();
    expect(r.container.innerHTML).toBe("");
  });

  it("四把钥匙各自都能开门：活动／暂停／正在生成／出错", () => {
    const open = (label: string, only: () => void) => {
      // 每轮先把桩清干净：四把钥匙要"只有它成立"，上一把留着不放，后面三条就都是空判
      Object.assign(h, { isActive: false, isPaused: false, isPlaying: false, error: null });
      const r = mount();
      only();
      r.re();
      expect(bar(r), label).not.toBeNull();
      r.unmount();
    };
    open("朗读活动中", () => { h.isActive = true; });
    open("暂停中", () => { h.isPaused = true; });
    open("正在生成", () => { setStore({ generating: true }); });
    open("出错", () => { h.error = "服务器拒了这次合成"; });
  });

  it("上一章／下一章没给回调时按钮还在，但要按不动（不许点了没反应还看着能点）", () => {
    h.isActive = true;
    const r = mount(undefined, { noNav: true });
    expect(byTitle(r, "上一章")).toBeDisabled();
    expect(byTitle(r, "下一章")).toBeDisabled();
    r.unmount();
  });
});

describe("顶栏「朗读」那颗按钮的触发", () => {
  it("startRequested 涨一格播一次；数字没涨时换别的 props 重渲染也不许多播", () => {
    // 计数器在挂载时就取当前值做起点（`prevStartRef = useRef(startRequested)`），
    // 所以这一格只能测"挂载之后涨的那一发"——直接挂着 1 进来是不播的。
    const r = mount({ startRequested: 0 } as Patch);
    expect(h.play).not.toHaveBeenCalled();

    setStore({ startRequested: 1 } as Patch);
    r.re();
    expect(h.play).toHaveBeenCalledTimes(1);

    r.re();
    r.re();
    expect(h.play, "计数没涨就不许再播").toHaveBeenCalledTimes(1);

    setStore({ startRequested: 2 } as Patch);
    r.re();
    expect(h.play, "涨一格就得再来一发").toHaveBeenCalledTimes(2);
    r.unmount();
  });

  it("正文空着时不许抢播，而且不能把这次请求吃掉——能播了要补上", () => {
    const r = mount({ startRequested: 0 } as Patch, { content: "" });
    setStore({ startRequested: 5 } as Patch);
    r.re();
    expect(h.play, "一个字都没有，不该播").not.toHaveBeenCalled();

    r.re();
    expect(h.play, "请求不能只判一次就丢掉").not.toHaveBeenCalled();

    r.rerender(
      <AudioPlayer novelId="n1" chapterContent="有字了" chapterIndex={3} chapterTitle="第三章" />,
    );
    expect(h.play, "能播了就得补上，否则用户在顶栏点的那下永远没反应").toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("播过一次之后，「正在生成」结束那一下不许自己再补播", () => {
    // 这一格才是 `startRequested > prevStartRef.current` 那道比较真正在挡的东西：
    // `canPlay` 是 effect 的依赖，生成结束会让 effect 重跑一次，只有比过上一格才知道请求已经消费掉了。
    const r = mount({ startRequested: 0 } as Patch);
    setStore({ startRequested: 1 });
    r.re();
    expect(h.play).toHaveBeenCalledTimes(1);

    setStore({ generating: true });
    r.re();
    setStore({ generating: false });
    r.re();
    expect(h.play, "生成结束不等于用户又按了一次「朗读」").toHaveBeenCalledTimes(1);
    r.unmount();
  });
});

describe("进度坐标：段数与百分比按「过滤后序号」", () => {
  const withBar = (store: Patch, paraIndices: number[]): Mounted => {
    h.isActive = true;
    h.isPlaying = true;
    h.orderedParaIndices = paraIndices;
    return mount(store);
  };

  it("显示的是过滤表里第几位，不是原始段落号", () => {
    // 过滤后只剩三段：原始索引 0／3／7，正在播第 3 段。
    // 样本特意取中段那一档：拿最后一档量，"直接用原始索引"也会被钳成同样的 3/3 与 100%，判不出差异。
    const r = withBar({ currentParagraph: 3, totalParagraphs: 3 }, [0, 3, 7]);
    expect(text(r)).toContain("2/3 段");
    expect(text(r)).toContain("(67%)");
    r.unmount();
  });

  it("当前段落被过滤掉了：退到最近的前一段，不许显示 0/3", () => {
    const r = withBar({ currentParagraph: 5, totalParagraphs: 3 }, [0, 3, 7]);
    expect(text(r)).toContain("2/3 段");
    r.unmount();
  });

  it("前面一段都不在表里：落到第一段，不许显示 0/3", () => {
    const r = withBar({ currentParagraph: 1, totalParagraphs: 3 }, [3, 7]);
    expect(text(r)).toContain("1/3 段");
    r.unmount();
  });

  it("索引越界不许算成 2/1 段、200%：段数与百分比两边都得钳住", () => {
    const r = withBar({ currentParagraph: 1, totalParagraphs: 1 }, [0, 1]);
    expect(text(r)).not.toContain("2/1");
    expect(text(r)).toContain("1/1 段");
    expect(text(r)).toContain("(100%)");
    expect(text(r)).not.toContain("(200%)");
    r.unmount();
  });

  it("点进度条：点击位置先换算成过滤后序号，再换回**原始**段落号交出去", () => {
    // 注：源码里那句 `Math.min(orderedParaIndices.length - 1, …)` 判不到——ratio 先被
    // `Math.max(0, Math.min(1, …))` 钳过，取整后不可能越界。摘掉它 26 条一条不红，
    // 那是防御性死支（同 `AudioPlayer` 之外的 `count === 0` 那一族），不为了红去造假断言。
    const r = withBar({ currentParagraph: 3, totalParagraphs: 3 }, [0, 3, 7]);
    const track = byTitle(r, "点击跳转到指定段落")!;
    // jsdom 的 getBoundingClientRect 恒为 0 宽，桩成 100px 才量得到中间那一格
    track.getBoundingClientRect = () =>
      ({ width: 100, left: 0, top: 0, height: 4, right: 100, bottom: 4, x: 0, y: 0, toJSON() {} }) as DOMRect;

    fireEvent.click(track, { clientX: 100 });
    expect(h.seekToParagraph).toHaveBeenLastCalledWith(7);
    fireEvent.click(track, { clientX: 0 });
    expect(h.seekToParagraph).toHaveBeenLastCalledWith(0);
    fireEvent.click(track, { clientX: 50 });
    expect(h.seekToParagraph, "中间那一格要交的是原始索引 3，不是过滤后序号 1").toHaveBeenLastCalledWith(3);
    r.unmount();
  });

  it("还没有任何可播段落（totalParagraphs=0）：这条进度 bar 不出现", () => {
    const r = withBar({ currentParagraph: 0, totalParagraphs: 0 }, []);
    expect(byTitle(r, "点击跳转到指定段落")).toBeNull();
    r.unmount();
  });
});

describe("计时与定时关闭", () => {
  /** 进度行只在有段数时出现，秒表的读数挂在那一行里 */
  const playing = (store?: Patch): Mounted => {
    h.isActive = true;
    h.isPlaying = true;
    return mount({ totalParagraphs: 1, ...store } as Patch);
  };

  it("只有真在播才一秒一秒走，暂停就冻住", () => {
    const r = playing();
    act(() => { vi.advanceTimersByTime(65_000); });
    expect(text(r)).toContain("1:05");

    h.isPlaying = false;
    h.isPaused = true;
    r.re();
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(text(r), "暂停期间秒表不许偷走").toContain("1:05");
    expect(text(r)).not.toContain("1:25");
    r.unmount();
  });

  it("收摊那一拍把秒表归零：同一趟朗读里不许下次接着 0:30 走", () => {
    const r = playing();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(text(r)).toContain("0:30");

    h.isActive = false;
    h.isPlaying = false;
    r.re();
    flushRaf();
    h.isActive = true;
    h.isPlaying = true;
    r.re();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(text(r), "得从 0:01 起，不是 0:31").toContain("0:01");
    expect(text(r)).not.toContain("0:31");
    r.unmount();
  });

  it("选 15 分钟：按钮上写明剩多久，图标从「关」翻成「定」", () => {
    const r = playing();
    fireEvent.click(byTitle(r, "定时关闭")!);
    fireEvent.click(r.container.querySelector('[class*="grid-cols-2"]')!.children[0]);
    flushRaf();
    expect(byTitle(r, "剩余 15 分钟")).not.toBeNull();
    expect(text(r)).toContain("15m");
    r.unmount();
  });

  it("倒数按分钟跳（60 秒一跳），跳到零那一发真的停下播放，之后不再倒第二次", () => {
    const r = playing();
    fireEvent.click(byTitle(r, "定时关闭")!);
    fireEvent.click(r.container.querySelector('[class*="grid-cols-2"]')!.children[0]);
    flushRaf();

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(byTitle(r, "剩余 14 分钟"), "60 秒该跳一分钟").not.toBeNull();

    act(() => { vi.advanceTimersByTime(14 * 60_000); });
    flushRaf();
    expect(h.stop, "倒数到零必须停").toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    expect(h.stop, "那一发之后 interval 得清掉，不许每过一分钟停一次").toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("暂停的时候不许倒数：人不在听，定时器不该把他催眠", () => {
    h.isActive = true;
    h.isPlaying = true;
    const r = playing();
    fireEvent.click(byTitle(r, "定时关闭")!);
    fireEvent.click(r.container.querySelector('[class*="grid-cols-2"]')!.children[0]);
    flushRaf();

    h.isPlaying = false;
    h.isPaused = true;
    r.re();
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(h.stop, "暂停期间到点也不算数").not.toHaveBeenCalled();
    expect(byTitle(r, "剩余 15 分钟"), "暂停时剩余数字不许偷偷减").not.toBeNull();
    r.unmount();
  });

  it("取消定时：档位归零 —— 图标回到「关」、按钮上不再挂分钟数，之后到点也不许停", () => {
    // 这条判的是 `setSleepTimer(0)` 那一半（两处显示都排在 `sleepTimer > 0` 那道闸后面）。
    // 刻意不判同一分支里那句 `setSleepRemaining(0)`：把取消后的剩余数字改成"不清"，
    // 26 条一条不红——取消之后没有任何一处会读它，那是条没有可观察后果的分支（M16 实测）。
    const r = playing();
    fireEvent.click(byTitle(r, "定时关闭")!);
    fireEvent.click(r.container.querySelector('[class*="grid-cols-2"]')!.children[0]);
    flushRaf();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(text(r)).toContain("14m");

    fireEvent.click(byTitle(r, "剩余 14 分钟")!);
    fireEvent.click(buttonNamed(r, "取消定时")!);
    flushRaf();
    expect(text(r)).not.toContain("14m");
    expect(byTitle(r, "定时关闭")).not.toBeNull();

    act(() => { vi.advanceTimersByTime(20 * 60_000); });
    expect(h.stop, "取消完了还被人按下暂停键，是最难查的那种").not.toHaveBeenCalled();
    r.unmount();
  });

  it("四档定时的文案走的是同一只换算表：60 分钟得写成「1小时」", () => {
    const r = playing();
    fireEvent.click(byTitle(r, "定时关闭")!);
    const labels = [...r.container.querySelectorAll('[class*="grid-cols-2"] button')].map((b) => b.textContent);
    expect(labels).toEqual(["15分钟", "30分钟", "1小时", "1小时30分钟"]);
    r.unmount();
  });
});

describe("预生成那一行", () => {
  const prep = (store: Patch): Mounted => {
    h.isActive = true;
    return mount({ generating: true, prepareTotal: 8, prepareReady: 0, ...store } as Patch);
  };

  it("浏览器自己推理那档报「正在生成第 N 段」，服务端只报已完成数", () => {
    const rZip = prep({ engine: "zipvoice" });
    expect(text(rZip)).toContain("正在预生成 1/8 段");
    rZip.unmount();

    const rServer = prep({ engine: "server" });
    expect(text(rServer)).toContain("正在预生成 0/8 段");
    expect(text(rServer)).not.toContain("1/8 段");
    rServer.unmount();
  });

  it("一段都没就绪时不给「立即播放」，就绪一段才给，点了真的跳过", () => {
    const r0 = prep({ engine: "server", prepareReady: 0 });
    expect(buttonNamed(r0, "立即播放")).toBeNull();
    expect(text(r0)).not.toContain("浏览器推理较慢");
    r0.unmount();

    const r1 = prep({ engine: "server", prepareReady: 1 });
    const go = buttonNamed(r1, "立即播放");
    expect(go, "就绪一段就该让用户能立刻开始").not.toBeNull();
    fireEvent.click(go!);
    expect(h.skipPrepare).toHaveBeenCalledTimes(1);
    r1.unmount();
  });

  it("顶上那条 1px：预生成阶段按段数算，跑满或没有段数时退回总进度那格", () => {
    const widthOf = (r: RenderResult) =>
      r.container.querySelector<HTMLElement>('[class*="h-1 bg-muted"] > div')!.style.width;

    const rPart = prep({ engine: "server", prepareReady: 2, prepareTotal: 8, generateProgress: 90 });
    expect(widthOf(rPart)).toBe("25%");
    rPart.unmount();

    const rFull = prep({ engine: "server", prepareReady: 8, prepareTotal: 8, generateProgress: 90 });
    expect(widthOf(rFull)).toBe("90%");
    rFull.unmount();

    const rNoTotal = prep({ engine: "server", prepareTotal: 0, generateProgress: 45 });
    expect(widthOf(rNoTotal)).toBe("45%");
    rNoTotal.unmount();
  });
});

describe("播放倍速", () => {
  beforeEach(() => { h.isActive = true; });

  it("按钮上那三个数必须同源：设置页语速 × 倍速 = 实际听感", () => {
    // 样本特意选 1.25 × 1.75 = 2.19：乘积与两个因子都不一样，串位才判得出来
    const r = mount({ speed: 1.25, playbackRate: 1.75 } as Patch);
    expect(byTitle(r, "播放倍速 1.75x（设置页语速 1.25x × 1.75x = 实际听感 2.19x）")).not.toBeNull();
    expect(text(r)).toContain("1.75x");
    r.unmount();
  });

  it("面板里只有当前那一枚是选中态；选完写回 store 并把面板关掉", () => {
    const r = mount({ playbackRate: 1.75 } as Patch);
    fireEvent.click(byTitle(r, "播放倍速 1.75x（设置页语速 1.00x × 1.75x = 实际听感 1.75x）")!);
    const grid = r.container.querySelector('[class*="grid-cols-4"]')!;
    const chosen = [...grid.children].filter((b) => (b as HTMLElement).className.includes("bg-primary"));
    expect(chosen.map((b) => b.textContent), "选中态只许有一枚").toEqual(["1.75x"]);

    fireEvent.click([...grid.children].find((b) => b.textContent === "2.5x")!);
    expect(useTTSStore.getState().playbackRate).toBe(2.5);
    expect(text(r), "选完得关面板，否则遮罩还压着屏幕").not.toContain("仅影响本次播放");
    r.unmount();
  });
});

describe("缓冲水位与出错原因", () => {
  it("只有会自己攒缓冲的引擎才报水位；一段都没攒上时不许出现", () => {
    h.isActive = true;
    const rWeb = mount({ engine: "webspeech", bufferedChunks: 3, totalParagraphs: 1 } as Patch);
    expect(text(rWeb)).not.toContain("缓冲");
    rWeb.unmount();

    const rServer = mount({ engine: "server", bufferedChunks: 3, totalParagraphs: 1 } as Patch);
    expect(text(rServer)).toContain("⏩ 缓冲 3 段");
    rServer.unmount();

    const rZero = mount({ engine: "server", bufferedChunks: 0, totalParagraphs: 1 } as Patch);
    expect(text(rZero)).not.toContain("缓冲");
    rZero.unmount();
  });

  it("出错那行：重试过要把次数写出来，整句原文挂在 title 上", () => {
    h.error = "服务器没装 sherpa-onnx，请 pip install";
    const r0 = mount();
    expect(text(r0)).toContain("朗读出错：服务器没装 sherpa-onnx，请 pip install");
    expect(text(r0)).not.toContain("已重试");
    expect(byTitle(r0, "服务器没装 sherpa-onnx，请 pip install")).not.toBeNull();
    r0.unmount();

    h.error = "服务器没装 sherpa-onnx，请 pip install";
    h.retryCount = 2;
    const r2 = mount();
    expect(text(r2)).toContain("朗读出错（已重试2次）：");
    r2.unmount();
  });
});
