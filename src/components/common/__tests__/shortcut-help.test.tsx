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
 * 5) **它是一层模态**（2026-09-27 由制作人点头之后补的第五个决定）：`role="dialog"`＋`aria-modal`、
 *    可访问名挂在标题上、那枚图标按钮有名字、打开时焦点进墙、焦点掉到墙外时 Tab 要拉回来、
 *    ESC 是第二个出口、卸载时把焦点还给来路那一个、父组件重渲染不抢焦点也不留在旧回调上。
 *    与 `VersionMismatchDialog` 同一口径（判据见 `common/__tests__/version-mismatch-dialog.test.tsx`，
 *    浏览器层见 `e2e/specs/a2-version-modal.spec.ts`）。
 *
 * 三格写在明处：
 * - **`Ctrl+`／`Alt+` 两条前缀本仓现在走不到**（实测：全仓只有 `AppLayout.tsx:77` 一条
 *   `shift: true`，ctrl/alt 绑定 0 处）。判它不是判现状界面，是判**这份显示表与 hook 的
 *   能力同源**——hook 认 `ctrl`/`alt`，哪天加一条 Ctrl 绑定而面板不显示，面板就在说假话。
 * - **"盖没盖住整屏"jsdom 量不到**：`fixed inset-0 z-50` 的实际效果（滚动页面上遮罩是否
 *   盖住、背后还能不能点）归浏览器层；**e2e 全仓现在没有一条快捷键面板的判据**（实测 grep
 *   `e2e/specs` 里"快捷键"0 命中），已记账。同样，"焦点在墙里看得见的那个描边"（`outline-none`
 *   换掉了什么）、遮罩的模糊背景，也都是渲染层的事。
 * - **"Tab 在面板里来回打转"这一格 jsdom 判不得**：面板里只有**一枚**可聚焦元素（关闭按钮），
 *   `first === last`，"正着 Tab 走到下一项"在 DOM 上没有任何可观察对象。实测（M15）：把
 *   `first`/`last` 两个赋值整个对调——**0 红**、`vitest` 退出 0。这是等价变异，不补判据；
 *   那一格由两项面板的浏览器层判据看着（`a2-version-modal.spec.ts` 的 M2：六下 Tab 不许出墙、
 *   且必须在两项之间真的动）。jsdom 这一层判得住的是**焦点已经掉到墙外时 Tab 要把它拉回来**
 *   （5.4a 正向／5.4b 反向，两支分开：M7 只红 5.4a、M8 只红 5.4b、M6 整段 trap 死了红两条）。
 *
 * **18 条判据、20 把刀**（短号 J1..J10／5.1..5.7 与 M1..M15、C1..C3、T1..T2，逐条读数在文件末尾）。
 * 前 10 条是在产品代码还没修的时候立的（那一轮 10 刀全部咬红、产品零改动，记在末尾"旧账"那段）；
 * 2026-09-27 制作人点头"修这 3 个问题"之后，模态那 8 条补上、产品代码按 `VersionMismatchDialog`
 * 那份写法改写成真模态，**全部 20 刀在新基线上重打**（旧刀的读数一并重取，见末尾）。
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

/** 墙外的一枚按钮：模拟"焦点已经跑到面板背后"（真机上点了背景控件就是这个样子）。 */
function backgroundButton(label: string) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  document.body.appendChild(el);
  return el;
}

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

