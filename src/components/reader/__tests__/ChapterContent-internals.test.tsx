import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ChapterContent } from "../ChapterContent";
import { useNovelStore } from "@/stores/novel-store";
import { useUIStore } from "@/stores/ui-store";
import { useTTSStore } from "@/stores/tts-store";
import { useRAGStore } from "@/stores/rag-store";
import { loadChapters } from "@/db/repositories";
import type { Novel } from "@/parsers/types";
import type { UseAutoReadOptions } from "@/hooks/useAutoRead";
import type { ShortcutBinding } from "@/hooks/useKeyboardShortcuts";

/**
 * `ChapterContent` 内部那几件事——浏览器档（`e2e/specs/b3-read-modes.spec.ts`）量不到的另一半。
 *
 * e2e 钉的是"看得见的翻页"：底栏标签、页码那一格、点三块屏幕各是什么。它量不到的是
 * 三样：**自动阅读的互斥**（开面板/展开右栏/换模式/TTS 开播都要停，而 hook 自己跨章不算），
 * **到底判定的前置条件**（分页没量出来时不许说"读完了"），**懒加载取窗口的参数**
 * （`max(0, i-10)` 起 21 章）。这些坏起来的形状是"自动阅读悄悄停不掉"或"下一章永远载不进来"，
 * 界面上第一眼都看不出来。
 *
 * 桩只放在三处接缝上：`useAutoRead`（把组件交出去的回调接住，由测试按时钟点它）、
 * `useKeyboardShortcuts`（同理，接住绑定表）、`AudioPlayer`（真实现要 Web Audio）。
 * 分页是真的：`getBoundingClientRect` 换成一套确定的假几何，让 `usePagination` 自己算页数。
 */

const cap = vi.hoisted(() => ({
  autoRead: null as UseAutoReadOptions | null,
  shortcuts: [] as ShortcutBinding[],
  wake: [] as { active: boolean; reason: string }[],
}));

/** 桩下来的"浏览器动了没有"：判的是组件请求动到哪，不是浏览器真动到哪 */
const scrolledIntoView: HTMLElement[] = [];
const scrollRequests: { el: HTMLElement; top: number | null }[] = [];

vi.mock("@/hooks/useAutoRead", () => ({
  useAutoRead: (opts: UseAutoReadOptions) => {
    cap.autoRead = opts;
  },
}));

vi.mock("@/hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: (bindings: ShortcutBinding[]) => {
    cap.shortcuts = bindings;
  },
}));

vi.mock("@/hooks/useScreenWakeLock", () => ({
  useScreenWakeLock: (active: boolean, reason: string) => {
    cap.wake.push({ active, reason });
  },
}));

vi.mock("@/components/tts/AudioPlayer", () => ({
  AudioPlayer: ({ chapterIndex }: { chapterIndex: number }) => (
    <div data-testid="audio-player">第 {chapterIndex} 章</div>
  ),
}));

vi.mock("@/db/repositories", () => ({
  loadChapters: vi.fn().mockResolvedValue([]),
}));

// ── 假几何：容器 600×500，每个 <p> 高 60、段间隔 4；滚动模式的章节盒各 2000 高 ──
// 分页真实依赖这两个数字：容器定 contentHeight，<p> 的 top 定切页位置；
// 章节盒的 top 定"章内偏移"（calcChapterOffset 判的就是它）。
const VIEW = { width: 600, height: 500 };
const PARA_HEIGHT = 60;
const PARA_STEP = 64;
const SECTION_STEP = 2000;

function rect(top: number, height: number, width: number): DOMRect {
  return {
    top, left: 0, right: width, bottom: top + height, x: 0, y: top, width, height,
    toJSON: () => ({}),
  } as DOMRect;
}

const realGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const realScrollIntoView = Element.prototype.scrollIntoView;
const realScrollBy = Element.prototype.scrollBy;
const realScrollTo = Element.prototype.scrollTo;

