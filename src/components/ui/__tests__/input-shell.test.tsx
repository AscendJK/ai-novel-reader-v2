/**
 * ui/input — 那只输入框首次有直接判据（全仓 5 只文件、13 处用到它）
 *
 * 24 行的壳，判据要盯的格子却比 badge 硬：**这只壳自己决定 `type` 往哪儿去**
 * （它把 `type` 从 props 里单独摘出来再写回去，摘错一次 API Key 那格就从密文变成明文）。
 * 五只调用文件全是"读者要填东西"的地方：登录页（服务器地址、用户名）、API 设置（名称、
 * **Key**、Base URL、模型、上下文长度、输出上限）、RAG 设置（四格数值）、问答的范围两格、
 * 搜索那一格。坏起来的形状是"填进去的东西没生效"或"密钥在屏幕上明文出现"。
 *
 * 判的三件事：
 * 1. `type` 这一格：不写就是 text，写 password 必须是 password，写 number 就得连
 *    `min/max/step` 一起到 DOM（`RAGSettings.tsx:260/289/316/331` 与 `ApiSettings.tsx:226/266`
 *    那六格数值的步进与原生校验全在 `step`／`min` 上，壳吞掉一个数就是"填 0 也收"）；
 * 2. `{...props}` 透传：受控的 `value`/`onChange`、`placeholder`、`id`/`name`（Label 的
 *    `htmlFor` 靠它配对）、`aria-label`（问答与搜索那三格只有 aria-label，吞掉就是无名输入框）、
 *    `autoComplete`（用户名那格交给密码管理器）、`onKeyDown`（登录两处 Enter 提交与搜索的 Enter）、
 *    `disabled`（登录 loading 那一格）、`ref`（`UsernameLogin.tsx:108` 拿它 focus）；
 * 3. `className` 走 `cn`：调用点全在盖高度与字号（`h-7 text-xs`、`h-6 w-20 text-xs`），
 *    冲突时调用方赢，但不冲突的 `focus-visible:ring-2`、`disabled:opacity-50`、
 *    `placeholder:text-muted-foreground` 一起丢掉就是"焦点环没了、禁用态看不出来"。
 *
 * 两条留在明处的产品事实（刻意不钉死）：
 * - base 串里 `file:border-0 file:bg-transparent file:text-sm file:font-medium` 这四条
 *   **全仓走不到**：`<Input>` 没有一处是 `type="file"`，两处真正的文件选择用的是原生
 *   `<input type="file">`（`BookSelect.tsx:581/602`、`ExportPanel.tsx:120`）。按"死代码不写判据"
 *   的口径不给它立判据——真要清就是删掉这四条，而不是补一条测试把它们锁住。
 * - `type` 不写时 DOM 上没有 `type` 属性，浏览器按 `text` 处理。这一版判的是"传了就必须在"，
 *   **不判**"永远补一个默认的 `type`"——那是改库的行为，而且对表单语义没好处。
 */
import { describe, it, expect, vi } from "vitest";
import { useRef, type ChangeEvent, type KeyboardEvent } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Input } from "../input";

const BASE = [
  "flex", "h-10", "w-full", "rounded-md", "border-input", "bg-background",
  "px-3", "py-2", "text-sm", "ring-offset-background",
  "placeholder:text-muted-foreground",
  "focus-visible:outline-none", "focus-visible:ring-2", "disabled:opacity-50",
];

function classesOf(name: string): string {
  return (screen.getByLabelText(name) as HTMLInputElement).className;
}

/** 类串里有没有"裸"的这一格：`h-7` 算，`data-[x]:h-7` 不算（那是另一格） */
function hasBare(cls: string, name: string): boolean {
  return cls.split(/\s+/).includes(name);
}

describe("type 这一格（壳自己摘出来再写回去）", () => {
  it("不写 type：DOM 上没有这个属性，但浏览器仍按 text 处理", () => {
    render(<Input aria-label="书名" />);
    const el = screen.getByLabelText("书名") as HTMLInputElement;
    expect(el.hasAttribute("type")).toBe(false);
    expect(el.type).toBe("text");
  });

  it("写 password 就真是 password——API Key 那一格的密文靠这条", () => {
    render(<Input type="password" aria-label="密钥" defaultValue="sk-123" />);
    const el = screen.getByLabelText("密钥") as HTMLInputElement;
    expect(el.type).toBe("password");
    // 真属性生效的证据是"读出来是圆点"：value 拿得到，但显示类型必须是 password
    expect(el.value).toBe("sk-123");
  });

  it("写 number 就得连 min / max / step 一起到 DOM（那六格数值的校验全在它们身上）", () => {
    render(<Input type="number" aria-label="Top K" min={1} max={200} step={5} defaultValue={10} />);
    const el = screen.getByLabelText("Top K") as HTMLInputElement;
    expect(el.type).toBe("number");
    expect(el.min).toBe("1");
    expect(el.max).toBe("200");
    expect(el.step).toBe("5");
  });

  it("同一只壳切 type：两侧都要照走（只在 password 一侧取样会被「写死成 password」骗过）", () => {
    const { rerender } = render(<Input type="password" aria-label="切换" />);
    expect((screen.getByLabelText("切换") as HTMLInputElement).type).toBe("password");
    rerender(<Input type="text" aria-label="切换" />);
    expect((screen.getByLabelText("切换") as HTMLInputElement).type).toBe("text");
  });
});

