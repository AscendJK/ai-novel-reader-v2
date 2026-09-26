/**
 * `GlobalNotes` 组件内部判据（地板第 1 档·全部笔记那一屏）。
 *
 * 这一屏是"一个列表 + 三个筛子 + 一枚删除"，坏起来最贵的三处都在**筛**上：
 * 1) **三个筛子是 AND**，而且是三段各自独立的判断（`GlobalNotes.tsx:35-41`）。少一段就是
 *    "按了小说筛，来源那一步白点"；`useMemo` 的依赖少一个，就是"点了下拉但列表不动"——
 *    所以每个筛子各有一条**只动它**的用例，三把刀才能各咬各的。
 * 2) **搜索命中三个字段里的任意一个**（正文 / 章名 / 书名，`:40` 那一行的三个 `||`）。
 *    书名那一支最容易丢：它要先过 `novelMap`，而笔记的 `novelId` 可能查不到书（`deleted`
 *    之后、或导入了一半），所以 `?. … || ""` 那半不是装饰——摘掉它就是**搜一下就整屏抛错**。
 * 3) **空态有两种话**（`:118`）：库里真没有说「暂无笔记」，有但被筛掉说「没有匹配的笔记」。
 *    说反了的代价是用户以为笔记丢了。
 * 其余是这一屏自己管的：展开按钮的门槛是"正文超过 100 字"（`:143`，边界在 100/101）、
 * 展开状态存在按 id 的 `Set` 里且**必须是新集合**（`:47` 就地改 `prev` 会让 React 不再重渲染，
 * 症状是"点了展开没反应"），日期钉 `updatedAt || createdAt`（`:137`，为 0 才退回创建时间），
 * 删除要先过确认框、只删点的那一条、删完要 `pushNow`（`:58-63`，少了它另一台设备还留着）。
 *
 * **这一档判不到的两格**（写在前面，免得被"这只有测试了"盖住）：
 * ① `zh-CN` 这个 locale 字面量在本机是**等价变异**（这台机器默认就是 zh-CN，摘掉它输出一样），
 *    所以只钉了"年在最前 + 带冒号"的形状，真正防漂移要靠非中文机器／CI；
 * ② 删除按钮的可访问名（原只有 `title="删除"`、没带是**哪一条**的上下文，与 MiniCard 同一类问题）。
 *    2026-09-26 已按制作人定的口径补上并判住：`删除笔记 {书名} {章名}`（屏上同一行那两层上下文），
 *    判据与两刀见「删除这一条链」一节与下面台账的 G29/G30 —— 这一格不再挂着。
 * 另：`loadAllNotes` 自己吞错返回 `[]`（`repositories.ts:374`），所以"加载失败"这一格在这层不可达。
 *
 * ## 变异台账：28 刀打在基线 `a853c66f…`（7135 字节 / 34 条全绿，**产品代码一行没动**），另 2 刀打在 `1e2e2b58…`（补可访问名之后）
 *
 * 每刀手改一处、跑完立刻按基线还原并核 SHA256；每轮固定读 `markers / reds / transform_failed /
 * skipped / markers_left / diff_lines / restored_sha`，28 轮全是 `markers=1 / transform_failed=0 /
 * skipped=0 / markers_left=0 / diff_lines=0 / restored_sha=a853c66f`。红数如下：
 * - **三筛各是独立的一段**：G1 摘掉小说筛＝3 红、G2 摘掉来源筛＝2 红、G3 摘掉搜索整段＝7 红；
 *   G4 依赖里少 `sourceFilter`＝2 红、G5 依赖里少 `searchQuery`＝7 红。**G3 与 G5 红的是同一批名字**
 *   （一片"搜索没反应"），成因却是两半——判断本身 vs 让判断重算的那份依赖，所以两半各站各的岗。
 * - **搜索那一行的三支**：G7 丢书名＝1 红、G8 丢章名＝1 红、G10 正文不再小写＝1 红、
 *   G6 不 trim＝1 红（只敲空格把列表清空）；G9 拿掉可选链与兜底＝6 红，红法是 `TypeError`
 *   （整屏抛）而不是"少一条结果"。
 * - **计数与空态**：G12 计数拿的是筛前＝9 红、G11 两种空态说反＝4 红。
 * - **展开那一簇**：G13 门槛从"大于 100"挪到"不小于 100"＝1 红（正好 100 字那条多出一枚按钮）、
 *   G14 展开不再决定裁切＝4 红、G15 就地改那只 `Set`＝4 红（症状是"点了没反应"）、G16 丢掉收起那一步＝1 红。
 * - **删除链**：G17 确认框不拦＝2 红、G18 删的不是点的那条＝1 红、G19 删完列表不动＝3 红、G20 删完不 push＝1 红。
 * - **加载与书名**：G23 书名那一发不发＝8 红、G24 笔记那一发喂给了书名＝29 红（整屏空，红得多不等于各有牙）、
 *   G27 书名兜底丢了＝1 红、G22 下拉拿标题当值＝4 红。
 * - **别处**：G25 徽章说反＝1 红、G21 日期两个来源取反＝2 红、G28 返回不接外壳＝1 红、
 *   G26b 小说下拉丢可访问名＝5 红（红在定位器上——这一条判的是"它得有名"，不是行为）。
 * - **删除按钮的可访问名（G29/G30，基线换成补名之后的 `1e2e2b58…`；这一族每轮连跑三只文件共 94 条，
 *   因为「收藏／删除／重新生成／十枚 ±」是同一件事，红名全部落在本文件的 34 条里）**：
 *   G29 摘掉 `aria-label`、只留 `title="删除"`＝**8 红**（名字那条 + 七条把名字当 locator 用的删除链
 *   用例：确认框、取消、删的是点的那条、删完 push、筛选下删、删到空、展开按 id 认）。**红 8 不等于
 *   八条各有牙**——这八条共用同一个取法，一处名字坏就一起拿不到按钮；真正的"名字本身"判据只有一条。
 *   G30 名字里丢掉章名（只留书名）＝**1 红**，红的正是名字那一条（它逐枚核到"书名 + 章名"两层，
 *   少了后半截就对不上）——G29 打"有没有上下文"、G30 打"上下文全不全"，两半各咬一次。
 *
 * **两笔要交代的处置**：① G26 首打跑出来 `markers=2`＝同一盘落了两刀（我连发两次编辑，第二次没把
 * 第一次的标记盖掉），按口径那一轮作废，重打成单标记的 G26b；两轮的红名一致，但只有 G26b 算数。
 * ② 「删到空」那条用例原来是不定次的 `while`，配上 G19（删完列表不动）会把跑刀的人吊死在循环里——
 * 改成带上限的 `for`，让这一格红在该红的断言上，而不是红成"这条用例永远跑不完"。
 *
 * **没打到的格子**（承认在这儿）：`Badge` 的 `variant`（secondary 与 outline 换错不会红，只影响颜色）；
 * 搜索框的 `value={searchQuery}` 受控那半（摘掉它仍会发 change，所以判不到）；删除按钮的
 * `md:opacity-0 md:group-hover:opacity-100`——"桌面端要悬停才看得见"这一格 jsdom 量不了 opacity，
 * 归浏览器层，本档不替它背书。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { NoteItem } from "@/db/repositories";
import type { NovelMeta } from "@/parsers/types";
import { GlobalNotes } from "../GlobalNotes";

const h = vi.hoisted(() => ({
  notes: [] as NoteItem[],
  novels: [] as NovelMeta[],
  loadAllNotes: vi.fn(),
  loadAllNovelMeta: vi.fn(),
  deleteNote: vi.fn(async () => {}),
  pushNow: vi.fn(),
  confirm: vi.fn(() => true as boolean),
}));

vi.mock("@/db/repositories", () => ({
  loadAllNotes: h.loadAllNotes,
  loadAllNovelMeta: h.loadAllNovelMeta,
  deleteNote: h.deleteNote,
}));
vi.mock("@/sync/sync-client", () => ({ syncClient: { pushNow: h.pushNow } }));

/** 正好 100 字／101 字：用来卡「超过 100 才有展开」那一格的下边界 */
const EXACT_100 = "落".repeat(100);
const EXACT_101 = "潮".repeat(100) + "声";

