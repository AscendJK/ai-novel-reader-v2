/**
 * `NovelCard` 卡片本体的直接判据（地板第 1 档·书架上那一本书，247 行）
 *
 * 这张卡是书架的主视觉，判断全在"进度算得对不对"与"这一本书此刻该说什么"两件事上：
 * 1) **进度算术**（`:49-52`、`:103-107`）：`readIndex + 1`（读到第 3 章就是 3/4 而不是 2/4）、
 *    `chapterCount > 0` 的除零闸、没读过是 0 且文案是「未开始阅读」；点卡片开书时
 *    没读过要从第 0 章起（`:57`）。
 * 2) **删除必须把事件交出去**（`:63`）：`NovelCard` 自己**不**挡冒泡——挡泡是调用方的事
 *    （`BookSelect.tsx:517` 第一句就是 `e.stopPropagation()`）。卡片一旦不传 event，
 *    调用方就没得挡，症状是"点删除先把书翻开"。
 * 3) **六档状态的优先级就是判断**（`:143-215`）：内存 → IndexedDB → 服务端就绪 → 构建中 →
 *    排队 → 失败 → 未构建；前三档全命中时必须说"已加载"（说"已缓存"是让读者以为还要读盘）。
 *    `buildStatuses` 缺这一本要落回 `{status:"none"}`（`:119`）而不是崩。
 * 4) **向量数与体积的拼法**（`:124-125`）：`chunkCount * dim * 4`——那个 4 是 float32 每维字节，
 *    写成 2 或 8 会让读者把缓存看成一半或两倍大。
 * 5) **`React.memo`**（`:45`）：书架几十上百张卡，阅读进度一上报就整片重渲染。
 *
 * ## 本档刻意没判的几格（别让"这只有测试了"盖住）
 * ① `:105` 的 `typeof progressPct === "number" ? ... : progressPct` —— `progressPct` 恒为 number，
 *    那半个三元是不可达分支（要清就整条清，判它等于给死路发钱）。
 * ② `:211` 未构建那一行的 `disabled={isBuilding || offlineMode}` 与「触发中...」文案 —— 构建中/排队
 *    早在 `:170`/`:181` 就 return 了，`isBuilding` 到这行恒为 false，也是不可达；**给了"删"的理由，
 *    不两头都判**。
 * ③ `:136-141` `handleBadgeClick` 里的 `if (buildStatus)` —— 挂了这个 handler 的三行（构建中/排队/失败）
 *    本身就要求 `buildStatus` 存在，摘掉判断没有任何可观察后果（防御，不是活路）。
 * ④ `formatCharCount` 的中文数量级口径归 `text-utils` 自己那档判（这里把它桩成可辨识字符串，
 *    只判"卡片把哪个数交给它"）；`fileFormat.toUpperCase()` 的产物只判"是 TXT/EPUB 两种大写"。
 *
 * ## 变异台账见文件末尾
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { NovelMeta } from "@/parsers/types";
import type { NovelBuildStatus } from "@/stores/build-store";

// ---------------------------------------------------------------- 依赖桩
const H = vi.hoisted(() => ({
  progressRenders: 0,
  progressValues: [] as unknown[],
  toggle: null as null | ((...args: unknown[]) => void),
  onOpen: null as null | ((...args: unknown[]) => void),
  onDelete: null as null | ((...args: unknown[]) => void),
  onBuild: null as null | ((...args: unknown[]) => void),
}));

vi.mock("@/components/ui/progress", async () => {
  const React0 = await import("react");
  return {
    Progress: (props: { value?: number }) => {
      H.progressRenders += 1;
      H.progressValues.push(props.value);
      return React0.createElement("div", { "data-testid": "progress" });
    },
  };
});
vi.mock("@/lib/text-utils", () => ({
  formatCharCount: (n: number) => `字数[${n}]`,
}));
vi.mock("@/rag/engines", () => ({
  getEngineDisplayName: (id: string) => `MOCK ${id}`,
}));
vi.mock("@/stores/build-store", () => ({
  useBuildStore: { getState: () => ({ toggleWindow: (...a: unknown[]) => H.toggle?.(...a) }) },
}));

import { NovelCard } from "../NovelCard";

type CardProps = ComponentProps<typeof NovelCard>;
type ServerStatus = CardProps["buildStatuses"][string][string];

const BGE = "Xenova/bge-small-zh-v1.5";

const meta = (over: Partial<NovelMeta> = {}): NovelMeta => ({
  id: "n1",
  title: "剑来",
  author: "烽火戏诸侯",
  fileName: "jianlai.txt",
  fileFormat: "txt",
  totalChars: 12345,
  chapterCount: 4,
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

const bs = (over: Partial<NovelBuildStatus>): NovelBuildStatus => ({
  novelId: "n1",
  engine: BGE,
  status: "idle",
  message: "",
  current: 0,
  total: 0,
  open: false,
  startTime: 0,
  lastUpdate: 0,
  ...over,
});

const ready = (over: Partial<ServerStatus> = {}): ServerStatus => ({
  status: "ready",
  chunkCount: 12,
  dim: 64,
  ...over,
} as ServerStatus);

const props = (over: Partial<CardProps> = {}): CardProps => ({
  novel: meta(),
  position: undefined,
  engine: BGE,
  lruKeys: new Set<string>(),
  cachedKeys: new Set<string>(),
  builds: new Map<string, NovelBuildStatus>(),
  buildStatuses: {},
  offlineMode: false,
  onOpen: (...a: unknown[]) => H.onOpen?.(...a),
  onDelete: (...a: unknown[]) => H.onDelete?.(...a),
  onBuild: (...a: unknown[]) => H.onBuild?.(...a),
  ...over,
});

const mount = (over: Partial<CardProps> = {}) => render(<NovelCard {...props(over)} />);
/** 卡片里唯一一只 Progress（已桩成 data-testid），它的 value 就是进度算术的读数 */
const pctText = () => screen.getByText(/%$/).textContent as string;
/** 这本书这一引擎的构建记录，键就是卡片取键的那把 */
const building = (st: Partial<NovelBuildStatus> = {}, id = "n1", engine = BGE) =>
  new Map([[`${id}-${engine}`, bs({ novelId: id, engine, ...st })]]);

