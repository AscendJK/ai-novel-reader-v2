/**
 * `useContinuousScroll` 的**落点纠正**这一档（既有两只测试都没碰的那半：
 * `useContinuousScroll.test.ts` 判的是 loadedChapters/坐标映射/pickChapterInZone，
 * `useContinuousScroll-edge-io.test.tsx` 判的是观察器接线与方向，都不碰 `scrollTop`）。
 *
 * 这只 hook 里同时跑着两套会写 `scrollTop` 的机制：
 *  - **A｜prepend 补偿**（`useContinuousScroll.ts:153-178`）：往上翻加载到一批新章节时，
 *    内容在视口上方变高，于是补一笔让"正在读的那一段"留在原处。
 *  - **B｜跳章逐帧纠正**（`:206-272`）：点目录跳章之后，章节盒带 `content-visibility:auto`
 *    先按 500px 估算记账、落到附近才塌成真实高度，浏览器自己的 scroll anchoring 又会反向拉——
 *    所以逐帧按「目标章离容器顶部差多少」纠正，先跟到静默窗（`SUPPRESS_RELEASE_MS`）结束。
 *
 * B 的收窗口径在 2026-09-25 改过一次，这文件的 B5/B6/B7 就是那一改的判据：
 * 原来**只看时间**——500ms 一到就撒手，可"上方章节塌成真实高度"这件事不保证在窗内落地
 * （e2e B24 整跑里红过的那一发：纠正确实写过、写的是窗内那一发，1.8 秒后落点仍差 203.7px）。
 * 现在窗外还留一只**布局哨兵**：盯「目标章在滚动内容里的 y」，它变了就往后续一个窗，
 * 但最多续到跳章起 `SETTLE_MAX_MS`——到顶就把 `scrollTop` 交还给读者。
 *
 * 两套各有理由，但它们**抢同一只 `scrollTop`**：A 那笔增量是在 `await loadChapters` **之前**
 * 量下的，而这一等可能几百毫秒（慢库/慢盘）。这期间用户点了目录、B 把视图带过去并在窗到期后
 * 收手，A 醒来按**旧落点**写回绝对值 → 落点被搬到别处，目录高亮与阅读进度一起记错。
 * **这一格没能在这里钉住（如实记着）**：jsdom 里只要 `addChapters` 落地，恢复锚定那条路
 * 会跟着跳一次章，于是 A 的写入紧接着被 B 覆盖——两条判据量到的都是"谁后写"，不是"补得对不对"。
 * 想判它得有真滚动台架（e2e 层：往上翻的同时点目录），B24 台架就是那一档。
 *
 * 还有一格**这次没判、也没改**（写在这里免得下批人以为它被顶管住了）：顶到期之后读者自己滚开了，
 * 此时上翻补载又落一笔补偿 → `rearm` 会把窗重开一轮、把视图**拽回刚点过的那一章**。这是 `8379cc5`
 * 就有的口径（补偿自己有残差，落点归纠正管），B8 只是在它上面加了一句"顶跟着重新起算"。要不要让
 * "读者的手"压过"补偿后的落点核对"，是一个**产品口径**问题（判据得先有口径才写得出来），已记账。
 *
 * jsdom 里 `scrollHeight` 恒 0、`getBoundingClientRect` 恒全零、`scrollIntoView`/`scrollTo`
 * 是空函数——三样真值一个都取不到，所以几何由本文件按一张「章顶坐标表」现搭：章顶 =
 * 它在已挂载序列里的序号 × 1000px（`grow` 旋钮：上方章节又长高的一截），文档高 = 章数 × 1000px
 * （`below` 旋钮：往视口下方补进来的一截），`scrollTop` 存本地变量。
 * rAF 也攥在手里（否则做不到"A 等待期间插一脚跳章"），时钟走假定时器 + `performance.now` 桩。
 *
 * 五刀逐条打过最后这一版实现（2026-09-25，每刀逐字替换 → 跑 → `cp` 字节还原 → 核 SHA256 回到
 * `6d70fc5b…`；红出来的条数与要证的格子一一对上）：
 * - 刀1 摘掉续窗（`contentY !== lastContentY` 那一段只留赋值）→ **B5 红**（1000 ≠ 1204，正是
 *   B24 的 204px）**且 B6 红**（1200 ≠ 1600，一路跟不住）。
 * - 刀2 把硬顶抬到十倍（`startedAt + SETTLE_MAX_MS` → `… * 10`）→ **只有 B6 红**（顶之后
 *   `writes` 1 ≠ 0）。B3 照样绿：没有布局位移时平窗到期就收手，那条不靠顶。
 * - 刀3 哨兵换成文档高（`lastContentY` 初值与每帧取值**一起**换成 `container.scrollHeight`）→
 *   **只有 B7 红**（下方补一章，`writes` 1 ≠ 0）。⚠ 只换每帧那一处（初值仍按内容里 y 取）会得到
 *   B3+B7 双红，量到的是"每帧都以为布局在动"——那是变异自己造的形状，不是设计判别器。
 * - 刀4 摘掉窗内闸（`if (now < until)` 换成恒真）→ **B3 红**（读者滚回 0 被拽回 1000）**且 B7 红**。
 * - 刀5 让顶不跟着补偿重新起算（`rearm` 里删掉 `startedAt = performance.now()`）→ **只有 B8 红**
 *   （3000 ≠ 3204）。这一刀就是整跑里 B24 又红那一发的形状：`交错1/纠正0/落点203.7`。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import { useEffect } from "react";
import { useContinuousScroll, SUPPRESS_RELEASE_MS, SETTLE_MAX_MS } from "../useContinuousScroll";
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
const topOf = (id: string) => {
  const i = Math.max(0, mountedNow().indexOf(id));
  return i * CHAPTER_H + (i > 0 ? grow : 0);
};
const docHeight = () => mountedNow().length * CHAPTER_H + grow + below;
/**
 * 「上方章节又长高了一截」的旋钮：真实形状是章节盒先按 `contain-intrinsic-size:0 500px`
 * 估算记账、落到附近才塌成真实高度——文档变高、目标章往下挪，而 `scrollTop` 一格没动。
 * 没有这只旋钮就演不出"位移落在窗之后"那一格（B5/B6），因为这里的一切几何都是现算的。
 */
