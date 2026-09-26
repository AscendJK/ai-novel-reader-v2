/**
 * ui/button — 全仓 32 只文件共用的那颗按钮，首次有直接判据
 *
 * 之前它只在各面板的用例里"被用到"（点它、断言它 disabled），没人看着它自己产出什么。
 * 它是底壳：类名串错了不报错，只是长得不对；`{...props}` 少了，全仓的 aria-label /
 * onClick / disabled 一起静默失效。判四件事：
 * 1. 变体与尺寸各自给什么类，base 那串（含 `disabled:opacity-50` 与键盘焦点环）是不是永远在；
 * 2. 调用方的 className 走 `cn`（tailwind-merge）：冲突时调用方赢，但不许把 base 挤没；
 * 3. props 透传：disabled 落到真属性、type 与 aria-label 原样到 DOM；
 * 4. forwardRef 与 displayName。
 *
 * 有意不判的格子（写了理由，不是漏）：
 * - 不设置默认 `type`：HTML 的 `<button>` 默认就是 `submit`。这一版判据钉的是"现状默认不设、
 *   传了就在"。全仓 `src/` 里没有任何 `<form>`（grep 零命中），所以 submit 语义今天不参与；
 *   把"永远不设"钉成判据只会挡住日后真要包进 form 的那一次改动。
 * - 没有 `asChild`：这一版 Button 不引 Slot，全仓也没有一处 `asChild` 用法（唯一命中在
 *   `ui/select.tsx` 的图标上）。等真加 polymorphic 时这条判据要一起改。
 * - 具体颜色值、hover 与 focus 环的真实呈现、响应式类：像素那一层归浏览器套；这里只判类名形状。
 * - 拼错的 variant 值：cva 的处理是"静默只留 base 类"。有一条用例钉住这个现状并上报，
 *   不替它改成抛错——那会把一处手误从"长得不一样"升级成"整屏白"。
 */
import { describe, it, expect } from "vitest";
import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import { Button } from "../button";

/** 拿某一格渲染出来的类名串 */
function classesOf(name: string): string {
  return (screen.getByRole("button", { name }) as HTMLButtonElement).className;
}

/** 类串里有没有"裸"的这一格：`bg-primary` 算，`hover:bg-primary/90` 不算（那是另一格） */
function hasBare(cls: string, name: string): boolean {
  return cls.split(/\s+/).includes(name);
}

const VARIANTS = ["default", "destructive", "outline", "secondary", "ghost", "link"] as const;
const SIZES = ["default", "sm", "lg", "icon"] as const;

describe("变体与尺寸给什么类", () => {
  it("六个变体各自渲染得出来，且都带着 base 那串（含 disabled 与焦点环）", () => {
    render(
      <>
        {VARIANTS.map((v) => (
          <Button key={v} variant={v}>
            {v}
          </Button>
        ))}
      </>,
    );
    for (const v of VARIANTS) {
      const cls = classesOf(v);
      expect(cls, v).toContain("inline-flex");
      expect(cls, v).toContain("disabled:opacity-50");
      expect(cls, v).toContain("focus-visible:ring-2");
      expect(cls, v).toContain("rounded-md");
    }
  });

  it("默认那一格就是 default 变体 + default 尺寸（不写 prop 也自洽）", () => {
    render(<Button>裸按钮</Button>);
    const cls = classesOf("裸按钮");
    expect(cls).toContain("bg-primary");
    expect(cls).toContain("text-primary-foreground");
    expect(cls).toContain("h-10");
    expect(cls).toContain("px-4");
  });

  it("六个变体的类互不相同（撞色＝改坏了一格而没人会红）", () => {
    render(
      <>
        {VARIANTS.map((v) => (
          <Button key={v} variant={v}>
            {v}
          </Button>
        ))}
      </>,
    );
    const seen = VARIANTS.map((v) => classesOf(v));
    expect(new Set(seen).size).toBe(VARIANTS.length);
  });

  it("destructive 有自己的红、outline 有边框、ghost 与 link 没有实心底色", () => {
    render(
      <>
        <Button variant="destructive">删</Button>
        <Button variant="outline">框</Button>
        <Button variant="ghost">灵</Button>
        <Button variant="link">链</Button>
      </>,
    );
    expect(classesOf("删")).toContain("bg-destructive");
    expect(classesOf("框")).toContain("border-input");
    expect(classesOf("灵")).not.toContain("bg-primary");
    expect(classesOf("灵")).not.toContain("bg-secondary");
    expect(classesOf("链")).toContain("underline-offset-4");
    expect(classesOf("链")).not.toContain("bg-primary");
  });

  it("四种尺寸各给一套：default 10 / sm 9 / lg 11 / icon 方", () => {
    render(
      <>
        {SIZES.map((s) => (
          <Button key={s} size={s}>
            {s}
          </Button>
        ))}
      </>,
    );
    expect(classesOf("default")).toMatch(/\bh-10\b/);
    expect(classesOf("sm")).toContain("h-9");
    expect(classesOf("sm")).toContain("px-3");
    expect(classesOf("lg")).toContain("h-11");
    expect(classesOf("lg")).toContain("px-8");
    expect(classesOf("icon")).toContain("h-10");
    expect(classesOf("icon")).toContain("w-10");
  });

  it("变体与尺寸正交：outline + icon 同时拿到边框与方块", () => {
    render(
      <Button variant="outline" size="icon">
        图标
      </Button>
    );
    const cls = classesOf("图标");
    expect(cls).toContain("border-input");
    expect(cls).toContain("w-10");
    expect(cls).not.toContain("px-4");
  });
});