describe("ShortcutHelp 是一层模态（2026-09-27 补）：这层遮罩挡的不只是鼠标，还有键盘", () => {
  it("5.1 role=dialog + aria-modal，可访问名挂在标题上", () => {
    const { panel } = open();
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    const labelledBy = panel.getAttribute("aria-labelledby");
    expect(labelledBy, "可访问名要挂在标题上，不是再来一个 aria-label 的平行说法").toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("键盘快捷键");
  });

  it("5.2 那枚图标按钮有可访问名（只有 X 的时候读屏念不出这是干什么的）", () => {
    open();
    expect(screen.getByRole("button", { name: "关闭快捷键说明" })).toBeTruthy();
  });

  it("5.3 打开时焦点在墙里面，不在面板背后", () => {
    const { panel } = open();
    const active = document.activeElement as HTMLElement | null;
    expect(active, "打开之后焦点没进面板，读屏与键盘用户还在外面").toBeTruthy();
    expect(panel.contains(active)).toBe(true);
  });

  it("5.4a 焦点掉在墙外时，正着 Tab 要把它拉回面板（不是让 Tab 走空）", () => {
    const bg = backgroundButton("墙外");
    const { panel } = open();
    bg.focus();
    expect(document.activeElement).toBe(bg);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement, "Tab 之后还在墙外＝正向那道拦截没动手").not.toBe(bg);
    expect(panel.contains(document.activeElement as HTMLElement), "正向 Tab 没把焦点拉回面板").toBe(true);
    bg.remove();
  });

  it("5.4b 焦点掉在墙外时，Shift+Tab 也要拉回来（反向是另一格，两支分开判）", () => {
    const bg = backgroundButton("墙外");
    const { panel } = open();
    bg.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement, "Shift+Tab 之后还在墙外＝反向那道拦截没动手").not.toBe(bg);
    expect(panel.contains(document.activeElement as HTMLElement), "反向 Tab 没把焦点拉回面板").toBe(true);
    bg.remove();
  });

  it("5.5 ESC 关得掉且只报一次；别的键不许关", () => {
    const { onClose } = open();
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose, "随便一个键就把面板关掉").toHaveBeenCalledTimes(0);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("5.6 关掉之后焦点还给来路那一个（面板是抢来的，得还回去）", () => {
    const host = document.createElement("button");
    host.textContent = "来路";
    document.body.appendChild(host);
    host.focus();
    expect(document.activeElement).toBe(host);
    const { panel, unmount } = open();
    expect(panel.contains(document.activeElement as HTMLElement), "前置：打开时焦点已在面板里").toBe(true);
    unmount();
    expect(document.activeElement).toBe(host);
    host.remove();
  });

  it("5.7 父组件重渲染（调用点每次给新箭头函数）：焦点不许被抢回来，ESC 报的也是新那一个", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { panel, rerender } = open({ onClose: first });
    const closeBtn = panel.querySelector("button") as HTMLElement;
    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);
    rerender(<ShortcutHelp shortcuts={ROWS} onClose={second} />);
    expect(document.activeElement, "把这段效果的依赖写成 [onClose]，每次重渲染都会重新聚焦面板，用户的 Tab 白按").toBe(closeBtn);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(second, "ESC 要走最新那一份 onClose").toHaveBeenCalledTimes(1);
    expect(first, "旧那一份 onClose 不许再被叫").toHaveBeenCalledTimes(0);
  });
});

