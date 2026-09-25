/**
 * CharacterGraph 本体的判别力测试（地板第 1 档）
 *
 * 这只 496 行的组件此前只被"转手"碰过：`graph-autolink-hint.test.tsx` 从
 * `CharacterGraphSection` 进去，判的是那句「兜底关系链」的提示文案；`BookTab-internals`
 * 判的是它下面的 props。它自己管的事一条都没有直接判据，而里面最狠的几个坏法都是**静默**的：
 *
 * 1) **布局算完没有**：d3 的 tick 是分帧跑的（300 次 / 每帧 50 次），`setSimData` 只在最后一帧
 *    落一次。任何"少一个分支"都会让屏上永远停在那句「计算布局中...」——图谱看起来在转，其实死了。
 * 2) **模型给的边引用不存在的人物**（图谱幻觉的常见形状）：那一条必须被丢掉。丢掉它的 `.filter`
 *    一摘，`forceLink` 当场抛，effect 崩，整个图谱区连"计算中"都不剩。
 * 3) **viewBox 与卡片高度是从真实节点位置算出来的**：换成写死的 800×600 / 定高，图会被裁掉一半
 *    或者缩成一条缝，界面上只是一张"有点小的图"，没人会报。
 * 4) **tooltip 定位必须拿鼠标的屏幕坐标**，不能拿节点在 SVG 里的坐标（容器带 `overflow-hidden`，
 *    SVG 坐标既会被裁切又和视口不是一个尺度——旧账"文档坐标是个天生失灵的哨兵"同一族）。
 * 5) **缩放有三条入口**（按钮、滚轮、双指），每一条都得夹在 0.3~10；夹漏一条就是"图缩没了"。
 *
 * 手法：`requestAnimationFrame` 排住手动冲（分块 tick 与那三处 rAF 收尾都在真调度器上抖）；
 * 所有定位都作用在**具体一层**（inline 卡片 / `fixed inset-0` 大图）上——这个组件展开时
 * 是两份 SVG 同时在屏上，拿 `getByText` 全局查一律犯严格模式（旧账记过）。
 *
 * 未判、留给别处的格（写清楚，别让"这只有测试了"盖住它们）：
 * - 「导出图片」整条（`:74-128`）：要 `XMLSerializer` + `Image.onload` + `canvas.toBlob`，
 *   jsdom 里画不出像素，判它只能判"调了几个 mock"。这一格归浏览器层，目前没有人判。
 * - 「导出 JSON」的**内容**只有 `handleExportJson` 里 `JSON.stringify(graphData, null, 2)` 一处，
 *   本批改判它"导出的是传进来的那一份 graphData（含 `autoLinked` 标记）"，但不判下载动作。
 * - d3 布局本身收敛得好不好（重叠、边长）不属于判据，是产品调参。
 * - 真实双指手势的 `touchAction`/`preventDefault` 在 jsdom 里不产生滚动后果，只判了状态换算。
 * - `aspectRatio = viewH > 0 ? viewW / viewH : 1` 里那**一支 1 永不可达**（`viewH` 至少是
 *   `2*pad = 100`），本批没判它、也没顺手删它——它是那种"看着像防御其实死支"的形状，
 *   要清就单独一笔，别混在补判据里。
 * - 布局是否真的好看（节点重叠、边交叉）不判：初值是 `Math.random()` 撒的，判它=判 d3。
 *
 * 变异台账在文件末尾的注释里（每刀手动一次一处，跑完 `cp` 字节还原并核 SHA256）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { CharacterGraph } from "../CharacterGraph";
import type { GraphData } from "@/hooks/useSummarizer";

// ── rAF 排住手动冲 ──
let frames: Map<number, (t: number) => void>;
let frameId = 0;
function stepFrames(times = 1) {
  for (let i = 0; i < times; i++) {
    const due = [...frames.values()];
    frames.clear();
    act(() => {
      due.forEach((cb) => cb(performance.now()));
    });
  }
}

/** 一直冲到布局落地（或帧数用完），返回用了几帧 */
function settle(maxFrames = 40): number {
  let used = 0;
  while (used < maxFrames && screen.queryByText("计算布局中...")) {
    stepFrames(1);
    used++;
  }
  return used;
}

