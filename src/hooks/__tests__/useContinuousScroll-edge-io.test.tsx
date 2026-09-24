/**
 * 连续滚动「边缘加载」这一档判据（反查 `src/test/setup.ts` 的桩查出来的空档）
 *
 * `useContinuousScroll.ts:486-502` 用 IntersectionObserver 监听两只哨兵，进视口就往前/往后
 * 各加载一批章节。此前**两层都没有判点**：
 *   - 一档：`src/test/setup.ts:74-94` 把 IntersectionObserver 桩成"存下回调、observe 是空函数、
 *     回调永远不会被叫"，而既有的 `useContinuousScroll.test.ts` 只判了两只哨兵 ref 初始为 null；
 *     全项目测试文件里没有一个提到 IntersectionObserver。
 *   - 浏览器层：e2e 没有一条用例做纵向滚动去撞那个边缘。
 * 所以这一批判据自带一只**会真发回调**的假 IO，装在 globalThis 上顶掉那只桩。
 *
 * 判的六格各有真实故障：root 用错（按窗口而不是滚动容器算边缘，长书里要么永不触发要么一直触发）、
 * 两只哨兵对调（往上翻却去加载后面的章）、`isIntersecting=false` 也当触发（一进视口外就疯狂拉库）、
 * 恢复进度/目录点击的抑制期不生效（`suppressIO` 那半段）、关掉连续滚动还去建观察器。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import { useContinuousScroll } from "../useContinuousScroll";
import { loadChapters } from "@/db/repositories";

vi.mock("@/db/repositories", () => ({
  loadChapters: vi.fn(async () => []),
}));

const load = vi.mocked(loadChapters);

type Entry = { isIntersecting: boolean; target: Element };
type IOCallback = (entries: Entry[]) => void;

let built: FakeIO[] = [];

/** 与 setup.ts 那只的区别：这一只把回调交回给测试，observe 真记元素 */
class FakeIO {
  cb: IOCallback;
  opts?: IntersectionObserverInit;
  seen: Element[] = [];
  disconnected = false;

  constructor(cb: IOCallback, opts?: IntersectionObserverInit) {
    this.cb = cb;
    this.opts = opts;
    built.push(this);
  }
  observe(el: Element) {
    this.seen.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

interface Chapter {
  id: string;
  title: string;
  index: number;
  content: string;
}

// 8 章，只有第 3-5 章（index 2..4）带着正文：于是"已加载窗口"卡在中间，
// 往前的起点必然 < 2、往后的起点必然 > 4，两个方向判得出方向。
const CHAPS: Chapter[] = Array.from({ length: 8 }, (_, i) => ({
  id: `ch-${i}`,
  title: `第${i + 1}章`,
  index: i,
  content: i >= 2 && i <= 4 ? `正文${i}` : "",
}));

let api: ReturnType<typeof useContinuousScroll>;

/**
 * 真把三只 ref 接到 DOM 上：`loadMore` 与那只观察器都要求 `containerRef.current` 非空，
 * 而观察器是在挂载那趟 effect 里建的——所以 ref 必须在 effect 跑之前就位，
 * 事后往 `renderHook` 的 ref 里塞元素已经晚了。
 */
function Host({ enabled = true }: { enabled?: boolean }) {
  const local = useContinuousScroll({
    novelId: "novel-1",
    chapters: CHAPS,
    onChapterChange: () => {},
    enabled,
  });
  useEffect(() => {
    api = local;
  });
  const { containerRef, topSentinelRef, bottomSentinelRef } = local;
  return (
    <div ref={containerRef} data-testid="container">
      <div ref={topSentinelRef} data-testid="top" />
      <div ref={bottomSentinelRef} data-testid="bottom" />
    </div>
  );
}

function observer(): FakeIO {
  expect(built, "边缘加载靠一只 IntersectionObserver，它得真被建出来").toHaveLength(1);
  return built[0];
}

/**
 * 越过挂载后那段"恢复阅读位置"的抑制窗（`useContinuousScroll.ts:315-330`，100ms + 500ms）。
 * 不越过它，`suppressChapterDetectionRef` 还是 true，边缘加载的回调一进来就被丢掉——
 * 那样下面每一条都会以"什么都没发生"的形状绿着，全是空判。
 */
async function mount(enabled = true): Promise<void> {
  render(<Host enabled={enabled} />);
  await act(async () => {
    vi.advanceTimersByTime(700);
  });
  // 越过抑制窗的那一路自己会检测/取章一次，清掉它：每条判据只数自己那一脚发出去的请求
  load.mockClear();
}

async function fire(which: "top" | "bottom", isIntersecting = true): Promise<void> {
  const target = screen.getByTestId(which);
  await act(async () => {
    observer().cb([{ isIntersecting, target }]);
  });
}

beforeEach(() => {
  built = [];
  load.mockClear();
  load.mockResolvedValue([]);
  vi.stubGlobal("IntersectionObserver", FakeIO);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("边缘加载的观察器接线", () => {
  it("root 是那只滚动容器，两只哨兵都挂上观察（root 用错＝按窗口算边缘，长书里永不触发或一直触发）", () => {
    render(<Host />);
    const obs = observer();
    expect(obs.opts?.root, "root 缺省就是视口，连续滚动的容器不是视口").toBe(screen.getByTestId("container"));
    expect(obs.seen).toEqual([screen.getByTestId("top"), screen.getByTestId("bottom")]);
  });

  it("关掉连续滚动时一只观察器都不建", async () => {
    await mount(false);
    expect(built).toHaveLength(0);
  });
});

describe("两只哨兵各自的方向", () => {
  it("底部哨兵进视口：从已加载最后一章的下一章开始往后取", async () => {
    await mount();
    await fire("bottom");
    expect(load).toHaveBeenCalledTimes(1);
    const [, startIndex] = load.mock.calls[0];
    expect(startIndex, "往后加载的起点必须在已加载窗口之后").toBeGreaterThan(4);
  });

  it("顶部哨兵进视口：从已加载第一章之前开始往前取（对调的话往上翻会去加载后面的章）", async () => {
    await mount();
    await fire("top");
    expect(load).toHaveBeenCalledTimes(1);
    const [, startIndex] = load.mock.calls[0];
    expect(startIndex, "往前取的起点必须落在已加载窗口之前").toBeLessThan(2);
  });

  it("离开视口不算触发：一进一出就拉库的话，长书会连着把整本读进内存", async () => {
    await mount();
    await fire("bottom", false);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("抑制期", () => {
  it("suppressIO 期间进视口不许加载；释放之后同样的触发要真去加载", async () => {
    await mount();
    let release: () => void = () => {};
    act(() => {
      release = api.suppressIO();
    });
    await fire("bottom");
    expect(load, "目录点击/进度恢复中间被插一刀加载，章节列表会在恢复途中变形").not.toHaveBeenCalled();
    act(() => {
      release();
    });
    await fire("bottom");
    expect(load, "释放之后还忽略的话，边缘加载就永久失效了").toHaveBeenCalledTimes(1);
  });
});
