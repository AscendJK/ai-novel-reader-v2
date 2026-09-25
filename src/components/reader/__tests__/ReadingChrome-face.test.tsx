/**
 * 地板第 1 档：`ReadingChrome.tsx` 这层外观首次被直接判。
 *
 * 为什么单独钉：这只文件是从 `ChapterContent.tsx` 抽出来的外观层（顶栏 / 底栏 / 正文段落），
 * 阅读器每一屏都挂在它上面，可**没有任何测试文件直接指着它**——`ChapterContent-internals.test.tsx`
 * 那批判的是 ChapterContent 自己的行为（顺带把它渲染出来了事），e2e 只有走位时的间接经过。
 * 于是它自己替调用点做的那些决定全在裸奔：朗读按钮什么时候该藏、快捷调速那枚在什么组合下才出现、
 * 切章在飞时底栏锁不锁、正文段落号怎么跟 TTS 的段号对齐、字体面板怎么个收口法。
 *
 * 口径：**只判这只文件自己做的决定**。store 用真的（`playing/paused/generating`、
 * `autoReadEnabled/readingMode/autoReadSpeed` 必须真翻才判得出接线），`ReadingToolbar` 换成
 * "记下收到的 props"的桩（它自己另有判据），lucide 桩成 `<svg data-icon=名字>`。
 *
 * 三处刻意不判，理由写在各自的位置：
 * ① 底栏中间那行页码的覆盖层不吃点击（`:288` 的 `pointer-events-none`）——jsdom 不做命中测试，
 *    摘掉照样绿，判点在 e2e 的窄屏那一档；
 * ② `AutoReadButton` 浮层容器上那句 `onClick={(e) => e.stopPropagation()}`（`:92`）——本批跑过这一刀：
 *    把它换成"什么都不做"，29 条仍全绿。关掉浮层走的是 `document` 上的 `mousedown`，而
 *    `wrapRef.contains(t)` 已经把浮层内部放过，这句 `click` 阶段的阻止没有下游读者（记成死代码，不当判据也不改产品）；
 * ③ 三处 `React.memo` 省下的渲染次数（屏上输出一样，没有可观察后果；比较器**判得起的那两半**——
 *    "高亮挪走要清掉"与"换正文必须重渲染"——各有一条）。
 */
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useUIStore } from "@/stores/ui-store";
import { useTTSStore } from "@/stores/tts-store";
import { BottomNav, ChapterParagraphs, TopBar } from "@/components/reader/ReadingChrome";
import type { BottomNavProps, TopBarProps } from "@/components/reader/ReadingChrome";

type IconProps = { className?: string };
type ToolbarProps = Record<string, unknown>;

const m = vi.hoisted(() => ({ toolbar: [] as ToolbarProps[] })) as unknown as { toolbar: ToolbarProps[] };