function graph(nodes: GraphData["nodes"], edges: GraphData["edges"]): GraphData {
  return { nodes, edges };
}

const THREE = graph(
  [
    { id: "令狐冲", group: "主角", description: "华山派大弟子" },
    { id: "任盈盈", group: "配角", description: "日月神教圣姑" },
    { id: "岳不群", group: "反派", description: "华山派掌门" },
  ],
  [
    { source: "令狐冲", target: "任盈盈", label: "恋人" },
    { source: "令狐冲", target: "岳不群", label: "师徒" },
  ]
);

/** 冲掉挂载时那发初值 rAF，并等布局落地；返回 inline 那张卡片容器 */
function mountInline(g: GraphData = THREE) {
  const { container } = render(<CharacterGraph graphData={g} />);
  stepFrames(1); // 展开状态那个 rAF 复位（组件初值靠它，装表后要拨一帧）
  settle();
  return container;
}

/** inline 卡片是带 style.height 的那一层；大图是 fixed inset-0 那一层 */
function inlineCard(container: HTMLElement): HTMLElement {
  const el = container.querySelector("div[style*='height']") as HTMLElement | null;
  if (!el) throw new Error("台架：找不到 inline 卡片层");
  return el;
}
function expandedLayer(container: HTMLElement): HTMLElement {
  const el = container.querySelector("div.fixed.inset-0") as HTMLElement | null;
  if (!el) throw new Error("台架：大图层没挂上");
  return el;
}
function nodePositions(card: HTMLElement): Array<{ x: number; y: number }> {
  // 只认节点本体（r=14 是非展开档的半径），描述命中区那只 r=28 不算
  return [...card.querySelectorAll("circle") ]
    .filter((c) => c.getAttribute("r") === "14")
    .map((c) => ({ x: Number(c.getAttribute("cx")), y: Number(c.getAttribute("cy")) }));
}

/**
 * 那一层里的"图谱 svg"——不能用 `querySelector("svg")`：顶栏三枚图标按钮各自带一只
 * `viewBox="0 0 24 24"` 的 svg，会先被命中（这一条在本批第一次跑就咬到我：读出宽度 24）。
 * 图谱 svg 的唯一身份是 `preserveAspectRatio="xMidYMid meet"`。
 */
function graphSvg(scope: HTMLElement): SVGSVGElement {
  const svg = scope.querySelector('svg[preserveAspectRatio="xMidYMid meet"]') as SVGSVGElement | null;
  if (!svg) throw new Error("台架：找不到那张图谱 svg");
  return svg;
}

/**
 * 把布局的**初值散布**钉下来，再一路冲到落地。
 *
 * 产品拿 `Math.random()` 撒每个节点的初值（`CharacterGraph.tsx:151`），所以"这张图最后是扁
 * 还是长"不是数据的性质，是随机数的性质。上一版我用"两个节点没有 y"去造扁图，那个 y 当场
 * 被产品覆掉——量出来的 320 是随机给的，不是夹紧给的（这就是把夹具的巧合当成判据的下场）。
 * 这里按调用顺序把随机数钉成给定序列（前两个数＝第 1 个节点的 x/y，后两个＝第 2 个）；
 * 四种力（link/charge/center/collide）对这条线完全对称，落点必然还在上面。
 * 判的是**夹紧的两支各管一边**，不是 d3 的布局质量。
 */
function renderWithLayout(randomSeq: number[]) {
  const real = Math.random;
  let i = 0;
  Math.random = () => (i < randomSeq.length ? randomSeq[i++] : real());
  try {
    const { container } = render(
      <CharacterGraph
        graphData={graph(
          [
            { id: "甲", group: "其他", description: "" },
            { id: "乙", group: "其他", description: "" },
          ],
          [{ source: "甲", target: "乙", label: "关联" }]
        )}
      />
    );
    // 300 次 tick ÷ 每帧 50 次 = 最多 6 帧；留到 12 帧兜住同批排进去的别的 rAF
    let guard = 0;
    while (frames.size && guard++ < 12) stepFrames(1);
    expect(screen.queryByText("计算布局中..."), "布局没落地，读到的是别的层").toBeNull();
    return container;
  } finally {
    Math.random = real;
  }
}

