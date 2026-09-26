/**
 * MiniCard 本体的直接判据（地板第 1 档）
 *
 * 这只卡片是"AI 结果到底有没有把话说全"的最后一道出口：三个调用点（`SubItem`、`ChapterTab`、
 * `QATab`）都往它塞总结/问答，而它管的事情坏了以后**没有任何报错**——只是屏上少一句话：
 * - 「精简模式 / 原文不完整」那一整块由 `metadata` 三个字段中任意一个唤起（旧账：输出预留越大、
 *   丢的章越多，而卡片看着跟"整段都读过"一模一样）。少判一个来源就是"数据在对象里、卡片上看不见"。
 * - 「精简」徽章有**两个来源**（顶层 `usedFallback` 与 `metadata.usedFallback`）：`ChapterTab`
 *   两个都传、`SubItem` 只传顶层、`QATab` 只传 metadata。任何一半被"简化"掉，都正好弄哑一只调用方。
 * - 数字要带千分位（`1,234 章`），日期要钉 `zh-CN`（跟着系统 locale 走就会变英文）。
 *
 * 未判 / 待议的两格（写清楚，别让"这只有测试了"盖住）：
 * - ~~「重新生成」那枚按钮没有可访问名~~：2026-09-26 补上了（`aria-label="重新生成 {title}"`，
 *   名字带卡片标题的口径沿用 09-24 搜索那一排按钮那笔）。判据与两刀在下面的「可访问名」一节。
 *   **同排另两枚没跟着带卡片名**：`收藏到笔记` 只有 `title`、`删除` 只有 `aria-label="删除"`，
 *   都有名字、都不是无名按钮，但一屏几十张卡片时读屏里仍是三枚同名的。要不要一起对齐等制作人一句话。
 * - `truncated` 单独出现时标题句写成「本分析使用了精简模式」——严格说截断≠精简，那是产品文案口径，
 *   本批按现状钉住（改文案要连带徽章那一格的口径一起谈）。
 * - `CardTitle` 的 `truncate` 与父级 `min-w-0` 是形状判据，jsdom 量不出后果（长标题真的把卡片撑破
 *   归浏览器层），本批不写"能截断"这种冒充后果的断言。
 *
 * 变异台账（每刀手动一次一处、跑完 `cp` 字节备份还原并核 SHA256 回基线
 * `a43af61074a922c3774f5054e8a8b04f2e3610bc76672652ba3e9dac7e8be027`，`MUT-` 残留 0、产品代码
 * `git diff` 空）。读数是实跑的：
 * 刀1  `showMetadata` 丢掉 `omittedChapters` 这一路 → 3 红（三来源那条 + 文案那条 + 千分位那条）
 * 刀2  「精简」徽章只看顶层 `usedFallback` ⇒ 1 红（只看 metadata 那半，正是 QATab 走的路）
 * 刀3  「精简」徽章只看 `metadata.usedFallback` ⇒ 1 红（只看顶层那半，正是 SubItem 走的路）
 *      —— 刀2/刀3 各只咬自己一半：两个来源是真的两条路，不是同一条判据凑两次
 * 刀4  标题句恒「送入模型的原文不完整」⇒ 1 红；刀5 恒「本分析使用了精简模式」⇒ 1 红（两个方向各咬一次）
 * 刀6  `omittedChapters` 去掉 `toLocaleString` ⇒ 1 红（1234 直接上屏）
 * 刀7  `segments > 1` 这道门槛去掉 ⇒ 1 红（「分为 1 段分析后合并」也写出来）
 * 刀8  **第一刀是无效变异（0 红）**：只改了内层 `分析了 {…}` 的取值，外层
 *      `{metadata.analyzedLength && (` 仍把整段遮着 ⇒ 这一路根本走不到。整段拿掉存在性判断
 *      （缺字段时拿 `originalLength` 兜底）之后 ⇒ 1 红。**"0 红"要先怀疑刀没落到执行路径上。**
 * 刀9  「原始内容」那行不再看 `truncated` ⇒ 1 红
 * 刀10 日期改 `toLocaleDateString` ⇒ 1 红；**刀10b 日期去掉 `"zh-CN"` ⇒ 0 红**：这台机器默认 locale
 *      恰好就是 `zh-CN`（实测 `Intl.DateTimeFormat().resolvedOptions().locale === "zh-CN"`，两种写法
 *      都出 `2024/1/2 13:05:00`），所以这一刀在本机是**等价变异**，不是判据没牙。补了一条"年在最前 +
 *      带冒号时分"的形状断言，让它在非中文机器／CI 上才有得红（`1/2/2024, 1:05:00 PM` 不以 4 位年开头）。
 * 刀11 `disabled={loading}` 去掉 ⇒ 1 红
 * 刀12 收藏按钮条件写反（`!onBookmark`）⇒ 4 红（两半都咬：不该画的画了、该画的没了；另两条按 DOM
 *      位置取按钮的用例跟着一起红——位置型定位器对按钮增减敏感，这正是想要的敏感度）
 * 刀13 `variant="summary"` 传成 `"note"` ⇒ 1 红；刀15 正文传成 `title` ⇒ 2 红
 * 刀14 `isTemp` 的虚线边框不画 ⇒ 1 红（「临时」徽章那条跟着红：一个 prop 管两处，两处都在判）
 *
 * 2026-09-26 补「重新生成」可访问名那一格的两刀（基线 `ec29e9b2d8ee8c8b50307abd65e742710cfcc6728fed12ed843569c3e9709369`，
 * 5774 字节；每刀一处、跑完 `cp` 字节还原并核 SHA 回基线，markers_left=0；本文件 23 条）：
 * 刀16 摘掉 `aria-label`、只留 hover 用的 `title="重新生成"` ⇒ **2 红**（两条名字判据全红：
 *      可访问名退成"重新生成"四个字——`title` 确实也能给出名字，所以这一刀打的不是"有没有名字"，
 *      打的是"名字里有没有带上是哪一张卡片"）。
 * 刀17 名字取错来源（`重新生成 {content}` 而不是 `{title}`）⇒ **同样 2 红**。刀16 是"没上下文"、
 *      刀17 是"上下文取错"，两半各咬一次；第二条用例特意让两张卡片的 `content` 相同、`title` 不同，
 *      就是为了这一刀能红：正文当名字时两枚同名，`getByRole` 直接找不到那两句话。
 * 同一笔里 ExportPanel 那只下拉的 `aria-label` 由那边文件的 **M26** 打（1 红）。
 *
 * **补名字连带收到的一只旧雷（不是判据没牙，是产品真的换了形状）**：`BookTab-internals` 里有
 * 四处拿 `{ name: /剧情时间线/ }` 这种"名字含标题"的正则定位 SubItem 那一行的表头。卡片一旦把
 * 标题写进可访问名，同一屏里就有了两枚名字含"剧情时间线"的按钮（表头 + 那张卡的重新生成），
 * `getByRole` 当场报 multiple。改成精确名 `{ name: "剧情时间线" }` 之后 316 条全绿。
 * 这正是这一格想要的效果（读屏里"重新生成 剧情时间线"就是能说清动的是哪一张卡），也是它对该文件
 * 里所有宽松定位器的通用警告：**以后再加带标题的名字，先查一遍正则型 locator。**
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { MiniCard } from "../MiniCard";
import type { AnalysisMetadata } from "@/agents/types";

// MarkdownRenderer 有自己的一批判据；这里只判"MiniCard 把哪一份 content 交下去"
const md = vi.hoisted(() => ({ seen: [] as Array<{ content: unknown; variant: unknown }> }));
vi.mock("../MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content, variant }: { content: string; variant?: string }) => {
    md.seen.push({ content, variant });
    return <div data-testid="md">{content}</div>;
  },
}));

const TS = new Date(2024, 0, 2, 13, 5, 0).getTime();

function card(props: Partial<Parameters<typeof MiniCard>[0]> = {}): HTMLElement {
  const { container } = render(
    <MiniCard
      title="令狐冲的性格分析"
      content="**外放**不羁"
      tokens={812}
      date={TS}
      {...props}
    />
  );
  return container;
}

function meta(m: AnalysisMetadata): AnalysisMetadata {
  return m;
}

beforeEach(() => {
  md.seen = [];
  cleanup();
});

describe("徽章与那一排出口：同一件事的两个来源都要认", () => {
  it("「临时」由 isTemp 驱动，而且虚线边框跟着它一起变（一个 prop 管两处）", () => {
    const c = card({ isTemp: true });
    expect(screen.getByText("临时")).toBeTruthy();
    expect(c.querySelector(".border-dashed")).toBeTruthy();
    cleanup();
    const plain = card();
    expect(screen.queryByText("临时")).toBeNull();
    expect(plain.querySelector(".border-dashed")).toBeNull();
  });

  it("顶层 usedFallback ⇒ 出「精简」徽章（SubItem 只传这一个）", () => {
    card({ usedFallback: true });
    expect(screen.getByText("精简")).toBeTruthy();
  });

  it("只有 metadata.usedFallback 时也要出「精简」徽章（QATab 只传 metadata）", () => {
    card({ metadata: meta({ usedFallback: true }) });
    expect(screen.getByText("精简")).toBeTruthy();
  });

  it("truncated 单独出现不算「精简」徽章（它只唤起下面那块，口径别混）", () => {
    card({ metadata: meta({ truncated: true, originalLength: 100 }) });
    expect(screen.queryByText("精简")).toBeNull();
  });

  it("字数徽章把 tokens 原样写出来，前面那个「~」是估的意思不能丢", () => {
    card({ tokens: 812 });
    expect(screen.getByText("~812")).toBeTruthy();
  });

  it("日期钉死 zh-CN 且带时分（跟着系统 locale 走就会变成英文日期）", () => {
    card();
    const shown = screen.getByText(new Date(TS).toLocaleString("zh-CN")) as HTMLElement;
    // 再钉一条"形状"：年在最前、带冒号时分。这台机器默认 locale 恰好就是 zh-CN，所以
    // "去掉 locale 参数"这一刀在本机是等价变异（实测 0 红）；换到 en-US 的机器/CI 上，
    // 这句才会把它抓出来（`1/2/2024, 1:05:00 PM` 不以 4 位年开头）。
    expect(shown.textContent).toMatch(/^\d{4}/);
    expect(shown.textContent).toContain(":");
  });
});

describe("元数据那一块：谁把它叫出来、叫什么文案、数字怎么读", () => {
  const hint = (c: HTMLElement) => c.querySelector(".bg-amber-500\\/10") as HTMLElement | null;

  it("三个字段各自单独都能把这块叫出来（少一个来源＝那种情况下卡片一句话都不说）", () => {
    for (const m of [meta({ usedFallback: true }), meta({ truncated: true }), meta({ omittedChapters: 3 })]) {
      cleanup();
      expect(hint(card({ metadata: m })), JSON.stringify(m)).not.toBeNull();
    }
  });

  it("三者全无时整块不出现；omittedChapters 是 0 也不算「有省略」", () => {
    expect(hint(card({ metadata: meta({}) }))).toBeNull();
    cleanup();
    expect(hint(card({ metadata: meta({ omittedChapters: 0 }) }))).toBeNull();
    cleanup();
    expect(hint(card())).toBeNull();
  });

  it("只丢了章节时说的是「送入模型的原文不完整」，不许喊成精简模式", () => {
    const c = card({ metadata: meta({ omittedChapters: 1234 }) });
    expect(hint(c)?.textContent).toContain("送入模型的原文不完整");
    expect(hint(c)?.textContent).not.toContain("本分析使用了精简模式");
  });

  it("走过精简/截断时说的是「本分析使用了精简模式」", () => {
    expect(hint(card({ metadata: meta({ usedFallback: true, omittedChapters: 2 }) }))?.textContent)
      .toContain("本分析使用了精简模式");
    cleanup();
    expect(hint(card({ metadata: meta({ truncated: true }) }))?.textContent)
      .toContain("本分析使用了精简模式");
  });

  it("丢的章数带千分位（上千章的书写成 1234 没法一眼读）", () => {
    const c = card({ metadata: meta({ omittedChapters: 1234 }) });
    expect(hint(c)?.textContent).toContain("1,234 章");
    expect(hint(c)?.textContent).not.toContain("1234 章");
  });

  it("截断时报原始长度，有 analyzedLength 才追加「分析了多少」", () => {
    const both = card({ metadata: meta({ truncated: true, originalLength: 20000, analyzedLength: 15000 }) });
    expect(hint(both)?.textContent).toContain("原始内容 20,000 字符");
    expect(hint(both)?.textContent).toContain("分析了 15,000 字符");
    cleanup();
    const only = card({ metadata: meta({ truncated: true, originalLength: 20000 }) });
    expect(hint(only)?.textContent).toContain("原始内容 20,000 字符");
    expect(hint(only)?.textContent).not.toContain("分析了");
  });

  it("没截断就不报「原始内容」那一行（即便带着 originalLength）", () => {
    const c = card({ metadata: meta({ usedFallback: true, originalLength: 20000 }) });
    expect(hint(c)?.textContent).not.toContain("原始内容");
  });

  it("分段那行只在真的多段时才写（顺带实测到一条口径：segments 自己叫不出这一整块）", () => {
    expect(hint(card({ metadata: meta({ usedFallback: true, segments: 3 }) }))?.textContent)
      .toContain("分为 3 段分析后合并");
    cleanup();
    expect(hint(card({ metadata: meta({ usedFallback: true, segments: 1 }) }))?.textContent)
      .not.toContain("分为");
    cleanup();
    // 现状口径：唤起整块的是 `usedFallback / truncated / omittedChapters` 这三个，
    // 单给 segments 时整块不出现。第一版用例把它当成"会显示"，是我想当然——判据按实测改。
    expect(hint(card({ metadata: meta({ segments: 3 }) }))).toBeNull();
  });
});

describe("三枚按钮：没给回调就不画，loading 只该按住「重新生成」", () => {
  // 「重新生成」那枚没有可访问名（见文件头），只能按 DOM 位置取
  const buttons = (c: HTMLElement) => [...c.querySelectorAll("button")];

  it("一枚回调都没给 ⇒ 一枚按钮都不画（不画点了没反应的图标）", () => {
    expect(buttons(card())).toHaveLength(0);
  });

  it("给了就各画一枚，点击各调自己的那一个，不串线", () => {
    const onBookmark = vi.fn();
    const onRegenerate = vi.fn();
    const onRemove = vi.fn();
    const c = card({ onBookmark, onRegenerate, onRemove });
    expect(buttons(c)).toHaveLength(3);
    fireEvent.click(screen.getByTitle("收藏到笔记"));
    fireEvent.click(buttons(c)[1]); // 重新生成
    fireEvent.click(screen.getByLabelText("删除"));
    expect(onBookmark).toHaveBeenCalledTimes(1);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("loading 只 disable「重新生成」，收藏与删除仍可点", () => {
    const c = card({ onBookmark: vi.fn(), onRegenerate: vi.fn(), onRemove: vi.fn(), loading: true });
    const [bookmark, regenerate, remove] = buttons(c);
    expect(regenerate.disabled, "loading 时重生成按钮该按住").toBe(true);
    expect(bookmark.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
  });

  it("不 loading 时三枚都可点（disable 不是常驻）", () => {
    const c = card({ onBookmark: vi.fn(), onRegenerate: vi.fn(), onRemove: vi.fn() });
    expect(buttons(c).map((b) => b.disabled)).toEqual([false, false, false]);
  });

  it("交给 MarkdownRenderer 的是 content 那一份，variant 是 summary", () => {
    card({ content: "正文只在这里出现一次" });
    expect(md.seen).toHaveLength(1);
    expect(md.seen[0].content).toBe("正文只在这里出现一次");
    expect(md.seen[0].variant).toBe("summary");
  });

  it("正文不等于标题：标题只出现在 CardTitle 一处", () => {
    const c = card({ title: "只属于标题的那句", content: "正文那句" });
    const titleNodes = [...c.querySelectorAll(".text-xs.truncate")];
    expect(titleNodes).toHaveLength(1);
    expect(titleNodes[0].textContent).toBe("只属于标题的那句");
    expect(screen.getByText("正文那句")).toBeTruthy();
  });
});

describe("「重新生成」的可访问名：图标按钮要说得出动的是哪一张卡片", () => {
  // 产品原来只画一只 RefreshCw 图标：既无 `aria-label` 也无 `title`，读屏里这一枚是**无名**的。
  // 而一屏同时摆着几十张卡片（SubItem 的总结列表、QATab 的每条回答），全叫同一个东西等于没法用。
  // 名字带标题是制作人 2026-09-24 定过的口径（同一类问题在搜索那一排按钮上先修过一次）。
  it("按可访问名找得到，名字是「重新生成 + 这一张的标题」", () => {
    card({ title: "令狐冲 vs 任我行：华山之争", onRegenerate: vi.fn() });
    expect(screen.getByRole("button", { name: "重新生成 令狐冲 vs 任我行：华山之争" })).toBeTruthy();
  });

  it("两张卡片同时在场：两枚各有各的名字（名字跟着 title 走，不是写死的一句）", () => {
    card({ title: "第一章的摘要", content: "同一句正文", onRegenerate: vi.fn() });
    card({ title: "第二章的摘要", content: "同一句正文", onRegenerate: vi.fn() });
    expect(screen.getByRole("button", { name: "重新生成 第一章的摘要" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新生成 第二章的摘要" })).toBeTruthy();
    // 名字取的是标题不是正文：正文跟着 content 变，读屏会念出半段总结
    expect(screen.getAllByRole("button", { name: /^重新生成 / })).toHaveLength(2);
  });

  it("没给 onRegenerate 时仍不画这枚（补名字不许顺手把出口变成常驻按钮）", () => {
    card({ title: "没有重生成的卡片", onBookmark: vi.fn(), onRemove: vi.fn() });
    expect(screen.queryByRole("button", { name: /^重新生成 / })).toBeNull();
    expect([...document.querySelectorAll("button")]).toHaveLength(2);
  });
});
