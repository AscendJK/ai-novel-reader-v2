import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { ReadingPanel } from "../ReadingPanel";
import { useNovelStore } from "@/stores/novel-store";
import { useSummaryStore } from "@/stores/summary-store";
import { useAiTaskStore } from "@/stores/ai-task-store";
import type { SummaryItem } from "@/stores/summary-store";
import type { AiTaskView } from "@/stores/ai-task-store";
import type { Novel } from "@/parsers/types";

/**
 * `ReadingPanel` 是阅读页的接线板：它自己不渲染正文，只决定**谁拿到哪一端的控制、
 * 什么状态下挂载**。这只文件被改过 15 笔（全项目第一），而在这之前没有任何测试
 * 直接指着它——浏览器档（`g-narrow.spec.ts`）能摸到"底栏六个标签都点得动、抽屉能开能关"，
 * 但它量不到下面这四类坏法：
 *
 * 1. **沉浸态的去处**：`immersive` 是挂到 `<html>` 的 class 上的（`ReadingPanel.tsx:26-29`），
 *    不是组件内部的样式。忘了卸载时摘掉，用户从阅读页回书架还是沉浸态。
 * 2. **体征的两个通道**：折叠按钮同时用「转圈图标」和 `data-ai-busy` 报"这本书还在跑"。
 *    跨书隔离（`aiBusy` 只数当前那本书的任务）一旦写错，A 书在跑会让 B 书的按钮转圈，
 *    而界面上没有别的线索能看出来。
 * 3. **`hasCurrentSummary` 的三条 AND**（书、章、类型），少一条绿点就乱亮；
 *    它同时是传给 `ChapterContent` 的那个 prop。
 * 4. **移动端 AI 面板是常挂载的**（`display:none` 而非条件渲染）：面板里跑着的活儿
 *    不能因为用户关掉面板就被卸载打断。这条坏起来的形状是"关掉就没了"。
 *
 * 桩只放在三处接缝（`ChapterNav`／`ChapterContent`／`SummaryPanel`）加图标库上，
 * 判的是"这只接线板把什么交给了谁"——三处子组件各自的行为有它们自己的测试文件。
 * 受控/非受控那两格刻意读 DOM 而不是读"最后一次 props 捕获"：桌面与移动端是同一只
 * 组件的两个实例，捕获顺序会被 lazy 的解析时机牵着走。
 *
 * 判别力（28 条 / 29 刀，逐刀手动下、跑完立刻反向还原，末了 `SHA256` 核回基线）：
 * 每刀都咬住了指定那一格，三处要如实记着——
 * ① 刀 3 第一版是**假绿**：我把 JSX 的右括号吞了，文件没编译，`红=0` 看着像"判据没用"。
 *    从那以后每条跑刀命令都固定核三样：`Transform failed`、`skipped`、盘上 `MUT-` 数。
 * ② 刀 4／25 第一次红不到格上：夹具（预热与按 testid 单查）假设了"面板只有一个实例"，
 *    契约一坏先炸夹具、28 条全 skip。改成"主动点开 + 推一帧 + 数实例"才归位。
 * ③ 刀 7／8／9 三把都只红同一格（"面板开着时不许转圈"），但各咬一条独立断言
 *    （`data-ai-busy`／图标／`title`）——其中 `title` 那条是写完判据自查时补的，不补就是一把空刀。
 *    另：刀 6／14 属于"翻 else 分支"型判点。把 `currentNovelId ? … : false` 的整段 guard
 *    删掉是**等价变异**（`novelId` 类型上不可能是 undefined），只有翻那一支才红——
 *    这两格判的是可观察行为，不是那两行防御码本身。
 */

type Props = Record<string, unknown>;
const last = <T,>(a: T[]) => a[a.length - 1];

const cap = vi.hoisted(() => ({
  nav: [] as Props[],
  content: [] as Props[],
  panel: [] as Props[],
}));

vi.mock("@/components/reader/ChapterNav", () => ({
  ChapterNav: (p: Props) => {
    cap.nav.push(p);
    return <div data-testid="chapter-nav" />;
  },
}));

vi.mock("@/components/reader/ChapterContent", () => ({
  ChapterContent: (p: Props) => {
    cap.content.push(p);
    return (
      <div data-testid="chapter-content">
        <button data-testid="fire-toggle-summary" onClick={() => (p.onToggleSummary as () => void)()} />
        <button data-testid="fire-toggle-immersive" onClick={() => (p.onToggleImmersive as () => void)()} />
      </div>
    );
  },
}));

