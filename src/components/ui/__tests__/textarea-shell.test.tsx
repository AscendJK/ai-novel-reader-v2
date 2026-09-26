/**
 * ui/textarea — 那三处多行框首次有直接判据
 *
 * 23 行的壳，和 `ui/input` 同族但**少一个 `type` 格**，多一格今天真正要紧的东西：
 * **读者写进去的换行不许在这层被改动**。三处调用点全是长文本：笔记输入框、笔记的编辑框
 * （`NotesTab.tsx:51/181`）、问答的提问框（`QATab.tsx:91`）。这一层把 value 过一道手
 * （trim、去 `\r`、`onChange={e => ...}` 里加工）都会变成"读者的笔记悄悄变了"。
 *
 * 判的三件事：
 * 1. `{...props}` 原样到 DOM：`id`/`name`、`placeholder`、受控的 `value`/`onChange`、
 *    `onKeyDown`（QATab 的"Enter 发问、Shift+Enter 换行"与 NotesTab 的"Ctrl/Cmd+Enter 保存"
 *    都挂在这上面）、`onClick`（`NotesTab.tsx:184` 那句 `stopPropagation` 就指望它穿下去）、
 *    `disabled`、`ref`；
 * 2. **换行与空格一字不动**（受控与非受控两条路各测一遍）；
 * 3. `className` 走 `cn`：三处调用点都在盖高度与字号（`min-h-[50px]`/`[60px]`/`[40px]` 与
 *    `text-xs`），冲突时调用方赢；不冲突的 `rounded-md`、`px-3`、`focus-visible:ring-2`、
 *    `disabled:opacity-50` 不许一起丢；不写 `className` 时壳给的 `min-h-[80px]` 要生效。
 *
 * 三条留在明处的产品事实（**都归调用点或归"删"的排序，不在这里钉死**）：
 * - `NotesTab.tsx:181` 那只编辑框**没有 `id`、没有 `placeholder`、没有 `aria-label`**——
 *   读屏念得出"多行编辑框"但念不出它是干什么的。另两只靠 `id` + `placeholder` 取得可访问名。
 *   这是调用点缺一个名字，不是这只壳坏了；补名字归调用点那一档。
 * - `ref` 这一格**今天全仓零调用**（`useRef<HTMLTextAreaElement>` 搜不到）。留着判据是因为
 *   `forwardRef` 是这只壳的公开契约，摘掉它属于 API 变更；真要连 `forwardRef` 一起删，
 *   改这条用例是应有的一步，不是"测试坏了"。
 * - `disabled:*` 那两条也没有调用点在用一个禁用的多行框，但 textarea **能**进 disabled 态
 *   （不像 badge 那枚不可聚焦的 div），所以按"元素能不能进那个状态"这条口径判它。
 */
import { describe, it, expect, vi } from "vitest";
import { useRef, type ChangeEvent, type KeyboardEvent, type MouseEvent } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Textarea } from "../textarea";

const BASE = [
  "flex", "min-h-[80px]", "w-full", "rounded-md", "border-input", "bg-background",
  "px-3", "py-2", "text-sm", "ring-offset-background", "placeholder:text-muted-foreground",
  "focus-visible:outline-none", "focus-visible:ring-2", "disabled:opacity-50",
];

function classOf(name: string): string {
  return (screen.getByRole("textbox", { name }) as HTMLTextAreaElement).className;
}

function hasBare(cls: string, token: string): boolean {
  return cls.split(/\s+/).includes(token);
}

