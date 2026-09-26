/**
 * `markdown-config` 本体的直接判据（地板第 1 档）
 *
 * 这只模块只有"两份组件映射 + 一个按变体取映射的函数"三件事，但它决定 **AI 吐出来的
 * 每一段 Markdown 长成什么样**。之前它只被 `MarkdownRenderer.test.tsx` 间接吃到（那里判的是
 * "渲染器把哪份配置交下去"），配置单元自己只有 1 条直接判据。这一档判的是配置自己坏得起来
 * 的形状，与渲染器接线无关：
 * - **summary 那三档标题必须逐级降一档**（`#`→h2、`##`→h3、`###`→h4）：AI 输出的一级标题
 *   不许抢页面自己的 h1，也不许把三级降成段落。
 * - **两份映射必须是两份**：`getMarkdownComponents` 的三元反了、或者两支返回同一份，
 *   整个面板的字会一起换成另一档的字号与间距。
 * - **同名 key 在两档里要有意地不同或相同**：`ul/ol/strong/code/p` 两档都配了，但 summary 多
 *   `space-y-*` 与 `break-words`，chat 的 `code` 用的是另一组底色；`em/hr/blockquote/li/表格五支`
 *   只有 summary 有。钉的是现状差异（口径同 button 那档"默认不设 type"：真要给 chat 补，判据跟着改）。
 *
 * 类名一律**按空格切成整 token 再比**，不对类名字符串写 `toContain`／`not.toContain`：
 * `bg-primary/30` 这类带斜杠的是另一个 token，子串判会读出假绿（见台账那批陷阱记录）。
 *
 * **本档刻意没判的一格**：
 * ① `space-y-0.5`、`leading-relaxed`、`dark:bg-white/10` 的**实际像素与主题效果**——jsdom 不做
 *    布局、也不跟着 `dark:` 变，这里只能钉"类名在不在"，量不到"渲染出来对不对"。窄屏表格横滚
 *    那条真效果在 e2e 层已有判据（`MarkdownRenderer.test.tsx` 的 K3 那一族走的浏览器层另说）。
 * ② react-markdown 自己怎么选 key、GFM 插件怎么解析竖线——那是依赖的行为，本档只交映射。
 *
 * ## 变异台账见文件末尾
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import { summaryComponents, chatComponents, getMarkdownComponents } from "../markdown-config";

type MapKey = keyof Components;

/** 直接调用映射里那一支：这一档判的是配置单元本身，不绕渲染器 */
function draw(map: Components, key: MapKey, text = "样本字"): HTMLElement {
  const render1 = map[key] as unknown as (props: { children?: ReactNode }) => ReactNode;
  const { container } = render(<div>{render1({ children: text })}</div>);
  const wrapper = container.firstElementChild as HTMLElement;
  return wrapper.firstElementChild as HTMLElement;
}

const toks = (el: HTMLElement | null): string[] =>
  ((el?.getAttribute("class") ?? "") as string).split(/\s+/).filter(Boolean);

const SUMMARY_KEYS = [
  "h1", "h2", "h3", "p", "ul", "ol", "li", "strong", "em", "hr",
  "blockquote", "code", "table", "thead", "tr", "th", "td",
] as const satisfies readonly MapKey[];

afterEach(() => cleanup());

describe("按变体取映射：取到的就是那两份本体，不是复制品也不是同一份", () => {
  it("summary 取到的是 summaryComponents 本身（同一引用）", () => {
    expect(getMarkdownComponents("summary")).toBe(summaryComponents);
  });

  it("chat 取到的是 chatComponents 本身（同一引用）", () => {
    expect(getMarkdownComponents("chat")).toBe(chatComponents);
  });

  it("两份映射不是同一个对象（三元写反或两支同一份都会让整屏字换一档）", () => {
    expect(summaryComponents).not.toBe(chatComponents);
  });

  it("summary 那一族的 key 一支不缺（漏一支就退回浏览器默认形状）", () => {
    const missing = SUMMARY_KEYS.filter((k) => summaryComponents[k] === undefined);
    expect(missing, `缺：${missing.join(", ")}`).toEqual([]);
  });

  it("chat 只配对话用得到的那五支，多出来的一律算坏（现状差异）", () => {
    expect(Object.keys(chatComponents).sort()).toEqual(["code", "ol", "p", "strong", "ul"]);
  });
});