// 真组件是 lazy 的（`ReadingPanel.tsx:4`）：桩保留同样的具名导出，挂载时机照旧要等一帧
vi.mock("@/components/summary/SummaryPanel", () => ({
  SummaryPanel: (p: Props) => {
    cap.panel.push(p);
    return (
      <div data-testid="summary-panel" data-value={(p.value as string | undefined) ?? "(不受控)"}>
        <button
          data-testid="panel-pick-tab"
          onClick={() => (p.onValueChange as ((v: string) => void) | undefined)?.("notes")}
        />
      </div>
    );
  },
}));

// 图标只判"用的是哪一只"，不判字形：真 lucide 的 svg 里认不出组件名
vi.mock("lucide-react", () => {
  const icon = (name: string) => (p: Props) => <svg data-icon={name} className={p.className as string} />;
  return {
    PanelRightOpen: icon("PanelRightOpen"),
    PanelRightClose: icon("PanelRightClose"),
    Loader2: icon("Loader2"),
    List: icon("List"),
    FileText: icon("FileText"),
    BookOpen: icon("BookOpen"),
    MessageSquare: icon("MessageSquare"),
    StickyNote: icon("StickyNote"),
    Search: icon("Search"),
    X: icon("X"),
  };
});

const NOVEL = {
  id: "novel-1", title: "测试书", author: "作者", fileName: "t.txt", fileFormat: "txt",
  totalChars: 100, chapterCount: 2, createdAt: 1, updatedAt: 1, chapters: [],
} as unknown as Novel;

const mkSummary = (over: Partial<SummaryItem> = {}): SummaryItem => ({
  id: "sum-1", novelId: "novel-1", chapterId: "ch-1", chapterTitle: "第一章",
  content: "总结正文", tokensUsed: 10, createdAt: 1, updatedAt: 1, type: "chapter", ...over,
});
const mkTask = (novelId: string): AiTaskView => ({
  id: `task-${novelId}`, novelId, name: "总结本章", type: "chapter-summary",
  status: "running", message: "正在分析", progress: null, queuedAt: 1, startedAt: 1,
});

const host = (sel: string) => document.querySelector<HTMLElement>(sel);
const collapseBtn = () => host("[data-sidebar='summary-panel'] > button")!;
const iconOf = (el: HTMLElement) => el.querySelector("svg")!.getAttribute("data-icon");
const busyDot = () => host("[data-sidebar='summary-panel'] span.absolute");
const panelHost = () => host("[data-mobile-ai-panel]");
const drawer = () => host("[data-mobile-nav-drawer]");
const navRows = () => Array.from(document.querySelectorAll<HTMLElement>(".md\\:hidden.fixed.bottom-0 button"));
const isShown = (el: HTMLElement | null) => !!el && el.style.display !== "none";
/** 某一处宿主里那一份面板实例（桌面在右栏、移动端在浮层里），读它收到的 prop */
const valueOf = (scope: HTMLElement | null) =>
  scope?.querySelector<HTMLElement>("[data-testid='summary-panel']")?.getAttribute("data-value") ?? null;
const pickBtnIn = (scope: HTMLElement | null) =>
  scope?.querySelector<HTMLElement>("[data-testid='panel-pick-tab']") ?? null;

