/**
 * VersionMismatchDialog — 版本不一致提示弹窗首次有直接判据
 *
 * 它是前后端版本对不上时用户看到的唯一说明：两个版本号、一句"哪些功能可能不正常"、
 * 一条去哪拿新后端的链接，以及一个"继续使用"的出口。之前只有 `AppLayout-shell` 整只 mock 掉它
 * （量的是"该不该弹、关掉之后还弹不弹"），弹窗里面写了什么没人看着。
 *
 * 判的五件事：
 * 1. 两个版本号各归各的槽——这面墙存在的意义就是让用户比对这两个数，串了比对立着更糟；
 * 2. 外链 `target="_blank"` 必须配 `rel="noopener noreferrer"`（少了就是新页面能摸到 window.opener）；
 * 3. 出口只有「继续使用」这一个，且它叫的就是 onClose；
 * 4. 说清去哪拿新后端（重启后端 / 解压覆盖 / Releases 链接），这三句都在；
 * 5. 模态那七格（可读名挂在标题上 + `aria-modal`／焦点进来与归还／ESC 关／ESC 叫的是最新那份
 *    回调／Tab 两个方向都在墙里打转／卸载把 window 监听摘干净／重渲染不抢焦点）——见最后那个新 describe。
 *
 * 2026-09-27 口径已定并落地：**当作真模态办**（制作人点头的方案 A）。
 * 原来的张力在于"仅作提示，不阻止用户使用"这句话与 `fixed inset-0` 这面墙互相矛盾——
 * 遮罩其实挡住了底下的一切。现在产品侧承认它是模态：`role="dialog"` + `aria-modal` +
 * 可访问名挂在标题上 + 打开时焦点进墙 + Tab 在墙里打转 + ESC 是第二个出口 + 卸载时焦点归还，
 * 而"不阻止使用"改口径成**关掉之后**不降级任何功能。这一只现在是全仓唯一带 `role="dialog"`
 * 的界面（grep 只这一处），别的"弹窗"要不要一起办是另一笔账，不由这一只代答。
 *
 * 有意不判的格子（写了理由，不是漏）：
 * - `z-[300]`、`fixed inset-0`、遮罩透明度这些类名的真实效果（盖住多少、点得到点不到）
 *   归浏览器层；这里只判类名形状。**模态那四件事也只在 jsdom 层判**：真浏览器里"Tab 出不去"
 *   与"焦点归还后页面会不会滚回去"要有现场才能量，而造版本不一致的现场目前没有 e2e 覆盖
 *   （全仓没有 spec 碰这只弹窗）——这一条是欠账，不是已判。
 * - 点遮罩不关闭：判的是现状（遮罩点击仍不关，出口只有「继续使用」与 ESC）。
 *   加了 ESC 之后这条没有变弱：V9 那一刀（遮罩 onClick 即关）照样红两条，还多一条双发。
 * - 两句说明正文的完整措辞：只钉各自的关键词，整句钉死会让正常润色变成红。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VersionMismatchDialog } from "../VersionMismatchDialog";

/** 两个值故意长得完全不一样：任何一侧写死或串槽都藏不住 */
const FE = "2.4.0";
const BE = "2.3.1";

function renderDialog(over?: Partial<{ frontend: string; backend: string; onClose: () => void }>) {
  const onClose = over?.onClose ?? vi.fn();
  render(
    <VersionMismatchDialog
      frontend={over?.frontend ?? FE}
      backend={over?.backend ?? BE}
      onClose={onClose}
    />,
  );
  return { onClose };
}

/** 「前端版本」/「后端版本」那两行：标签与值同一个 flex 行内，按标签取行 */
function rowOf(label: string): HTMLElement {
  const tag = screen.getByText(label).parentElement as HTMLElement;
  return tag;
}