beforeEach(() => {
  H.progressRenders = 0;
  H.progressValues = [];
  H.toggle = vi.fn();
  H.onOpen = vi.fn();
  H.onDelete = vi.fn();
  H.onBuild = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ================================================================ 进度算术
describe("读到哪、进度多少、点开来从哪一章", () => {
  it("没读过：未开始阅读 + 0.00% + 进度条给 0", () => {
    mount();
    expect(screen.getByText("未开始阅读")).toBeTruthy();
    expect(pctText()).toBe("0.00%");
    expect(H.progressValues).toEqual([0]);
  });

  it("已读至第 N 章要说 N（不是 N-1），进度按 (index+1)/总章数", () => {
    mount({ position: { chapterId: "c3", chapterIndex: 2 } });
    expect(screen.getByText("已读至第 3 章")).toBeTruthy();
    expect(pctText()).toBe("75.00%");
    expect(H.progressValues).toEqual([75]);
  });

  it("读到最后一章是 100%，不许溢出", () => {
    mount({ position: { chapterId: "c4", chapterIndex: 3 } });
    expect(pctText()).toBe("100.00%");
    expect(H.progressValues).toEqual([100]);
  });

  it("章数为 0（解析残缺）：进度取 0，不把 Infinity/NaN 上屏", () => {
    mount({ novel: meta({ chapterCount: 0 }), position: { chapterId: "c0", chapterIndex: 0 } });
    expect(pctText()).toBe("0.00%");
    expect(pctText()).not.toMatch(/Infinity|NaN/);
    expect(H.progressValues).toEqual([0]);
  });

  it("除不尽的写两位小数", () => {
    mount({ novel: meta({ chapterCount: 3 }), position: { chapterId: "c0", chapterIndex: 0 } });
    expect(pctText()).toBe("33.33%");
  });

  it("没读过：点卡片从第 0 章开", () => {
    mount();
    fireEvent.click(screen.getByText("《剑来》"));
    expect(H.onOpen).toHaveBeenCalledWith("n1", 0);
  });

  it("读过：点卡片从记录那一章开（不许从第 0 章重读）", () => {
    mount({ position: { chapterId: "c2", chapterIndex: 1 } });
    fireEvent.click(screen.getByText("《剑来》"));
    expect(H.onOpen).toHaveBeenCalledWith("n1", 1);
  });
});

// ================================================================ 卡面信息与删除出口
describe("卡面信息、徽章、删除那一枚把事件交出去", () => {
  it("书名带书名号、格式徽章大写、章数与字数各占一枚", () => {
    mount();
    expect(screen.getByText("《剑来》")).toBeTruthy();
    expect(screen.getByText("TXT")).toBeTruthy();
    expect(screen.getByText("4 章")).toBeTruthy();
    expect(screen.getByText("字数[12345]")).toBeTruthy();
  });

  it("文件名总在（读者靠它对上自己传的那个文件）", () => {
    mount({ novel: meta({ fileName: "第 3 卷.epub", fileFormat: "epub" }) });
    expect(screen.getByText("第 3 卷.epub")).toBeTruthy();
    expect(screen.getByText("EPUB")).toBeTruthy();
  });

  it("有作者才画作者那一行，没作者不画空行", () => {
    const sub = (root: HTMLElement) => root.querySelectorAll("p.text-xs.text-muted-foreground");
    const { unmount, container } = mount();
    expect(screen.getByText("烽火戏诸侯")).toBeTruthy();
    // 作者行 + 文件名行
    expect(sub(container)).toHaveLength(2);
    unmount();
    cleanup();
    const r2 = mount({ novel: meta({ author: undefined }) });
    expect(screen.queryByText("烽火戏诸侯")).toBeNull();
    expect(sub(r2.container)).toHaveLength(1);
  });

  it("删除按钮要有名可读（只有一枚图标的按钮）", () => {
    mount();
    expect(screen.getByRole("button", { name: "删除此书" })).toBeTruthy();
  });

  it("删除把事件、id、书名三件一起交给调用方", () => {
    const spy = vi.fn();
    H.onDelete = spy;
    mount({ novel: meta({ id: "n9", title: "长相思" }) });
    fireEvent.click(screen.getByRole("button", { name: "删除此书" }));
    const args = spy.mock.calls[0];
    expect(typeof args[0]).toBe("object");
    expect((args[0] as { stopPropagation?: unknown }).stopPropagation).toBeInstanceOf(Function);
    expect(args[1]).toBe("n9");
    expect(args[2]).toBe("长相思");
  });

  it("调用方挡了泡，删除就不该顺手把书翻开", () => {
    H.onDelete = (e: unknown) => (e as { stopPropagation: () => void }).stopPropagation();
    mount();
    fireEvent.click(screen.getByRole("button", { name: "删除此书" }));
    expect(H.onOpen).toHaveBeenCalledTimes(0);
  });

  it("卡片自己不挡泡：不挡就会同时开书（这条锁住契约的另一半）", () => {
    H.onDelete = () => {};
    mount();
    fireEvent.click(screen.getByRole("button", { name: "删除此书" }));
    expect(H.onOpen).toHaveBeenCalledTimes(1);
  });
});

// ================================================================ RAG 状态：优先级
describe("构建状态六档：谁先说话", () => {
  it("内存里就有：说「已加载」，不说「已缓存」也不说「就绪」", () => {
    mount({
      lruKeys: new Set([`n1-${BGE}`]),
      cachedKeys: new Set([`n1-${BGE}`]),
      buildStatuses: { n1: { [BGE]: ready() } },
    });
    expect(screen.getByText("BGE 已加载 · 12向量 · 3KB")).toBeTruthy();
    expect(screen.queryByText(/已缓存|就绪/)).toBeNull();
  });

  it("内存没有、IndexedDB 里有：说「已缓存」", () => {
    mount({ cachedKeys: new Set([`n1-${BGE}`]), buildStatuses: { n1: { [BGE]: ready() } } });
    expect(screen.getByText(/^BGE 已缓存/)).toBeTruthy();
  });

  it("只有服务端就绪：说「就绪」", () => {
    mount({ buildStatuses: { n1: { [BGE]: ready() } } });
    expect(screen.getByText(/^BGE 就绪/)).toBeTruthy();
  });

  it("服务端状态缺这一本：落回「未构建」，不崩", () => {
    mount();
    expect(screen.getByText("BGE 未构建")).toBeTruthy();
  });

  it("status 不是 ready 就不算就绪（idle 也要说未构建）", () => {
    mount({ buildStatuses: { n1: { [BGE]: { status: "idle" } } } });
    expect(screen.getByText("BGE 未构建")).toBeTruthy();
    expect(screen.queryByText(/就绪/)).toBeNull();
  });

  it("内存与缓存的键是 书 id + 引擎：别只引擎的命中不许顶到这一行", () => {
    mount({ lruKeys: new Set(["n1-Xenova/gte-small"]) });
    expect(screen.getByText("BGE 未构建")).toBeTruthy();
    expect(screen.queryByText(/已加载/)).toBeNull();
  });

  it("构建记录也按 书 id + 引擎 取：别只在构建不算这本在构建", () => {
    mount({ builds: building({ status: "building" }, "n2") });
    expect(screen.getByText("BGE 未构建")).toBeTruthy();
    expect(screen.queryByText(/构建中/)).toBeNull();
    cleanup();
    // 反向：光秃秃的书 id 也不算命中——键必须是 id + "-" + engine 两半都在
    mount({ builds: new Map([["n1", bs({ status: "building" })]]) });
    expect(screen.getByText("BGE 未构建")).toBeTruthy();
  });
});

// ================================================================ 向量数与体积
describe("向量数与体积怎么拼", () => {
  it("每维按 float32 的 4 字节算（写成 2 或 8 读者就把缓存看错一半）", () => {
    mount({ buildStatuses: { n1: { [BGE]: ready({ chunkCount: 1000, dim: 64 }) } } });
    expect(screen.getByText("BGE 就绪 · 1000向量 · 250KB")).toBeTruthy();
  });

  it("一万条起用 k，边界那一格也算 k", () => {
    mount({ buildStatuses: { n1: { [BGE]: ready({ chunkCount: 10000, dim: 1 }) } } });
    expect(screen.getByText("BGE 就绪 · 10.0k向量 · 39KB")).toBeTruthy();
  });

  it("过 1MB 换 MB", () => {
    mount({ buildStatuses: { n1: { [BGE]: ready({ chunkCount: 4096, dim: 64 }) } } });
    expect(screen.getByText("BGE 就绪 · 4096向量 · 1.0MB")).toBeTruthy();
  });

  it("一千零二十四字节那一格还写 KB，不许提前进 MB", () => {
    mount({ buildStatuses: { n1: { [BGE]: ready({ chunkCount: 1, dim: 256 }) } } });
    expect(screen.getByText("BGE 就绪 · 1向量 · 1KB")).toBeTruthy();
  });

  it("一条向量都没有就别拼 stats（「0向量 · 0B」是废话）", () => {
    mount({ lruKeys: new Set([`n1-${BGE}`]) });
    expect(screen.getByText("BGE 已加载")).toBeTruthy();
    expect(screen.queryByText(/向量/)).toBeNull();
  });

  it("引擎短名认得四种关键词", () => {
    const cases: [string, string][] = [
      ["Xenova/bge-small-zh-v1.5", "BGE"],
      ["Xenova/gte-small", "GTE"],
      ["intfloat/multilingual-e5-large", "E5"],
      ["sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", "MiniLM"],
    ];
    for (const [engine, label] of cases) {
      cleanup();
      mount({ engine });
      expect(screen.getByText(`${label} 未构建`)).toBeTruthy();
    }
  });

  it("认不出的引擎只取展示名的第一个词", () => {
    mount({ engine: "custom/my-model" });
    expect(screen.getByText("MOCK 未构建")).toBeTruthy();
  });
});

// ================================================================ 构建中 / 排队 / 失败 / 未构建
describe("在跑的、排队的、炸过的、还没动手的", () => {
  it("building / loading / encoding 三种都算「构建中」并带转圈", () => {
    for (const status of ["building", "loading", "encoding"] as const) {
      cleanup();
      mount({ builds: building({ status }) });
      expect(screen.getByText("BGE 构建中...")).toBeTruthy();
      expect(document.querySelector("svg.animate-spin")).toBeTruthy();
    }
  });

  it("排队要说第几位，报不出位置就写问号（别显示「排队第 undefined 位」）", () => {
    const { unmount } = mount({ builds: building({ status: "queued", queuePosition: 3 }) });
    expect(screen.getByText("排队第 3 位")).toBeTruthy();
    unmount();
    cleanup();
    mount({ builds: building({ status: "queued" }) });
    expect(screen.getByText("排队第 ? 位")).toBeTruthy();
  });

  it("排队那一发不许转圈（它在等队，不在算）", () => {
    mount({ builds: building({ status: "queued", queuePosition: 1 }) });
    expect(document.querySelector("svg.animate-spin")).toBeNull();
  });

  it("失败要说「失败」并给重试，重试走 onBuild 且不许顺手开书", () => {
    mount({ builds: building({ status: "error", error: "炸了" }) });
    expect(screen.getByText("BGE 失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(H.onBuild).toHaveBeenCalledWith("n1");
    expect(H.onOpen).toHaveBeenCalledTimes(0);
  });

  it("离线时失败那一行改口叫「离线」并按住", () => {
    mount({ builds: building({ status: "error" }), offlineMode: true });
    const btn = screen.getByRole<HTMLButtonElement>("button", { name: "离线" });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(H.onBuild).toHaveBeenCalledTimes(0);
  });

  it("未构建那一行给「构建」，点它走 onBuild 且不开书", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "构建" }));
    expect(H.onBuild).toHaveBeenCalledWith("n1");
    expect(H.onOpen).toHaveBeenCalledTimes(0);
  });

  it("离线时未构建要说「离线不可用」并按住构建", () => {
    mount({ offlineMode: true });
    expect(screen.getByText("BGE 离线不可用")).toBeTruthy();
    const btn = screen.getByRole<HTMLButtonElement>("button", { name: "离线" });
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(H.onBuild).toHaveBeenCalledTimes(0);
  });

  it("点状态那一行只开窗，不许开书；开的是这本书这个引擎", () => {
    mount({ builds: building({ status: "building" }) });
    fireEvent.click(screen.getByText("BGE 构建中..."));
    expect(H.toggle).toHaveBeenCalledWith("n1", BGE);
    expect(H.onOpen).toHaveBeenCalledTimes(0);
  });

  it("失败那一行的字也要能点开状态窗", () => {
    mount({ builds: building({ status: "error" }) });
    fireEvent.click(screen.getByText("BGE 失败"));
    expect(H.toggle).toHaveBeenCalledWith("n1", BGE);
  });
});