function fakeGetBoundingClientRect(this: Element): DOMRect {
  const el = this as HTMLElement;
  // 翻页容器：ChapterContent 里唯一写了 touch-action:none 的那块
  if (el.style?.touchAction === "none") return rect(0, VIEW.height, VIEW.width);
  if (el.classList?.contains("chapter-section")) {
    const sibs = Array.from(el.parentElement?.children ?? []);
    const idx = sibs.filter((s) => s.classList.contains("chapter-section")).indexOf(el);
    // 真实几何是**视口坐标**：滚得越深，章节盒的 top 越往负走。组件算"章内偏移"用的
    // 正是 `elRect.top - containerRect.top + scrollTop`，桩要是直接给文档坐标就重复加了一次
    const box = el.closest(".chapter-scroll-container");
    return rect(Math.max(0, idx) * SECTION_STEP - (box?.scrollTop ?? 0), SECTION_STEP, VIEW.width);
  }
  if (el.tagName === "P") {
    let idx = 0;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) idx++;
    return rect(idx * PARA_STEP, PARA_HEIGHT, VIEW.width - 48);
  }
  return rect(0, 0, 0);
}

/** 一章若干段：20 段按上面的几何切成 3 页（第 7、14 段各起新一页） */
function chapterOf(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, i) => `第${i + 1}段 渡口那条船在天亮前解开缆。`).join("\n\n");
}

function novelOf(chapterCount: number, withContent: boolean[]): Novel {
  const chapters = Array.from({ length: chapterCount }, (_, i) => ({
    id: `ch-${i + 1}`,
    title: `第${i + 1}章`,
    index: i,
    content: withContent[i] ? chapterOf(20) : "",
    novelId: "n1",
    startOffset: 0,
    endOffset: 0,
  }));
  return {
    id: "n1",
    title: "单元测试书",
    author: "作者",
    fileName: "unit.txt",
    fileFormat: "txt",
    totalChars: 1000,
    chapterCount,
    createdAt: 1,
    updatedAt: 1,
    chapters,
  } as unknown as Novel;
}

function mount(opts: {
  novel: Novel;
  chapterId: string;
  summaryOpen?: boolean;
}) {
  useNovelStore.setState({ currentNovel: opts.novel, selectedChapterId: opts.chapterId });
  return render(
    <ChapterContent
      summaryOpen={opts.summaryOpen ?? false}
      hasSummary={false}
      immersive={false}
      onToggleImmersive={() => {}}
    />,
  );
}

/** 推进到"容器尺寸量完 + 分页算完"（两个 effect 各排一次延时与帧） */
async function settle(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
}

const autoReadButton = () => screen.getByTitle("自动阅读（速度/间隔在字体面板中设置）");
const stopAutoReadButton = () => screen.getByTitle("停止自动阅读");
const fontPanelButton = () => screen.getByTitle("字体设置");
const pagingCanvas = () => document.querySelector<HTMLElement>('div[style*="touch-action"]')!;
const pageLabel = () => screen.getByText(/^\d+(-\d+)? \/ \d+$/);

/** 取组件交给 useAutoRead 的那份参数（每次渲染重记，拿到的就是当前这一次） */
const handed = () => {
  const opts = cap.autoRead;
  if (!opts) throw new Error("组件没把参数交给 useAutoRead");
  return opts;
};

const scrollBox = () => document.querySelector<HTMLElement>(".chapter-scroll-container")!;
const positions = () => useNovelStore.getState().readingPositions;

function seedPosition(novelId: string, pos: { chapterId: string; chapterIndex: number; scrollTop: number; chapterOffset: number }): void {
  useNovelStore.setState({ readingPositions: { ...positions(), [novelId]: pos } });
}

/** jsdom 里 `el.scrollTop = v` 写不进去（元素量不出可滚动尺寸，读回恒 0），所以钉在元素身上 */
function pinScrollTop(el: HTMLElement, value: number): void {
  Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value });
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function renameNovel(n: Novel, id: string): Novel {
  return { ...n, id, chapters: n.chapters.map((c) => ({ ...c, novelId: id })) } as Novel;
}

