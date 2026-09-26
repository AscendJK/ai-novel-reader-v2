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
 * 还有一格**2026-09-26 改掉了口径**（原来是"顶到期之后读者自己滚开了，补偿再落一笔仍会把他拽回
 * 刚点过的那一章"，`8379cc5` 起就这样）：制作人拍的口径是**只在硬顶到期之后让步**——交还之后读者
 * 自己动手滚过（滚轮／触屏／翻页键），这一跳就不再要落点，此后补偿落笔也不许再 `rearm`。
 * 判据是 B9（让位）、B10（光一只 scroll 事件不算输入——anchoring 也发这个）、B11（时刻必须在交还
 * 之后，窗内动过手不算）、B12（在输入框里敲空格不算）、B13（滚轮落在容器之外不算）。
 *
 * 这一格**两层都判**，因为这里先绿过一次而产品其实是坏的：监听最初挂在阅读容器上，jsdom 的 B9
 * 三条当场全绿——那里是我自己往容器 dispatch 的，接没接上监听量不出差别。真凶只有浏览器层的
 * B26（`e2e/specs/b-import.spec.ts`）量得到：读数 `滚轮后纠正 9 发`，读者确实被拽了回去。
 * 改成挂 window 捕获 + 按包含关系过滤之后两层才都绿。所以浏览器层两只各管一头：**B24 五轮**里没有
 * 任何人输入，管"没让过头"（落点仍须 ≤2px）；**B26** 真输入，管"该让位时真让了"。
 *
 * jsdom 里 `scrollHeight` 恒 0、`getBoundingClientRect` 恒全零、`scrollIntoView`/`scrollTo`
 * 是空函数——三样真值一个都取不到，所以几何由本文件按一张「章顶坐标表」现搭：章顶 =
 * 它在已挂载序列里的序号 × 1000px（`grow` 旋钮：上方章节又长高的一截），文档高 = 章数 × 1000px
 * （`below` 旋钮：往视口下方补进来的一截），`scrollTop` 存本地变量。
 * rAF 也攥在手里（否则做不到"A 等待期间插一脚跳章"），时钟走假定时器 + `performance.now` 桩。
 *
 * ## 变异台账：14 刀全部打在基线 `664cab9c…`（33363 字节 / 16 条全绿）上
 *
 * 2026-09-26 一次性重跑：刀1–刀5 是 09-25 那五刀，当时打在 `6d70fc5b…` 上；这一版加了"让位"之后
 * 有**两刀的读数变了**（刀2、刀5，下面标出来），其余三条一模一样。逐字替换 → 跑 → `cp` 字节还原 →
 * 核 `restored_sha` 回到基线；每轮 `markers_left=0 transform_failed=0 skipped=0`。红了哪几条按本文件的号。
 *
 * - **刀1** 摘掉续窗（`contentY !== lastContentY` 那一段只留赋值）→ **2 红：B5**（1000 ≠ 1204，
 *   正是 B24 那 204px）**+ B6**（1200 ≠ 1600，一路跟不住）。
 * - **刀2** 把硬顶抬到十倍（`startedAt + SETTLE_MAX_MS` → `… * 10`）→ **4 红：B6 + B9 三条**。
 *   ⚠ 读数变了（09-25 是"只有 B6 红"）：顶既然不到期，`handedBackAt` 就永远不落下，让位那条
 *   判据根本没有可让的时机，循环一路纠正到静默窗外——B9 三条被拽回目标章。**这一把顺带证出了
 *   两格是一根绳上的**：顶不只管"最多占多久"，它还管"什么时候开始算读者的意见作数"。
 * - **刀3** 哨兵换成文档高（`lastContentY` 的**初值与每帧取值一起**换成 `container.scrollHeight`）
 *   → **只有 B7 红**（下方补一章，`writes` 1 ≠ 0）。⚠ 这一把两处同动，`markers=2` 是它的形状，
 *   不是两刀同盘。只换每帧那一处（初值仍按内容里 y 取）会得到 B3+B7 双红，量到的是"每帧都以为
 *   布局在动"——那是变异自己造的形状，不是设计判别器。
 * - **刀4** 摘掉窗内闸（`if (now < until)` 换成恒真）→ **2 红：B3**（读者滚回 0 被拽回 1000）**+ B7**。
 * - **刀5** 让顶不跟着补偿重新起算（`rearm` 里删掉 `startedAt = performance.now()`）
 *   → **5 红：B8 + B10 + B11 + B12 + B13**。⚠ 读数变了（09-25 是"只有 B8 红"，那时后四条还没生出来）。
 *   **B9 三条反而全绿**——它们只判"让位之后不许有写入"，而这一刀让循环压根起不来，不写当然不拽。
 *   这就是"让位"不能单独判的原因：一头绿得越彻底，越可能只是另一头坏了。B8/B10–B13 是那另一头。
 * - **T1** 摘掉整条让位判据（当作没写过那一行）→ **3 红：B9 三条**。
 * - **T8** 只摘掉"记下交还时刻"那一行（gate 留着，但它永远等不到那一刻）→ **同样 3 红：B9 三条**。
 *   T1/T8 咬同一组用例不是重复：这一格两半缺一不可，少一半也照样错。
 * - **T2** 让位不看时刻（`userScrollAt > 0` 就 return）→ **只有 B11 红**（窗内动过一次手之后，
 *   补偿留下的 204px 就没人收了）。
 * - **T3** 把 `scroll` 事件也算读者的手 → **只有 B10 红**。
 * - **T4/T5/T6** 分别摘掉滚轮／触屏／翻页键那一路监听 → **各只红对应的 B9 一条**：三条不重复，
 *   少接哪一路产品就在哪种设备上被拽回去。
 * - **T7** 摘掉"可编辑目标"守卫 → **只有 B12 红**。
 * - **T9** 去掉"命中点在不在阅读容器里"那层过滤 → **只有 B13 红**。
 *
 * **没打到的**：`>=` 与 `>` 那一毫秒的边界（B9 里特意隔了 60ms，所以两种写法都绿——同一毫秒分不出
 * 先后，那一刻宁可不抢，不值得为它造一条假判据）；`enabled` 关掉时监听该不该撤（撤了＝分页模式下
 * 这条不再工作，而产品里分页模式根本没有这只容器）。
 *
 * **这里判不到、只能靠浏览器层的一条**：监听"挂在容器上"在 jsdom 里照样 16 条全绿（B9 三条是这里
 * 自己往容器 dispatch 的，接没接上监听量不出差别），而产品里 `ChapterContent.tsx:591` 在没有当前章时
 * 提前 return，容器那只 div 首帧根本不存在。这一格只有 B26 第一跑量得到（`滚轮后纠正 9 发`）。
 * 它是这一批里唯一一处"jsdom 全绿而产品是坏的"。
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

  /**
   * 交班现场的公共部分：跳章 → 顶到期（`scrollTop` 交还）→ **交还之后**发一发 `send()` →
   * 上翻补载落一笔补偿（它自己会叫 `rearm`）→ 上方章节再塌 204px（B8 里正是要收掉的那一发）。
   * 读数走模块级的 `writes` / `scrollTopValue`，目标章章顶按返回值的 `target` 比。
   */
  async function afterHandover(send: () => void): Promise<{ target: number }> {
    await mount([5, 6]); // 刻意不从第 0 章起：不然 `loadMore` 会因"前面没章了"提前返回，rearm 根本不叫
    await act(async () => { apiRef.scrollToChapter("ch-6"); });
    await advance(SETTLE_MAX_MS + 50); // 顶过掉
    await stepFrames(1);               // 这一帧发现到过顶：所有权交还（`handedBackAt` 落下）
    await advance(60);                 // 读者是在交还**之后**才动的手，不是同一毫秒
    scrollTopValue = 500;              // 视图挪到别处（离第 7 章章顶 2700px）
    await act(async () => { send(); });
    const { resolve } = deferredLoad();
    await fireTopEdge();
    await act(async () => { resolve([mk(3), mk(4)]); await Promise.resolve(); });
    await stepFrames(3); // 补偿落笔
    writes = 0;
    grow = 204;
    await stepFrames(4);
    return { target: topOf("ch-6") };
  }

  // `8379cc5` 起的老口径：顶到期之后读者自己滚开了，此时上翻补载再落一笔补偿，`rearm` 会把窗
  // 重开一轮、按"目标章离容器顶差多少"把视图**拽回他刚才点过的那一章**。2026-09-26 制作人改成
  // **只在硬顶到期之后让步**（窗内照旧跟到落点，那是 B1/B4/B11 的形状）。
  // "读者的手"三种输入各判一条：摘掉任一只监听，只有对应那一条会红——它们不是同一条路的三个名字
  //（滚轮在桌面、触屏在手机、翻页键在键盘，产品里三者都可能真的把正文滚走）。
  const READERS_HAND: Array<[string, () => void]> = [
    ["滚轮", () => host().dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true }))],
    ["触屏划", () => host().dispatchEvent(new Event("touchmove", { bubbles: true }))],
    ["翻页键", () => host().dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }))],
  ];
  for (const [name, send] of READERS_HAND) {
    it(`B9 顶过掉之后读者用${name}自己动手滚过：此后补偿再落笔也不许把窗叫回来`, async () => {
      const { target } = await afterHandover(send);
      expect(writes, "读者的手接过之后，这一跳的落点核对不许再写 scrollTop").toBe(0);
      expect(scrollTopValue, "视图被拽回了刚点过的那一章").not.toBe(target);
    });
  }

  it("B10 只有 scroll 事件不算读者的手（anchoring 也发这个）", async () => {
    // 这一条钉的是 B9 那个判据**过头**的形状：要是拿"顶到期之后又发过一次 scroll"当读者的手，
    // 那 scroll anchoring／别的程序化写入会把纠正永久缴械，B8 那一格（补偿后 204px 要收回）
    // 就没人管了。同一只场景，只把输入事件换成一只光秃秃的 scroll——落点核对还得照常接手。
    const { target } = await afterHandover(() => {
      host().dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(writes, "没有人的输入就不算交班，补偿之后落点核对还得继续").toBeGreaterThan(0);
    expect(scrollTopValue).toBe(target);
  });

  it("B12 在输入框里敲空格不算读者的手（正文一格没动）", async () => {
    // `keydown` 听在 window 上，搜索框/笔记框收到的空格一样会冒泡过来。没有那只"可编辑目标"
    // 守卫，用户在补载前后打个字就把落点核对缴械了——症状还是"页面自己飞回刚点过的那一章"。
    const { target } = await afterHandover(() => {
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      input.remove();
    });
    expect(writes, "敲字不是滚正文，落点核对不许因此交班").toBeGreaterThan(0);
    expect(scrollTopValue).toBe(target);
  });

  it("B11 只在顶到期之后让步：窗内动过手、交还之后再没动手，补偿仍要能接手", async () => {
    // 这一条钉的是 B9 那个判据**放宽**的形状：要是写成"读者这一轮动过手就不管了"（不看时刻），
    // B8/B9/B10/B12 全是绿的——而产品会在读者只是跳章后随手滚了一下、之后一直停在目标章时，
    // 把补偿留下的 204px 整头发空。制作人定的口径是**只在交还之后**才让位。
    await mount([5, 6]);
    await act(async () => { apiRef.scrollToChapter("ch-6"); });
    await advance(SUPPRESS_RELEASE_MS - 100); // 还在静默窗内
    scrollTopValue = 500;
    await act(async () => {
      host().dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true }));
    });
    await stepFrames(2); // 窗内：照旧拽回来（B1/B4 的口径）
    expect(scrollTopValue, "窗内读者的手不让位，这一跳就是意图").toBe(topOf("ch-6"));
    await advance(SETTLE_MAX_MS + 200); // 顶到期，所有权交还；此后不再动手
    await stepFrames(1);
    writes = 0;
    const { resolve } = deferredLoad();
    await fireTopEdge();
    await act(async () => { resolve([mk(3), mk(4)]); await Promise.resolve(); });
    await stepFrames(3);
    grow = 204;
    await stepFrames(4);
    expect(writes, "交还之后没再动手，补偿落笔仍要把落点接手").toBeGreaterThan(0);
    expect(scrollTopValue).toBe(topOf("ch-6"));
  });

  it("B13 滚轮落在阅读容器之外不算读者的手（监听挂 window，靠包含关系过滤）", async () => {
    // 监听为什么挂 window 而不是挂容器：`ChapterContent.tsx:591` 在没有当前章时提前 return，
    // 容器那只 div 首帧根本不存在，而这只 effect 的依赖只有 `[enabled]`——挂容器就一次都接不上。
    // 是 B26 第一次跑量出来的（读数 `滚轮后纠正 9 发`，读者确实被拽了回去），而这一档当时全绿：
    // 那里是我自己往容器上 dispatch 的。挂到 window 之后，"谁的滚轮"就变成一格要判的：
    // 在侧栏目录里滚滚轮，不该把正文的落点核对缴械。
    const { target } = await afterHandover(() => {
      document.body.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true }));
    });
    expect(writes, "正文之外的滚轮不算读者接过了这一跳").toBeGreaterThan(0);
    expect(scrollTopValue).toBe(target);
  });
});