const pickMobileTab = (label: string) =>
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}$`) }));
const toggleImmersive = () => fireEvent.click(screen.getByTestId("fire-toggle-immersive"));
const toggleSummary = () => fireEvent.click(screen.getByTestId("fire-toggle-summary"));
const desktopHost = () => host("[data-sidebar='summary-panel']");
/** lazy 那一帧：真挂载要等动态 import 落地，`fireEvent` 的 act 包不住 */
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** 右栏那一份是 lazy 的：开一扇之后要等它落地才看得到面板本体 */
const openDesktopPanel = async () => { toggleSummary(); await flush(); };
/** 两份导航在桩里是同一只组件：抽屉那份以「收到 onPicked」为身份区分 */
const drawerNavProps = () => last(cap.nav.filter((p) => p.onPicked !== undefined));
const desktopNavProps = () => last(cap.nav.filter((p) => p.onPicked === undefined));

describe("ReadingPanel：阅读页接线板自己的契约", () => {
  /**
   * 先预热那一次挂起：`lazy` 的 import 若不先落地，每只用例都会收到一条"挂起的东西在
   * act 之外落地"的警告（React 按组件类型缓存解析结果，预一次就够）。警告盖满屏，
   * 将来真有一条就看不见了。
   * 这里**主动点开一次面板**而不是直接等实例：预热不能反过来依赖"移动端面板常挂载"这条契约。
   * 用 `flush`（推一帧）而不是 `findByTestId`：桌面与移动端是同一只组件，右栏一旦改成常挂载
   * 就有两个实例，按 testid 查询会先炸在夹具里、28 条全被 skip，判点反而落不到格上。
   */
  beforeAll(async () => {
    const { unmount, getByRole } = render(<ReadingPanel />);
    fireEvent.click(getByRole("button", { name: /^本章$/ }));
    await flush();
    unmount();
  });

  beforeEach(() => {
    useNovelStore.setState({ currentNovel: NOVEL, selectedChapterId: "ch-1" });
    useSummaryStore.setState({ summaries: [] });
    useAiTaskStore.setState({ tasks: [] });
    cap.nav.length = 0; cap.content.length = 0; cap.panel.length = 0;
    document.documentElement.className = "";
  });
  afterEach(() => { cleanup(); });

  /* ---------- 1. 沉浸态 ---------- */

  it("沉浸开关只有一处真相：ChapterContent 报上来，class 挂到 <html>", () => {
    render(<ReadingPanel />);
    expect(document.documentElement.classList.contains("immersive")).toBe(false);
    toggleImmersive();
    expect(document.documentElement.classList.contains("immersive")).toBe(true);
    toggleImmersive();
    expect(document.documentElement.classList.contains("immersive")).toBe(false);
  });

  it("开着沉浸就离开阅读页：<html> 上那个 class 必须跟着摘掉", () => {
    const { unmount } = render(<ReadingPanel />);
    toggleImmersive();
    expect(document.documentElement.classList.contains("immersive")).toBe(true);
    unmount();
    expect(document.documentElement.classList.contains("immersive")).toBe(false);
  });

  it("沉浸把 `immersive` 同时交给导航与正文（三处必须同步）", () => {
    render(<ReadingPanel />);
    expect(desktopNavProps().immersive).toBe(false);
    expect(last(cap.content).immersive).toBe(false);
    toggleImmersive();
    expect(desktopNavProps().immersive).toBe(true);
    expect(last(cap.content).immersive).toBe(true);
  });

  it("沉浸时手机底栏整个从 DOM 消失，而不是藏起来", () => {
    render(<ReadingPanel />);
    expect(navRows()).toHaveLength(6);
    toggleImmersive();
    expect(navRows()).toHaveLength(0);
    toggleImmersive();
    expect(navRows()).toHaveLength(6);
  });

  it("抽屉开着时进沉浸：抽屉里那份导航不继承沉浸态（它是浮层，不是正文）", () => {
    render(<ReadingPanel />);
    pickMobileTab("目录");
    toggleImmersive();
    expect(drawerNavProps().immersive).toBeFalsy();
    expect(desktopNavProps().immersive).toBe(true);
    expect(last(cap.content).immersive).toBe(true);
  });

  /* ---------- 2. 折叠按钮的三态与体征 ---------- */

  it("收起且没活儿：展开图标 + `data-ai-busy=0` + 可访问名说「展开」", () => {
    render(<ReadingPanel />);
    expect(iconOf(collapseBtn())).toBe("PanelRightOpen");
    expect(collapseBtn().getAttribute("data-ai-busy")).toBe("0");
    expect(collapseBtn().getAttribute("aria-label")).toBe("展开 AI 分析面板");
  });

  it("展开着：图标翻成收起、可访问名跟着翻（按钮不能一直顶着「展开」这个名字）", async () => {
    render(<ReadingPanel />);
    await openDesktopPanel();
    expect(iconOf(collapseBtn())).toBe("PanelRightClose");
    expect(collapseBtn().getAttribute("aria-label")).toBe("收起 AI 分析面板");
  });

  it("当前这本书在跑：收起态转圈，并把体征挂到 `data-ai-busy`", () => {
    useAiTaskStore.setState({ tasks: [mkTask("novel-1")] });
    render(<ReadingPanel />);
    expect(iconOf(collapseBtn())).toBe("Loader2");
    expect(collapseBtn().getAttribute("data-ai-busy")).toBe("1");
    expect(collapseBtn().getAttribute("title")).toContain("收起面板不会中断它");
  });

  it("面板开着时不许转圈：那是收起按钮，不是进度条", () => {
    useAiTaskStore.setState({ tasks: [mkTask("novel-1")] });
    render(<ReadingPanel />);
    toggleSummary();
    expect(iconOf(collapseBtn())).toBe("PanelRightClose");
    expect(collapseBtn().getAttribute("data-ai-busy")).toBe("0");
    expect(collapseBtn().getAttribute("title")).toBeNull(); // 面板就在眼前，"收起面板不会中断它"这句是假话
  });

  it("另一本书在跑，不许让这本书的按钮转圈", () => {
    useAiTaskStore.setState({ tasks: [mkTask("novel-2")] });
    render(<ReadingPanel />);
    expect(iconOf(collapseBtn())).toBe("PanelRightOpen");
    expect(collapseBtn().getAttribute("data-ai-busy")).toBe("0");
  });

  it("台账里有活儿但没选书：没有『当前这本书』就没有体征", () => {
    useNovelStore.setState({ currentNovel: null, selectedChapterId: null });
    useAiTaskStore.setState({ tasks: [mkTask("novel-2")] });
    render(<ReadingPanel />);
    expect(collapseBtn().getAttribute("data-ai-busy")).toBe("0");
    expect(iconOf(collapseBtn())).toBe("PanelRightOpen");
  });

  /* ---------- 3. hasCurrentSummary 的三条 AND ---------- */

  it("三条全对上才算『这本书这一章有总结』：绿点与 prop 一起亮", () => {
    useSummaryStore.setState({ summaries: [mkSummary()] });
    render(<ReadingPanel />);
    expect(last(cap.content).hasSummary).toBe(true);
    expect(busyDot()).not.toBeNull();
  });

  it("换个章就不算：`chapterId` 单独不成立要把绿点亮灭", () => {
    useSummaryStore.setState({ summaries: [mkSummary({ chapterId: "ch-2" })] });
    render(<ReadingPanel />);
    expect(last(cap.content).hasSummary).toBe(false);
    expect(busyDot()).toBeNull();
  });

  it("别的书同 id 的总结不算：`novelId` 单独不成立", () => {
    useSummaryStore.setState({ summaries: [mkSummary({ novelId: "novel-2" })] });
    render(<ReadingPanel />);
    expect(last(cap.content).hasSummary).toBe(false);
  });

  it("全书/图谱/时间线那种章节级总结不算：`type` 单独不成立", () => {
    useSummaryStore.setState({ summaries: [mkSummary({ type: "global" })] });
    render(<ReadingPanel />);
    expect(last(cap.content).hasSummary).toBe(false);
  });

  it("没选书时不许因为台账里留着上一条而亮", () => {
    useSummaryStore.setState({ summaries: [mkSummary()] });
    useNovelStore.setState({ currentNovel: null, selectedChapterId: null });
    render(<ReadingPanel />);
    expect(last(cap.content).hasSummary).toBe(false);
  });

  it("面板展开着就不需要绿点：收起态才是它的出场时机", () => {
    useSummaryStore.setState({ summaries: [mkSummary()] });
    render(<ReadingPanel />);
    expect(busyDot()).not.toBeNull();
    toggleSummary();
    expect(busyDot()).toBeNull();
  });

  /* ---------- 4. 手机底栏六个入口 ---------- */

  it("六个入口一个都不能少，各自指向各自那一档", () => {
    render(<ReadingPanel />);
    expect(navRows().map((r) => r.textContent)).toEqual(["目录", "问答", "本章", "全书", "笔记", "搜索"]);
    expect(navRows().map((r) => iconOf(r))).toEqual([
      "List", "MessageSquare", "FileText", "BookOpen", "StickyNote", "Search",
    ]);
    const tabOf: Record<string, string> = { 问答: "qa", 本章: "chapter", 全书: "book", 搜索: "search" };
    for (const [label, tab] of Object.entries(tabOf)) {
      pickMobileTab(label);
      expect(isShown(panelHost())).toBe(true);
      expect(valueOf(panelHost())).toBe(tab);
    }
    pickMobileTab("笔记");
    expect(valueOf(panelHost())).toBe("notes");
  });

  it("『目录』开的是左抽屉，不是 AI 面板", () => {
    render(<ReadingPanel />);
    pickMobileTab("目录");
    expect(drawer()).not.toBeNull();
    expect(isShown(panelHost())).toBe(false);
  });

  /* ---------- 5. 抽屉：两份导航、一个出口 ---------- */

  it("三份接缝共用同一只滚动控制 ref（跳章得落到正在读的那一份）", () => {
    render(<ReadingPanel />);
    const desktopRef = desktopNavProps().scrollControlRef;
    expect(desktopRef).toBeTruthy();
    expect(last(cap.content).scrollControlRef).toBe(desktopRef);
    pickMobileTab("目录");
    expect(drawerNavProps().scrollControlRef).toBe(desktopRef);
  });

  it("桌面那份导航不许收到 `onPicked`：抽屉的开关状态不该被桌面点击动到", () => {
    render(<ReadingPanel />);
    expect(cap.nav.filter((p) => p.onPicked !== undefined)).toHaveLength(0);
    expect(desktopNavProps().onPicked).toBeUndefined();
  });

  it("抽屉里点定章节，抽屉自己收掉；遮罩点一下也收", () => {
    render(<ReadingPanel />);
    pickMobileTab("目录");
    const picked = drawerNavProps().onPicked as (id: string) => void;
    expect(picked).toBeTypeOf("function");
    act(() => picked("ch-2"));
    expect(drawer()).toBeNull();

    pickMobileTab("目录");
    const backdrop = drawer()!.previousElementSibling as HTMLElement;
    fireEvent.click(backdrop);
    expect(drawer()).toBeNull();
  });

  it("抽屉那份 `onPicked` 引用必须稳定：整块重渲染不许把 memo 化的导航打穿", () => {
    render(<ReadingPanel />);
    pickMobileTab("目录");
    const before = drawerNavProps().onPicked;
    const renders = cap.nav.length;
    toggleImmersive();
    expect(cap.nav.length).toBeGreaterThan(renders); // 桩确实又收了一次 props
    expect(drawerNavProps().onPicked).toBe(before);
  });

  /* ---------- 6. 移动端 AI 面板：常挂载 + 受控 ---------- */

  it("没点开之前 AI 面板就在 DOM 里但不可见（常挂载的前提是它一开始就在）", () => {
    render(<ReadingPanel />);
    expect(panelHost()).not.toBeNull();
    expect(isShown(panelHost())).toBe(false);
  });

  it("关掉移动端 AI 面板只是藏起来：里面跑着的活儿不能因为卸载而死", async () => {
    render(<ReadingPanel />);
    pickMobileTab("问答");
    const mounted = screen.getAllByTestId("summary-panel").length; // 用计数而不是按 testid 单查：桌面右栏若改成常挂载会有两个实例
    fireEvent.click(screen.getByLabelText("关闭 AI 分析"));
    expect(isShown(panelHost())).toBe(false);
    expect(screen.getAllByTestId("summary-panel")).toHaveLength(mounted);
  });

  it("移动端面板里换 tab，关掉再开还是那一 tab（状态握在接线板手里）", () => {
    render(<ReadingPanel />);
    pickMobileTab("全书");
    fireEvent.click(pickBtnIn(panelHost())!); // 面板自己选到「笔记」
    expect(valueOf(panelHost())).toBe("notes");
    fireEvent.click(screen.getByLabelText("关闭 AI 分析"));
    pickMobileTab("全书");
    expect(valueOf(panelHost())).toBe("book");
  });

  it("只有移动端那份是受控的：桌面右栏不接管 tab", async () => {
    render(<ReadingPanel />);
    await openDesktopPanel();
    expect(valueOf(desktopHost())).toBe("(不受控)");
    fireEvent.click(pickBtnIn(desktopHost())!); // 桌面那份点了不该有人接
    expect(valueOf(desktopHost())).toBe("(不受控)");
    expect(valueOf(panelHost())).toBe("chapter");
  });

  /* ---------- 7. 右栏挂载时机 ---------- */

  it("桌面右栏按开关挂载/卸载，正文那侧同步收到 `summaryOpen`", async () => {
    render(<ReadingPanel />);
    expect(valueOf(desktopHost())).toBeNull();
    expect(last(cap.content).summaryOpen).toBe(false);
    await openDesktopPanel();
    expect(valueOf(desktopHost())).toBe("(不受控)");
    expect(last(cap.content).summaryOpen).toBe(true);
    await openDesktopPanel();
    expect(valueOf(desktopHost())).toBeNull();
    expect(last(cap.content).summaryOpen).toBe(false);
  });
});
