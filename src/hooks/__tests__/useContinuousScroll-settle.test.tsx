/**
 * `useContinuousScroll` 的**落点纠正**这一档（既有两只测试都没碰的那半：
 * `useContinuousScroll.test.ts` 判的是 loadedChapters/坐标映射/pickChapterInZone，
 * `useContinuousScroll-edge-io.test.tsx` 判的是观察器接线与方向，都不碰 `scrollTop`）。
 *
 * 这只 hook 里同时跑着两套会写 `scrollTop` 的机制：
 *  - **A｜prepend 补偿**（`useContinuousScroll.ts:137-152`）：往上翻加载到一批新章节时，
 *    内容在视口上方变高，于是补一笔让"正在读的那一段"留在原处。
 *  - **B｜跳章逐帧纠正**（`:175-204`）：点目录跳章之后，章节盒带 `content-visibility:auto`
 *    先按 500px 估算记账、落到附近才塌成真实高度，浏览器自己的 scroll anchoring 又会反向拉——
 *    所以逐帧按「目标章离容器顶部差多少」纠正，一路跟到静默窗（`SUPPRESS_RELEASE_MS`）结束。
 *
 * 两套各有理由，但它们**抢同一只 `scrollTop`**：A 那笔增量是在 `await loadChapters` **之前**
 * 量下的，而这一等可能几百毫秒（慢库/慢盘）。这期间用户点了目录、B 把视图带过去并在窗到期后
 * 收手，A 醒来按**旧落点**写回绝对值 → 落点被搬到别处，目录高亮与阅读进度一起记错。
 * **这一格没能在这里钉住（如实记着）**：jsdom 里只要 `addChapters` 落地，恢复锚定那条路
 * 会跟着跳一次章，于是 A 的写入紧接着被 B 覆盖——两条判据量到的都是"谁后写"，不是"补得对不对"。
 * 想判它得有真滚动台架（e2e 层：往上翻的同时点目录），这一档先留空。本文件因此只判 B 那一侧
 * 与 A 的解锁时机，**产品代码一行没动**。
 *
 * jsdom 里 `scrollHeight` 恒 0、`getBoundingClientRect` 恒全零、`scrollIntoView`/`scrollTo`
 * 是空函数——三样真值一个都取不到，所以几何由本文件按一张「章顶坐标表」现搭：章顶 =
 * 它在已挂载序列里的序号 × 1000px，文档高 = 章数 × 1000px，`scrollTop` 存本地变量。
 * rAF 也攥在手里（否则做不到"A 等待期间插一脚跳章"），时钟走假定时器 + `performance.now` 桩。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import { useEffect } from "react";
import { useContinuousScroll, SUPPRESS_RELEASE_MS } from "../useContinuousScroll";
import { loadChapters } from "@/db/repositories";
import { useNovelStore } from "@/stores/novel-store";

vi.mock("@/db/repositories", () => ({ loadChapters: vi.fn(async () => []) }));
const load = vi.mocked(loadChapters);

const CHAPTER_H = 1000;
const idOf = (i: number) => `ch-${i}`;
const idxOf = (id: string) => Number(id.slice(3));

interface Chapter { id: string; title: string; index: number; content: string }
const mk = (i: number): Chapter => ({ id: idOf(i), title: `第${i + 1}章`, index: i, content: `正文${i}` });


let apiRef!: ReturnType<typeof useContinuousScroll>;
let scrollTopValue = 0;
let now = 0;
/** 逐帧纠正每一轮写了几次 scrollTop：两轮并存时同一帧会写两次，用户看到的是来回拽 */
let writes = 0;

/** DOM 里的章节（带正文的才渲染出来，按 index 升序＝DOM 顺序）——派生，不在渲染期改模块变量 */
const mountedNow = () => ((useNovelStore.getState().currentNovel?.chapters ?? []) as unknown as Chapter[])
  .filter((c) => c.content).map((c) => c.id).sort((a, b) => idxOf(a) - idxOf(b));
const topOf = (id: string) => Math.max(0, mountedNow().indexOf(id)) * CHAPTER_H;
const docHeight = () => mountedNow().length * CHAPTER_H;