beforeEach(() => {
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    const id = ++frameId;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("空数据 / 还没算完 / 算完 —— 三种屏上状态各是一句", () => {
  it("没有节点时说「图谱数据为空，请重试」，不许拿『计算中』盖掉它", () => {
    render(<CharacterGraph graphData={graph([], [])} />);
    expect(screen.getByText("图谱数据为空，请重试")).toBeTruthy();
    expect(screen.queryByText("计算布局中...")).toBeNull();
  });

  it("有节点但布局没落地时说「计算布局中...」，且首帧不落地（tick 是分帧跑的，不许冻住主线程）", () => {
    render(<CharacterGraph graphData={THREE} />);
    expect(screen.getByText("计算布局中...")).toBeTruthy();
    stepFrames(1); // 一帧只跑 50 次 tick：300 次的账不可能一帧结清
    expect(screen.queryByText("计算布局中...")).toBeTruthy();
  });

  it("分块跑到收敛才落地，落地的节点数与有效边数都对", () => {
    render(<CharacterGraph graphData={THREE} />);
    stepFrames(1);
    expect(screen.queryByText("计算布局中...")).toBeTruthy();
    settle();
    expect(screen.queryByText("计算布局中...")).toBeNull();
    expect(screen.getByText("3 人 · 2 条关系")).toBeTruthy();
  });

  it("卸载之后不再往 state 里落布局（cleanup 要把已排的 rAF 全部取消）", () => {
    const { unmount } = render(<CharacterGraph graphData={THREE} />);
    stepFrames(1); // 只跑第一块，故意留在"还在算"的状态
    expect(frames.size, "前提：队里还有等着的分块").toBeGreaterThan(0);
    unmount();
    expect(frames.size, "卸载时没把后续分块取消掉").toBe(0);
  });
});

describe("边引用了不存在的人物（图谱幻觉的常见形状）", () => {
  it("那条边被丢掉，图谱照样出来——摘掉过滤是当场崩，屏上连『计算中』都不剩", () => {
    const g = graph(
      [
        { id: "令狐冲", group: "主角", description: "华山派大弟子" },
        { id: "任盈盈", group: "配角", description: "日月神教圣姑" },
      ],
      [
        { source: "令狐冲", target: "不存在的角色", label: "仇敌" },
        { source: "令狐冲", target: "任盈盈", label: "恋人" },
      ]
    );
    mountInline(g);
    expect(screen.getByText("2 人 · 1 条关系")).toBeTruthy();
  });

  it("全部边都悬空时也不许崩，且「0 条关系」要如实写出来", () => {
    const g = graph(
      [
        { id: "甲", group: "其他", description: "" },
        { id: "乙", group: "其他", description: "" },
      ],
      [{ source: "甲", target: "查无此人", label: "关联" }]
    );
    mountInline(g);
    expect(screen.getByText("2 人 · 0 条关系")).toBeTruthy();
  });
});

describe("viewBox 与卡片高度都跟着真实节点位置走", () => {
  it("inline 的 viewBox 是节点包围盒 ± 50（写死 800×600 会把图裁掉一半或留大片空白）", () => {
    const container = mountInline();
    const card = inlineCard(container);
    const pts = nodePositions(card);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const [minX, minY, w, h] = graphSvg(card)
      .getAttribute("viewBox")!
      .split(/[\s,]+/)
      .map(Number);
    expect(minX).toBe(Math.min(...xs) - 50);
    expect(minY).toBe(Math.min(...ys) - 50);
    expect(w).toBe(Math.max(...xs) + 50 - minX);
    expect(h).toBe(Math.max(...ys) + 50 - minY);
  });

  it("展开档的边距是 80 而不是 50：同一批节点，viewBox 要正好宽出 60", () => {
    const container = mountInline();
    const inlineBox = graphSvg(inlineCard(container)).getAttribute("viewBox")!;
    fireEvent.click(screen.getByText("大图"));
    stepFrames(1); // 展开/收起那发 rAF 复位
    const bigBox = graphSvg(expandedLayer(container)).getAttribute("viewBox")!;
    const w = (s: string) => Number(s.split(/[\s,]+/)[2]);
    // 用 closeTo 而不是 toBe：两边各自是"加常量再相减"的浮点式，差 60 这件事在最后一位
    // 小数上可能抖一个 ULP——而 6 位小数的余量对"pad 恒 50"这一刀（差值 0）依然咬得住。
    expect(w(bigBox)).toBeCloseTo(w(inlineBox) + 60, 6);
  });

  it("卡片高度按长宽比算，并夹在 140~320（细长图不许把书架撑穿，扁图不许缩成一条缝）", () => {
    const container = mountInline();
    const card = inlineCard(container);
    const pts = nodePositions(card);
    const [, , w, h] = graphSvg(card).getAttribute("viewBox")!.split(/[\s,]+/).map(Number);
    const expected = Math.max(140, Math.min(320, Math.round(280 / (w / h))));
    expect(card.style.height).toBe(`${expected}px`);
    expect(pts.length).toBe(3);
  });

  it("横扁的图顶到下限 140：不夹就是几十像素的一条缝，用户在书架上看不见关系", () => {
    // 两节点同一水平线时 `viewH` 只剩 `2*pad = 100`，比例一到 2 以上，`280/比例` 就掉穿 140。
    const container = renderWithLayout([0.05, 0.5, 0.95, 0.5]);
    expect(inlineCard(container).style.height).toBe("140px");
  });

  it("竖长的图顶到上限 320：不夹就是八百像素，把书架那一栏整个撑穿", () => {
    // 同一份数据、同一对力，只是初值换到一条竖线上：`viewW = 100`，比例跌破 0.875 就撞上限。
    const container = renderWithLayout([0.5, 0.05, 0.5, 0.95]);
    expect(inlineCard(container).style.height).toBe("320px");
  });

  it("展开时 inline 的高度让位给全屏层（0），不把两份图叠在一起", () => {
    const container = mountInline();
    expect(inlineCard(container).style.height).not.toBe("0px");
    fireEvent.click(screen.getByText("大图"));
    stepFrames(1);
    expect(inlineCard(container).style.height).toBe("0px");
  });
});

describe("兜底链在图上就得和真关系分得开", () => {
  it("autoLinked 边走虚线，真关系边走实线（inline 档是 4 3）", () => {
    const g = graph(
      [
        { id: "令狐冲", group: "主角", description: "华山派大弟子" },
        { id: "任盈盈", group: "配角", description: "日月神教圣姑" },
        { id: "岳不群", group: "反派", description: "华山派掌门" },
      ],
      [
        { source: "令狐冲", target: "任盈盈", label: "恋人" },
        { source: "任盈盈", target: "岳不群", label: "关联", autoLinked: true },
      ]
    );
    const container = mountInline(g);
    const lines = [...inlineCard(container).querySelectorAll("line")];
    const dashed = lines.filter((l) => l.getAttribute("stroke-dasharray") === "4 3");
    const solid = lines.filter((l) => l.getAttribute("stroke-dasharray") === null);
    expect(dashed.length).toBe(1);
    expect(solid.length).toBe(1);
  });

  it("大图档的虚线是 6 4（放大了还能看出是补的）", () => {
    const g = graph(
      [
        { id: "令狐冲", group: "主角", description: "华山派大弟子" },
        { id: "任盈盈", group: "配角", description: "日月神教圣姑" },
      ],
      [{ source: "令狐冲", target: "任盈盈", label: "关联", autoLinked: true }]
    );
    const container = mountInline(g);
    fireEvent.click(screen.getByText("大图"));
    stepFrames(1);
    const lines = [...expandedLayer(container).querySelectorAll("line")];
    expect(lines.filter((l) => l.getAttribute("stroke-dasharray") === "6 4").length).toBe(1);
  });
});

describe("同一人物每次重绘都是同一个颜色", () => {
  it("预定义组名直接取表里的色（绕过表就会把『主角』画成随机色）", () => {
    const container = mountInline();
    const fills = [...inlineCard(container).querySelectorAll("circle") ]
      .filter((c) => c.getAttribute("r") === "14")
      .map((c) => c.getAttribute("fill"));
    expect(fills).toContain("#7c3aed"); // 主角
    expect(fills).toContain("#2563eb"); // 配角
    expect(fills).toContain("#dc2626"); // 反派
  });

  it("表里没有的组名按名字生成颜色，且两次渲染完全一致（重绘不许变色）", () => {
    const g = graph(
      [
        { id: "甲", group: "剑仙", description: "" },
        { id: "乙", group: "散修", description: "" },
      ],
      []
    );
    const first = render(<CharacterGraph graphData={g} />).container;
    stepFrames(1);
    settle();
    const a = inlineCard(first).querySelectorAll("circle")[0]?.getAttribute("fill");
    cleanup();
    const second = render(<CharacterGraph graphData={g} />).container;
    stepFrames(1);
    settle();
    const b = inlineCard(second).querySelectorAll("circle")[0]?.getAttribute("fill");
    expect(a).toBeTruthy();
    expect(b).toBe(a);
    expect(String(a)).toMatch(/^hsl\(/);
  });
});

describe("缩放：三条入口都要夹住，且收/放之后要能复位", () => {
  function openBig(container: HTMLElement) {
    fireEvent.click(screen.getByText("大图"));
    stepFrames(1);
    return expandedLayer(container);
  }
  const zoomLabel = (layer: HTMLElement) => layer.querySelector("span.text-xs")!.textContent;

  it("点「缩小」到 30% 就不再降（夹漏一次图就缩没了）", () => {
    const container = mountInline();
    const layer = openBig(container);
    const minus = layer.querySelector('button[aria-label="缩小"]') as HTMLButtonElement;
    for (let i = 0; i < 12; i++) fireEvent.click(minus);
    expect(zoomLabel(layer)).toBe("30%");
  });

  it("点「放大」到 1000% 封顶", () => {
    const container = mountInline();
    const layer = openBig(container);
    const plus = layer.querySelector('button[aria-label="放大"]') as HTMLButtonElement;
    for (let i = 0; i < 60; i++) fireEvent.click(plus);
    expect(zoomLabel(layer)).toBe("1000%");
  });

  it("滚轮走的是容器上的原生 listener：向下滚是缩小，并且 preventDefault 被叫到（不然页面跟着翻页）", () => {
    const container = mountInline();
    const layer = openBig(container);
    const scrollArea = layer.querySelector("div.flex-1") as HTMLElement;
    const wheel = new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: false });
    const spy = vi.spyOn(wheel, "preventDefault");
    fireEvent(scrollArea, wheel);
    expect(spy).toHaveBeenCalled();
    expect(zoomLabel(layer)).toBe("85%");
  });

  it("双指张开按比例放大、收拢缩小，同样夹在 0.3~10", () => {
    const container = mountInline();
    const layer = openBig(container);
    const scrollArea = layer.querySelector("div.flex-1") as HTMLElement;
    const touch = (x0: number, x1: number) => {
      const t = (clientX: number) => ({ clientX, clientY: 0, identifier: 0, target: scrollArea } as unknown as Touch);
      return { touches: [t(x0), t(x1)] };
    };
    fireEvent.touchStart(scrollArea, touch(0, 100) as never);
    fireEvent.touchMove(scrollArea, touch(0, 200) as never); // 距离翻倍 → 100% 起放大到 200%
    expect(zoomLabel(layer)).toBe("200%");
    fireEvent.touchMove(scrollArea, touch(0, 2) as never); // 收到 2%：0.02 倍 → 夹到 30%
    expect(zoomLabel(layer)).toBe("30%");
  });

  it("收掉大图再重新展开时缩放复位到 100%（那发 rAF 初值 reset 不能少）", () => {
    const container = mountInline();
    const layer = openBig(container);
    fireEvent.click(layer.querySelector('button[aria-label="放大"]') as HTMLButtonElement);
    expect(zoomLabel(layer)).toBe("120%");
    fireEvent.click(layer.querySelector('button[aria-label="关闭全屏"]') as HTMLButtonElement);
    stepFrames(1);
    fireEvent.click(screen.getByText("大图"));
    stepFrames(1);
    expect(zoomLabel(expandedLayer(container))).toBe("100%");
  });
});

describe("tooltip 定位与开关", () => {
  it("位置来自鼠标的屏幕坐标（+12/-10），不是节点在 SVG 里的坐标", () => {
    const container = mountInline();
    const card = inlineCard(container);
    // 命中区是描述那一只 r=28 的透明圆
    const hit = [...card.querySelectorAll("circle")].find((c) => c.getAttribute("r") === "28") as Element;
    fireEvent.mouseEnter(hit, { clientX: 300, clientY: 400 });
    const tip = screen.getByText("华山派大弟子") as HTMLElement;
    expect(tip.style.left).toBe("312px");
    expect(tip.style.top).toBe("390px");
    // 反证它没有拿 SVG 坐标：节点本体坐标在 ±150 里，绝不可能算出 312px
    const nodeX = Number(hit.getAttribute("cx"));
    expect(Math.abs(nodeX + 12 - 312)).toBeGreaterThan(50);
  });

  it("移动鼠标时跟手", () => {
    const container = mountInline();
    const hit = [...inlineCard(container).querySelectorAll("circle")].find((c) => c.getAttribute("r") === "28") as Element;
    fireEvent.mouseEnter(hit, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(hit, { clientX: 180, clientY: 260 });
    const tip = screen.getByText("华山派大弟子") as HTMLElement;
    expect(tip.style.left).toBe("192px");
    expect(tip.style.top).toBe("250px");
  });

  it("没有描述的人物不生成命中区（屏上不该有一块看不见的点把点击吃掉）", () => {
    const g = graph(
      [
        { id: "甲", group: "其他", description: "" },
        { id: "乙", group: "其他", description: "有描述" },
      ],
      []
    );
    const container = mountInline(g);
    const hits = [...inlineCard(container).querySelectorAll("circle")].filter((c) => c.getAttribute("r") === "28");
    expect(hits.length).toBe(1);
  });

  it("触屏上没有 hover：点一下出说明，再点一下收掉", () => {
    const container = mountInline();
    const hit = [...inlineCard(container).querySelectorAll("circle")].find((c) => c.getAttribute("r") === "28") as Element;
    fireEvent.click(hit);
    expect(screen.queryByText("华山派大弟子")).toBeTruthy();
    fireEvent.click(hit);
    expect(screen.queryByText("华山派大弟子")).toBeNull();
  });

  it("展开成大图后屏上只留一份 tooltip：inline 那半被 `!expanded` 关掉，两份叠着会飘在错的地方", () => {
    const container = mountInline();
    const hit = [...inlineCard(container).querySelectorAll("circle")].find((c) => c.getAttribute("r") === "28") as Element;
    fireEvent.mouseEnter(hit, { clientX: 10, clientY: 10 });
    expect(container.querySelectorAll("div.fixed.z-\\[60\\]").length).toBe(1);
    fireEvent.click(screen.getByText("大图"));
    stepFrames(1);
    const tips = container.querySelectorAll("div.fixed.z-\\[60\\]");
    expect(tips.length, "inline 那份没跟着 `!expanded` 关掉，屏上叠了两张说明卡").toBe(1);
    expect(expandedLayer(container).contains(tips[0])).toBe(true);
  });
});

describe("重绘入口", () => {
  it("给了 onRegenerate 才画那枚「重绘」，点它就调一次", () => {
    const onRegenerate = vi.fn();
    render(<CharacterGraph graphData={THREE} onRegenerate={onRegenerate} />);
    stepFrames(1);
    settle();
    fireEvent.click(screen.getByTitle("重绘"));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("没给就不画（不画一条点了没反应的按钮）", () => {
    mountInline();
    expect(screen.queryByTitle("重绘")).toBeNull();
  });
  it("展开档那一份命中区与定位是同一规则（它和 inline 是同一段 JSX 的复制，必须各判一次）", () => {
    // 记这一格的理由：我先只判了 inline 档，然后把"没有描述也生成命中区"这一刀下到**展开档**
    // 那一份上——28 条全绿（实测，不是推测）。同一段代码抄两份时，判一份不等于判两份。
    const g = graph(
      [
        { id: "甲", group: "其他", description: "有描述的那个人" },
        { id: "乙", group: "其他", description: "" },
      ],
      []
    );
    const container = mountInline(g);
    fireEvent.click(screen.getByText("大图"));
    stepFrames(1);
    const layer = expandedLayer(container);
    // 展开档的节点半径是 24，命中区是它的两倍
    const hits = [...layer.querySelectorAll("circle")].filter((c) => c.getAttribute("r") === "48");
    expect(hits.length, "展开档没有跟着 `n.description` 收命中区").toBe(1);
    fireEvent.mouseEnter(hits[0], { clientX: 500, clientY: 600 });
    const tip = screen.getByText("有描述的那个人") as HTMLElement;
    expect(tip.style.left).toBe("512px");
    expect(tip.style.top).toBe("590px");
  });
});

/* 变异台账（每刀手动一次一处、跑完 `cp` 字节备份还原并核 SHA256 回基线
 * `5ff142283f11b9d65c93b877489d312c102cf60db598ea2552ebbcd47ea9129e`；结束态 `MUT-` 计数 0）：
 * 刀1  删掉空状态那三行 → 1 红（『图谱数据为空』那条），屏上只剩「计算布局中...」
 * 刀2  摘掉边的 `.filter((l) => l.source && l.target)` → 2 红（两条悬空边用例，effect 当场抛）
 * 刀3  `chunkSize` 50→300（一帧跑完）→ 4 红：三条分块落地用例 + 「放大到 1000%」被拖过
 *      5 秒天花板（`Test timed out in 5000ms`，红因是慢，不是那条判据的内容）
 * 刀4  cleanup 只清数组、不 `cancelAnimationFrame` → 1 红（卸载后队列里还剩 1 发）
 * 刀5  `viewBox` 写死 `0 0 800 600` → 3 红（±50、pad+60、卡片高度那条按 DOM 里的 viewBox
 *      反算，所以它跟着一起红——这一条判据牵的是"高度跟着真实包围盒走"，不假）
 * 刀6  `pad` 恒 50（不分展开档）→ 1 红（差值 60 变成 0）
 * 刀7a 去掉 `Math.max(140, …)` 下限 → 1 红（横扁档实测 86px）
 * 刀7b 去掉 `Math.min(320, …)` 上限 → 1 红（竖长档实测 914px）
 * 刀8  展开时 inline 高度不置 0 → 1 红（实测 320px 而不是 0）
 * 刀9a inline 档 `strokeDasharray` 抹平 → 1 红；刀9b 展开档抹平 → 1 红（两份复制各咬各的）
 * 刀10 预定义组也走哈希 → 1 红（『重绘不变色』那条照旧绿：哈希本身仍是确定的）
 * 刀11 `handleZoom` 去掉上限 → 1 红（实测 1300%）；滚轮与双指两处夹界不受影响
 * 刀12 滚轮 handler 去掉 `preventDefault` → 1 红（spy 没被叫到），换算那半照旧绿
 * 刀13 pinch 去掉下限 → 1 红（实测 2%）
 * 刀14 删掉展开/收起那发 rAF 复位 → 1 红（重新展开还停在 120%）
 * 刀15  inline tooltip 改用节点 SVG 坐标 → 2 红（实测 67.7px vs 鼠标所在的 312px，飘了 244px）
 *      刀15b 同一刀下到展开档那一份 → 1 红（实测 218.2px vs 512px）
 * 刀16  inline 档「没有描述也生成命中区」→ 1 红（2 只而不是 1 只）
 * 刀16b **同一刀先只下到展开档那一份时：0 红（28 条全绿，实测）**——这就是补上
 *        "展开档那一份命中区与定位"那条用例的来由；补完之后同一刀翻红（2 只 vs 1 只）。
 *        同一段 JSX 抄两份，判一份不等于判两份。
 * 刀17 去掉 `onRegenerate &&` 条件 → 1 红（没给回调也画出按钮）
 */