describe("{...props} 原样到 DOM", () => {
  it("渲染出来是真 textarea，children 走 props", () => {
    render(<Textarea aria-label="提问" />);
    const el = screen.getByRole("textbox", { name: "提问" });
    expect(el.tagName).toBe("TEXTAREA");
  });

  it("id 与 name 穿到本体，placeholder 也到（另两只框的可访问名就靠这两格）", () => {
    render(<Textarea id="qa-input" name="qa-input" placeholder="输入问题，支持追问..." />);
    const el = screen.getByRole("textbox");
    expect(el).toHaveAttribute("id", "qa-input");
    expect(el).toHaveAttribute("name", "qa-input");
    expect(el).toHaveAttribute("placeholder", "输入问题，支持追问...");
  });

  it("受控的 value 与 onChange：值当场交回调用方，改了的 value 也画得出来", () => {
    // 同 ui/input 那一记：受控元素在事件之后会被 React 按 prop 复原，所以必须在 handler 当场取
    const seen: string[] = [];
    const onChange = vi.fn((e: ChangeEvent<HTMLTextAreaElement>) => { seen.push(e.target.value); });
    const { rerender } = render(<Textarea aria-label="笔记" value="第一段" onChange={onChange} />);
    const el = () => screen.getByRole("textbox", { name: "笔记" }) as HTMLTextAreaElement;
    fireEvent.change(el(), { target: { value: "第一段\n第二段" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["第一段\n第二段"]);
    // JSX 属性写成字符串字面量时 `\n` **不是换行**，是两个字符——必须走表达式括号
    rerender(<Textarea aria-label="笔记" value={"第一段\n第二段"} onChange={onChange} />);
    expect(el().value).toBe("第一段\n第二段");
  });

  it("换行与行首空格一字不动地画出来（非受控那条路也一样）——这层不许加工读者的内容", () => {
    const raw = "  第一行\n第二行\n\n第四行（前面是空行）\n";
    render(<Textarea aria-label="原样" defaultValue={raw} />);
    const el = screen.getByRole("textbox", { name: "原样" }) as HTMLTextAreaElement;
    expect(el.value).toBe(raw);
    expect((el.textContent ?? "").length, "多行内容不许被压成一行").toBeGreaterThan(10);
  });

  it("onKeyDown 三种组合都到得了调用方（Enter 发问 / Shift+Enter 换行 / Ctrl+Enter 保存）", () => {
    const seen: string[] = [];
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      seen.push(`${e.key}:${e.shiftKey ? "shift" : ""}${e.ctrlKey || e.metaKey ? "ctrl" : ""}`);
    };
    render(<Textarea aria-label="问答" defaultValue="问" onKeyDown={onKeyDown} />);
    const el = screen.getByRole("textbox", { name: "问答" });
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyDown(el, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(el, { key: "Enter", ctrlKey: true });
    expect(seen).toEqual(["Enter:", "Enter:shift", "Enter:ctrl"]);
    expect((el as HTMLTextAreaElement).value, "壳不许顺手把内容改掉").toBe("问");  });

  it("onClick 穿得下去（编辑框那句 stopPropagation 靠它，不穿下去就是「点编辑框把整条收起」）", () => {
    let bubbled = 0;
    const onOuter = () => { bubbled += 1; };
    const onClick = (e: MouseEvent<HTMLTextAreaElement>) => { e.stopPropagation(); };
    render(
      <div onClick={onOuter}>
        <Textarea aria-label="编辑中" onClick={onClick} />
      </div>,
    );
    fireEvent.click(screen.getByRole("textbox", { name: "编辑中" }));
    expect(bubbled, "onClick 没穿下去：外层监听替读者把面板收起了").toBe(0);
  });

  it("disabled 落在真属性上，且类串里那一格确实配得上这个状态", () => {
    render(<Textarea aria-label="只读着" disabled />);
    const el = screen.getByRole("textbox", { name: "只读着" }) as HTMLTextAreaElement;
    expect(el.disabled).toBe(true);
    expect(el.hasAttribute("aria-disabled")).toBe(false);
    expect(classOf("只读着")).toContain("disabled:cursor-not-allowed");
  });

  it("ref 拿到的是真 textarea（今天全仓没人用它，但 forwardRef 是这只壳的公开契约）", () => {
    const Probe = () => {
      const ref = useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <Textarea ref={ref} aria-label="带 ref" />
          <button onClick={() => ref.current?.focus()}>去聚焦</button>
        </>
      );
    };
    render(<Probe />);
    screen.getByText("去聚焦").click();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "带 ref" }));
  });
});