/** 字体面板那格只记"挂了几次、收到哪些 props"；它自己的行为另有判据 */
vi.mock("../ReadingToolbar", () => ({
  ReadingToolbar: (props: ToolbarProps) => {
    useEffect(() => {
      m.toolbar.push(props);
      // 桩只记挂载那一次：面板每次重渲染都会给一支新 props，带 deps 就会重复计数
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="font-toolbar" />;
  },
}));

vi.mock("lucide-react", () => {
  const icon = (name: string) => (p: IconProps) => <svg data-icon={name} className={p.className} />;
  return {
    Sparkles: icon("Sparkles"),
    ChevronLeft: icon("ChevronLeft"),
    ChevronRight: icon("ChevronRight"),
    Type: icon("Type"),
    Loader2: icon("Loader2"),
    Maximize2: icon("Maximize2"),
    Minimize2: icon("Minimize2"),
    Play: icon("Play"),
    BookOpen: icon("BookOpen"),
    Pause: icon("Pause"),
  };
});

const setShowFontPanel = vi.fn();
const onToggleImmersive = vi.fn();
const onPrev = vi.fn();
const onNext = vi.fn();

let view: ReturnType<typeof render>;

function topBarProps(over: Partial<TopBarProps> = {}): TopBarProps {
  return {
    chapter: { id: "c-3", title: "第三章", content: "甲\n\n乙\n \n丙" },
    currentIndex: 2,
    chapters: [{ id: "c-1" }, { id: "c-2" }, { id: "c-3" }],
    summaries: [],
    summaryOpen: false,
    onToggleSummary: () => {},
    hasSummary: false,
    showFontPanel: false,
    setShowFontPanel,
    onToggleImmersive,
    fontSize: 18,
    setFontSize: () => {},
    fontWeight: 400,
    cycleFontWeight: () => {},
    currentWeightLabel: "常规",
    lineHeight: 1.8,
    setLineHeight: () => {},
    paragraphSpacing: 8,
    setParagraphSpacing: () => {},
    fontFamily: "serif",
    setFontFamily: () => {},
    readingMode: "single",
    setReadingMode: () => {},
    autoSwitchPageMode: true,
    setAutoSwitchPageMode: () => {},
    autoReadInterval: 8,
    setAutoReadInterval: () => {},
    autoReadSpeed: 1,
    setAutoReadSpeed: () => {},
    immersive: false,
    isIndexLoading: false,
    windowWidth: 1024,
    ...over,
  };
}

function topBar(over: Partial<TopBarProps> = {}) {
  view = render(<TopBar {...topBarProps(over)} />);
  return view;
}

function rerenderTopBar(over: Partial<TopBarProps>) {
  act(() => {
    view.rerender(<TopBar {...topBarProps(over)} />);
  });
}

const set = (name: string) => screen.getByRole("button", { name });
const has = (name: string) => screen.queryByRole("button", { name });
const iconEl = (name: string) => document.querySelector(`[data-icon='${name}']`);
const btns = () => Array.from(document.querySelectorAll("button"));
/** 有文字内容的按钮，可访问名取的是文字，那枚只有 title 的入口就得按 title 认 */
const byTitle = (t: string) => {
  const found = document.querySelector(`button[title='${t}']`);
  expect(found, `找不到 title="${t}" 的那枚按钮`).toBeTruthy();
  return found as HTMLElement;
};

function fontToggle(): HTMLElement {
  const found = document.querySelector("[data-font-toggle]");
  expect(found, "字体开关得真在 DOM 上").toBeTruthy();
  return found as HTMLElement;
}

const panelBox = () => document.querySelector("[data-font-panel]");

/** 产品把监听注册推迟一帧（`:176`），所以要能"先不冲帧"与"冲一帧"两种走法 */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  });
}

function setTTS(over: Record<string, boolean>) {
  act(() => {
    useTTSStore.setState(over as never);
  });
}

function setUI(over: Record<string, unknown>) {
  act(() => {
    useUIStore.setState(over as never);
  });
}

function nav(over: Partial<BottomNavProps> = {}) {
  const base: BottomNavProps = {
    immersive: false,
    prevLabel: "上一页",
    nextLabel: "下一页",
    onPrev,
    onNext,
    prevDisabled: false,
    nextDisabled: false,
    loadingChapter: null,
    pageLabel: "2 / 6 页",
    ...over,
  };
  view = render(<BottomNav {...base} />);
  return view;
}

type ParaProps = {
  content: string;
  paragraphSpacing: number;
  ttsActive: boolean;
  ttsParagraph: number;
  chapterId: string;
  selectedChapterId: string | null;
};

function paras(over: Partial<ParaProps> = {}) {
  const base: ParaProps = {
    content: "甲\n\n乙\n \n丙",
    paragraphSpacing: 8,
    ttsActive: false,
    ttsParagraph: 0,
    chapterId: "c-1",
    selectedChapterId: "c-1",
    ...over,
  };
  view = render(<ChapterParagraphs {...base} />);
  return { view, props: base };
}

const ps = () => Array.from(document.querySelectorAll("p[data-tts-paragraph]")) as HTMLElement[];
/** 按段号认，不按位置认：空行占号不占字，位置会骗人 */
const para = (n: number) => document.querySelector(`p[data-tts-paragraph='${n}']`) as HTMLElement | null;

beforeEach(() => {
  m.toolbar.length = 0;
  setShowFontPanel.mockReset();
  onToggleImmersive.mockReset();
  onPrev.mockReset();
  onNext.mockReset();
  localStorage.clear();
  setTTS({ playing: false, paused: false, generating: false });
  setUI({ autoReadEnabled: false, readingMode: "scroll", autoReadSpeed: 2 });
});

