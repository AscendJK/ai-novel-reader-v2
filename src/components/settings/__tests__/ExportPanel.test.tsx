/**
 * ExportPanel 本体的直接判据（地板第 1 档）
 *
 * 这只面板管的是"数据出得去、回得来，并且能告诉用户库里还剩多少地方"。它的坏法全是**不说谎就沉默**：
 * - 存储那一块：阈值一到就该换色、换文案；`quota` 是 0 时不许算出 `NaN%`；浏览器没有
 *   `navigator.storage.estimate` 时整块该消失，而不是显示「0 B / 0 B」这种假数据。
 * - 导入回执：六个计数逐个报，`ignoredSettings > 0` 必须说出来（旧账：丢弃 API 配置不许静默，
 *   用户会以为"恢复了却找不到自己的服务商"是功能坏了）；失败时不许卡在"导入中"。
 * - 单本导出：没选书时两枚按钮该按住；JSON 那枚与 TXT 那枚不许串到同一个出口。
 *
 * 未判 / 待议（写清楚，别让"这只有测试了"盖住）：
 * - 回执的颜色是靠 `importResult.includes("成功")` 嗅探出来的（`ExportPanel.tsx:122`）。本批按现状钉住
 *   "成功=绿、失败=红"这一格，但**这句话本身是脆的**：失败信息里只要含"成功"两字就会染绿。
 *   改成 state（`{kind:"ok"|"error"}`）是更好的形状，属于产品改动，不在这一笔里做。
 * - 真正落盘/下载的动作在 `@/lib/export`（那边有自己的用例），本文件用桩，判的是**面板把哪几个
 *   数字、哪个 novelId 交出去**，不判文件内容。
 * - ~~`SelectTrigger` 只有 `id/name`、没有 `aria-label`~~：2026-09-26 补上了名字（`M26` 打的就是这一格，
 *   与 MiniCard 那枚「重新生成」同一笔）。
 *
 * 变异台账（每刀手动一次一处、跑完 `cp` 字节备份还原并核 SHA256 回基线；读数是实跑的，记在文件末尾）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { ExportPanel } from "../ExportPanel";
import type { NovelMeta } from "@/parsers/types";

const db = vi.hoisted(() => ({ loadAllNovelMeta: vi.fn() }));
const ex = vi.hoisted(() => ({
  exportNovelAsJSON: vi.fn(),
  exportNovelAsTXT: vi.fn(),
  exportAllAsJSON: vi.fn(),
  importFromJSON: vi.fn(),
}));

vi.mock("@/db/repositories", () => ({ loadAllNovelMeta: db.loadAllNovelMeta }));
vi.mock("@/lib/export", () => ({
  exportNovelAsJSON: ex.exportNovelAsJSON,
  exportNovelAsTXT: ex.exportNovelAsTXT,
  exportAllAsJSON: ex.exportAllAsJSON,
  importFromJSON: ex.importFromJSON,
}));

function novel(id: string, title: string, chapterCount: number, author?: string): NovelMeta {
  return { id, title, chapterCount, ...(author ? { author } : {}) } as NovelMeta;
}

/** 存储估算：`navigator.storage.estimate` 在 jsdom 里根本没有，逐用例装 */
function stubEstimate(usage: number, quota: number) {
  const storage = { estimate: () => Promise.resolve({ usage, quota }) };
  Object.defineProperty(navigator, "storage", { value: storage, configurable: true, writable: true });
}
function noEstimate() {
  Object.defineProperty(navigator, "storage", { value: {}, configurable: true, writable: true });
}

const bar = () => document.querySelector("div.w-full.h-2 > div") as HTMLElement;
const cardOf = () => document.querySelector("h3")?.parentElement?.querySelector("div.space-y-4 > div") as HTMLElement;

async function mount() {
  render(<ExportPanel />);
  await waitFor(() => expect(db.loadAllNovelMeta).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText("导出 / 备份")).toBeTruthy());
}