describe("{...props} 原样到 DOM", () => {
  it("受控的 value 与 onChange：打字那一发把新值交回调用方，改了的 value 也会画出来", () => {
    // `e.target.value` 必须在 handler **当场**取：受控 input 在事件之后会被 React 按 prop
    // 复原（第一版判据事后去读 `mock.calls[0][0].target.value`，量到的是旧值 `gpt-4o`，
    // 那是受控组件的正常行为，不是产品坏了）。
    const seen: string[] = [];
    const onChange = vi.fn((e: ChangeEvent<HTMLInputElement>) => { seen.push(e.target.value); });
    const { rerender } = render(<Input aria-label="模型" value="gpt-4o" onChange={onChange} />);
    const el = () => screen.getByLabelText("模型") as HTMLInputElement;
    fireEvent.change(el(), { target: { value: "deepseek-chat" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["deepseek-chat"]);
    rerender(<Input aria-label="模型" value="deepseek-chat" onChange={onChange} />);
    expect(el().value).toBe("deepseek-chat");
  });

  it("placeholder 与 aria-label 都到 DOM（问答与搜索那三格只有 aria-label 可取名字）", () => {
    render(<Input aria-label="语义搜索" placeholder="输入关键词" />);
    const el = screen.getByLabelText("语义搜索");
    expect(el).toHaveAttribute("placeholder", "输入关键词");
    expect(el).toHaveAttribute("aria-label", "语义搜索");
  });

  it("id 与 name 穿到 input 本体（Label 的 htmlFor 与表单名都靠这一格）", () => {
    render(
      <div>
        <label htmlFor="api-key">API Key</label>
        <Input id="api-key" name="api-key" />
      </div>,
    );
    const el = screen.getByLabelText("API Key");
    expect(el).toHaveAttribute("id", "api-key");
    expect(el).toHaveAttribute("name", "api-key");
  });

  it("onKeyDown 拿得到当前输入（登录两处 Enter 提交读的就是 e.target.value）", () => {
    const seen: string[] = [];
    const onKey = vi.fn((e: KeyboardEvent<HTMLInputElement>) => {
      // KeyboardEvent 的 `target` 在 React 类型里是裸 EventTarget（ChangeEvent 才是 `T`），
      // 当场取 currentTarget 才是同一件事
      seen.push(e.currentTarget.value);
    });
    render(<Input aria-label="用户名" defaultValue=" Kun " onKeyDown={onKey} />);
    fireEvent.keyDown(screen.getByLabelText("用户名"), { key: "Enter" });
    expect(onKey).toHaveBeenCalledTimes(1);
    // 值原样交出去，不在壳这一层 trim——去不去空格是调用点的决定
    expect(seen).toEqual([" Kun "]);
  });

  it("autoComplete 不被吞（用户名那格要交给密码管理器）", () => {
    render(<Input aria-label="新用户名" autoComplete="username" />);
    expect(screen.getByLabelText("新用户名")).toHaveAttribute("autocomplete", "username");
  });

  it("disabled 落在真属性上，且带 disabled 时类串里那一格用得上", () => {
    render(<Input aria-label="服务器地址" disabled />);
    const el = screen.getByLabelText("服务器地址") as HTMLInputElement;
    expect(el.disabled).toBe(true);
    expect(el.hasAttribute("aria-disabled")).toBe(false);
    expect(classesOf("服务器地址")).toContain("disabled:cursor-not-allowed");
  });

  it("ref 拿到的是真 input（UsernameLogin 用它 focus 与找父级）", () => {
    const Probe = () => {
      const ref = useRef<HTMLInputElement>(null);
      return (
        <>
          <Input ref={ref} aria-label="带 ref" />
          <button onClick={() => ref.current?.focus()}>去聚焦</button>
        </>
      );
    };
    render(<Probe />);
    screen.getByText("去聚焦").click();
    expect(document.activeElement).toBe(screen.getByLabelText("带 ref"));
  });

  it("渲染出来是真 input 元素，不是被包成一层的 div", () => {
    render(<Input aria-label="形状" />);
    expect(screen.getByLabelText("形状").tagName).toBe("INPUT");
  });
});

describe("className 是合并，不是顶掉", () => {
  it("h-7 text-xs 挤掉 base 的 h-10 与 text-sm，但不冲突的柱子全在", () => {
    // 这就是 RAGSettings 与 ApiSettings 那七格的写法
    render(<Input className="h-7 w-24 text-xs" aria-label="上下文长度" />);
    const cls = classesOf("上下文长度");
    expect(hasBare(cls, "h-7")).toBe(true);
    expect(hasBare(cls, "h-10")).toBe(false);
    expect(hasBare(cls, "text-xs")).toBe(true);
    expect(hasBare(cls, "text-sm")).toBe(false);
    expect(hasBare(cls, "w-24")).toBe(true);
    expect(hasBare(cls, "w-full")).toBe(false);
    for (const bit of ["rounded-md", "px-3", "py-2", "focus-visible:ring-2", "disabled:opacity-50"]) {
      expect(cls, `丢了 ${bit}`).toContain(bit);
    }
  });

  it("base 那一串永远在（每一格都判，缺一格就是某一处输入框悄悄变形）", () => {
    render(<Input aria-label="裸框" />);
    const cls = classesOf("裸框");
    for (const bit of BASE) expect(cls, `少了 ${bit}`).toContain(bit);
  });

  it("没给 className 时不许冒出 undefined 这类脏字面量", () => {
    render(<Input aria-label="干净" />);
    expect(classesOf("干净")).not.toMatch(/undefined|false|null/);
  });
});

describe("壳自己的署名", () => {
  it("displayName 是 Input（DevTools 与按名查组件都靠它，forwardRef 组件没有它就只剩 Object）", () => {
    expect(Input.displayName).toBe("Input");
  });
});

// ── 变异台账（基线 sha256=a62d797d… / 807 B；一刀一跑一还原，每轮核 markers=1、
//    transform_failed=0、markers_left=0、diff_lines=0、sha 回到基线）────────────────────
//
// 12 刀：10 刀咬红，2 刀 0 红（E6/E12 是同一刀跑了两遍，读数一致）。对照 D0＝E0b＝16 条全绿。
// 首跑 E0 红 1 条是**我自己的预期写错**（不是产品坏，见下面"第一记"），修完才立对照。
//
// 第一记（写判据时踩到的）：**受控 input 的事件对象不能事后读**。第一版断言拿
//   `onChange.mock.calls[0][0].target.value`，量回来的是旧值 `gpt-4o`——React 在处理完 change
//   之后会把 DOM 的值按 prop 复原。改成在 handler 当场把值 push 进数组，判的才是
//   "调用点当时拿到什么"（`ApiSettings.tsx:168` 那七格写的就是当场取）。
//
// E1  摘掉 `type={type}` 那一行      3 红：password ／ number+min/max/step ／ 切 type 两侧。
//     **"不写 type"那条正好不该红**——红名分配本身就是判据没写反的证据。
// E2  `type={type ?? "text"}`          1 红：只有"DOM 上没有这个属性"那条。与 E1 反向，
//     钉的是"不写就没有"这一格（兜一个看着无害的默认值，症状是登录页那两格多了个属性）。
// E3  丢掉 `{...props}`              15 红（16 条只剩 displayName 那条绿）：`aria-label` 也走 props，
//     所以这一记读出来的就是"全仓 13 处输入框一起瞎"的爆炸半径。
// E4  base 整串不给，只留调用方的      3 红：disabled 那条 ／ 合并那条 ／ base 串那条
// E5  不转发 ref（`ref={undefined}`）  1 红：ref 那条（`UsernameLogin.tsx:108` 拿它 focus）
// E6/E12 摘掉 base 里 `file:` 那四条    **0 红 ×2**，而且**刻意不补断言**：全仓没有一处
//     `<Input type="file">`，两处真文件选择用的是原生 input（`BookSelect.tsx:581/602`、
//     `ExportPanel.tsx:120`）。死代码不写判据——真要动它就是删这四条。
// E7  摘掉 `disabled:cursor-not-allowed disabled:opacity-50`  3 红。**与 badge 的 D10 正好相反**：
//     同样是"focus/disabled 这类状态类"，input 天然可聚焦可禁用（且 `UsernameLogin.tsx:308` 真的
//     在用 disabled），所以这一格有牙；badge 那枚 div 拿不到焦点，同形的那一刀才是 0 红。
//     ——**"状态类是不是装饰"要看这个元素能不能进那个状态**，不能按类名形状一刀切。
// E8  摘掉 `focus-visible:ring-2`       2 红：合并那条 ／ base 串那条
// E9  `cn` 参数顺序对调（base 顶掉调用方）1 红：只有合并那条（调用点那七格的 h-7/h-6 全废）
// E10 不调 `cn`，改纯字符串拼接          2 红：合并那条 ／ "不许冒 undefined"那条
// E11 `displayName` 改掉                1 红：署名那条