function Host() {
  const chapters = useNovelStore((s) => (s.currentNovel?.chapters ?? [])) as unknown as Chapter[];
  const local = useContinuousScroll({ novelId: "novel-1", chapters: chapters as never, onChapterChange: () => {}, enabled: true });
  useEffect(() => { apiRef = local; });
  // 三只 ref 解构出来再交出去：直接在 JSX 里写 `local.containerRef` 会被 react-hooks/refs 判成
  // "渲染期读 ref"（`useContinuousScroll-edge-io.test.tsx` 同款写法）
  const { containerRef, topSentinelRef, bottomSentinelRef } = local;
  return (
    <div data-testid="container" ref={containerRef}>
      <div ref={topSentinelRef} data-testid="top" />
      <div ref={bottomSentinelRef} data-testid="bottom" />
      {[...chapters].filter((c) => c.content).sort((a, b) => a.index - b.index).map((c) => (
        <div key={c.id} className="chapter-section" data-chapter-id={c.id} />
      ))}
    </div>
  );
}
const host = () => screen.getByTestId("container") as HTMLDivElement;

/** 容器几何：可读写，全部现算 */
function installGeometry() {
  const el = host();
  Object.defineProperty(el, "scrollTop", {
    configurable: true, get: () => scrollTopValue, set: (v: number) => { scrollTopValue = v; },
  });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => docHeight() });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 800 });
  el.scrollTo = ((arg?: ScrollToOptions | number | null) => {
    writes++;
    scrollTopValue = typeof arg === "number" ? arg : Number((arg as ScrollToOptions | null)?.top ?? 0);
  }) as typeof el.scrollTo;
}

