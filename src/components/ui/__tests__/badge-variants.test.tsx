/**
 * ui/badge — 那枚小徽章首次有直接判据（全仓 10 只文件在用它）
 *
 * 和 `ui/button` 同一族：34 行 cva 薄壳，类名串错了不报错、只是长得不对，`{...props}` 少了
 * 全仓的 children 一起没。它出现在书架卡片、地点详情、笔记来源、API 提供商、模型镜像每一处
 * 状态标注上——**这些位置坏起来的症状都是"读者分不清这条是什么"**，而不是"界面塌了"。
 *
 * 判的四件事：
 * 1. 四个变体各给一套类、互不撞色，base 那串（圆角／内距／`font-semibold`／`transition-colors`）
 *    永远在；不写 `variant` 时走 `defaultVariants` 那一格。
 * 2. `outline` 是**唯一不写背景**的一型。全仓 46 处 `<Badge>` 里有 23 处走 outline，靠这一格自己描色
 *    （`NovelCard.tsx:146/155/164/226/235` 的 `text-green-500 border-green-500/30`、
 *    `BookSelect.tsx:739` 的 `text-muted-foreground`）——给它加上 `bg-*` 就是静默改这 12 处。
 * 3. 调用方的 `className` 走 `cn`（tailwind-merge）：冲突时调用方赢，但不许把不冲突的 base 挤没。
 * 4. 渲染出来是 `<div>`：这一版不是 `span`、不是 `button`，props 原样落到 DOM。
 *
 * 三条要留在明处的产品事实（**都刻意没有反过来钉死**）：
 * - `destructive` 那一型**全仓零调用**（`<Badge variant="destructive">` 搜不到，用 destructive 的
 *   只有 `ChapterTab.tsx:99` 那颗 Button）。它出现在下面"四型互不相同"那一列里，所以**真要删这一型，
 *   改那条用例是应有的一步**，不是"测试坏了"。（按"死代码不写判据"的口径，这里不给它单独立判据。）
 * - `focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2` 这四条挂在一枚
 *   **不可聚焦的 `<div>`** 上是装饰——除非调用点补 `tabIndex`（全仓没有一处）。**这一格 jsdom 判不到**：
 *   jsdom 允许对任意元素 `focus()` 并把它放进 `document.activeElement`，真浏览器只对可聚焦元素这么做，
 *   所以在单测层写"焦点环在不在"必然假绿。留给浏览器层，或者哪天真要交互时把那四条一起删。
 * - 调用点有两枚写着 `variant` 默认值同时又手动 `bg-primary`（`ApiSettings.tsx:121`、
 *   `RAGSettings.tsx:129`），是**同值覆盖**：合并完看不出差别。它读起来像"特意挑了主色"，
 *   实际什么都没做——下次读那两处别以为它们在盖色。
 * - `badgeVariants` 没有导出（shadcn 原版导），所以这套类外部无法复用。没有调用者，不判。
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "../badge";

const BASE = [
  "inline-flex", "items-center", "rounded-full", "border", "px-2.5", "py-0.5",
  "text-xs", "font-semibold", "transition-colors",
];
const VARIANTS = ["default", "secondary", "destructive", "outline"] as const;

/** 拿某一枚渲染出来的类名串（每只用例里的文本都取唯一值） */
function classOf(text: string): string {
  return (screen.getByText(text) as HTMLElement).className;
}

/** 类串里有没有"裸"的这一格：`bg-primary` 算，`hover:bg-primary/80` 不算（那是另一格） */
function hasBare(cls: string, name: string): boolean {
  return cls.split(/\s+/).includes(name);
}

/** 串里有没有任何 `bg-*` 类（带变体前缀的也算） */
const hasAnyBg = (cls: string) => /(^|\s)bg-/.test(cls);