describe("朗读按钮什么时候该藏起来", () => {
  it("播放中／暂停中／正在合成，三种「在跑」任一都不许再给一枚能点开的按钮", () => {
    topBar();
    expect(iconEl("Play"), "三档全停时按钮在位").toBeTruthy();
    for (const which of ["playing", "paused", "generating"] as const) {
      setTTS({ [which]: true });
      expect(iconEl("Play"), `${which}=true 还挂着朗读按钮，就是给了用户第二个入口`).toBeNull();
      setTTS({ [which]: false });
      expect(iconEl("Play"), `${which} 落回去之后按钮该回来`).toBeTruthy();
    }
  });

  it("点它只把「要开播」记进 store，不自己动播放状态", () => {
    topBar();
    const before = useTTSStore.getState().startRequested;
    fireEvent.click(set("语音朗读"));
    expect(useTTSStore.getState().startRequested, "开播决定在 tts-manager 那头，这里只许举手").toBe(before + 1);
    expect(useTTSStore.getState().playing).toBe(false);
  });
});

describe("自动阅读开关与快捷调速", () => {
  it("两态的图标、体征与提示各走一套，点一下真翻档、再点翻回来", () => {
    topBar();
    expect(iconEl("BookOpen")).toBeTruthy();
    expect(set("自动阅读（速度/间隔在字体面板中设置）").className).not.toContain("animate-pulse");
    fireEvent.click(set("自动阅读（速度/间隔在字体面板中设置）"));
    expect(useUIStore.getState().autoReadEnabled).toBe(true);
    expect(iconEl("Pause")).toBeTruthy();
    expect(set("停止自动阅读").className, "开着的时候得有个东西在动，否则看不出是谁在跑").toContain("animate-pulse");
    fireEvent.click(set("停止自动阅读"));
    expect(useUIStore.getState().autoReadEnabled).toBe(false);
  });

  it("快捷调速那枚只在「开着 + 滚动模式」这一格里出现（翻页模式没有行/秒可调）", () => {
    setUI({ autoReadEnabled: true, readingMode: "scroll" });
    topBar();
    expect(document.querySelector("button[title='快捷调速']")).toBeTruthy();
    setUI({ readingMode: "single" });
    expect(document.querySelector("button[title='快捷调速']"), "翻页模式给「行/秒」是假的：那模式用的是间隔秒数").toBeNull();
    setUI({ autoReadEnabled: false, readingMode: "scroll" });
    expect(document.querySelector("button[title='快捷调速']"), "自动阅读没开时不该有调速入口").toBeNull();
  });

  it("按钮上的速度读 store，面板里的速度读 props——两个来源不许串", () => {
    setUI({ autoReadEnabled: true, readingMode: "scroll", autoReadSpeed: 3 });
    topBar({ autoReadSpeed: 1, showFontPanel: true });
    expect(byTitle("快捷调速").textContent).toBe("3 行/秒");
    expect(m.toolbar[m.toolbar.length - 1].autoReadSpeed, "面板收的必须是调用点给的那一份").toBe(1);
  });

  it("浮层把五档一次摊全，点其中一档：改掉速度、落进本地偏好、并把浮层收起", () => {
    setUI({ autoReadEnabled: true, readingMode: "scroll", autoReadSpeed: 2 });
    topBar();
    fireEvent.click(byTitle("快捷调速"));
    const panel = screen.getByText("滚动速度").parentElement as HTMLElement;
    expect(Array.from(panel.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "0.5 行/秒",
      "1 行/秒",
      "2 行/秒",
      "3 行/秒",
      "4 行/秒",
    ]);
    fireEvent.click(set("4 行/秒"));
    expect(useUIStore.getState().autoReadSpeed).toBe(4);
    expect(localStorage.getItem("novel-reader-auto-read-speed"), "选完得记住，下次开机还是它").toBe("4");
    expect(screen.queryByText("滚动速度"), "选完还摊着五档就是多一层要再关的东西").toBeNull();
    expect(byTitle("快捷调速").textContent).toBe("4 行/秒");
  });

  it("浮层里只有当前那一档是选中态", () => {
    setUI({ autoReadEnabled: true, readingMode: "scroll", autoReadSpeed: 1 });
    topBar();
    fireEvent.click(byTitle("快捷调速"));
    const panel = screen.getByText("滚动速度").parentElement as HTMLElement;
    const lit = Array.from(panel.querySelectorAll("button")).filter((b) => b.className.includes("bg-primary"));
    expect(lit.map((b) => b.textContent)).toEqual(["1 行/秒"]);
  });

  it("点浮层外面才收，点自己范围内（那枚调速按钮）不许被自己的监听关掉", () => {
    setUI({ autoReadEnabled: true, readingMode: "scroll" });
    topBar();
    fireEvent.click(byTitle("快捷调速"));
    expect(screen.getByText("滚动速度")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("滚动速度")).toBeNull();
    fireEvent.click(byTitle("快捷调速"));
    fireEvent.mouseDown(byTitle("快捷调速"));
    expect(
      screen.getByText("滚动速度"),
      "监听把「按下开关那一下」也算成外面，浮层就永远打不开",
    ).toBeInTheDocument();
  });
});