beforeEach(() => {
  Element.prototype.getBoundingClientRect = fakeGetBoundingClientRect;
  // jsdom 没实现这些：滚动模式一挂载就真会走到它们（恢复进度、跟随朗读）。
  // 只桩"浏览器会怎么动"，判的还是组件决定动到哪。
  scrolledIntoView.length = 0;
  scrollRequests.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledIntoView.push(this as HTMLElement);
  };
  Element.prototype.scrollTo = function (this: Element, arg?: ScrollToOptions | number | null) {
    const top = typeof arg === "object" && arg !== null ? (arg.top ?? null) : null;
    scrollRequests.push({ el: this as HTMLElement, top });
  } as typeof Element.prototype.scrollTo;
  Element.prototype.scrollBy = () => {};
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  // 默认那档假时钟不含 requestAnimationFrame（分页那圈是靠真实 16ms 混过去的），
  // 而"跳到朗读那一段所在的那一页"正是排在 rAF 上——不纳进来就推不动
  vi.useFakeTimers({
    toFake: [
      "setTimeout", "clearTimeout", "setInterval", "clearInterval",
      "setImmediate", "clearImmediate", "Date",
      "requestAnimationFrame", "cancelAnimationFrame", "performance",
    ],
  });
  useUIStore.setState({
    fontSize: 16, fontWeight: 400, lineHeight: 1.8, paragraphSpacing: 12,
    fontFamily: "serif", readingMode: "single", autoSwitchPageMode: false,
    autoReadEnabled: false, autoReadInterval: 5, autoReadSpeed: 2, offlineMode: false,
  });
  useRAGStore.setState({ indexLoadingKeys: new Set() });
  useTTSStore.setState({ playing: false, paused: false, generating: false, currentChapterIndex: -1, currentParagraph: -1 });
  cap.autoRead = null;
  cap.shortcuts = [];
  cap.wake = [];
  vi.mocked(loadChapters).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realGetBoundingClientRect;
  Element.prototype.scrollIntoView = realScrollIntoView;
  Element.prototype.scrollBy = realScrollBy;
  Element.prototype.scrollTo = realScrollTo;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("自动阅读的互斥：三停一不停", () => {
  it("打开字体面板 / 展开右栏 / 换阅读模式都算干扰，立刻停", async () => {
    const novel = novelOf(3, [true, true, true]);
    const { rerender } = mount({ novel, chapterId: "ch-1" });
    await settle();

    fireEvent.click(autoReadButton());
    expect(useUIStore.getState().autoReadEnabled).toBe(true);

    // ① 字体面板
    fireEvent.click(fontPanelButton());
    expect(useUIStore.getState().autoReadEnabled, "① 打开字体面板没让自动阅读停下来").toBe(false);
    expect(handed().enabled).toBe(false);

    // ② 右栏 AI 面板展开（prop 变化，不是组件自己的 state）
    useUIStore.getState().setAutoReadEnabled(true);
    rerender(
      <ChapterContent
        summaryOpen
        hasSummary={false}
        immersive={false}
        onToggleImmersive={() => {}}
      />,
    );
    expect(useUIStore.getState().autoReadEnabled, "② 展开右栏没让自动阅读停下来").toBe(false);

    // ③ 切换阅读模式
    useUIStore.getState().setAutoReadEnabled(true);
    useUIStore.getState().setReadingMode("scroll");
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(useUIStore.getState().autoReadEnabled, "③ 换阅读模式没让自动阅读停下来").toBe(false);
  });

  it("TTS 开播要停自动阅读：两个都在自动前进，不能同时跑", async () => {
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    fireEvent.click(autoReadButton());
    expect(useUIStore.getState().autoReadEnabled).toBe(true);

    useTTSStore.setState({ playing: true });
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(useUIStore.getState().autoReadEnabled).toBe(false);
  });

  it("hook 自己翻到下一章不算用户切章（不停），用户手动切章才算（停）", async () => {
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    fireEvent.click(autoReadButton());

    // 由 hook 的回调驱动翻页：底栏那两个按钮按设计本来就会停，所以不能拿它们点
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        handed().onNextPage();
        vi.advanceTimersByTime(50);
      });
    }
    expect(pageLabel().textContent).toBe("1 / 3"); // 已经落到第二章第一页
    expect(useNovelStore.getState().selectedChapterId).toBe("ch-2");
    expect(useUIStore.getState().autoReadEnabled, "自动跨章不该被误判成手动切章").toBe(true);

    // 用户自己跳章：这才是要停的那一种
    useNovelStore.getState().setSelectedChapter("ch-3");
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(useUIStore.getState().autoReadEnabled).toBe(false);
  });

  it("屏幕常亮跟着自动阅读的开关走，理由写着「自动阅读」", async () => {
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    expect(cap.wake.at(-1)).toEqual({ active: false, reason: "自动阅读" });

    fireEvent.click(autoReadButton());
    expect(cap.wake.at(-1)).toEqual({ active: true, reason: "自动阅读" });

    fireEvent.click(stopAutoReadButton());
    expect(cap.wake.at(-1)).toEqual({ active: false, reason: "自动阅读" });
  });

  it("滚动速度基准是「字号 × 行高倍数」，翻页模式才报 paginated", async () => {
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    expect(handed().lineHeightPx).toBe(16 * 1.8);
    expect(handed().paginated).toBe(true);

    useUIStore.getState().setFontSize(20);
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(handed().lineHeightPx).toBe(20 * 1.8);
  });
});