describe("说明的内容", () => {
  it("标题与'不阻止使用'的定性句都在场", () => {
    renderDialog();
    expect(screen.getByText("前后端版本不一致")).toBeInTheDocument();
    expect(screen.getByText("部分功能可能无法正常工作")).toBeInTheDocument();
  });

  it("「前端版本」那一行取的是 frontend，不是 backend", () => {
    renderDialog();
    const row = rowOf("前端版本");
    expect(row.textContent).toContain("前端版本");
    expect(row.textContent).toContain(FE);
    expect(row.textContent).not.toContain(BE);
  });

  it("「后端版本」那一行取的是 backend，不是 frontend", () => {
    renderDialog();
    const row = rowOf("后端版本");
    expect(row.textContent).toContain("后端版本");
    expect(row.textContent).toContain(BE);
    expect(row.textContent).not.toContain(FE);
  });

  it("两个值对调之后两行跟着对调（证明槽是跟着 prop 走的，不是写死的）", () => {
    renderDialog({ frontend: "9.9.9", backend: "1.0.0" });
    expect(rowOf("前端版本").textContent).toContain("9.9.9");
    expect(rowOf("后端版本").textContent).toContain("1.0.0");
    expect(rowOf("前端版本").textContent).not.toContain("1.0.0");
  });

  it("建议正文两句都在：重启后端 / 重新构建前端", () => {
    renderDialog();
    const text = document.body.textContent || "";
    expect(text).toContain("建议重启后端服务器");
    expect(text).toContain("或重新构建部署前端");
  });

  it("去哪拿新后端说清楚了：GitHub Releases 链接 + '解压覆盖原项目目录'", () => {
    renderDialog();
    const text = document.body.textContent || "";
    expect(text).toContain("可前往");
    expect(text).toContain("下载最新后端包");
    expect(text).toContain("解压覆盖原项目目录");
  });
});