// 本地时间构造，渲染回去也是本地时间 → 期望串与时区无关（实测：2024/1/2 13:05:00）
const TS_UPD_SNOW = new Date(2024, 0, 2, 13, 5, 0).getTime();
const TS_CRT_SNOW = new Date(2023, 10, 5, 8, 30, 0).getTime();
const TS_CRT_ORPHAN = new Date(2022, 5, 1, 9, 0, 0).getTime();
/** 每条笔记各用一个**不同**的时间戳：拿 `getByText` 取日期时才不会撞在一起 */
const TS_OTHER = [
  new Date(2024, 2, 3, 4, 5, 6).getTime(),
  new Date(2024, 6, 7, 8, 9, 10).getTime(),
  new Date(2025, 0, 1, 2, 3, 4).getTime(),
];
const DATE_SNOW = "2024/1/2 13:05:00";
const DATE_CRT_SNOW = "2023/11/5 08:30:00";
const DATE_ORPHAN = "2022/6/1 09:00:00";

function note(over: Partial<NoteItem> & { id: string }): NoteItem {
  return {
    novelId: "nv-a",
    chapterId: "c-1",
    chapterTitle: "第一章",
    content: "默认正文",
    source: "user",
    sourceLabel: "手动",
    createdAt: TS_CRT_SNOW,
    updatedAt: TS_UPD_SNOW,
    ...over,
  };
}