describe("到底判定", () => {
  it("分页还没量出来时不许说「已读到底」", async () => {
    mount({ novel: novelOf(1, [true]), chapterId: "ch-1" });
    // 不 settle：totalPages 仍是 0，safePage 恒为 0，此时少了前置条件就会误判到底
    expect(handed().isAtEnd()).toBe(false);

    await settle();
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        handed().onNextPage();
        vi.advanceTimersByTime(50);
      });
    }
    expect(pageLabel().textContent).toBe("3 / 3");
    expect(handed().isAtEnd()).toBe(true);
  });

  it("末章末页才算到底，中间章末页和末章首页都不算", async () => {
    mount({ novel: novelOf(2, [true, true]), chapterId: "ch-1" });
    await settle();
    expect(pageLabel().textContent).toBe("1 / 3");
    expect(handed().isAtEnd()).toBe(false);

    await toLastPage();
    expect(pageLabel().textContent).toBe("3 / 3");
    expect(handed().isAtEnd(), "本章翻到头，但后面还有章就不算读完").toBe(false);

    // 走底栏那枚跨章按钮（它会把页码归零，跟用户点到的东西是同一个）
    fireEvent.click(screen.getByRole("button", { name: "第2章" }));
    await settle();
    expect(pageLabel().textContent, "跨章要落回本章第一页").toBe("1 / 3");
    expect(handed().isAtEnd(), "末章第一页不算").toBe(false);
    await toLastPage();
    expect(pageLabel().textContent).toBe("3 / 3");
    expect(handed().isAtEnd()).toBe(true);
  });
});

describe("翻页手势", () => {
  it("滚轮：不到 30px 不算，300ms 内第二下不算，往回滚要回上一页", async () => {
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    const canvas = pagingCanvas();

    fireEvent.wheel(canvas, { deltaY: 10 });
    expect(pageLabel().textContent, "轻划一下不该翻页").toBe("1 / 3");

    fireEvent.wheel(canvas, { deltaY: 120 });
    expect(pageLabel().textContent).toBe("2 / 3");

    fireEvent.wheel(canvas, { deltaY: 120 });
    expect(pageLabel().textContent, "300ms 内的连击要吞掉").toBe("2 / 3");

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.wheel(canvas, { deltaY: -120 });
    expect(pageLabel().textContent).toBe("1 / 3");
  });

  it("空格翻页：字体面板开着、或焦点落在按钮上时让开", async () => {
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    if (!cap.shortcuts.some((b) => b.key === " " && b.when)) throw new Error("空格绑定没带前置条件");
    // 必须每次现取：面板一开绑定表就换了一份新的（真监听器每次渲染重读 ref），
    // 抓住旧那份来判，判的就不是当前界面状态了
    const space = () => cap.shortcuts.find((b) => b.key === " ")!;

    expect(space().when!()).toBe(true);
    await act(async () => {
      space().action();
      vi.advanceTimersByTime(50);
    });
    expect(pageLabel().textContent).toBe("2 / 3");

    fireEvent.click(fontPanelButton());
    expect(space().when!(), "字体面板开着时空格该让给面板里的输入").toBe(false);
    fireEvent.click(fontPanelButton());
    expect(space().when!(), "关回面板又要能翻").toBe(true);

    screen.getByRole("button", { name: "上一页" }).focus();
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(space().when!(), "焦点在按钮上时空格该归按钮").toBe(false);
  });

  it("横向滑动才算翻页，斜着滑不算", async () => {
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    const canvas = pagingCanvas();

    const swipe = async (fromX: number, fromY: number, toX: number, toY: number) => {
      fireEvent.touchStart(canvas, { touches: [{ clientX: fromX, clientY: fromY }] });
      fireEvent.touchEnd(canvas, { changedTouches: [{ clientX: toX, clientY: toY }] });
      await act(async () => {
        vi.advanceTimersByTime(50);
      });
    };

    await swipe(300, 200, 230, 210); // 横 70 / 纵 10 → 翻页
    expect(pageLabel().textContent).toBe("2 / 3");

    await swipe(300, 200, 240, 140); // 横 60 / 纵 60 → 斜着走，不算
    expect(pageLabel().textContent, "斜着滑不该翻页").toBe("2 / 3");

    await swipe(100, 200, 200, 200); // 往右横滑 100 → 上一页
    expect(pageLabel().textContent).toBe("1 / 3");

    await swipe(300, 200, 270, 200); // 只挪 30px，够不上一次滑动
    expect(pageLabel().textContent, "太短的滑动不该翻页").toBe("1 / 3");
  });
});