describe("summary 的标题：AI 的 # 逐级降一档，页面自己的 h1 不被抢", () => {
  it("`#` 画成 h2，不是 h1", () => {
    const el = draw(summaryComponents, "h1");
    expect(el.tagName).toBe("H2");
  });

  it("`##` 画成 h3，不是 h2", () => {
    expect(draw(summaryComponents, "h2").tagName).toBe("H3");
  });

  it("`###` 画成 h4，不是 h3", () => {
    expect(draw(summaryComponents, "h3").tagName).toBe("H4");
  });

  it("三档标题都把文字透出去（降档不许吞字）", () => {
    expect(draw(summaryComponents, "h1", "华山").textContent).toBe("华山");
    expect(draw(summaryComponents, "h2", "华山").textContent).toContain("华山");
    expect(draw(summaryComponents, "h3", "华山").textContent).toBe("华山");
  });

  it("h2 前面那颗圆点：第一个子元素是带 primary 底色的 span", () => {
    const h3 = draw(summaryComponents, "h2", "章节名");
    const dot = h3.firstElementChild as HTMLElement;
    expect(dot.tagName).toBe("SPAN");
    expect(toks(dot)).toEqual(expect.arrayContaining(["w-1", "h-1", "rounded-full", "bg-primary", "shrink-0"]));
    expect(h3.textContent).toBe("章节名");
  });

  it("h2 自己是 flex 排（圆点与文字在一行），且三档类名各是各的", () => {
    expect(toks(draw(summaryComponents, "h1"))).toEqual(
      expect.arrayContaining(["text-sm", "font-bold", "border-b", "first:mt-0"])
    );
    expect(toks(draw(summaryComponents, "h2"))).toEqual(
      expect.arrayContaining(["text-xs", "font-semibold", "flex", "items-center", "gap-1"])
    );
    expect(toks(draw(summaryComponents, "h3"))).toEqual(
      expect.arrayContaining(["text-xs", "font-medium"])
    );
    expect(toks(draw(summaryComponents, "h2"))).not.toContain("border-b");
    expect(toks(draw(summaryComponents, "h3"))).not.toContain("flex");
  });

  it("三档字号不许写成同一档（h1 那支比另两支大）", () => {
    expect(toks(draw(summaryComponents, "h1"))).toContain("text-sm");
    expect(toks(draw(summaryComponents, "h1"))).not.toContain("text-xs");
  });
});

describe("列表：summary 带行距，chat 不带；ul 与 ol 各用对的符号", () => {
  it("summary ul 是 disc 且带行距与缩进", () => {
    expect(toks(draw(summaryComponents, "ul"))).toEqual(
      expect.arrayContaining(["list-disc", "pl-3", "space-y-0.5", "text-foreground/75"])
    );
  });

  it("summary ol 是 decimal，除符号外与 ul 同形（两支不是复制粘贴同一支）", () => {
    expect(toks(draw(summaryComponents, "ol"))).toEqual(
      expect.arrayContaining(["list-decimal", "pl-3", "space-y-0.5", "text-foreground/75"])
    );
    expect(toks(draw(summaryComponents, "ol"))).not.toContain("list-disc");
    expect(toks(draw(summaryComponents, "ul"))).not.toContain("list-decimal");
  });

  it("summary li 只留一点左内边距（符号位由 ul/ol 的 pl-3 让出来）", () => {
    expect(toks(draw(summaryComponents, "li"))).toEqual(["pl-0.5"]);
  });

  it("chat 的 ul/ol 没有行距那一格（短对话不许被拉开）", () => {
    expect(toks(draw(chatComponents, "ul"))).toEqual(["list-disc", "pl-3"]);
    expect(toks(draw(chatComponents, "ol"))).toEqual(["list-decimal", "pl-3"]);
  });

  it("ul 的标签没被换成别的（list 语义掉了对读屏是灾难）", () => {
    expect(draw(summaryComponents, "ul").tagName).toBe("UL");
    expect(draw(summaryComponents, "ol").tagName).toBe("OL");
    expect(draw(chatComponents, "ul").tagName).toBe("UL");
  });
});