describe("那条外链", () => {
  function link(): HTMLAnchorElement {
    return screen.getByRole("link", { name: "GitHub Releases" }) as HTMLAnchorElement;
  }

  it("指向本仓的 releases 页，文字就是 GitHub Releases", () => {
    renderDialog();
    expect(link().getAttribute("href")).toBe("https://github.com/AscendJK/ai-novel-reader-v2/releases");
    expect(link().textContent).toBe("GitHub Releases");
  });

  it("新窗口打开就必须带 noopener 与 noreferrer：三者同进同退", () => {
    renderDialog();
    const a = link();
    expect(a.getAttribute("target")).toBe("_blank");
    const rel = a.getAttribute("rel") || "";
    expect(rel.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  });
});

describe("出口", () => {
  it("整面只有一个可操作出口，文案是「继续使用」而不是「关闭」", () => {
    renderDialog();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect((buttons[0] as HTMLButtonElement).textContent).toBe("继续使用");
  });

  it("点「继续使用」＝叫 onClose 一次（关掉之后还弹不归这只组件，归调用点）", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "继续使用" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点遮罩本身不关闭：现状是只有那一个出口能关", () => {
    const { onClose } = renderDialog();
    const overlay = document.querySelector(".fixed.inset-0") as HTMLElement;
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("出口是个真按钮（能被键盘触发、读屏列得出来），不是一个带 onClick 的 div", () => {
    renderDialog();
    const btn = screen.getByRole("button", { name: "继续使用" }) as HTMLButtonElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.disabled).toBe(false);
  });

  it("形状类还在（盖满整面、层级压住内容）：真实遮挡效果归浏览器层", () => {
    renderDialog();
    const overlay = document.querySelector(".fixed.inset-0");
    expect(overlay?.className).toContain("z-[300]");
    expect(overlay?.className).toContain("bg-background/80");
  });
});

/*
 * ── 变异台账（还原法：字节基线 `sha256=ed5a0fdf…` / 2513 B，`cp` 到临时基线，一刀一跑一还原）──
 *
 * 15 刀全部至少打红一条，没有一刀 0 红（即没有"等价变异"混在里面）。每轮 markers=1、
 * transform_failed=0、markers_left=0、diff_lines=0、sha 回到基线——除 V6 那轮见下。
 *
 * V0-对照        exit=0  reds=0  （13 全绿）
 * V1-两行槽对调  reds=3  「前端版本」取 frontend ／「后端版本」取 backend ／ 两个值对调那条
 * V2-前端槽写死  reds=2  「前端版本」那一行 ／ 对调那条
 * V3-去掉 rel    reds=1  noopener+noreferrer 那条
 * V4-去掉 target reds=1  同一条（target 与 rel 分开下刀，各红各的）
 * V5-链接指到仓库首页 reds=1  href 那条
 * V6b-按钮不叫 onClose reds=1  点击→onClose 那条
 *   （V6 首刀同样改 onClick，但把 `MUT-` 注释写进了按钮正文里，`textContent` 断言吃到多出来的
 *    空白，连带「只有一个出口」一起红——刀的污染不是判据的功劳，删掉重写为 V6b，只红一条。）
 * V7-onClose 叫两次 reds=1  同一条（toHaveBeenCalledTimes(1) 不是 toHaveBeenCalled()）
 * V8-加第二个出口 reds=1  「整面只有一个可操作出口」
 * V9-遮罩点击即关闭 reds=2  「点遮罩不关闭」+「点按钮叫一次」——加了遮罩 onClick 之后按钮那一下
 *    冒泡到遮罩，onClose 被叫两回。一条刀同时盯住"多一个关法"和"出口双发"两件事。
 * V10-标题改字 reds=1  标题那条
 * V11-删掉 Releases 整段 reds=3  「去哪拿新后端」+ href 那条 + target/rel 那条（整段没了，三条一起塌）
 * V12-z-[300] 降到 z-50 reds=1  形状类那条
 * V13-出口换成带 onClick 的 div reds=3  「只有一个出口」+「点击」+「真按钮」（getAllByRole 空即抛）
 * V14-后端槽写死 reds=1  只有对调那条红
 *   （值得记一笔：单独盯「后端版本那一行含 2.3.1」的判据会被骗过去——夹具里的 BE 就是 "2.3.1"，
 *    写死成同一个字面量它照样绿。真正盯住写死的是"把两个值对调再渲染"那一条。）
 * V15-删掉建议正文整段 reds=1  「建议重启后端 / 重新构建前端」那条
 *
 * ── 2026-09-27 补：按真模态办（新基线 sha `99b3b4e0`／4821 B；旧基线 ed5a0fdf 与中途的
 * 7adc4619 都作废——后者被 lint 一记 `react-hooks/refs`（渲染期写 ref）打回，改成提交后同步，
 * 于是多出第 20 条与 W10。闸门又一次替我挡了"看着绿其实接线错"。）
 * 新七条（14~20）× 十一刀，每刀都咬住且红名可归因：
 * W1 摘 `role="dialog"`            3 红：14 与 15/17（那两条靠 `getByRole("dialog")` 取容器，
 *    角色没了连带取不到——这一记读出的是"角色是三条的共同把手"）
 * W2 摘 `aria-modal`               1 红：只有 14
 * W3 摘 `aria-labelledby`          1 红：14（报的是"可访问名要靠 id 指向标题"那句）
 * W4 ESC 分支不再叫 onClose        1 红：16
 * W5 打开时不聚焦进弹窗            1 红：15（红在"焦点还留在背景"那一侧取样）
 * W6 卸载时不还焦点                1 红：15（同一条的另一侧：activeElement 落在 body）
 * W7 不摘 window 监听              1 红：18 —— **这条判据在实现之前是必然绿的**（那时还没有监听
 *    可摘），它的牙是随实现才长出来的；所以立红阶段它 0 红不算证据，W7 才是。
 * W8 末尾不绕回（正向 Tab）        1 红：17
 * W8b 开头不绕回（Shift+Tab）      1 红：17 的另一条断言 —— 两个方向是两格，各下一刀
 * W9b 焦点效果的依赖写成 `[onClose]`  1 红：19（重渲染把焦点从 Releases 链接抢回面板）。
 *    第一版 W9 是在"渲染期写 ref"那个形状上跑的，产品被 lint 打回后重打，读数同为 1 红。
 * W10 提交后不把 onClose 同步进 ref  1 红：20 —— 这一格与 W9b 是**相反方向的两格**：
 *    依赖写上 onClose 红的是"焦点被抢"，不同步红的是"ESC 叫到旧回调"。只判一头时另一头随便坏。
 * 对照 W0：19 全绿（开局与收局各一次）。
 *
 * 途中自己差点踩的两记：一是 W1 还没还原就想叠 W2（盘上同时两刀就分不出红名归谁，
 * 上一轮已经为此作废过一次）；二是这段注释本身——把变异标记的字面写法贴进文档注释会提前
 * 闭合注释块，整只文件解析失败、报出"0 test"。所以这里只说"属性堆里插注释"那种写法，
 * 不贴它的原文。规则不变：**一次一处、跑完立刻 `cp` 回基线并 `cmp`**，
 * `grep -c MUT-` 归零才算还原干净。
 *
 * 覆盖到的格子：13 条用例 × 15 刀，每格都被至少一刀指名打中；没有判了却从没红过的格子。
 */

describe("既然遮罩挡住了底下的一切，就按真模态判它", () => {
  // 口径已定（制作人点头）：这面墙**当作模态办**，不是"仅作提示"。
  // 遮罩 `fixed inset-0` 已经把底下的东西全挡住了，此时不给可访问名与键盘出口，
  // 用户面对的就是一层读屏念不出、Tab 还会跑进去的雾。
  // RTL 的自动 cleanup 只管它自己挂进去的容器，下面这些是手动 append 到 body 的，
  // 不清掉就会让"整面只有一个可操作出口""getByRole('dialog') 取唯一"这类断言跨用例串味。
  afterEach(() => {
    document.body.querySelectorAll("[data-host-button]").forEach((n) => n.remove());
  });

  function host(): HTMLButtonElement {
    const b = document.createElement("button");
    b.dataset.hostButton = "1";
    b.textContent = "背景里的那枚按钮";
    document.body.appendChild(b);
    return b;
  }

  it("14. 有 role=\"dialog\"、aria-modal，且名字挂在标题那一句上", () => {
    renderDialog();
    const dlg = screen.getByRole("dialog") as HTMLElement;
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dlg.getAttribute("aria-labelledby");
    expect(labelledBy, "可访问名要靠 id 指向标题，不能靠 aria-label 各写一份措辞").toBeTruthy();
    const title = document.getElementById(labelledBy!);
    expect(title?.textContent).toBe("前后端版本不一致");
  });

  it("15. 打开时焦点进到墙里，卸载时还给来路那一个", () => {
    const outside = host();
    outside.focus();
    expect(document.activeElement).toBe(outside);
    const { unmount } = render(
      <VersionMismatchDialog frontend={FE} backend={BE} onClose={vi.fn()} />,
    );
    expect(outside.contains(document.activeElement), "焦点还留在背景=键盘用户第一下按空").toBe(false);
    expect(screen.getByRole("dialog").contains(document.activeElement as Node)).toBe(true);
    unmount();
    expect(document.activeElement).toBe(outside);
  });

  it("16. ESC 就是第二个出口：叫 onClose 恰好一次，且不把这次按键吞掉之外的活干了", () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // 别的键不许顺手关（Tab／Enter 在控件上是正常按键）
    fireEvent.keyDown(window, { key: "Tab" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("17. Tab 与 Shift+Tab 在墙里打转，不许跑到背景那枚按钮上", () => {
    const outside = host();
    renderDialog();
    const focusables = () =>
      Array.from(screen.getByRole("dialog").querySelectorAll(
        "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )) as HTMLElement[];
    const list = focusables();
    // 弹窗里能聚焦的就两个：那条 Releases 外链 + 「继续使用」
    expect(list).toHaveLength(2);
    outside.focus();
    list[1].focus();
    fireEvent.keyDown(list[1], { key: "Tab" });
    expect(document.activeElement, "Tab 到末尾要绕回头一个").toBe(list[0]);
    fireEvent.keyDown(list[0], { key: "Tab", shiftKey: true });
    expect(document.activeElement, "Shift+Tab 到开头要绕到末尾").toBe(list[1]);
    fireEvent.keyDown(list[1], { key: "Tab", shiftKey: false });
    expect(outside.contains(document.activeElement), "焦点漏到背景里去了").toBe(false);
  });

  it("20. ESC 叫的是最新那一份 onClose，不是第一次渲染时抓到的那个", () => {
    // 与上一条配对：上一条钉"依赖里不许写 onClose"（焦点不被抢），这一条钉"ref 要在提交后
    // 同步成最新那份"。只判前一格会漏掉后一种错法——把 onClose 关进空依赖的闭包里，
    // 焦点行为完全正常，但调用点换了回调之后 ESC 叫的是旧的（多半还是个 no-op）。
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<VersionMismatchDialog frontend={FE} backend={BE} onClose={first} />);
    rerender(<VersionMismatchDialog frontend={FE} backend={BE} onClose={second} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(first, "ESC 叫到了第一次渲染那份旧回调").not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("19. 调用点重渲染（onClose 换了身份）不许把焦点抢回面板", () => {
    // 焦点进了弹窗之后，键盘用户 Tab 到那条 Releases 链接上；此时父组件只要重渲染一次
    // （版本号刷新、store 抖一下），而 effect 的依赖里写了 onClose——内联箭头函数每次都是新的，
    // 整段"聚焦面板 + 挂监听"就会重来：焦点被抢回去，旧监听还得靠 cleanup 摘干净。
    const outside = host();
    const { rerender } = render(
      <VersionMismatchDialog frontend={FE} backend={BE} onClose={vi.fn()} />,
    );
    const link = screen.getByRole("link", { name: "GitHub Releases" }) as HTMLElement;
    link.focus();
    rerender(<VersionMismatchDialog frontend="2.4.1" backend={BE} onClose={vi.fn()} />);
    expect(document.activeElement, "重渲染把焦点抢走了").toBe(link);
    expect(outside.contains(document.activeElement)).toBe(false);
  });

  it("18. 卸载之后不许把监听留在 window 上", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <VersionMismatchDialog frontend={FE} backend={BE} onClose={onClose} />,
    );
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose, "组件都没了还叫 onClose=监听没摘，会随弹随关次数攒出一堆死监听").toHaveBeenCalledTimes(0);
  });
});