describe("调用方的 className", () => {
  it("冲突时调用方赢（走 tailwind-merge，不是字符串拼接）", () => {
    render(
      <Button size="default" className="h-20">
        改高
      </Button>
    );
    const cls = classesOf("改高");
    expect(cls).toContain("h-20");
    expect(cls).not.toContain("h-10");
  });

  it("调用方盖色不带走 base 的柱子（焦点环与 disabled 仍在）", () => {
    render(
      <Button className="bg-red-500">盖色</Button>
    );
    const cls = classesOf("盖色");
    expect(cls).toContain("bg-red-500");
    // 只判"裸的那一格"被盖掉：`hover:bg-primary/90` 带前缀，与 `bg-red-500` 不是同一格，
    // 留着才是对的——twMerge 把它们混为一谈反而是 bug。
    expect(hasBare(cls, "bg-primary")).toBe(false);
    expect(cls).toContain("focus-visible:ring-2");
    expect(cls).toContain("disabled:opacity-50");
  });

  it("拼错的变体名：不崩，但也不会给你颜色（现状上报，不替它改成抛错）", () => {
    render(<Button variant={"danger-typo" as "link"}>手误</Button>);
    const cls = classesOf("手误");
    expect(cls).toContain("inline-flex");
    expect(cls).not.toContain("bg-primary");
    expect(cls).not.toContain("bg-destructive");
  });
});

describe("props 与 ref 原样到 DOM", () => {
  it("渲染出来的是真 button 元素，children 就是它的可访问名", () => {
    render(<Button>继续使用</Button>);
    const el = screen.getByRole("button", { name: "继续使用" }) as HTMLButtonElement;
    expect(el.tagName).toBe("BUTTON");
    expect(el.textContent).toBe("继续使用");
  });

  it("disabled 落在真属性上（不是只有 aria-disabled），且不带 onClick 时点不动", () => {
    render(
      <Button disabled onClick={() => {}}>
        别点
      </Button>
    );
    const el = screen.getByRole("button", { name: "别点" }) as HTMLButtonElement;
    expect(el.disabled).toBe(true);
    expect(el.hasAttribute("aria-disabled")).toBe(false);
  });

  it("type 与 aria-label 原样透传；不写 type 时 DOM 上就没有这个属性", () => {
    const { rerender } = render(
      <Button aria-label="关掉它">关</Button>,
    );
    const el = screen.getByRole("button", { name: "关掉它" }) as HTMLButtonElement;
    expect(el.getAttribute("aria-label")).toBe("关掉它");
    expect(el.getAttribute("type")).toBeNull();
    rerender(
      <Button aria-label="关掉它" type="button">
        关
      </Button>,
    );
    expect(screen.getByRole("button", { name: "关掉它" }).getAttribute("type")).toBe("button");
  });

  it("ref 拿到的是那颗 button 本体（focus 与 click 都得从它出发）", () => {
    const Probe = () => {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <Button ref={ref} onClick={() => ref.current?.focus()}>
          带 ref
        </Button>
      );
    };
    render(<Probe />);
    const el = screen.getByRole("button", { name: "带 ref" });
    el.click();
    expect(document.activeElement).toBe(el);
  });

  it("displayName 是 Button（React DevTools 与按名查组件的调试都靠它）", () => {
    expect(Button.displayName).toBe("Button");
  });
});

// ── 变异台账（还原法：字节基线 sha256=601d3ed5… / 1665 B，一刀一跑一还原）──────────────
//
// 15 刀全部至少打红一条，没有一轮 0 红；每轮 markers=1、markers_left=0、diff_lines=0、
// sha 回到基线。14 条用例每一条都被至少一刀指名打红过。跑法 %TEMP%\knife-bt.sh。
//
// B1  base 少 `disabled:opacity-50`      2 红：六变体都带 base ／ 盖色不带走 base
// B2  default 的串换成 ghost 的            2 红：默认那一格 ／ 六变体互不相同
// B3  destructive 与 default 撞色          2 红：互不相同 ／ destructive 有自己的红
// B4  sm 与 lg 对调                        1 红：四种尺寸各给一套
// B5  不走 `cn`，改纯字符串拼接            2 红：冲突时调用方赢 ／ 盖色不带走 base
// B6  拼错的变体名兜成 default             1 红：拼错的那一条（不崩也不给颜色）
// B7b 丢掉 `{...props}` 透传              13 红：只剩 displayName 那条还绿
//     （children 本身就是 prop——这一记读出来的就是"全仓 32 只文件一起瞎"的真实爆炸半径）
// B8  disabled 只给 aria-disabled          1 红：落在真属性上
// B9  不转发 ref                           1 红：ref 拿到 button 本体
// B10 size 写死成 default                  2 红：四种尺寸 ／ 变体与尺寸正交
// B11 variant 写死成 default               4 红：互不相同 ／ destructive 一族 ／ 正交 ／ 拼错那一条
// B12 ghost 串里加上 bg-primary            1 红：ghost 与 link 没有实心底色
// B13 默认补 `type="button"`               1 红：不写 type 时 DOM 上就没有这个属性
// B14 displayName 改成 "Btn"               1 红：displayName
// B15 base 少 `focus-visible:ring-2`       2 红：六变体都带 base ／ 盖色不带走 base
//
// 两笔方法上的账：
// 1) B7 第一遍是**废读**（transform_failed=1、reds=0）：把 `MUT-` 注释写在 `/>` 之后当 JSX
//    兄弟节点，esbuild 直接解析失败，整只文件没跑起来。挪到 return 上方重打为 B7b。
//    教训还是那条：markers=1 不等于刀有效，transform_failed 必须一起核。
// 2) 「盖色不带走 base」里判"被盖掉"不能写 `not.toContain("bg-primary")`：串里合法地留着
//    `hover:bg-primary/90`，带前缀的是另一格。改成按空格切开取整 token（hasBare），
//    否则这条判据会把正确的合并行为读成红。