describe("段落与行内：p / strong / em / code / hr / blockquote", () => {
  it("summary 段落：弱化前景色 + 行距 + 允许断词（长串不许撑破面板）", () => {
    const p = draw(summaryComponents, "p");
    expect(p.tagName).toBe("P");
    expect(toks(p)).toEqual(expect.arrayContaining(["text-foreground/80", "leading-relaxed", "break-words"]));
  });

  it("chat 段落：只留紧凑外边距，且明确不带 summary 那一组", () => {
    const p = draw(chatComponents, "p");
    expect(p.tagName).toBe("P");
    expect(toks(p)).toEqual(["mb-0.5", "last:mb-0"]);
    expect(toks(p)).not.toContain("leading-relaxed");
  });

  it("strong 两档都加粗，但字重档位不同（summary 是 semibold）", () => {
    expect(toks(draw(summaryComponents, "strong"))).toEqual(["font-semibold"]);
    expect(toks(draw(chatComponents, "strong"))).toEqual(["font-semibold"]);
    expect(draw(summaryComponents, "strong").tagName).toBe("STRONG");
  });

  it("em 只有 summary 配了斜体加 primary 色，chat 那档没有这一支", () => {
    expect(toks(draw(summaryComponents, "em"))).toEqual(["italic", "text-primary"]);
    expect(draw(summaryComponents, "em").tagName).toBe("EM");
    expect(chatComponents.em).toBeUndefined();
  });

  it("code 两档用的是两组底色：summary 走 muted，chat 走半透明黑白", () => {
    expect(toks(draw(summaryComponents, "code"))).toEqual(
      expect.arrayContaining(["bg-muted", "rounded", "text-xs", "break-all"])
    );
    expect(toks(draw(summaryComponents, "code"))).not.toContain("bg-black/10");
    const chatCode = toks(draw(chatComponents, "code"));
    expect(chatCode).toEqual(expect.arrayContaining(["bg-black/10", "dark:bg-white/10", "rounded"]));
    expect(chatCode).not.toContain("bg-muted");
    expect(chatCode).not.toContain("break-all");
  });

  it("hr 只有 summary 配了上下外边距与分隔色", () => {
    const hr = draw(summaryComponents, "hr");
    expect(hr.tagName).toBe("HR");
    expect(toks(hr)).toEqual(["my-2", "border-border"]);
    expect(chatComponents.hr).toBeUndefined();
  });

  it("blockquote 只有 summary 配：左边那道 primary 竖线 + 斜体 + 断词", () => {
    const bq = draw(summaryComponents, "blockquote");
    expect(bq.tagName).toBe("BLOCKQUOTE");
    expect(toks(bq)).toEqual(["border-l-2", "border-primary/30", "pl-2", "italic", "break-words"]);
    expect(chatComponents.blockquote).toBeUndefined();
  });
});