/**
 * 判别力台账（2026-09-27 本机，`CI=1 npx vitest run src/components/common/__tests__/shortcut-help.test.tsx`）。
 *
 * 当前基线：`ShortcutHelp.tsx` = sha256 `b4384333…`（4452 字节）＝已经改成真模态那一份。每刀之后
 * `cp` 回这份基线 + `cmp` + 重核 sha，20 刀跑完再取一次"0 刀对照"（18 条全绿、退出 0）。
 * 落笔顺序要说清：这 20 刀是先打在 `76f869b3…`（3881 字节）那一份上跑完的；之后往文件头补了两段
 * **注释**（ESC 有两条出口这一格、以及把"Tab 在墙里打转"改成实话），产品语义一个字没动，字节变了，
 * 于是把 0 刀对照与 M6／M11／T1／M15 四刀在新字节上重打一遍——读数一条没变（2 红、1 红、1 红、0 红、全绿）。
 * 判据短号：J1..J10（这只面板自己的契约）＋ 5.1..5.7（模态那七条）。**20 刀里 19 刀咬红，
 * 唯一 0 红的是 M15——那一格判不得，理由写在文件头第三格。**
 *
 *  5.1 role+aria-modal、可访问名挂在标题上   5.2 关闭按钮有可访问名   5.3 打开时焦点在墙里
 *  5.4a/5.4b 焦点掉到墙外时正/反向 Tab 要拉回来   5.5 ESC 关得掉且只报一次
 *  5.6 卸载时把焦点还给来路   5.7 父组件重渲染既不抢焦点也不留在旧回调上
 *
 *  M1  摘 `aria-modal="true"`                          → 1 红（5.1）
 *  M2  `aria-labelledby` 换成平行的 `aria-label`        → 1 红（5.1）
 *  M3  摘掉按钮的 `aria-label="关闭快捷键说明"`          → 1 红（5.2）
 *  M4  摘掉 `panelRef.current?.focus()`                → 2 红（5.3 5.6）
 *  M5  摘掉面板的 `tabIndex={-1}`                      → 2 红（5.3 5.6）＝与 M4 红同一批名字、两格不同的刀
 *  M6  `Array.from(querySelectorAll)` 换成空数组（trap 整段死）→ 2 红（5.4a 5.4b）
 *  M7  正向分支去掉 `!inside`                          → 1 红（5.4a）
 *  M8  反向分支去掉 `!inside`                          → 1 红（5.4b） ← M7/M8 各只红一条＝两格真的分开判住了
 *  M9  ESC 分支里那句回报摘掉（留着 `return`）          → 2 红（5.5 5.7）
 *  M10 卸载时不再 `previous?.focus?.()`                → 1 红（5.6）
 *  M11 ESC 不走 ref、直接闭包捕获 `onClose`             → 1 红（5.7）
 *  M12 焦点那段效果的依赖写成 `[onClose]`              → 1 红（5.7）——重渲染把焦点抢回面板
 *  M13 `closeRef` 只同步一次（依赖写成 `[]`）           → 1 红（5.7）——ESC 打在旧那一份回调上
 *  M14 把"记来路"挪到"抢焦点"之后                      → 1 红（5.6）＝顺序刀：来路记晚了就还错地方
 *  M15 `first`/`last` 两个赋值对调                     → **0 红、退出 0**（等价变异；那一格判不到）
 *  C1  摘掉面板的 `stopPropagation`                    → 3 红（J1 J2 J3）＝旧 H1 在新基线上重打，读数一致
 *  C2  摘掉遮罩的 `onClick={onClose}`                  → 1 红（J1）
 *  C3  摘掉关闭按钮自己的 `onClick={onClose}`           → 1 红（J3）＝旧 H10 重打，读数一致
 *  T1  `h3` 换成 `div`                                 → 1 红（J10）＝旧 H7 重打，读数一致
 *  T2  删掉 `" ": "Space"` 那一格                      → 2 红（J6 J7）＝旧 H2 重打，读数一致
 *
 * 旧账（同日早先，基线 `fd2479ef…`/1665 字节、产品一行没动）：H1 3 红、H2 2 红、H3 2 红、H4 3 红、
 * H5 1 红、H6 2 红、H7 1 红、H8 6 红、H9 3 红、H10 1 红。产品改写之后，H3/H4/H5/H6/H8/H9 这六刀的
 * **目标行**逐字节核过与旧基线相同（`keyLabel` 那张表、大写兜底、修饰键前缀、`kbd`、`shortcuts.map`），
 * 读数照抄；H1/H2/H7/H10 四刀的目标行这次动到了（面板那行拆成多行、`h3` 多了 `id`、按钮多了
 * `aria-label`），所以在新基线上重打过——C1/T2/T1/C3，四条读数一条没变。
 *
 * 两条过程账（比读数更值得记）：
 * ① 早先用 `npx vitest run … | grep "FAIL"` 取数会**少行**——默认 reporter 用 ANSI 光标上移重画
 *   进度，重定向到文件后一条判据名就被盖掉一条（H4 那一次屏上只显 2 条、文件里有 3 条）。
 *   现在固定 `CI=1`（非交互 reporter）＋**从文件里 `grep -c` 数**，两条一起用才不会把"红 2 条"
 *   读成"红 3 条"或反过来。
 * ② 本轮第一次跑有 1 红是我自己写错的期望（`{key:"k2"}` 的兜底是 `K2` 不是 `K`）——判据先按
 *   实测改对，没动产品。
 *
 * 再补两条（改写产品那一轮踩的，比上面两条更贵）：
 * ③ **jsdom 里"连按八下 Tab 不许出面板"是一条假绿判据**：jsdom 处理 `keydown` 不会自己移动焦点，
 *   所以把整段 trap 摘掉（M6）焦点仍然原地不动、那条判据仍然绿。改成"焦点先掉到墙外一枚按钮上，
 *   Tab 必须把它拉回面板"才有牙——同一把 M6 现在红两条（5.4a/5.4b）。**判"拦住了键盘"必须判
 *   "handler 自己动了焦点"，不能判"焦点没动"。**
 * ④ 5.7 第一次跑是红的，红在我自己：从 RTL 的 `render()` 里解构了 `panel`（它只给 `container`），
 *   那是夹具坏了不是产品坏了。用本文件自己的 `open({ onClose: first })` 拿到 `panel` 与 `rerender`
 *   之后 18 条全绿，才继续下刀。
 */