describe("四个变体各给什么类", () => {
  it("四型都渲染得出来，且每一型都带着 base 那串", () => {
    render(
      <>
        {VARIANTS.map((v) => (
          <Badge key={v} variant={v}>{`型-${v}`}</Badge>
        ))}
      </>,
    );
    for (const v of VARIANTS) {
      const cls = classOf(`型-${v}`);
      for (const bit of BASE) expect(cls, `${v} 少了 base 的 ${bit}`).toContain(bit);
    }
  });

  it("不写 variant 就是 default（`defaultVariants` 那一格：删掉它这枚会变白底）", () => {
    render(<Badge>没写变体</Badge>);
    const cls = classOf("没写变体");
    expect(cls).toContain("bg-primary");
    expect(cls).toContain("text-primary-foreground");
    // 与显式 default 完全同一串——这一格判的是"两种写法必须一致"
    render(<Badge variant="default">显式 default</Badge>);
    expect(classOf("显式 default")).toBe(cls);
  });

  it("四型互不相同（撞了色就是改坏一格而界面上没人会红）", () => {
    render(
      <>
        {VARIANTS.map((v) => (
          <Badge key={v} variant={v}>{`异-${v}`}</Badge>
        ))}
      </>,
    );
    const seen = VARIANTS.map((v) => classOf(`异-${v}`));
    expect(new Set(seen).size).toBe(VARIANTS.length);
  });

  it("三型实底都写 border-transparent；outline 是唯一不写背景的一型", () => {
    render(
      <>
        <Badge variant="default">底-default</Badge>
        <Badge variant="secondary">底-secondary</Badge>
        <Badge variant="destructive">底-destructive</Badge>
        <Badge variant="outline">底-outline</Badge>
      </>,
    );
    expect(classOf("底-default")).toContain("bg-primary");
    expect(classOf("底-secondary")).toContain("bg-secondary");
    expect(classOf("底-destructive")).toContain("bg-destructive");
    for (const t of ["底-default", "底-secondary", "底-destructive"]) {
      expect(classOf(t), t).toContain("border-transparent");
    }
    // outline 那一格 23 处靠它自己描色，给它加背景就是静默改那 23 处
    const outline = classOf("底-outline");
    expect(hasAnyBg(outline), outline).toBe(false);
    expect(outline).toContain("text-foreground");
    expect(hasBare(outline, "border-transparent")).toBe(false);
  });

  it("拼错的变体名：不崩，但只留 base（和 button 同一格，现状上报不替它改成抛错）", () => {
    render(<Badge variant={"danger-typo" as "outline"}>手误</Badge>);
    const cls = classOf("手误");
    expect(cls).toContain("inline-flex");
    expect(hasAnyBg(cls), cls).toBe(false);
    expect(cls).not.toContain("bg-primary");
  });
});

describe("调用方的 className 是合并，不是顶掉", () => {
  it("text-[10px] 挤掉 base 的 text-xs，但圆角、内距、字重这些不冲突的还在", () => {
    // 这是全仓最常见的写法：MiniCard／ApiSettings／RAGSettings／GlobalNotes 都这么挂
    render(<Badge variant="outline" className="text-[10px] font-normal">十号</Badge>);
    const cls = classOf("十号");
    expect(cls).toContain("text-[10px]");
    expect(cls).not.toContain("text-xs");
    expect(cls).toContain("rounded-full");
    expect(cls).toContain("px-2.5");
    // font-normal 与 font-semibold 同族，调用方赢（这十枚确实写着 font-normal）
    expect(cls).toContain("font-normal");
    expect(hasBare(cls, "font-semibold")).toBe(false);
  });

  it("盖色只带走裸的那一格，带 hover 前缀的是另一格（留着才对）", () => {
    render(<Badge className="bg-red-500">盖色</Badge>);
    const cls = classOf("盖色");
    expect(cls).toContain("bg-red-500");
    expect(hasBare(cls, "bg-primary")).toBe(false);
    expect(cls).toContain("hover:bg-primary/80");
    expect(cls).toContain("text-primary-foreground");
    expect(cls).toContain("transition-colors");
  });

  it("没给 className 时也不许冒出一串 undefined 之类的脏字面量", () => {
    render(<Badge>光板</Badge>);
    expect(classOf("光板")).not.toMatch(/undefined|false|null/);
  });
});