beforeEach(() => {
  db.loadAllNovelMeta.mockReset().mockResolvedValue([]);
  ex.exportNovelAsJSON.mockReset().mockResolvedValue(undefined);
  ex.exportNovelAsTXT.mockReset().mockResolvedValue(undefined);
  ex.exportAllAsJSON.mockReset().mockResolvedValue(undefined);
  ex.importFromJSON.mockReset();
  // Radix Select 在 jsdom 里要这三样，否则"列表没渲染"会被读成产品坏了
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.releasePointerCapture = (id: number) => id;
  proto.hasPointerCapture = () => false;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("存储用量那一块：阈值、文案与除零", () => {
  it("浏览器不给 estimate 时整块不出现——不许拿「0 B / 0 B」冒充真实用量", async () => {
    noEstimate();
    await mount();
    expect(screen.queryByText("浏览器存储用量")).toBeNull();
  });

/** 那一行「已用 / 总量」——整页只有这一个 span 同时挂这两个类 */
const usageLine = () => document.querySelector("span.text-xs.text-muted-foreground") as HTMLElement;

  it("四档单位各按自己的边界换档：1023 B / 1.0 KB / 1.0 MB / 1.00 GB（小数位一错就露出来）", async () => {
    const MB = 1024 * 1024;
    const cases: Array<[number, string]> = [
      [1023, "1023 B"],
      [1024, "1.0 KB"],
      [MB, "1.0 MB"],
      [1024 * MB, "1.00 GB"],
    ];
    for (const [bytes, shown] of cases) {
      cleanup();
      stubEstimate(bytes, 4 * 1024 * MB);
      await mount();
      await waitFor(() => expect(screen.getByText("浏览器存储用量")).toBeTruthy());
      // 两个数一起判：只量"用了多少"的话，容量那一半错了看不出来
      expect(usageLine().textContent).toBe(`${shown} / 4.00 GB`);
    }
  });

  it("79% 还不该报警：进度条是主色、卡片不带警示边框、没有那句提醒", async () => {
    stubEstimate(790, 1000);
    await mount();
    await waitFor(() => expect(screen.getByText("浏览器存储用量")).toBeTruthy());
    expect(bar().style.width).toBe("79%");
    expect(bar().className).toContain("bg-primary");
    expect(screen.queryByText(/存储空间/)).toBeNull();
  });

  it("80% 起整块一起转黄：边框、进度条、文案三处同进同退", async () => {
    stubEstimate(800, 1000);
    await mount();
    await waitFor(() => expect(screen.getByText("存储空间使用较多，建议定期清理不需要的数据")).toBeTruthy());
    expect(bar().className).toContain("bg-amber-500");
    expect(cardOf().className).toContain("border-amber-500/50");
  });

  it("95% 起转红并换成「即将用尽」那句话（黄红两档不许共用一句）", async () => {
    stubEstimate(950, 1000);
    await mount();
    await waitFor(() => expect(screen.getByText("存储空间即将用尽，建议删除不需要的小说或导出备份后清理")).toBeTruthy());
    expect(screen.queryByText("存储空间使用较多，建议定期清理不需要的数据")).toBeNull();
    expect(bar().className).toContain("bg-destructive");
    expect(cardOf().className).toContain("border-destructive");
  });

  it("用量超过容量时宽度封顶 100%（负数或 300% 都会把进度条画穿）", async () => {
    stubEstimate(3000, 1000);
    await mount();
    await waitFor(() => expect(screen.getByText("浏览器存储用量")).toBeTruthy());
    expect(bar().style.width).toBe("100%");
  });

  it("容量取不到（quota 为 0）时百分比是 0，不许出现 NaN%", async () => {
    stubEstimate(500, 0);
    await mount();
    await waitFor(() => expect(screen.getByText("浏览器存储用量")).toBeTruthy());
    expect(bar().style.width).toBe("0%");
    expect(bar().style.width).not.toContain("NaN");
  });
});

describe("导入备份：回执说什么、说完之后回到什么状态", () => {
  const fileInput = () => screen.getByLabelText("选择备份文件") as HTMLInputElement;
  const pickFile = () => {
    const input = fileInput();
    Object.defineProperty(input, "files", { value: [new File(["{}"], "backup.json")], configurable: true });
    // jsdom 不许给 file input 赋非空 value，而真浏览器选完文件后 `value` 是带 fakepath 的。
    // 不补这一格，"`finally` 里那句 `value = ""`"就成了永远为真的断言（变异打不红）。
    Object.defineProperty(input, "value", {
      value: "C:\\fakepath\\backup.json", writable: true, configurable: true,
    });
    fireEvent.change(input);
    return input;
  };

  it("导入期间「选择文件」按住并改成「导入中...」，结束后原样回来", async () => {
    ex.importFromJSON.mockResolvedValue({
      novels: 1, chapters: 2, summaries: 3, notes: 4, maps: 5, graphs: 6, ignoredSettings: 0,
    });
    await mount();
    const button = screen.getByRole("button", { name: /选择文件/ });
    pickFile();
    expect(button).toBeDisabled();
    expect(button.textContent).toContain("导入中");
    await waitFor(() => expect(screen.getByText(/导入成功/)).toBeTruthy());
    expect(button).not.toBeDisabled();
    expect(button.textContent).toContain("选择文件");
  });

  it("成功回执把六类数量逐个报出来（漏一类＝用户不知道自己恢复了什么）", async () => {
    ex.importFromJSON.mockResolvedValue({
      novels: 3, chapters: 120, summaries: 40, notes: 7, maps: 2, graphs: 2, ignoredSettings: 0,
    });
    await mount();
    pickFile();
    await waitFor(() => expect(screen.getByText("导入成功：3 本小说，120 个章节，40 条摘要，7 条笔记，2 张地图，2 份人物图谱")).toBeTruthy());
  });

  it("备份里带来的 API 配置被丢弃时必须说出来；一条都没丢就不许凭空加这句", async () => {
    const base = { novels: 1, chapters: 1, summaries: 0, notes: 0, maps: 0, graphs: 0 };
    ex.importFromJSON.mockResolvedValue({ ...base, ignoredSettings: 2 });
    await mount();
    pickFile();
    await waitFor(() => expect(screen.getByText(/已忽略 2 条 API 配置（备份不携带钥匙，请重新填写）/)).toBeTruthy());
    cleanup();
    ex.importFromJSON.mockResolvedValue({ ...base, ignoredSettings: 0 });
    await mount();
    pickFile();
    await waitFor(() => expect(screen.getByText(/导入成功/)).toBeTruthy());
    expect(screen.queryByText(/已忽略/)).toBeNull();
  });

  it("失败时把原因原样接上；抛的不是 Error 也要有话说，不许空白或 undefined", async () => {
    ex.importFromJSON.mockRejectedValue(new Error("不是合法的备份文件"));
    await mount();
    pickFile();
    await waitFor(() => expect(screen.getByText("导入失败：不是合法的备份文件")).toBeTruthy());
    cleanup();
    ex.importFromJSON.mockRejectedValue("boom");
    await mount();
    pickFile();
    await waitFor(() => expect(screen.getByText("导入失败：文件格式错误")).toBeTruthy());
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it("失败也要收尾：不许卡在「导入中...」、下次选同一个文件还选得动", async () => {
    ex.importFromJSON.mockRejectedValue(new Error("坏了"));
    await mount();
    const input = pickFile();
    await waitFor(() => expect(screen.getByText("导入失败：坏了")).toBeTruthy());
    expect(screen.getByRole("button", { name: /选择文件/ })).not.toBeDisabled();
    // `finally` 里那句 `value = ""` 判的就是这个：不复位的话，再选同一个文件不触发 change
    expect(input.value).toBe("");
  });

  it("导入成功后重新拉一次列表（否则单本导出那栏还拿着旧书架）", async () => {
    ex.importFromJSON.mockResolvedValue({
      novels: 1, chapters: 1, summaries: 0, notes: 0, maps: 0, graphs: 0, ignoredSettings: 0,
    });
    db.loadAllNovelMeta.mockResolvedValue([novel("b1", "新引进的书", 9)]);
    await mount();
    expect(db.loadAllNovelMeta).toHaveBeenCalledTimes(1);
    pickFile();
    await waitFor(() => expect(db.loadAllNovelMeta).toHaveBeenCalledTimes(2));
  });

  it("回执颜色按现状钉：成功绿、失败红", async () => {
    ex.importFromJSON.mockResolvedValue({
      novels: 1, chapters: 1, summaries: 0, notes: 0, maps: 0, graphs: 0, ignoredSettings: 0,
    });
    await mount();
    pickFile();
    await waitFor(() => expect(screen.getByText(/导入成功/)).toBeTruthy());
    expect(screen.getByText(/导入成功/).className).toContain("text-green-500");
    cleanup();
    ex.importFromJSON.mockRejectedValue(new Error("坏了"));
    await mount();
    pickFile();
    await waitFor(() => expect(screen.getByText("导入失败：坏了")).toBeTruthy());
    expect(screen.getByText("导入失败：坏了").className).toContain("text-destructive");
  });
});

describe("单本导出：没得选就不许画出可点的出口", () => {
  async function mountWithBooks(list: NovelMeta[]) {
    noEstimate();
    db.loadAllNovelMeta.mockResolvedValue(list);
    await mount();
    await waitFor(() => expect(screen.getByText("单本导出")).toBeTruthy());
  }

  it("书架是空的 ⇒ 整张「单本导出」卡片不出现", async () => {
    noEstimate();
    db.loadAllNovelMeta.mockResolvedValue([]);
    await mount();
    expect(screen.queryByText("单本导出")).toBeNull();
  });

  it("下拉项写「标题 (N 章)」——章数是选书时唯一能核对的线索", async () => {
    await mountWithBooks([novel("b1", "长相思", 24), novel("b2", "紫钗记", 2)]);
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getByRole("option", { name: "长相思 (24 章)" })).toBeTruthy());
    expect(screen.getByRole("option", { name: "紫钗记 (2 章)" })).toBeTruthy();
  });

  it("那只下拉有可访问名（只挂 id/name 不算——这一处没有 <label for>）", async () => {
    // 补之前实测的名字：`aria-label` 没有、`id="export-novel"` 上方无 `<label>`，于是可访问名
    // 只剩渲染出来的占位文案「选择小说...」——读屏念得出占位符，却听不出这只控件是干什么的
    // （而且选完一本书之后名字会跟着变成书名，同一只控件在页面上换名字）。
    // 同一排两枚导出按钮本来就有名字（`title="JSON 格式"` / `"TXT 格式"`），缺的正是这一只。
    await mountWithBooks([novel("b1", "长相思", 24)]);
    expect(screen.getByRole("combobox", { name: "选择要导出的小说" })).toBeTruthy();
  });

  it("没选书时两枚导出按钮都按住；选完之后各走各的出口、传的是 novelId", async () => {
    await mountWithBooks([novel("b1", "长相思", 24)]);
    const json = screen.getByRole("button", { name: "JSON 格式" });
    const txt = screen.getByRole("button", { name: "TXT 格式" });
    expect(json).toBeDisabled();
    expect(txt).toBeDisabled();
    fireEvent.click(json);
    fireEvent.click(txt);
    expect(ex.exportNovelAsJSON).not.toHaveBeenCalled();
    expect(ex.exportNovelAsTXT).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "长相思 (24 章)" }));
    expect(json).not.toBeDisabled();
    fireEvent.click(json);
    fireEvent.click(txt);
    await waitFor(() => expect(ex.exportNovelAsJSON).toHaveBeenCalledWith("b1"));
    expect(ex.exportNovelAsTXT).toHaveBeenCalledWith("b1");
  });

  it("选中之后补一行「作者 · N 章」，没有作者时如实写「未知作者」", async () => {
    await mountWithBooks([novel("b1", "长相思", 24, "洪升"), novel("b2", "紫钗记", 2)]);
    expect(screen.queryByText(/未知作者/)).toBeNull();
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "长相思 (24 章)" }));
    expect(screen.getByText("洪升 · 24 章")).toBeTruthy();
    cleanup();
    await mountWithBooks([novel("b2", "紫钗记", 2)]);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "紫钗记 (2 章)" }));
    expect(screen.getByText("未知作者 · 2 章")).toBeTruthy();
  });

  it("「导出全部数据」那枚走 exportAllAsJSON，不与单本的两个出口混用", async () => {
    await mountWithBooks([novel("b1", "长相思", 24)]);
    fireEvent.click(screen.getByRole("button", { name: /导出 JSON/ }));
    await waitFor(() => expect(ex.exportAllAsJSON).toHaveBeenCalledTimes(1));
    expect(ex.exportNovelAsJSON).not.toHaveBeenCalled();
  });
});

