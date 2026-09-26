/**
 * `MarkdownRenderer` 本体的直接判据（地板第 1 档）
 *
 * 这只渲染器只有"选一份配置 + 合并自定义 + 要不要包一层 div"三件事，但它是**所有 AI
 * 输出上屏的最后一道**：MiniCard、SubItem、QATab、章节总结全走它。它坏了不会有报错，
 * 只会让屏上的字变成默认浏览器的样子（或者整段消失）。所以判的是：
 * - **variant 决定哪份配置**：`summary` 会把 AI 吐出来的 `#` 逐级降级（`h1→h2`、`h2→h3`），
 *   而 `chat` 没配标题那一档，`#` 就是真 `h1`。这条是**屏上量得到**的差异，不是"参数传了没"。
 * - **合并方向**：自定义组件覆盖同名默认项，但**不许把其他默认项一起丢掉**（顺序反了就是
 *   "我只想换个段落样式，结果整屏表格与代码块全没了"）。
 * - **className 那道 truthy 门槛**：包一层 div 是给父级 grid/flex 用的；不包时必须真的不包
 *   （多一层 div 会把 `space-y-*` 之类的兄弟选择器隔断）。空字符串不算"要包"。
 *
 * **本档刻意没判的两格**：
 * ① `content` 里出现原始 HTML（`<script>`、`<img onerror>`）时 react-markdown 默认**不渲染 HTML**，
 *    那是厂商那边的行为、不是这只组件的判断，且已有 `sanitize-svg` 那一档在管真入口；这里只钉
 *    "我们自己的三件事"，不给依赖的默认安全性写判据（哪天换渲染器，这些"绿"会一起骗人）。
 * ② **表格**：实测这台渲染器**画不出表格**——全仓没有 `remark-gfm`，`ReactMarkdown` 也没传任何
 *    `remarkPlugins`（grep 依赖与 src 都是零），而 CommonMark 本身不含表格。所以 AI 输出里的
 *    `| 甲 | 乙 |` 上屏是**竖线原文**，`markdown-config` 里那五支 `table/thead/tr/th/td`（含
 *    "窄屏给表格包一层横向滚动"那格）走不到。**这一格不写判据**：写"表格不成表格"等于把大概率
 *    不是本意的现状钉成契约，写"表格会成表格"则是假绿。已当成产品事实报给制作人
 *    （要么装 `remark-gfm` 让那五支活过来，要么把表格配置删掉别留着骗人）。同理受影响的是
 *    删除线 `~~x~~`、自动链接、任务清单——都是 GFM 扩展，现在一律按普通文本渲染。
 *
 * ## 变异台账见文件末尾：8 轮全部打在基线 `279f8554…`（产品代码一行没动）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Components } from "react-markdown";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { type MarkdownVariant } from "../markdown-config";

// 只包一层记数，配置本身仍走真的那份——判的是"渲染器把哪个变体交下去"，不是配置自己
const cfg = vi.hoisted(() => ({ seen: [] as MarkdownVariant[] }));
vi.mock("../markdown-config", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("../markdown-config");
  return {
    ...mod,
    getMarkdownComponents: (variant: MarkdownVariant) => {
      cfg.seen.push(variant);
      return mod.getMarkdownComponents(variant);
    },
  };
});

const renderMd = (props: { content?: string; variant?: MarkdownVariant; components?: Components; className?: string }) =>
  render(
    <MarkdownRenderer
      content={props.content ?? "正文"}
      variant={props.variant}
      components={props.components}
      className={props.className}
    />
  );

beforeEach(() => {
  cfg.seen = [];
});
afterEach(() => {
  cleanup();
});

describe("正文与变体：哪份配置真的上了屏", () => {
  it("content 走 markdown：粗体渲染成 strong，文本原样在", () => {
    renderMd({ content: "令狐冲**接住**那一掌" });
    const strong = screen.getByText("接住");
    expect(strong.tagName).toBe("STRONG");
  });

  it("不传 variant 时按 summary 配（默认值判得到，不是碰巧）", () => {
    renderMd({ content: "x" });
    expect(cfg.seen).toEqual(["summary"]);
  });

  it("variant 透传给配置：chat 就取 chat", () => {
    renderMd({ content: "x", variant: "chat" });
    expect(cfg.seen).toEqual(["chat"]);
  });

  it("同一句 `# 标题`：summary 降级成 h2，chat 是真 h1（两档的差异量得到）", () => {
    const { unmount } = renderMd({ content: "# 华山", variant: "summary" });
    expect(screen.queryByRole("heading", { level: 2 })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    unmount();

    renderMd({ content: "# 华山", variant: "chat" });
    expect(screen.queryByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("段落两档各有各的类名（配置没串）", () => {
    const { unmount } = renderMd({ content: "一句", variant: "summary" });
    const sumP = screen.getByText("一句");
    expect(sumP.className).toContain("leading-relaxed");
    unmount();

    renderMd({ content: "一句", variant: "chat" });
    const chatP = screen.getByText("一句");
    expect(chatP.className).toContain("last:mb-0");
    expect(chatP.className).not.toContain("leading-relaxed");
  });

  it("引用块只有 summary 配了：chat 里退成浏览器默认（不崩、也不冒充有样式）", () => {
    const { unmount } = renderMd({ content: "> 引用一句", variant: "summary" });
    expect(document.querySelector("blockquote")).toBeTruthy();
    unmount();

    renderMd({ content: "> 引用一句", variant: "chat" });
    const bq = document.querySelector("blockquote");
    expect(bq).toBeTruthy();
    expect(bq!.getAttribute("class")).toBeNull();
  });
});

describe("自定义组件：覆盖同名项，不许顺手丢掉别的", () => {
  it("给了 components 就赢：同名 key 用自定义那支", () => {
    renderMd({
      content: "自定义段落",
      components: { p: ({ children }) => <p data-own="1">{children}</p> } as Components,
    });
    const p = screen.getByText("自定义段落");
    expect(p.getAttribute("data-own")).toBe("1");
    expect(p.className).toBe("");
  });

  it("覆盖 p 之后，默认项仍在：粗体还走 summary 那支 strong", () => {
    renderMd({
      content: "**还是粗体**",
      components: { p: ({ children }) => <p data-own="1">{children}</p> } as Components,
    });
    const strong = screen.getByText("还是粗体");
    expect(strong.tagName).toBe("STRONG");
    expect(strong.className).toContain("font-semibold");
  });

  it("覆盖 p 之后，其它默认项仍在：分隔线走 summary 那支 hr", () => {
    renderMd({
      content: "上面\n\n---\n\n下面",
      components: { p: ({ children }) => <p data-own="1">{children}</p> } as Components,
    });
    const hr = document.querySelector("hr");
    expect(hr).toBeTruthy();
    expect(hr!.className).toContain("my-2");
  });

  it("不传 components 时拿到的是配置本体（不多一层空对象）", () => {
    renderMd({ content: "`code`" });
    const code = screen.getByText("code");
    expect(code.tagName).toBe("CODE");
    expect(code.className).toContain("bg-muted");
    expect(cfg.seen).toEqual(["summary"]);
  });
});

describe("className 那道门槛：要包就包，不包就别多一层", () => {
  it("给了 className：外面包一层带名字的 div，markdown 在它里面且**配置仍然生效**", () => {
    const { container } = renderMd({ content: "包一层", className: "prose-mini" });
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.tagName).toBe("DIV");
    expect(wrap.className).toBe("prose-mini");
    const p = wrap.querySelector("p");
    expect(p?.textContent).toContain("包一层");
    // 包一层这条路也得把 mergedComponents 交下去：只判 div 会漏掉"wrapper 那支忘了传配置"
    expect(p!.className).toContain("leading-relaxed");
  });

  it("没给 className：不包 wrapper（多一层 div 会隔断父级的兄弟选择器）", () => {
    const { container } = renderMd({ content: "不包" });
    const first = container.firstElementChild as HTMLElement;
    expect(first.tagName).toBe("P");
    expect(container.querySelector("div")).toBeNull();
  });

  it("className 是空串也不算要包（判的是 truthy 不是 !== undefined）", () => {
    const { container } = renderMd({ content: "空串", className: "" });
    expect((container.firstElementChild as HTMLElement).tagName).toBe("P");
    expect(container.querySelector("div")).toBeNull();
  });

  it("content 为空串：什么都不画，也不崩", () => {
    const { container } = renderMd({ content: "" });
    expect(container.firstChild).toBeNull();
  });

  it("配置是跟着 variant 现取的：换 variant 重渲染，段落类名跟着换", () => {
    const { rerender, container } = renderMd({ content: "跟着换", variant: "summary" });
    expect(screen.getByText("跟着换").className).toContain("leading-relaxed");
    rerender(
      <MarkdownRenderer content="跟着换" variant="chat" />
    );
    expect(screen.getByText("跟着换").className).toContain("last:mb-0");
    expect(container.querySelector("div")).toBeNull();
  });
});

/* ================================================================ 变异台账
 * 8 轮全部打在基线 `279f8554…`（MarkdownRenderer.tsx **未改动**那一版，15 条全绿）。
 * 每刀手改一处、跑完 `cp` 字节备份还原并核 SHA256；每轮固定读数
 * `markers / reds / transform_failed / skipped / markers_left / restored_sha`，八轮都是
 * `markers=1 / transform_failed=0 / skipped=0 / markers_left=0 / restored_sha=279f8554`。
 * - M1 默认档从 summary 改成 chat＝3 红；M7 收了 variant 却不往下传（恒取 summary）＝5 红
 *   ——两刀各打"默认值"与"透传"，M7 咬得更宽（chat 那一整族判据全塌）。
 * - M2 合并方向反了（默认盖掉自定义）＝1 红；M5 完全忽略调用方 components＝1 红。
 *   两刀红的是**同一条**"给了就赢"，但 M2 是"顺序错"、M5 是"根本不接"，形状不同。
 * - M3 className 门槛从 truthy 改成 `!== undefined`＝1 红（空串那一格）；
 *   M4 永远包一层 div＝4 红（不包 wrapper 的两条 + 空 content + 换 variant 重渲染那条里
 *   顺手判的"没有多余 div"）。
 * - **M6 首打 0 红，而且不是等价变异——是我漏判了一格**：带 wrapper 那一支把
 *   `components` 不交出去（`components={undefined}`），当时那条用例只判了 div 的标签名与
 *   类名，没判里面的段落还吃不吃配置，于是渲染器"包一层但把样式整支丢掉"这种坏法量不到。
 *   补上"wrapper 里那个 p 仍带 summary 的类名"之后，先重跑一次 0 刀对照（15 条全绿、SHA 仍是
 *   `279f8554`），再打同一刀 **M6b＝1 红**。
 * 另一笔过程账：M6 中途我用一次性 python 脚本去改产品文件（图快），跑出来才发现它一次动了两处、
 *   `markers` 直接变 2 归不了因——按既定口径**变异必须手动一次一处**，已还原重下。这条记着。
 */