function meta(id: string, title: string): NovelMeta {
  return {
    id,
    title,
    fileName: `${id}.txt`,
    fileFormat: "txt",
    totalChars: 1234,
    chapterCount: 7,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * 夹具故意**不**按 id／novelId／时间排序：任何"按下标取那条"的写法在这里必红。
 * `n-orphan` 的书不在 novels 里（书名兜底 + 搜索不许抛错就靠它）。
 */
const NOTES: NoteItem[] = [
  note({
    id: "n-snow",
    novelId: "nv-b",
    chapterTitle: "第十二章 雪线",
    content: "雪线之上的驿站没有灯火",
    createdAt: TS_CRT_SNOW,
    updatedAt: TS_UPD_SNOW,
  }),
  note({ id: "n-ship", chapterTitle: "第一章 出航", content: "Sword 与帆同时升起", source: "ai", updatedAt: TS_OTHER[0] }),
  note({
    id: "n-orphan",
    novelId: "nv-zz",
    chapterTitle: "第七章 归途",
    content: "归途上没人说话",
    createdAt: TS_CRT_ORPHAN,
    updatedAt: 0,
  }),
  note({ id: "n-edge100", chapterTitle: "第二章 落雁", content: EXACT_100, updatedAt: TS_OTHER[1] }),
  note({
    id: "n-edge101",
    novelId: "nv-b",
    chapterTitle: "第三章 长夜",
    content: EXACT_101,
    source: "ai",
    updatedAt: TS_OTHER[2],
  }),
];

const NOVELS: NovelMeta[] = [meta("nv-b", "剑歌行"), meta("nv-a", "沧海云帆")];

/** 两发加载都是 promise：把 microtask 跑干，断言才对着稳定态 */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function setup() {
  const onBack = vi.fn();
  render(<GlobalNotes onBack={onBack} />);
  await flush();
  return { onBack };
}

const count = () => screen.getByText(/^\(\d+\)$/);
/** 正文那一段 `<p>`：`getByText` 拿到的就是它自己，closest 只是兜一手 */
const body = (text: string) => screen.getByText(text).closest("p") as HTMLElement;
/** 一张卡片的左半（徽章 / 书名 / 章名 / 正文 / 展开都在这只容器里） */
const cardOf = (text: string) => body(text).closest("div.min-w-0") as HTMLElement;
const expandBtnOf = (text: string) => cardOf(text).querySelector("button.mt-1") as HTMLButtonElement;
const cards = () => screen.getAllByRole("button", { name: /^删除笔记 / });
const cardCount = () => screen.queryAllByRole("button", { name: /^删除笔记 / }).length;

beforeEach(() => {
  vi.clearAllMocks();
  h.notes = NOTES.map((n) => ({ ...n }));
  h.novels = NOVELS.map((n) => ({ ...n }));
  h.loadAllNotes.mockImplementation(async () => h.notes);
  h.loadAllNovelMeta.mockImplementation(async () => h.novels);
  // jsdom 的 window.confirm 是"未实现"，不装桩恒返回 undefined ——
  // "取消就不删"那条会假绿（桩没装上等于永远取消）
  vi.stubGlobal("confirm", h.confirm);
  h.confirm.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GlobalNotes · 两发加载各归各位", () => {
  it("挂载时笔记与书名各发一发，且只发一次", async () => {
    await setup();
    expect(h.loadAllNotes).toHaveBeenCalledTimes(1);
    expect(h.loadAllNovelMeta).toHaveBeenCalledTimes(1);
  });

  it("列表来自 loadAllNotes，下拉的选项来自 loadAllNovelMeta（两发串了就红）", async () => {
    await setup();
    expect(screen.getByText("雪线之上的驿站没有灯火")).toBeInTheDocument();
    expect(count()).toHaveTextContent("(5)");
    const sel = screen.getByRole("combobox", { name: "按小说筛选" }) as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["全部小说", "剑歌行", "沧海云帆"]);
  });

  it("下拉项的 value 是书的 id，不是标题（按标题取值筛不出东西）", async () => {
    await setup();
    const sel = screen.getByRole("combobox", { name: "按小说筛选" }) as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["all", "nv-b", "nv-a"]);
  });

  it("「返回」把外壳的 onBack 喊一次，自己不猜路由", async () => {
    const { onBack } = await setup();
    fireEvent.click(screen.getByRole("button", { name: /返回/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("GlobalNotes · 三个筛子是 AND，且每筛自己会重算", () => {
  it("按小说筛：只留那本的笔记，计数跟着筛子走", async () => {
    await setup();
    fireEvent.change(screen.getByRole("combobox", { name: "按小说筛选" }), { target: { value: "nv-b" } });
    await flush();
    expect(screen.getByText("雪线之上的驿站没有灯火")).toBeInTheDocument();
    expect(screen.queryByText("Sword 与帆同时升起")).toBeNull();
    expect(count()).toHaveTextContent("(2)");
  });

  it("按来源筛 user 与 ai 各一次：AI 那两条留下，手动那三条消失", async () => {
    await setup();
    const sel = screen.getByRole("combobox", { name: "按来源筛选" });
    fireEvent.change(sel, { target: { value: "ai" } });
    await flush();
    expect(count()).toHaveTextContent("(2)");
    expect(screen.getByText("Sword 与帆同时升起")).toBeInTheDocument();
    expect(screen.queryByText("雪线之上的驿站没有灯火")).toBeNull();
    fireEvent.change(sel, { target: { value: "user" } });
    await flush();
    expect(count()).toHaveTextContent("(3)");
    expect(screen.queryByText("Sword 与帆同时升起")).toBeNull();
    fireEvent.change(sel, { target: { value: "all" } });
    await flush();
    expect(count()).toHaveTextContent("(5)");
  });

  it("来源下拉摆的就是这三档（全部来源 / 用户笔记 / AI 笔记）", async () => {
    await setup();
    const sel = screen.getByRole("combobox", { name: "按来源筛选" }) as HTMLSelectElement;
    expect([...sel.options].map((o) => `${o.value}:${o.textContent}`)).toEqual([
      "all:全部来源",
      "user:用户笔记",
      "ai:AI 笔记",
    ]);
  });

  it("搜正文命中（命中的是 content，不是章名也不是书名）", async () => {
    await setup();
    fireEvent.change(screen.getByPlaceholderText("搜索笔记内容、章节、书名..."), {
      target: { value: "驿站" },
    });
    await flush();
    expect(count()).toHaveTextContent("(1)");
    expect(screen.getByText("雪线之上的驿站没有灯火")).toBeInTheDocument();
  });

  it("搜章节名命中（正文里没有这四个字）", async () => {
    await setup();
    fireEvent.change(screen.getByPlaceholderText("搜索笔记内容、章节、书名..."), {
      target: { value: "出航" },
    });
    await flush();
    expect(count()).toHaveTextContent("(1)");
    expect(screen.getByText("Sword 与帆同时升起")).toBeInTheDocument();
  });

  it("搜书名命中（笔记正文与章名里都没有「沧海」）", async () => {
    await setup();
    fireEvent.change(screen.getByPlaceholderText("搜索笔记内容、章节、书名..."), {
      target: { value: "沧海" },
    });
    await flush();
    expect(count()).toHaveTextContent("(2)");
    expect(screen.getByText("Sword 与帆同时升起")).toBeInTheDocument();
    expect(screen.getByText(EXACT_100)).toBeInTheDocument();
  });

  it("搜索不分大小写：小写 sword 命中正文里大写的 Sword", async () => {
    await setup();
    fireEvent.change(screen.getByPlaceholderText("搜索笔记内容、章节、书名..."), {
      target: { value: "sword" },
    });
    await flush();
    expect(count()).toHaveTextContent("(1)");
  });

  it("只敲空格不算搜索：列表不许被三个空格清空", async () => {
    await setup();
    fireEvent.change(screen.getByPlaceholderText("搜索笔记内容、章节、书名..."), {
      target: { value: "   " },
    });
    await flush();
    expect(count()).toHaveTextContent("(5)");
    expect(screen.queryByText("没有匹配的笔记")).toBeNull();
  });

  it("三筛叠加是 AND：同时满足三段的只剩一条", async () => {
    await setup();
    fireEvent.change(screen.getByRole("combobox", { name: "按小说筛选" }), { target: { value: "nv-b" } });
    fireEvent.change(screen.getByRole("combobox", { name: "按来源筛选" }), { target: { value: "ai" } });
    await flush();
    expect(count()).toHaveTextContent("(1)");
    expect(screen.getByText(EXACT_101)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("搜索笔记内容、章节、书名..."), {
      target: { value: "雪线" },
    });
    await flush();
    expect(count()).toHaveTextContent("(0)");
    expect(screen.getByText("没有匹配的笔记")).toBeInTheDocument();
  });

  it("书已被删（novelId 查不到）时按书名搜索不许整屏抛错", async () => {
    await setup();
    fireEvent.change(screen.getByPlaceholderText("搜索笔记内容、章节、书名..."), {
      target: { value: "归途" },
    });
    await flush();
    expect(count()).toHaveTextContent("(1)");
    expect(screen.getByText("归途上没人说话")).toBeInTheDocument();
  });
});

describe("GlobalNotes · 空态的两种话", () => {
  it("库里真没有笔记说「暂无笔记」", async () => {
    h.notes = [];
    await setup();
    expect(screen.getByText("暂无笔记")).toBeInTheDocument();
    expect(screen.queryByText("没有匹配的笔记")).toBeNull();
    expect(count()).toHaveTextContent("(0)");
  });

  it("有笔记但被筛掉说「没有匹配的笔记」，不许吓用户说没有笔记", async () => {
    await setup();
    fireEvent.change(screen.getByPlaceholderText("搜索笔记内容、章节、书名..."), {
      target: { value: "这四个字谁都没有" },
    });
    await flush();
    expect(screen.getByText("没有匹配的笔记")).toBeInTheDocument();
    expect(screen.queryByText("暂无笔记")).toBeNull();
  });
});

describe("GlobalNotes · 一张卡片自己管的东西", () => {
  it("AI 笔记挂「AI」，手动笔记挂「笔记」，各归各的卡", async () => {
    await setup();
    expect(cardOf("Sword 与帆同时升起")).toHaveTextContent("AI");
    expect(cardOf("雪线之上的驿站没有灯火")).toHaveTextContent("笔记");
    expect(screen.getAllByText("AI")).toHaveLength(2);
    expect(screen.getAllByText("笔记")).toHaveLength(3);
  });

  it("卡片上的书名取自 novelMap，查不到的兜底成「未知小说」", async () => {
    await setup();
    expect(cardOf("雪线之上的驿站没有灯火")).toHaveTextContent("剑歌行");
    expect(cardOf("Sword 与帆同时升起")).toHaveTextContent("沧海云帆");
    expect(cardOf("归途上没人说话")).toHaveTextContent("未知小说");
    expect(cardOf("归途上没人说话")).not.toHaveTextContent("nv-zz");
  });

  it("章名上屏", async () => {
    await setup();
    expect(cardOf("雪线之上的驿站没有灯火")).toHaveTextContent("第十二章 雪线");
    expect(cardOf(EXACT_101)).toHaveTextContent("第三章 长夜");
  });

  it("日期取 updatedAt（有更新就用更新的那次，不是创建那次）", async () => {
    await setup();
    const card = cardOf("雪线之上的驿站没有灯火");
    expect(card).toHaveTextContent(DATE_SNOW);
    expect(card.textContent).not.toContain(DATE_CRT_SNOW);
  });

  it("updatedAt 为 0 才退回 createdAt", async () => {
    await setup();
    expect(cardOf("归途上没人说话")).toHaveTextContent(DATE_ORPHAN);
  });

  it("日期钉中文格式：年在最前、时分秒带冒号（本机摘掉 zh-CN 是等价变异，这一条防的是别的机器）", async () => {
    await setup();
    const shown = cardOf("雪线之上的驿站没有灯火").textContent!.match(/\d{4}\/\d{1,2}\/\d{1,2}[^ ]* [0-9:]+/)![0];
    expect(shown).toBe(DATE_SNOW);
    expect(shown).toMatch(/^\d{4}\//);
    expect(shown).toMatch(/:\d{2}:\d{2}$/);
  });

  it("正文正好 100 字不画「展开」，101 字才画", async () => {
    await setup();
    expect(EXACT_100).toHaveLength(100);
    expect(EXACT_101).toHaveLength(101);
    expect(screen.queryAllByText("展开")).toHaveLength(1);
    fireEvent.click(expandBtnOf(EXACT_101));
    await flush();
    expect(screen.getAllByText("收起")).toHaveLength(1);
  });
});

describe("GlobalNotes · 展开状态存在按 id 的集合里", () => {
  it("折叠时段落带 line-clamp-2，展开后不带", async () => {
    await setup();
    expect(body(EXACT_101)).toHaveClass("line-clamp-2");
    fireEvent.click(expandBtnOf(EXACT_101));
    await flush();
    expect(body(EXACT_101)).not.toHaveClass("line-clamp-2");
  });

  it("展开一条不影响别的条（状态按 id，不是全局开关）", async () => {
    await setup();
    fireEvent.click(expandBtnOf(EXACT_101));
    await flush();
    expect(body(EXACT_101)).not.toHaveClass("line-clamp-2");
    expect(body("Sword 与帆同时升起")).toHaveClass("line-clamp-2");
  });

  it("再点一次收起，第三次再展开（Set 的删与加两条分支都走）", async () => {
    await setup();
    const btn = expandBtnOf(EXACT_101);
    fireEvent.click(btn);
    await flush();
    expect(body(EXACT_101)).not.toHaveClass("line-clamp-2");
    fireEvent.click(expandBtnOf(EXACT_101));
    await flush();
    expect(body(EXACT_101)).toHaveClass("line-clamp-2");
    expect(expandBtnOf(EXACT_101)).toHaveTextContent("展开");
    fireEvent.click(expandBtnOf(EXACT_101));
    await flush();
    expect(body(EXACT_101)).not.toHaveClass("line-clamp-2");
    expect(expandBtnOf(EXACT_101)).toHaveTextContent("收起");
  });

  it("展开状态在删除别的笔记之后仍然按 id 认（不是按下标认）", async () => {
    await setup();
    fireEvent.click(expandBtnOf(EXACT_101));
    await flush();
    fireEvent.click(cards()[0]);
    await flush();
    expect(body(EXACT_101)).not.toHaveClass("line-clamp-2");
    expect(body("Sword 与帆同时升起")).toHaveClass("line-clamp-2");
  });
});

describe("GlobalNotes · 删除这一条链", () => {
  it("一枚删除按钮一条笔记，名字带「书名 + 章名」这两层上下文", async () => {
    await setup();
    expect(cardCount()).toBe(5);
    expect(screen.getByRole("button", { name: "删除笔记 剑歌行 第十二章 雪线" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除笔记 沧海云帆 第一章 出航" })).toBeTruthy();
    // 书已被删的那条兜底成「未知小说」，名字跟着屏上那行走，不露 novelId
    expect(screen.getByRole("button", { name: "删除笔记 未知小说 第七章 归途" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /nv-zz/ })).toBeNull();
  });

  it("确认框问的是那句写死的话", async () => {
    await setup();
    fireEvent.click(cards()[1]);
    await flush();
    expect(h.confirm).toHaveBeenCalledWith("确定删除这条笔记？");
  });

  it("点取消：不落库、列表不动、不 push", async () => {
    await setup();
    h.confirm.mockReturnValue(false);
    fireEvent.click(cards()[1]);
    await flush();
    expect(h.deleteNote).not.toHaveBeenCalled();
    expect(h.pushNow).not.toHaveBeenCalled();
    expect(count()).toHaveTextContent("(5)");
    expect(screen.getByText("Sword 与帆同时升起")).toBeInTheDocument();
  });

  it("确认之后删的是**点的那一条**的 id，别的一条不动", async () => {
    await setup();
    fireEvent.click(cards()[2]);
    await flush();
    expect(h.deleteNote).toHaveBeenCalledWith("n-orphan");
    expect(h.deleteNote).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("归途上没人说话")).toBeNull();
    expect(screen.getByText("Sword 与帆同时升起")).toBeInTheDocument();
    expect(count()).toHaveTextContent("(4)");
  });

  it("删完喊一次 pushNow（少了它另一台设备还留着这条）", async () => {
    await setup();
    fireEvent.click(cards()[0]);
    await flush();
    expect(h.pushNow).toHaveBeenCalledTimes(1);
  });

  it("筛选状态下删掉当前可见的那条，筛子照旧生效", async () => {
    await setup();
    fireEvent.change(screen.getByRole("combobox", { name: "按小说筛选" }), { target: { value: "nv-b" } });
    await flush();
    expect(cards()).toHaveLength(2);
    fireEvent.click(cards()[0]);
    await flush();
    expect(h.deleteNote).toHaveBeenCalledWith("n-snow");
    expect(count()).toHaveTextContent("(1)");
    expect(screen.getByText(EXACT_101)).toBeInTheDocument();
  });

  it("删到空之后文案换成「暂无笔记」（列表真的空了，不是被筛掉）", async () => {
    await setup();
    expect(cardCount()).toBe(5);
    // 循环带上限：万一"删完列表不动"，这条用例该红在该红的断言上，而不是把跑刀的人吊死在循环里
    for (let i = 0; i < 5 && cardCount() > 0; i++) {
      fireEvent.click(screen.getAllByRole("button", { name: /^删除笔记 / })[0]);
      await flush();
    }
    expect(h.deleteNote).toHaveBeenCalledTimes(5);
    expect(screen.getByText("暂无笔记")).toBeInTheDocument();
    expect(count()).toHaveTextContent("(0)");
  });
});