// ================================================================ TF-IDF 那一支
describe("tfidf 引擎走另一支，不碰 RAG 那一块", () => {
  it("引擎是 tfidf：RAG 那一块与空行都不画", () => {
    const { container } = mount({ engine: "tfidf" });
    expect(screen.queryByText(/BGE|未构建|构建中/)).toBeNull();
    expect(screen.queryByText(/TF-IDF/)).toBeNull();
    // 只判文字看不见"摆了一条空行"：状态行都带 border-t，没状态就该一条也没有
    expect(container.querySelectorAll(".border-t")).toHaveLength(0);
  });

  it("tfidf 在内存里说「已加载」", () => {
    mount({ engine: "tfidf", lruKeys: new Set(["n1-tfidf"]) });
    expect(screen.getByText("TF-IDF 已加载")).toBeTruthy();
  });

  it("tfidf 只在 IndexedDB 里说「已缓存」", () => {
    mount({ engine: "tfidf", cachedKeys: new Set(["n1-tfidf"]) });
    expect(screen.getByText("TF-IDF 已缓存")).toBeTruthy();
  });

  it("tfidf 的命中也按 书 id + tfidf 这把键", () => {
    mount({ engine: "tfidf", lruKeys: new Set(["n2-tfidf"]) });
    expect(screen.queryByText(/TF-IDF/)).toBeNull();
  });
});