describe("props 与元素形状", () => {
  it("渲染出来是 div（改成 span 会动那 10 只文件的排版；全仓没有一处把它嵌进 p 或 button）", () => {
    render(<Badge>形状</Badge>);
    const el = screen.getByText("形状");
    expect(el.tagName).toBe("DIV");
    expect(el).not.toBeDisabled();
  });

  it("children 与 title / id / data-* 一起原样落到 DOM（children 走的正是 `{...props}`）", () => {
    render(
      <Badge variant="secondary" title="悬停说明" id="bdg-1" data-testid="bdg">
        透传
      </Badge>,
    );
    const el = screen.getByTestId("bdg");
    expect(el.textContent).toBe("透传");
    expect(el.getAttribute("title")).toBe("悬停说明");
    expect(el.getAttribute("id")).toBe("bdg-1");
  });

  it("className 之外不吞属性：onClick 也能挂上（虽然这一版没人挂）", () => {
    let fired = 0;
    render(
      <Badge data-testid="clickable" onClick={() => { fired += 1; }}>
        点我
      </Badge>,
    );
    screen.getByTestId("clickable").click();
    expect(fired).toBe(1);
  });
});

// ── 变异台账（基线 sha256=c47f85ba… / 1072 B；一刀一跑一还原，每轮核 markers=1、
//    transform_failed=0、markers_left=0、diff_lines=0、sha 回到基线）────────────────────
//
// 12 刀：11 刀咬红，1 刀 0 红且**原因写在明处**（D10）。11 条用例都被指名打红过——
// 但要看清是哪一记打的：**「children 原样到 DOM」与「onClick 挂得上」这两条只有 D5 打得到**
// （它们判的就是 `{...props}` 这一格，别的手法碰不到）。D1／D2 两刀因终端未落红名重跑过一遍
// （D1r／D2r），红名与下表一致。
// 对照：D0 = D0b = 11 条全绿（开局与收局各一次，证明中途没把产品留下半个字）。
//
// D1r base 少 `rounded-full`            2 红：四型都带 base ／ text-[10px] 那一条也判 base
// D2r 删掉 `defaultVariants` 整格        2 红：不写 variant 就是 default ／ 盖色那一条
// D3  outline 串换成 secondary 的        2 红：四型互不相同 ／ outline 是唯一不写背景的
// D4  不走 `cn`，改字符串拼接            3 红：text-xs 被顶掉那条 ／ 盖色那条 ／ 不冒 undefined 那条
// D5  丢掉 `{...props}`                11 红（**一条不剩**：children 本身就走 props，
//     这一记读出的就是"全仓 10 只文件的状态标注一起空掉"的真实爆炸半径）
// D6  `<div>` 换成 `<span>`             1 红：渲染形状那条（只有 tagName 看得见，类串完全一样）
// D7  `variant` 写死成 "default"         3 红：互不相同 ／ 三型实底与 outline ／ 拼错变体那条
// D8  `cn` 参数顺序对调（base 顶掉调用方） 2 红：text-[10px] 那条 ／ 盖色那条
// D9  base 少 `border`（描边宽度）        1 红：四型都带 base——**outline 那 23 处的边框宽度靠这一格**，
//     调用点只写 `border-green-500/30` 这一族的颜色，宽度不在就整族看不见
// D10 base 少 `focus:` 那四条             **0 红**，而且是**真装饰**不是漏判：`<div>` 没有 `tabIndex`
//     就拿不到焦点，那四条在真浏览器里永远不生效；jsdom 又允许对任意元素 `focus()`，在这层写
//     "焦点环在不在"必然假绿。所以这一格的正确处置是记下来（文件头同一条），不是补断言。
// D11 `defaultVariants` 换成 "outline"    2 红：不写 variant 那条（D2 是删，D11 是换错——两刀不同格）
// D12 secondary 串换成 default 的         2 红：四型互不相同 ／ 三型实底与 outline
//
// 一记方法账：**"写死成 default"这一刀不会红"不写 variant"那条**（D7 的红名里没有它）——那条判据
// 只在"没写"这一侧取样，写死恰好满足它。真正咬住 D7 的是另外三条。这条和 button 那档
// 「受控组件每一格都要给两个相反的值」是同一族，只是方向不同：**变体型判据的牙在"给两个不同的值"，
// 不在"给一个不写"**。
