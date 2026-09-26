/**
 * VersionMismatchDialog — 版本不一致提示弹窗首次有直接判据
 *
 * 它是前后端版本对不上时用户看到的唯一说明：两个版本号、一句"哪些功能可能不正常"、
 * 一条去哪拿新后端的链接，以及一个"继续使用"的出口。之前只有 `AppLayout-shell` 整只 mock 掉它
 * （量的是"该不该弹、关掉之后还弹不弹"），弹窗里面写了什么没人看着。
 *
 * 判的四件事：
 * 1. 两个版本号各归各的槽——这面墙存在的意义就是让用户比对这两个数，串了比对立着更糟；
 * 2. 外链 `target="_blank"` 必须配 `rel="noopener noreferrer"`（少了就是新页面能摸到 window.opener）；
 * 3. 出口只有「继续使用」这一个，且它叫的就是 onClose；
 * 4. 说清去哪拿新后端（重启后端 / 解压覆盖 / Releases 链接），这三句都在。
 *
 * 有意不判的格子（写了理由，不是漏）：
 * - 没有 `role="dialog"` / `aria-modal` / 焦点陷阱：**全仓所有"弹窗"都没有**（grep 零命中），
 *   这是这仓的既有形状而不是这一只的漏洞。要给就给整套（另议），在这里单独钉一只只会造成假一致。
 * - `z-[300]`、`fixed inset-0`、遮罩透明度这些类名的真实效果（盖住多少、点得到点不到）
 *   归浏览器层；这里只判类名形状。
 * - 点遮罩不关闭：判的是现状（只有按钮能关）。它与文件头那句"仅作提示，不阻止用户使用"
 *   有张力——遮罩其实挡住了底下的一切。已作为产品口径上报，不替它改成另一种行为。
 * - 两句说明正文的完整措辞：只钉各自的关键词，整句钉死会让正常润色变成红。
 */
import { describe, it, expect, vi } from "vitest";
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
 * 覆盖到的格子：13 条用例 × 15 刀，每格都被至少一刀指名打中；没有判了却从没红过的格子。
 */
