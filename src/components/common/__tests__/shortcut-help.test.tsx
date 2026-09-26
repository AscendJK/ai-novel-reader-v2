/**
 * `common/ShortcutHelp` 的"自己那份契约"判据（地板第 1 档）。
 *
 * 这只面板是 `useKeyboardShortcuts` 那张表的**唯一出口**：hook 那边有判据（见
 * `hooks/__tests__/useKeyboardShortcuts-dispatch.test.ts:15`——"description 这个字段 hook
 * 从不读，它只服务 ShortcutHelp"），而面板自己一句判据都没有，且 `AppLayout` 的壳判据
 * 把它整只 `vi.mock` 掉了（`layout/__tests__/AppLayout-shell.test.tsx:78`）。也就是说
 * **读者实际看到的这九个键帽，以前没有任何一句判据看着**。
 *
 * 唯一调用点是 `AppLayout.tsx:278-290`，它给的九条就是这里的样本（一条不多一条不少）。
 * 判的是这个文件替读者做的四个决定：
 * 1) **点哪儿关、点哪儿不关**：遮罩 `onClick={onClose}` + 内层 `e.stopPropagation()`。
 *    少了后半句，症状是"在面板里选一行文字，帮助就自己关了"；而关闭按钮那一下如果两层
 *    都算，会变成 `onClose` 收两次——同一条判据两头都要取样。
 * 2) **键帽上的串与 hook 真听的键一致**：`keyLabel` 的符号表 + 修饰键前缀顺序。
 *    面板说"←"而监听的是 `ArrowLeft` 这件事本身是对的（`e.key` 就是 `ArrowLeft`），
 *    但**表少一格就露馅**：`" "` 那格被删掉之后走 `toUpperCase()`，键帽上是一个**看不见
 *    的空格**——界面不报错，读者只觉得"这格是空的"。
 * 3) **表外的大写兜底**：`t`→`T`、`i`→`I`（hook 比对的是小写 `e.key`，显示给读者要看大写）。
 * 4) **九行照原样、按顺序**：描述一字不改（其中两条是 `滚动: 上一章 / 翻页: 上一页` 这种
 *    带斜杠的长句），列表少一行没人会发现。
 *
 * 三格写在明处：
 * - **`Ctrl+`／`Alt+` 两条前缀本仓现在走不到**（实测：全仓只有 `AppLayout.tsx:77` 一条
 *   `shift: true`，ctrl/alt 绑定 0 处）。判它不是判现状界面，是判**这份显示表与 hook 的
 *   能力同源**——hook 认 `ctrl`/`alt`，哪天加一条 Ctrl 绑定而面板不显示，面板就在说假话。
 * - **"盖没盖住整屏"jsdom 量不到**：`fixed inset-0 z-50` 的实际效果（滚动页面上遮罩是否
 *   盖住、背后还能不能点）归浏览器层；**e2e 全仓现在没有一条快捷键面板的判据**（实测 grep
 *   `e2e/specs` 里"快捷键"0 命中），已记账。
 * - **这层遮罩其实不是"真模态"**：没有 `role="dialog"`/`aria-modal`、焦点能 Tab 到面板背后、
 *   那枚关闭按钮是**没有可访问名的图标按钮**（`<Button size="icon"><X/></Button>`）。
 *   这三格与 `VersionMismatchDialog` 修之前一模一样，属于产品缺陷、不属于这只壳自己的契约，
 *   **本轮不写判据也不改产品**——报制作人点头后单独一批办（判恒真的"它没有角色"等于把缺陷钉成现状）。
 *
 * **10 条判据、10 把刀，逐条读数记在文件末尾**（短号 J1..J10 / H1..H10）。
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import type { ShortcutBinding } from "@/hooks/useKeyboardShortcuts";

import { ShortcutHelp } from "../ShortcutHelp";

/** AppLayout.tsx:75-77 + 279-288 的原文九条（action 全换成空函数，面板不读它）。 */
const ROWS: ShortcutBinding[] = [
  { key: "t", action: () => {}, description: "切换主题" },
  { key: "Escape", action: () => {}, description: "关闭弹窗" },
  { key: "?", shift: true, action: () => {}, description: "显示快捷键帮助" },
  { key: "ArrowLeft", action: () => {}, description: "滚动: 上一章 / 翻页: 上一页" },
  { key: "ArrowRight", action: () => {}, description: "滚动: 下一章 / 翻页: 下一页" },
  { key: " ", action: () => {}, description: "翻页模式: 下一页" },
  { key: "+", action: () => {}, description: "增大字号" },
  { key: "-", action: () => {}, description: "减小字号" },
  { key: "i", action: () => {}, description: "切换沉浸模式" },
];