let grow = 0;
/** 「往视口下方补了一章」的旋钮：只让文档变高，目标章在内容里的坐标一格不动（B7） */
let below = 0;

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
  // 旋钮必须归零：它们是模块级状态，上一只用例留下的 204 会串进下一只（B6 第一次红就
  // 是这么被顶成 1804 的——数字对不上原因，判据就成了假绿/假红的双色票）
  grow = 0;
  below = 0;
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

  it("B5 收窗之后布局又塌一次：晚到的那次位移也得收回来（B24 量到的 204px 就是这个）", async () => {
    // 整跑里红过一次的那一发：补偿落笔、纠正也确实写了一发（纠正1），可 1.8 秒后落点仍差
    // 203.7px——位移落在 500ms 定长窗**之后**，而收窗只看时间，于是没人再核。
    // 单跑与 3 并发压力都演不出来，所以这里拿"文档高度在窗外又变一次"把它钉成确定的形状。
    await mount([0, 1]);
    await act(async () => { apiRef.scrollToChapter("ch-1"); });
    await advance(SUPPRESS_RELEASE_MS + 10); // 窗到期
    await stepFrames(1);                     // 今天实现在这一帧就收手了
    grow = 204;                              // 上方章节把估算高度塌成真实高度：文档又长高、目标章往下挪
    await stepFrames(3);
    expect(scrollTopValue, "窗外的一次布局位移没被收回，落点留在旧位置").toBe(topOf("ch-1"));
  });

  it("B6 布局一直动也不能一直抢：到顶要交手", async () => {
    // 续窗必须有顶，否则"布局一直在动"（长书、慢盘、边读边塌高度）会变成无限期抢走读者的手。
    // 步数按 `SETTLE_MAX_MS` 推出来，不写死：抬了顶这条就跟着量到更长的窗，
    // 写死 12 步的话哪天顶改小了它仍在测一个不存在的时刻。
    await mount([0, 1]);
    await act(async () => { apiRef.scrollToChapter("ch-1"); });
    const jumpedAt = now; // 性能桩下 performance.now() 就是这个变量，跳章那一刻=实现的 startedAt
    const STEP = 120;
    while (now - jumpedAt + STEP < SETTLE_MAX_MS) {
      grow += 50; // 每 STEP 塌一次，一直不停
      await advance(STEP);
      await stepFrames(1);
    }
    expect(scrollTopValue, `硬顶(${SETTLE_MAX_MS}ms)之前它该一路跟着核落点`).toBe(topOf("ch-1"));
    const held = scrollTopValue;
    writes = 0;
    grow += 400; // 顶之后的位移：不许再伸手
    await advance(SETTLE_MAX_MS - (now - jumpedAt) + 10);
    await stepFrames(4);
    expect(writes, `过了 SETTLE_MAX_MS(${SETTLE_MAX_MS}ms) 还在写 scrollTop＝手感被永久抢走`).toBe(0);
    expect(scrollTopValue).toBe(held);
  });

  it("B7 哨兵只认「目标章上方动了」：往视口下方补载不许把窗续上", async () => {
    // 这条今天就是绿的，它钉的是**新代码的过度反应**：续窗的哨兵要是拿 `scrollHeight` 当
    // 依据，读到下方补进一批章节（文档变高、目标章一格没挪）就会把窗续上，把已经自己
    // 滚开的读者一把拽回刚点过的那一章——修一个洞开出另一个更响的洞。刀法：把 `contentY`
    // 换成 `container.scrollHeight` 记账，这一条必红。
    await mount([0, 1]);
    await act(async () => { apiRef.scrollToChapter("ch-1"); });
    await advance(SUPPRESS_RELEASE_MS + 10); // 平窗到期
    await stepFrames(1);
    scrollTopValue = 0;                      // 读者自己往上滚走了
    below = 1000;                            // 下方补进来一章：文档变高，目标章在内容里的坐标没动
    await stepFrames(3);
    expect(writes, "下方长高不算落点被顶，不许为此抢回 scrollTop").toBe(0);
    expect(scrollTopValue).toBe(0);
  });

  it("B8 顶过掉之后补偿又落一笔：那一发要能把纠正重新叫起来", async () => {
    // 2026-09-25 整跑里 B24 又红的那一发，读数写得很清楚：`交错1/纠正0/落点203.7`——补偿在跳章
    // 1.6 秒之后才落笔，`rearm` 把窗口往后推了一把，可循环第一件事就是"过顶了就交手"，于是那一推
    // 完全没落地，纠正一次都没写。**顶管的是"没人动手时它自己能占多久"，不是"这次跳章从此不管了"**：
    // 有人刚往文档上方插过一批章节，落点又成了悬案，所有权得重新起算。
    await mount([5, 6]); // 刻意不从第 0 章起：不然 `loadMore` 会因"前面没章了"提前返回，rearm 根本不叫
    await act(async () => { apiRef.scrollToChapter("ch-6"); });
    await advance(SETTLE_MAX_MS + 50); // 顶过掉
    const { resolve } = deferredLoad();
    await fireTopEdge();
    await act(async () => { resolve([mk(3), mk(4)]); await Promise.resolve(); });
    await stepFrames(3); // 补偿落笔（这一笔自己是准的）
    expect(scrollTopValue, "前提：补偿落笔之后落点还钉在目标章顶上").toBe(topOf("ch-6"));
    grow = 204; // 紧接着上方章节塌一次——B24 量到的就是这一发
    await stepFrames(3);
    expect(scrollTopValue, "过顶之后补偿又叫不起纠正，这 204px 没人收").toBe(topOf("ch-6"));
  });
});