// ================================================================ memo
describe("memo：整片书架不许跟着进度上报重画", () => {
  const base = props();

  function Shelf({ tick }: { tick: number }) {
    return (
      <div data-tick={tick}>
        <NovelCard {...base} />
      </div>
    );
  }

  it("卡片自己的 props 一件没变：父级重渲染不许重画", () => {
    const { rerender } = render(<Shelf tick={0} />);
    expect(H.progressRenders).toBe(1);
    rerender(<Shelf tick={1} />);
    rerender(<Shelf tick={2} />);
    expect(H.progressRenders).toBe(1);
  });

  it("书名变了必须重画（memo 不许把该画的也钉住）", () => {
    const { rerender } = render(<NovelCard {...props()} />);
    rerender(<NovelCard {...props({ novel: meta({ title: "剑来第二部" }) })} />);
    expect(H.progressRenders).toBe(2);
    expect(screen.getByText("《剑来第二部》")).toBeTruthy();
  });
});

/* ================================================================ 变异台账

产品代码基线：src/components/layout/NovelCard.tsx，sha256 前 8 位 `ad4a89d6`（10609 字节），全程一行未改。
控制组 43 条全绿。每一刀 = 一次手改 + 一次全跑，跑完立刻按字节基线还原；33 轮全部 markers=1、
transform_failed=0、还原后 diff_lines=0、SHA 当场核回 `ad4a89d6`。**这一只没有一轮 0 红。**

| 刀 | 改了什么 | 红了什么 |
| --- | --- | --- |
| N1 | 进度少算一章（`(readIndex+1)` 去掉 `+1`） | 75%/100%/33.33% 三条 |
| N2 | 摘掉 `chapterCount > 0` 除零闸 | 「章数为 0 不把 NaN 上屏」 |
| N3 | `readIndex >= 0` 改成 `> 0`（第 1 章不算读过） | 「除不尽的写两位小数」 |
| N4 | 没读过时开书落在第 1 章 | 「没读过从第 0 章开」 |
| N5 | 「已读至第 N 章」少报一章（N1 的另一半：文案与算术是两个位点） | 「已读至第 N 章要说 N」 |
| N6 | 摘掉删除按钮的 `title` | 删除那一组 4 条（全部靠可访问名定位） |
| N7 | `onDelete` 只交事件，id 与书名丢了 | 「事件、id、书名三件一起交出去」 |
| N8 | 摘掉作者闸，没作者也摆一行 | 「没作者不画空行」（数 `<p>` 那半句咬住的） |
| N9 | 内存/IndexedDB 两档顺序颠倒 | 「内存里就有就说已加载」 |
| N10 | `onServer` 从 `=== "ready"` 松成 `!== "none"` | 「idle 也不算就绪」 |
| N11 | `buildStatuses` 缺这一本时默认当就绪 | 13 条（这一格喂着整块状态） |
| N12 | 内存/缓存命中键不看引擎 | 已加载 / 已缓存 / 别拼 stats 3 条 |
| N13 | 构建记录键不看引擎 | 5 条 |
| N13b | 同上，判据补上反向那一格后重跑 | 6 条（多出「光秃秃的书 id 不算命中」） |
| N14 | `chunkCount * dim * 4` 写成 `* 2` | 体积与 stats 5 条 |
| N15 | 计数 `>= 10000` 改 `> 10000` | 「一万那一格也算 k」 |
| N16 | MB 档 `>= 1048576` 改 `>` | 「过 1MB 换 MB」 |
| N17 | KB 档 `>= 1024` 改 `>` | 「正好 1024B 仍写 KB」 |
| N18 | 零条向量也拼 stats | 「别拼 0向量 · 0B」 |
| N19 | 短名链里不再认 MiniLM | 「四种关键词」 |
| N20 | 兜底不再 `.split(" ")[0]` | 「只取展示名第一个词」 |
| N21 | `encoding` 不算构建中 | 「三种状态都算构建中」 |
| N22 | 排队位置报不出时空着（去掉 `\|\| "?"`） | 「报不出就写问号」 |
| N23 | 排队那一发也转圈 | 「排队不许转圈」 |
| N24 | 离线时重试不再 disabled | 「离线那一行按住」 |
| N25 | 离线时按钮文案仍写「重试」 | 「离线时改口叫离线」 |
| N26 | `handleBadgeClick` 不再挡泡 | 「点状态行只开窗不许开书」 |
| N27 | `toggleWindow` 两个参数互换 | 2 条（开窗对象与引擎都要对得上） |
| N28 | 「构建」按钮不再挡泡 | 「点构建走 onBuild 且不开书」 |
| N29 | RAG 那一块不再排除 tfidf | 「引擎是 tfidf 时不画 RAG」 |
| N30 | tfidf 两处都没命中时摆一条空行 | 「什么都不画」——这条靠数 `border-t` 咬住，只判文字看不见空行 |
| N31 | `React.memo` 比较器恒 false（永不命中） | 「props 没变不许重画」 |
| N32 | `React.memo` 比较器恒 true（永远命中） | 「书名变了必须重画」 |

**两处中途加强判据**（都不是产品的错，是我第一版判得不够狠）：
① N13 只判了"别只引擎的命中不算"，反向（光秃秃 id）没判 → 补一条 → N13b 从 5 红变 6 红。
② tfidf「什么都不画」原来只查文字——空行没有文字，`return null` 换成画一条空 `<div>` 照样绿；
   改成数卡片里的 `border-t` 条数（N30 才咬得住）。**"没有文字"与"没有元素"是两件事。**

跑刀途中自己废掉的一次编辑：N28 第一版把 `</Button>` 提前写进了标记里（会整只文件解析失败），
另一版把 `//` 注释落在 JSX 子节点位置（会当文字画出来）——两处都在跑之前用 `git diff --numstat` 与
读回文件拦下，没有留下假绿轮次。
*/