/** 章节盒的 rect / scrollIntoView：按坐标表 + 当前 scrollTop 算 */
let restoreGeometry: (() => void) | null = null;
function installChapterGeometry() {
  const origRect = Element.prototype.getBoundingClientRect;
  const origInto = Element.prototype.scrollIntoView;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const id = this.getAttribute?.("data-chapter-id");
    if (!id) return origRect.call(this);
    const top = topOf(id) - scrollTopValue;
    return { top, bottom: top + CHAPTER_H, left: 0, right: 800, width: 800, height: CHAPTER_H, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
  Element.prototype.scrollIntoView = function (this: Element) {
    const id = this.getAttribute?.("data-chapter-id");
    if (id && mountedNow().includes(id)) scrollTopValue = topOf(id);
  };
  restoreGeometry = () => {
    Element.prototype.getBoundingClientRect = origRect;
    Element.prototype.scrollIntoView = origInto;
  };
}

/** 攥住 rAF */
let frames: FrameRequestCallback[] = [];
async function stepFrames(n: number) {
  for (let i = 0; i < n; i++) {
    const batch = frames; frames = [];
    await act(async () => { batch.forEach((cb) => cb(now)); });
  }
}
async function advance(ms: number) {
  now += ms;
  await act(async () => { vi.advanceTimersByTime(ms); });
}

/** 会真发回调的 IntersectionObserver（`setup.ts` 那只 observe 是空函数） */
class FakeIO {
  static built: FakeIO[] = [];
  cb: (entries: { isIntersecting: boolean; target: Element }[]) => void;
  seen: Element[] = [];
  constructor(cb: FakeIO["cb"]) { this.cb = cb; FakeIO.built.push(this); }
  observe(el: Element) { this.seen.push(el); }
  unobserve() {} disconnect() {} takeRecords(): never[] { return []; }
}

/** 撞「上边缘」——A 唯一的入口（`loadMore` 不在 hook 的返回值里） */
async function fireTopEdge() {
  const io = FakeIO.built[FakeIO.built.length - 1];
  await act(async () => { io.cb([{ isIntersecting: true, target: screen.getByTestId("top") }]); });
}

async function mount(initial: number[]) {
  useNovelStore.setState({
    currentNovel: { id: "novel-1", title: "测试书", chapters: initial.map(mk) } as never,
    selectedChapterId: null,
  });
  render(<Host />);
  installGeometry();
  installChapterGeometry();
  await advance(SUPPRESS_RELEASE_MS + 400); // 越过挂载期"恢复阅读位置"那段抑制窗，否则 A 的回调一进来就被丢掉
  load.mockClear();
}

/** 让 loadChapters 交出一只由测试决定何时落地的 promise */
function deferredLoad() {
  let resolve!: (v: Chapter[]) => void;
  const p = new Promise<Chapter[]>((r) => { resolve = r; });
  load.mockReturnValue(p as never);
  return { resolve };
}

beforeEach(() => {
  FakeIO.built = [];
  frames = [];
  scrollTopValue = 0;
  now = 0;
  writes = 0;
  vi.stubGlobal("IntersectionObserver", FakeIO);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  load.mockReset();
  load.mockResolvedValue([]);
});
afterEach(() => {
  restoreGeometry?.(); restoreGeometry = null;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("B｜跳章后的逐帧纠正", () => {
  it("B1 漂出死区才追：1px 的亚像素差不去动它（否则纠正停不下来）", async () => {
    await mount([0, 1]);
    await act(async () => { apiRef.scrollToChapter("ch-1"); });
    const atTop = topOf("ch-1");
    expect(scrollTopValue).toBe(atTop);
    scrollTopValue = atTop + 1;   // 亚像素
    await stepFrames(1);
    expect(scrollTopValue).toBe(atTop + 1); // 死区内：不追
    scrollTopValue = atTop + 40;  // 真漂了
    await stepFrames(1);
    expect(scrollTopValue).toBe(atTop);     // 追回来
  });

  it("B2 第二次跳章接管之后，前一轮的纠正循环要作废", async () => {
    await mount([0, 1, 2]);
    await act(async () => { apiRef.scrollToChapter("ch-1"); });
    await act(async () => { apiRef.scrollToChapter("ch-2"); });
    scrollTopValue = topOf("ch-1"); // 假装浏览器又把视图拽回第 2 章
    writes = 0;
    await stepFrames(1);
    expect(scrollTopValue).toBe(topOf("ch-2")); // 落点归后一轮
    // 判的是"同一帧只许有一只循环动手"：前一轮没作废的话它会朝自己的目标再写一发
    expect(writes, "两轮纠正循环并存＝同一帧往两个目标各拽一次，用户看到的是抖动").toBe(1);
  });

  it("B3 静默窗一过就收手：不许永久抢走用户的手感", async () => {
    await mount([0, 1]);
    await act(async () => { apiRef.scrollToChapter("ch-1"); });
    await advance(SUPPRESS_RELEASE_MS + 10);
    scrollTopValue = 0;             // 用户自己往上滚
    await stepFrames(2);
    expect(scrollTopValue).toBe(0); // 纠正已经停了，不会把他拽回去
  });

  it("A2 往上翻的补偿做完之前不许解锁：否则哨兵还在检测区，会一轮接一轮拉库", async () => {
    // 样本刻意不从第 0 章起（[5,6] 往前补 [3,4]）：若补到顶，`loadMore` 会因
    // "前面已经没有章了"提前返回，那条守卫会把"提前解锁"一起遮掉，这格就成了空判
    await mount([5, 6]);
    scrollTopValue = 1500;
    const { resolve } = deferredLoad();
    await fireTopEdge();
    await act(async () => { resolve([mk(3), mk(4)]); await Promise.resolve(); });
    await fireTopEdge();                       // 补偿还没跑（rAF 没推）
    expect(load).toHaveBeenCalledTimes(1);     // 此刻再撞边缘不该发出第二个请求
    await stepFrames(3);
    expect(apiRef.isLoadingMore).toBe(false);
  });

  it("B4 纠正的是「目标章离容器顶部」的差，不是文档坐标（后者对滚动天生不变）", async () => {
    await mount([0, 1]);
    await act(async () => { apiRef.scrollToChapter("ch-1"); });
    scrollTopValue = topOf("ch-1") + 60; // 漂走：目标章顶部离容器顶 60px
    await stepFrames(1);
    expect(scrollTopValue).toBe(topOf("ch-1"));
  });
});