describe("顶栏的读数与状态体征", () => {
  it("非沉浸报「千分位字数 + 第几章/共几章」，沉浸时这一整行收起", () => {
    topBar({ chapter: { id: "c-3", title: "第三章", content: "一".repeat(12345) }, currentIndex: 2 });
    expect(view.container.textContent).toContain("12,345 字");
    expect(view.container.textContent).toContain("3 / 3");
    rerenderTopBar({ immersive: true, currentIndex: 2 });
    expect(view.container.textContent, "沉浸态别再报字数").not.toContain("12,345 字");
    expect(view.container.textContent).not.toContain("3 / 3");
    expect(screen.getByText("第三章")).toBeInTheDocument();
  });

  it("索引在后台建时顶栏要说「加载中」，建完了不许留着", () => {
    topBar({ isIndexLoading: true });
    expect(screen.getByText("加载中")).toBeInTheDocument();
    expect(iconEl("Loader2")).toBeTruthy();
    rerenderTopBar({ isIndexLoading: false });
    expect(screen.queryByText("加载中")).toBeNull();
  });

  it("那枚总结体征只在「非沉浸 + 右栏没开」时出现，两半各配一个只它不成立的样本", () => {
    topBar({ hasSummary: true });
    expect(document.querySelector('[title="已有章节总结"]')).toBeTruthy();
    rerenderTopBar({ hasSummary: true, summaryOpen: true });
    expect(document.querySelector('[title="已有章节总结"]'), "右栏已经摊开了就别在旁边再点一盏灯").toBeNull();
    rerenderTopBar({ hasSummary: true, summaryOpen: false, immersive: true });
    expect(document.querySelector('[title="已有章节总结"]'), "沉浸态顶栏整条收窄，不留体征").toBeNull();
  });

  it("有总结与没总结的提示文案与颜色各走一套", () => {
    topBar({ hasSummary: true });
    expect(document.querySelector('[title="已有章节总结"] svg')).toHaveClass("text-primary");
    rerenderTopBar({ hasSummary: false });
    const dim = document.querySelector('[title="暂无章节总结"] svg');
    expect(dim).toBeTruthy();
    expect(dim).not.toHaveClass("text-primary");
    expect(dim).toHaveClass("text-muted-foreground/40");
  });

  it("沉浸按钮：调用点没给回调就不挂；给了就按当前态换图标与提示，点它只转告一次", () => {
    topBar({ onToggleImmersive: undefined });
    expect(has("沉浸模式")).toBeNull();
    rerenderTopBar({ immersive: true });
    expect(byTitle("退出沉浸模式")).toBeTruthy();
    expect(iconEl("Minimize2")).toBeTruthy();
    fireEvent.click(set("退出沉浸模式"));
    expect(onToggleImmersive).toHaveBeenCalledTimes(1);
    rerenderTopBar({ immersive: false });
    expect(byTitle("沉浸模式")).toBeTruthy();
    expect(iconEl("Maximize2")).toBeTruthy();
  });

  it("字体开关只在非沉浸挂，点它报的是「取反」而不是恒开", () => {
    topBar({ showFontPanel: false });
    fireEvent.click(fontToggle());
    expect(setShowFontPanel).toHaveBeenLastCalledWith(true);
    rerenderTopBar({ showFontPanel: true });
    fireEvent.click(fontToggle());
    expect(setShowFontPanel).toHaveBeenLastCalledWith(false);
    rerenderTopBar({ immersive: true });
    expect(document.querySelector("[data-font-toggle]"), "沉浸态不该留字体入口").toBeNull();
  });
});