/* 变异台账（基线 SHA256=c3d913b7a08a26fd386d5e30db41ed9e5b2795217271f73af6f931d048c2c6a3，7794 字节；
 * 每刀手动一次一处、跑完 `cp /tmp/ExportPanel.baseline.tsx` 还原并核 SHA 回基线，markers_left=0、diff 空。
 * 读数一律来自 `npx vitest run <本文件>` 的真退出码与真红名；transform_failed / skipped 每刀都核过。
 *
 *  刀  改哪一处                                        红                       红数
 *  M1  estimate 缺失时兜 `{usage:0,quota:0}`            不给 estimate 整块不出现      1
 *  M2  KB 分支抬成 `<= 1024*1024`（吞掉整 1MB）          四档单位换档                  1
 *      （这条判据中途换过一次形状：原来用正则去撞 `getByText`，被 ESLint 挑出无用转义，
 *        改成直接读那一行的 `textContent`。换形状后**重打了一刀 MUT-2b**，仍 1 红。）
 *  M3  isWarning `>= 80` → `>= 75`                     79% 还不该报警                1
 *  M4  isWarning `>= 80` → `>= 81`                     80% 起整块一起转黄            1
 *  M5  isCritical `>= 95` → `>= 96`                    95% 起转红换文案              1
 *  M6  宽度去掉 `Math.min(usagePct, 100)`               宽度封顶 100%                 1
 *  M7  除零闸 `quota > 0` → `quota >= 0`                NaN%                         1
 *  M8  卡片边框丢掉 isCritical 一档                      95% 起转红（border）          1
 *  M9  进度条颜色丢掉 isCritical 一档                    95% 起转红（bg）             1
 *  M10 黄红两档共用一句提醒                              95% 起转红（文案）            1
 *  M11 摘掉 `disabled={importing}`                      导入期间按住（toBeDisabled）   1
 *  M12 忙时按钮文字恒为「选择文件」                       导入期间改名（test:173）      1
 *  M13 回执删掉「N 张地图」那一类                         六类数量逐个报                1
 *  M14 `ignoredSettings > 0` → `>= 0`（恒报已忽略）      六类数量 + 不许凭空加这句      2
 *  M15 `ignoredSettings > 0` → `> 2`（丢 2 条却不说）    必须说出来                    1
 *  M16 非 Error 的兜底换成 `String(e)`                   抛的不是 Error 也要有话说      1
 *  M17 删掉 `finally` 里的 `value = ""`                  下次选同一个文件还选得动       1
 *  M18 删掉导入成功后的 `loadAllNovelMeta()`              导入成功后重拉列表            1
 *  M19 成败颜色对调                                      回执颜色：成功绿、失败红       1
 *  M20 `novels.length > 0` → `>= 0`（空书架也画卡片）     空书架不出现卡片              1
 *  M21 下拉项去掉「(N 章)」                              下拉项标签 / 选书两格 / 作者行  3
 *  M22 摘掉 JSON 那枚的 `disabled={!selectedNovelId}`    没选书时按住（toBeDisabled）   1
 *  M23 JSON 那枚接到 `exportNovelAsTXT`                 各走各的出口（toHaveBeenCalledWith）1
 *  M24 去掉 `|| "未知作者"`                             没有作者时如实写未知作者        1
 *  M25「导出 JSON」接到 `exportNovelAsJSON("")`          全量导出不与单本混用            1
 *  M26 摘掉 `SelectTrigger` 的 `aria-label`（2026-09-26 补名字那一格；基线换成
 *      `63f34c38e4fd7af27a8bcddef241763e88b0180851d657fecdf18f29663ecdb7`，8144 字节）
 *                                                      那只下拉有可访问名              1
 *
 * 打废的两处（记下来，别当成"这格没判"）：
 * - 第一次 M2 把 `<=` 加在了 MB 那一行——测试值上行为完全没变，是**等价变异**，跑之前自己看出来的，未跑即撤。
 * - 第一次 M20 的注释写在 `(` 之后造成 JSX 少括号，那轮 `transform_failed=1 / reds=0`：**那不是 0 红**，
 *   重打成合法语法后 1 红。跑刀命令因此固定核 transform_failed 与 skipped 两行。
 *
 * 没单独打的（形状与已打的那格相同，不谎称全覆盖）：
 * - TXT 那枚的 `disabled={!selectedNovelId}`：与 M22 同形同用例，摘掉它同样会红。
 * - MB→GB 那一档边界（M2 打的是 KB→MB）。
 * - `AlertTriangle` 图标、`border-t` 分隔线这类纯装饰，没立判据也没打。
 */