describe("表格五支：窄屏横滚那一层必须包在 table 外面（放开「不要使用表格」之后这条路天天走）", () => {
  it("table 那一支的外层是 div、内层才是 table", () => {
    const table = draw(summaryComponents, "table");
    expect(table.tagName).toBe("DIV");
    const inner = table.firstElementChild as HTMLElement;
    expect(inner.tagName).toBe("TABLE");
  });

  it("外层带横向滚动、内层带满宽与边框合并（类名不许写错地方）", () => {
    const table = draw(summaryComponents, "table");
    expect(toks(table)).toEqual(expect.arrayContaining(["overflow-x-auto", "max-w-full", "my-1"]));
    expect(toks(table.firstElementChild as HTMLElement)).toEqual([
      "w-full",
      "text-xs",
      "border-collapse",
    ]);
  });

  it("thead 有底色", () => {
    expect(draw(summaryComponents, "thead").tagName).toBe("THEAD");
    expect(toks(draw(summaryComponents, "thead"))).toEqual(["bg-muted/50"]);
  });

  it("tr 逐行下边线、最后一行不画", () => {
    expect(toks(draw(summaryComponents, "tr"))).toEqual(["border-b", "border-border", "last:border-0"]);
  });

  it("th 还是 th、td 还是 td（表头塌成 td 就没有列名了）", () => {
    expect(draw(summaryComponents, "th").tagName).toBe("TH");
    expect(draw(summaryComponents, "td").tagName).toBe("TD");
    expect(toks(draw(summaryComponents, "th"))).toEqual([
      "text-left",
      "px-1.5",
      "py-0.5",
      "font-semibold",
    ]);
    expect(toks(draw(summaryComponents, "td"))).toEqual(["px-1.5", "py-0.5"]);
  });

  it("th 与 td 不是同一支：th 左对齐加粗，td 没有", () => {
    expect(toks(draw(summaryComponents, "td"))).not.toContain("font-semibold");
    expect(toks(draw(summaryComponents, "td"))).not.toContain("text-left");
    expect(toks(draw(summaryComponents, "th"))).not.toEqual(toks(draw(summaryComponents, "td")));
  });

  it("chat 那档没有表格五支（现状：对话里出现表格就退回浏览器默认）", () => {
    for (const k of ["table", "thead", "tr", "th", "td"] as MapKey[]) {
      expect(chatComponents[k], `chat 多出 ${k} 那一支`).toBeUndefined();
    }
  });
});

/* ================================================================ 变异台账
 * 基线：`markdown-config.tsx` SHA256 `681dec80…` / 3358 B（本轮**产品一行没动**，只新增本文件）。
 * 每刀手改一处、跑完立刻从字节备份还原并 `cmp`；12 轮（1 轮 0 刀对照 + 11 刀）固定读数
 * `markers=1 / vitest 正常退出（非 0 崩溃）/ markers_left=0 / sha 回到 681dec80 / size 回到 3358`。
 * 对照轮：31 条全绿、红=0。
 *
 * - C1  h1 那支画成真 h1（降档摘掉）        1 红（「`#` 画成 h2」）
 * - C2  三元两支返回对调                    2 红（summary 与 chat 那两条引用判据各一条）
 * - C3  无视 variant 恒返回 summary         1 红（只有 chat 那条）——**C2 与 C3 红数不同**：
 *       对调是"两边都错"，恒返回只有 chat 侧错。拿这两刀的形状差异证明那两条引用判据各自有牙。
 * - C4  th 塌成 td                          1 红
 * - C5  th 与 td 的类名整组对调             2 红（标签那条 + 「th 与 td 不是同一支」那条）
 *       —— C4 与 C5 红数不同：标签对调与类名对调是两个格子，一条判据管不着另一条。
 * - C6  摘掉表格外层 wrapper（类名并到 table 上）2 红（外层必须是 div + 类名不许写错地方）
 *       放开「不要使用表格」之后这条路天天走，这一格掉了窄屏就整张表撑破面板。
 * - C7  chat 的 code 抄了 summary 那一组     1 红（两档底色那条）
 * - C8  摘掉 h2 那颗 primary 圆点            1 红
 * - C9  summary 的 ul 摘掉 space-y-0.5       1 红（行距那一格；chat 那条不受影响，正是"两档各判各的"）
 * - C10 整支摘掉 summary 的 hr               2 红（「key 一支不缺」＋「hr 只有 summary 配了」）
 * - C11 给 chat 补上 table 那一支            2 红（「chat 只配五支」＋「chat 没有表格五支」）。
 *       **这刀是"加功能"形状的刀**：红不代表那种改动是坏的，记在这里说明这两条钉的是**现状差异**
 *       （口径同 button 那档「默认不设 type」、也同 `MarkdownRenderer.test.tsx` 的 K6）。
 *
 * 11 刀**没有一记 0 红**，所以这一档没有"判不到的格子"要写进台账。
 * 与渲染器那一档的分工：`MarkdownRenderer.test.tsx` 判的是"渲染器把哪份配置交下去"（M1/M7/K1/K2），
 * 本文件判的是"配置单元自己长什么样"（直接调用映射里那一支，不绕渲染器）。两层红名互不重叠。
 */