describe("字体面板的挂载与收口", () => {
  it("面板开着才把工具条挂上来，关着一次都不挂", () => {
    topBar({ showFontPanel: false });
    expect(m.toolbar).toHaveLength(0);
    rerenderTopBar({ showFontPanel: true });
    expect(m.toolbar).toHaveLength(1);
  });

  it("排版参数原样递下去，windowWidth 没给时按 1024 兜", () => {
    topBar({
      showFontPanel: true,
      fontSize: 22,
      lineHeight: 2.1,
      paragraphSpacing: 12,
      fontFamily: "sans",
      readingMode: "double",
      autoReadInterval: 5,
      windowWidth: undefined,
    });
    const got = m.toolbar[m.toolbar.length - 1];
    expect(got.fontSize).toBe(22);
    expect(got.lineHeight).toBe(2.1);
    expect(got.paragraphSpacing).toBe(12);
    expect(got.fontFamily).toBe("sans");
    expect(got.readingMode).toBe("double");
    expect(got.autoReadInterval).toBe(5);
    expect(got.windowWidth, "面板要靠宽度决定默认布局，缺省得是个数").toBe(1024);
  });

  it("监听推迟一帧注册：刚点开那一下 mousedown 不算「点外面」", async () => {
    topBar({ showFontPanel: false });
    setShowFontPanel.mockClear();
    rerenderTopBar({ showFontPanel: true });
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(setShowFontPanel, "注册赶在打开那一下之前，面板一开就自己关掉自己").not.toHaveBeenCalled();
    await flushFrame();
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(setShowFontPanel).toHaveBeenLastCalledWith(false);
  });

  it("面板内与开关按钮上的 mousedown 都不算「点外面」（两道白名单各判一次）", async () => {
    topBar({ showFontPanel: true });
    await flushFrame();
    setShowFontPanel.mockClear();
    act(() => {
      fireEvent.mouseDown(fontToggle());
    });
    expect(setShowFontPanel, "把开关自己算成外面，就永远只能开一次").not.toHaveBeenCalled();
    act(() => {
      fireEvent.mouseDown(panelBox() as HTMLElement);
    });
    expect(setShowFontPanel, "点面板里的滑杆不该顺手把面板收掉").not.toHaveBeenCalled();
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(setShowFontPanel).toHaveBeenLastCalledWith(false);
  });

  it("卸载要把监听摘掉：面板开着就离开阅读器，之后的点击不许再碰调用点的状态", async () => {
    topBar({ showFontPanel: true });
    await flushFrame();
    view.unmount();
    setShowFontPanel.mockClear();
    fireEvent.mouseDown(document.body);
    expect(
      setShowFontPanel,
      "监听留在 document 上，下次进阅读器就会多一只耳朵同时说话",
    ).not.toHaveBeenCalled();
  });
});