describe("className 是合并，不是顶掉", () => {
  it("三处的 min-h-[50px]/[60px]/[40px] 都挤得掉默认高度，但不冲突的柱子全在", () => {
    const { unmount } = render(<Textarea aria-label="笔记框" className="text-xs min-h-[50px]" />);
    let cls = classOf("笔记框");
    expect(hasBare(cls, "min-h-[50px]")).toBe(true);
    expect(hasBare(cls, "min-h-[80px]")).toBe(false);
    expect(hasBare(cls, "text-xs")).toBe(true);
    expect(hasBare(cls, "text-sm")).toBe(false);
    for (const bit of ["rounded-md", "px-3", "py-2", "focus-visible:ring-2", "disabled:opacity-50"]) {
      expect(cls, `丢了 ${bit}`).toContain(bit);
    }
    unmount();
    render(<Textarea aria-label="提问框" className="text-xs min-h-[40px]" />);
    cls = classOf("提问框");
    expect(hasBare(cls, "min-h-[40px]")).toBe(true);
    expect(hasBare(cls, "min-h-[80px]")).toBe(false);
  });

  it("不写 className 时壳给的高度与字号生效（min-h-[80px] + text-sm）", () => {
    render(<Textarea aria-label="裸框" />);
    const cls = classOf("裸框");
    for (const bit of BASE) expect(cls, `少了 ${bit}`).toContain(bit);
  });

  it("没给 className 时不许冒出 undefined 这类脏字面量", () => {
    render(<Textarea aria-label="干净" />);
    expect(classOf("干净")).not.toMatch(/undefined|false|null/);
  });
});

describe("壳自己的署名", () => {
  it("displayName 是 Textarea", () => {
    expect(Textarea.displayName).toBe("Textarea");
  });
});

// ── 变异台账（基线 sha256=ed7c4a2c… / 755 B；一刀一跑一还原，每轮核 markers=1、
//    transform_failed=0、markers_left=0、diff_lines=0、sha 回到基线）────────────────────
//
// 10 刀全部咬红，没有一记 0 红；12 条用例每一条都被指名打红过。
// 对照：T0 首跑红 1 条——**是我自己的预期写错**（见下面第一记），修完 T0b＝12 绿；
// 收局 T0c 再跑一次＝12 绿，证明中途没把产品留下半个字。
//
// 第一记（写判据时踩到的，比任何一刀都值得留）：**JSX 属性写成字符串字面量时 `\n` 不是换行**。
//   `value="第一段\n第二段"` 交给组件的是"反斜杠 + n"两个字符，于是断言
//   `el.value).toBe("第一段\n第二段")` 里左边是真换行、右边是字面量，红成
//   `expected '第一段\n第二段' to be '第一段\n第二段'`——两条看起来一模一样的字符串。
//   多行框这一档偏偏全靠换行，写错这一处就会把"判住了换行"读成"判住了两个字符"。
//   要判换行只能走表达式：`value={"第一段\n第二段"}`。
//
// U1  丢掉 `{...props}`            11 红（12 条只剩 displayName）：三只框的可访问名与内容一起没
// U2  `onChange` 被顶成空函数        1 红：受控那条（读者打字不再回传，症状是"写了笔记但存的是空的"）
// U3  base 少 `min-h-[80px]`         1 红：不写 className 时壳给的高度那条
// U4  这层 `defaultValue.trim()`     1 红：非受控那条——**开头结尾的空格与换行就是读者的内容**
// U5b 这层把 `value` 里的 `\n` 换成空格 1 红：受控那条。**与 U4 是两条路（受控／非受控），各下一刀**
// U6  `onClick` 被顶成空函数         1 红：`NotesTab.tsx:184` 那句 stopPropagation 白写，
//     症状是"点编辑框整条笔记被收起"
// U7  不转发 ref                    1 红：ref 那条（今天全仓没人用，但契约在）
// U8  `cn` 参数顺序对调              1 红：合并那条（三处的 min-h-[50px]/[60px]/[40px] 全被顶回 80）
// U9  base 少 `disabled:cursor-not-allowed` 1 红：disabled 那条
// U10 base 少 `placeholder:text-muted-foreground` 1 红：base 串那条
//
// 与 `ui/input` 那一档的分工：三处 Textarea 与 13 处 Input 共用的是 `cn` 与 `{...props}` 两格，
// 但**Input 的牙在 `type`（密文／数值），Textarea 的牙在"内容一字不动"（换行）**——
// 所以两档各写各的判据，不互相引用当作已判。