/** 从本章第一页翻到末页：末页那枚按钮才写着下一章的标题 */
async function toLastPage(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await act(async () => {
      handed().onNextPage();
      vi.advanceTimersByTime(50);
    });
  }
}

describe("章节装载", () => {
  it("目标章没正文时按「往前 10 章、共 21 章」取窗口，取到才切过去", async () => {
    const loaded = Array.from({ length: 15 }, () => true);
    const novel = novelOf(16, [...loaded, false]);
    mount({ novel, chapterId: "ch-15" });
    await settle();
    await toLastPage();
    expect(pageLabel().textContent).toBe("3 / 3");

    const before = vi.mocked(loadChapters).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "第16章" }));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    // 目标 index=15 → start=max(0,15-10)=5，一次取 21 章
    expect(vi.mocked(loadChapters).mock.calls.slice(before).map((c) => c.slice(0, 3))).toEqual([
      ["n1", 5, 21],
    ]);
    expect(useNovelStore.getState().selectedChapterId).toBe("ch-16");
  });

  it("目标章已有正文就不查库", async () => {
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    await toLastPage();
    fireEvent.click(screen.getByRole("button", { name: "第2章" }));
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(vi.mocked(loadChapters)).not.toHaveBeenCalled();
    expect(useNovelStore.getState().selectedChapterId).toBe("ch-2");
  });
});