describe("底栏那两枚章钮", () => {
  it("切章在飞时两枚一起锁住，各侧本来可点的那半也不例外", () => {
    nav({ loadingChapter: "c-9" });
    expect(btns().filter((b) => b.disabled)).toHaveLength(2);
    fireEvent.click(btns()[0]);
    fireEvent.click(btns()[1]);
    expect(onPrev).not.toHaveBeenCalled();
    expect(onNext, "章节还没取回来就让用户点「下一页」，点出来的是上一本的章").not.toHaveBeenCalled();
  });

  it("没在切章时两枚各按自己的位，一边锁死不许把另一边带走", () => {
    nav({ prevDisabled: true, nextDisabled: false });
    expect(btns()[0].disabled).toBe(true);
    expect(btns()[1].disabled, "第一章不该顺手把「下一页」也锁掉").toBe(false);
    view.unmount();
    nav({ prevDisabled: false, nextDisabled: true });
    expect(btns()[0].disabled).toBe(false);
    expect(btns()[1].disabled, "末章不该把「上一页」也锁掉").toBe(true);
  });

  it("转圈只给「本来就该禁用」那一侧，另一侧照常给箭头", () => {
    nav({ loadingChapter: "c-9", prevDisabled: true, nextDisabled: false });
    expect(btns()[0].querySelector("[data-icon='Loader2']")).toBeTruthy();
    expect(btns()[1].querySelector("[data-icon='Loader2']")).toBeNull();
    view.unmount();
    nav({ loadingChapter: null, prevDisabled: true });
    expect(btns()[0].querySelector("[data-icon='ChevronLeft']"), "只是第一章，不是正在加载，别画转圈").toBeTruthy();
    view.unmount();
    nav({ loadingChapter: "c-9", prevDisabled: false });
    expect(btns()[0].querySelector("[data-icon='ChevronLeft']")).toBeTruthy();
  });

  it("点可点的那枚只转告对应那侧，另一枚一发都不碰", () => {
    nav();
    fireEvent.click(set("下一页"));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
    view.unmount();
    nav();
    fireEvent.click(set("上一页"));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("页码那行要挂在底栏里，且 ref 真落在那块容器上（调用点靠它做落点）", () => {
    const box = { current: null as HTMLDivElement | null };
    view = render(
      <BottomNav
        immersive={false}
        prevLabel="上一页"
        nextLabel="下一页"
        onPrev={onPrev}
        onNext={onNext}
        prevDisabled={false}
        nextDisabled={false}
        loadingChapter={null}
        pageLabel="2 / 6 页"
        ref={box}
      />,
    );
    expect(screen.getByText("2 / 6 页")).toBeInTheDocument();
    expect(box.current, "ref 没接到容器上，调用点就量不到这块的高度").toBe(view.container.firstElementChild);
    expect(box.current).toBeInstanceOf(HTMLDivElement);
  });
});

describe("正文段落：序号、行距与高亮", () => {
  it("段落号按「切出来的下标」排，空行占号不占字——TTS 报第几段就落在第几段", () => {
    paras();
    expect(ps().map((p) => p.getAttribute("data-tts-paragraph"))).toEqual(["0", "1", "3"]);
    expect(ps().map((p) => p.textContent)).toEqual(["甲", "乙", "丙"]);
    expect(document.querySelectorAll("br")).toHaveLength(1);
    expect(para(2), "空行占一个段号，但它是 <br/>，不许被当成一段正文").toBeNull();
  });

  it("段距跟着 paragraphSpacing 走，单位是 px", () => {
    paras({ paragraphSpacing: 20 });
    expect(ps()).toHaveLength(3);
    for (const p of ps()) expect(p.style.marginBottom).toBe("20px");
  });

  it("高亮要三样同时成立：在读、是当前章、且正好读到那一段", () => {
    paras({ ttsActive: true, ttsParagraph: 3 });
    expect(para(3)).toHaveClass("border-primary");
    expect(para(0)).not.toHaveClass("border-primary");
    view.unmount();
    paras({ ttsActive: true, ttsParagraph: 3, chapterId: "c-2", selectedChapterId: "c-1" });
    expect(para(3), "别的已加载章节不许跟着一起亮").not.toHaveClass("border-primary");
    view.unmount();
    paras({ ttsActive: false, ttsParagraph: 3 });
    expect(para(3), "整本书不在朗读时不许留着高亮").not.toHaveClass("border-primary");
  });

  it("亮底要跟着朗读走：推进一段换一段亮、挪到别的章要清、停下来也要清（比较器三个相等判断各管一头）", () => {
    const { props } = paras({ ttsActive: true, ttsParagraph: 1 });
    expect(para(1)).toHaveClass("border-primary");
    act(() => {
      view.rerender(<ChapterParagraphs {...props} ttsParagraph={3} />);
    });
    expect(para(3), "读到第 3 段了还不换，就是比较器不看 ttsParagraph").toHaveClass("border-primary");
    expect(para(1)?.className).not.toContain("border-primary");
    act(() => {
      view.rerender(<ChapterParagraphs {...props} ttsParagraph={3} selectedChapterId="c-2" />);
    });
    expect(
      para(3)?.className,
      "比较器要是不看 selectedChapterId 的变化，旧章就永远顶着一条亮边",
    ).not.toContain("border-primary");
    // 停下来那一发要另起一棵树：上一步已经把这本判成"不是当前章"，比较器那时就该跳过渲染，量不到 ttsActive
    view.unmount();
    const lit = paras({ ttsActive: true, ttsParagraph: 1 });
    expect(para(1)).toHaveClass("border-primary");
    act(() => {
      view.rerender(<ChapterParagraphs {...lit.props} ttsActive={false} />);
    });
    expect(
      para(1)?.className,
      "朗读停了还不摘，屏幕上就留下一段没人读的亮边（比较器不看 ttsActive）",
    ).not.toContain("border-primary");
  });

  it("换正文与换段距都必须重渲染（比较器第一行）", () => {
    const { props } = paras({ paragraphSpacing: 8 });
    expect(para(0)?.textContent).toBe("甲");
    act(() => {
      view.rerender(<ChapterParagraphs {...props} content={"丁\n戊"} paragraphSpacing={24} />);
    });
    expect(para(0)?.textContent, "正文换了却不重渲染，就是旧章还挂在屏幕上").toBe("丁");
    expect(para(1)?.textContent).toBe("戊");
    expect(para(1)?.style.marginBottom).toBe("24px");
  });
});