/** 遮罩／面板／行：三层各自的取法。 */
function open(props: { shortcuts?: ShortcutBinding[]; onClose?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn();
  const utils = render(<ShortcutHelp shortcuts={props.shortcuts ?? ROWS} onClose={onClose} />);
  const overlay = utils.container.firstElementChild as HTMLElement;
  const panel = overlay.firstElementChild as HTMLElement;
  return { ...utils, overlay, panel, onClose };
}

const rowsOf = (panel: HTMLElement) => [...panel.querySelectorAll("[class*='justify-between']")].filter((n) => n.querySelector("kbd"));
const keys = (panel: HTMLElement) => [...panel.querySelectorAll("kbd")].map((k) => k.textContent);

describe("ShortcutHelp：点哪儿关、点哪儿不关", () => {
  it("遮罩那一下关一次，面板里那一下不许关（少了 stopPropagation 就是「选字自己关了」）", () => {
    const { overlay, panel, onClose } = open();
    fireEvent.click(panel);
    expect(onClose, "面板里点空白不许关掉").toHaveBeenCalledTimes(0);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("面板里的一行（描述文字）不许把关闭带上", () => {
    const { onClose } = open();
    const row = screen.getByText("增大字号");
    fireEvent.click(row);
    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it("关闭按钮那一下只回报一次（按钮的 onClose 与遮罩的 onClose 不许叠成两次）", () => {
    const { panel, onClose } = open();
    const header = panel.firstElementChild as HTMLElement;
    const closeBtn = header.querySelector("button") as HTMLElement;
    expect(closeBtn, "前置：标题行里那枚关闭按钮要找得到").toBeTruthy();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ShortcutHelp：键帽上的串要与 hook 真听的键同源", () => {
  it("九行照原样、按顺序渲染，描述一字不改", () => {
    const { panel } = open();
    const rows = rowsOf(panel);
    expect(rows.length).toBe(9);
    ROWS.forEach((r, i) => {
      expect(rows[i].textContent).toContain(r.description);
    });
    expect(rows[3].textContent).toContain("滚动: 上一章 / 翻页: 上一页");
  });

  it("每行一只 kbd（键帽语义；换成 span 读屏就念不出「这是个键」）", () => {
    const { panel } = open();
    const caps = panel.querySelectorAll("kbd");
    expect(caps.length).toBe(9);
    expect(caps[0].tagName).toBe("KBD");
  });

  it("符号表逐条对上：← → Esc ? + - 与 Space", () => {
    const { panel } = open();
    expect(keys(panel)).toEqual(["T", "Esc", "Shift+?", "←", "→", "Space", "+", "-", "I"]);
  });

  it("空格那一格不许渲染成看不见的空键帽", () => {
    const { panel } = open({ shortcuts: [{ key: " ", action: () => {}, description: "翻页模式: 下一页" }] });
    const cap = panel.querySelector("kbd")!;
    expect(cap.textContent).toBe("Space");
    // 兜底是 toUpperCase()，而 " ".toUpperCase() 还是 " "——表里那一格没了就是一只空键帽
    expect(cap.textContent!.trim()).not.toBe("");
  });

  it("表外的键走大写兜底（hook 比的是小写 e.key，给读者看的是大写）", () => {
    const { panel } = open({
      shortcuts: [
        { key: "t", action: () => {}, description: "切换主题" },
        { key: "i", action: () => {}, description: "切换沉浸模式" },
        { key: "ArrowLeft", action: () => {}, description: "上一章" },
      ],
    });
    expect(keys(panel)).toEqual(["T", "I", "←"]);
  });

  it("修饰键前缀按 Ctrl→Shift→Alt，且没修饰键时一个字都不许多打", () => {
    // 本仓现在只有 shift 一条活着（AppLayout.tsx:77）；这一条判的是"显示表与 hook 的能力同源"，
    // 理由写在文件头第三格——hook 认 ctrl/alt，面板不显示就是假话。
    const { panel } = open({
      shortcuts: [
        { key: "k", ctrl: true, shift: true, alt: true, action: () => {}, description: "三个都按" },
        { key: "k2", ctrl: true, action: () => {}, description: "只按 Ctrl" },
        { key: "k3", action: () => {}, description: "一个都不按" },
      ],
    });
    expect(keys(panel)).toEqual(["Ctrl+Shift+Alt+K", "Ctrl+K2", "K3"]);
  });

  it("标题是真 h3（与全站卡片/面板标题同一层级，读屏按标题导航）", () => {
    open();
    const heading = screen.getByRole("heading", { level: 3, name: "键盘快捷键" });
    expect(heading.tagName).toBe("H3");
  });
});

/**
 * 判别力台账（2026-09-27 本机，`CI=1 npx vitest run src/components/common/__tests__/shortcut-help.test.tsx`）。
 * 基线：`src/components/common/ShortcutHelp.tsx` = sha256 `fd2479ef…`（1665 字节），
 * **产品代码一行没动**（10 刀每刀之后 `cp` 回基线并 `cmp` + 重核 sha，最后 `git diff --numstat` 空）。
 * 判据短号 J1..J10 按书写顺序；**没有一刀 0 红**。
 *
 *  J1 遮罩关一次/面板不关  J2 面板里一行不触发关闭  J3 关闭按钮只回报一次
 *  J4 九行照原样按顺序     J5 每行一只 kbd         J6 符号表逐条对上
 *  J7 空格那格不许空键帽   J8 表外大写兜底          J9 修饰键顺序与不缺打  J10 标题真 h3
 *
 *  H1 摘掉内层 `onClick={(e) => e.stopPropagation()}` → **3 红**（J1 J2 J3——正是要抓的两种坏法：
 *     面板里选字自己关了、关闭按钮叠成两次）
 *  H2 删掉 `keyLabel` 里 `" ": "Space"` 那一格 → **2 红**（J7 目标 + J6 连带）
 *     ★这条是本轮最有价值的一把：兜底是 `toUpperCase()`，而 `" ".toUpperCase()` 还是空格——
 *     少这一格界面不报错，键帽只是一只看不见的空盒。
 *  H3 `ArrowLeft: "←"` 改成原样 `"ArrowLeft"` → **2 红**（J6 + J8）
 *  H4 兜底 `map[key] || key.toUpperCase()` 去掉大写 → **3 红**（J6 J8 J9）
 *  H5 修饰键顺序换成 Alt→Shift→Ctrl → **1 红**（J9）
 *  H6 只留 Ctrl 那一支 → **2 红**（J6 的 `Shift+?` 是活着的调用点，J9 同源那半）
 *  H7 `h3` 换成 `div` → **1 红**（J10）
 *  H8 `kbd` 换成 `span` → **6 红**（J5 目标，其余按 `querySelectorAll("kbd")` 取的一起倒）
 *  H9 `shortcuts.map` 改成 `slice(0, 8).map`（少渲染一行）→ **3 红**（J4 目标 + J5 J6 连带）
 *  H10 关闭按钮的 `onClick={onClose}` 摘掉 → **1 红**（J3）
 *
 * 两条过程账（比读数更值得记）：
 * ① 早先用 `npx vitest run … | grep "FAIL"` 取数会**少行**——默认 reporter 用 ANSI 光标上移重画
 *   进度，重定向到文件后一条判据名就被盖掉一条（H4 那一次屏上只显 2 条、文件里有 3 条）。
 *   现在固定 `CI=1`（非交互 reporter）＋**从文件里 `grep -c` 数**，两条一起用才不会把"红 2 条"
 *   读成"红 3 条"或反过来。
 * ② 本轮第一次跑有 1 红是我自己写错的期望（`{key:"k2"}` 的兜底是 `K2` 不是 `K`）——判据先按
 *   实测改对，没动产品。
 */