describe("阅读进度落盘", () => {
  it("头一发当场落，之后每 3 秒最多一次，攒下的那一次要补上", async () => {
    useUIStore.getState().setReadingMode("scroll");
    seedPosition("n1", { chapterId: "ch-1", chapterIndex: 0, scrollTop: 0, chapterOffset: 0 });
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    const box = scrollBox();

    pinScrollTop(box, 500);
    fireEvent.scroll(box);
    expect(positions().n1.scrollTop, "第一次滚动要当场落盘").toBe(500);

    pinScrollTop(box, 2500);
    fireEvent.scroll(box);
    expect(positions().n1.scrollTop, "3 秒内的滚动不该每次都写盘").toBe(500);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(positions().n1.scrollTop).toBe(2500);
    expect(positions().n1.chapterOffset, "章内偏移 = scrollTop − 章节盒顶部：第二章盒从 2000 起").toBe(500);
  });

  it("切到后台那一下当场落盘，不等剩下的 3 秒", async () => {
    useUIStore.getState().setReadingMode("scroll");
    seedPosition("n1", { chapterId: "ch-1", chapterIndex: 0, scrollTop: 0, chapterOffset: 0 });
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    const box = scrollBox();

    pinScrollTop(box, 1200);
    fireEvent.scroll(box);
    pinScrollTop(box, 1800);
    fireEvent.scroll(box);
    expect(positions().n1.scrollTop).toBe(1200);

    setVisibility("hidden");
    expect(positions().n1.scrollTop, "切后台时必须把攒下的那一次写掉").toBe(1800);
  });

  it("回到前台：请求回到那一章那一格，不是回到顶", async () => {
    useUIStore.getState().setReadingMode("scroll");
    seedPosition("n1", { chapterId: "ch-2", chapterIndex: 1, scrollTop: 4000, chapterOffset: 200 });
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-2" });
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(700); // 让开机那趟恢复的静默窗走完，下面才只量"回前台"这一发
    });
    scrollRequests.length = 0;
    pinScrollTop(scrollBox(), 0);

    setVisibility("visible");
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(scrollRequests.length, "回前台要重发一次回位请求").toBeGreaterThan(0);
    // 第二章盒顶在 2000、章内偏移 200 → 该请求落到 1800
    expect(scrollRequests[0].top).toBe(1800);
  });

  it("切书：上一本用「上次量自它」的那份收尾；攒着没落的那一发不许写到新书头上", async () => {
    const a = novelOf(3, [true, true, true]);
    const b = renameNovel(a, "n2");
    useUIStore.getState().setReadingMode("scroll");
    seedPosition("n1", { chapterId: "ch-1", chapterIndex: 0, scrollTop: 0, chapterOffset: 0 });
    seedPosition("n2", { chapterId: "ch-1", chapterIndex: 0, scrollTop: 4000, chapterOffset: 3000 });
    mount({ novel: a, chapterId: "ch-1" });
    await settle();
    const box = scrollBox();

    pinScrollTop(box, 2500);
    fireEvent.scroll(box);
    expect(positions().n1.scrollTop).toBe(2500);
    pinScrollTop(box, 2800);
    fireEvent.scroll(box); // 3 秒内 → 攒着
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(positions().n1.scrollTop).toBe(2500);

    // 换书：这一刻容器已经是新书的 DOM，位置归零
    pinScrollTop(box, 0);
    useNovelStore.setState({ currentNovel: b, selectedChapterId: "ch-1" });
    await act(async () => {}); // 先把切书那次提交冲干净（含"取消攒下的保存"），再推时钟
    expect(positions().n1.scrollTop, "收尾要交回上一次量自旧书的那份，不许现场重新量").toBe(2500);

    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(positions().n1.scrollTop).toBe(2500);
    expect(positions().n2.scrollTop, "攒着的那一发不能落到刚换上的新书头上").toBe(4000);
  });
});

describe("朗读跟随", () => {
  it("翻页模式：跟到哪一段就翻到那一段所在的那一页", async () => {
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    expect(pageLabel().textContent).toBe("1 / 3");

    // 两步走：setState 之后要先让 React 把 effect 跑完，再推时钟——跟随那一发是排在
    // requestAnimationFrame 上的，同一个 act 里先推时钟就永远推不到它
    await act(async () => {
      useTTSStore.setState({ playing: true, currentChapterIndex: 0, currentParagraph: 3 });
    });
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(pageLabel().textContent, "第 4 段就在本页，不许乱跳").toBe("1 / 3");
    expect(
      document.querySelector("p.bg-primary\\/10")?.getAttribute("data-tts-paragraph"),
      "要跟的那一段得被标出来",
    ).toBe("3");

    await act(async () => {
      useTTSStore.setState({ currentParagraph: 15 });
    });
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(pageLabel().textContent, "第 16 段落在本章第 3 页").toBe("3 / 3");
  });

  it("滚动模式：scrollIntoView 落在被读的那一段自己身上", async () => {
    useUIStore.getState().setReadingMode("scroll");
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-2" });
    await settle();
    scrolledIntoView.length = 0;

    useTTSStore.setState({ playing: true, currentChapterIndex: 1, currentParagraph: 2 });
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    const el = scrolledIntoView.at(-1);
    expect(el?.getAttribute("data-tts-paragraph"), "要跟的是朗读的那一段").toBe("2");
    expect(el?.closest(".chapter-section")?.getAttribute("data-chapter-id"), "只能在本章里找那一段").toBe("ch-2");
  });
});

describe("播放栏", () => {
  it("翻页与滚动模式之间来回切，播放器不卸载", async () => {
    mount({ novel: novelOf(3, [true, true, true]), chapterId: "ch-1" });
    await settle();
    const first = screen.getByTestId("audio-player");
    expect(first.textContent).toBe("第 0 章");

    useUIStore.getState().setReadingMode("scroll");
    await settle();
    expect(screen.getByTestId("audio-player"), "切到滚动模式不该把播放器拆掉重建").toBe(first);

    useUIStore.getState().setReadingMode("double");
    await settle();
    expect(screen.getByTestId("audio-player")).toBe(first);
  });
});
