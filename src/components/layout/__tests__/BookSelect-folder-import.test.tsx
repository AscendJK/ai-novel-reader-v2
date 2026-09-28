import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BookSelect } from "../BookSelect";

/**
 * 「从文件夹导入」的**先算后动**（制作人 2026-09-28 拍 A 带折中）。
 *
 * 这一支为什么会失控：`handleFolderPick` 先看 `showOpenFilePicker`，支持的浏览器（Chrome/Edge，
 * 含桌面真页面实测）走的是"多选文件"——那本来就是一只只挑出来的，不需要闸。**不支持的那条退路**
 * （桌面 Firefox 等没有 File System Access API 的浏览器）点的是带 `webkitdirectory` 的隐藏 input，
 * 语义是**只能选文件夹**，返回该文件夹含子目录的**扁平全文件清单**；旧代码拿到清单后直接
 * `processFiles` 逐本入库（`BookSelect.tsx` 那个 `for`），于是"我以为在选文件夹里的几本"与
 * "整个目录树里的 .txt 都上了架"之间一个字都没有。
 *
 * 折中的口径（就这一句，别扩）：**只给 `webkitdirectory` 这一支加确认闸**，多选与拖拽不加——
 * 那两条是用户一只只点出来的，加闸只会让常用路径多一次点击。
 *
 * ## 为什么这一档只能在 jsdom 量
 *
 * 浏览器那一档（`e2e/specs/b2-shelf.spec.ts`）的 B18 钉的是"iPhone UA 下那颗按钮与那条支路都不在"。
 * 而"选完文件夹之后、确认之前一本书都不许入库"要的是**把一只 51 个文件的文件夹递进 input**：
 * Chromium 的 `fileChooser` 不接受目录（Playwright 的 `setInputFiles` 只能给文件列表），
 * 而 jsdom 里 `Object.defineProperty(input, "files", …)` 想给几只给几只。
 * 顺带一条老坑：**jsdom 的 file input `value` 永远是空串**，所以断言一律不看 `value`，只看递进去的
 * `File` 对象真的到了谁手上。
 *
 * ## 立红读数（产品未改时先跑这九条）
 *
 * `Tests 8 failed | 1 passed (9)`。红的是这八条：报数、面板本数＝解析次数、取消不回执、
 * 确认后面板收走、点面板不开文件选择器、几十本要勾、正常数量不多那一勾、边界 50。
 * **当时就绿的那一条是保护格**：「文件夹里一本小说都没有 → 说清楚且不长出确认按钮」——
 * 旧代码本来就有那句 `未找到 .txt 或 .epub 文件`，而"确认按钮不存在"在旧代码里是恒真；
 * 留在这里防的是"以后把闸做成'空文件夹也要确认'"。不算立红成绩。
 *
 * ## 刀账 FD1..FD8（基线 `BookSelect.tsx` sha256 前 16 位 = `91063070a8231b47`；
 * 每刀反向编辑还原后当场核 SHA，`MUT-` 残留计数每次都是 0；0 刀对照：本文件 9 绿 ＋
 * 隔壁 `BookSelect-shelf.test.tsx` 16 绿 = 25 绿）
 *
 *  - **FD1** `handleFolderFallback` 回到旧行为（`setPendingFolder(null)` ＋ 直接 `processFiles(valid)`）
 *    → 一档红 **8**（除了那条保护格，全红——这一刀就是"闸整个没生效"的形状）
 *  - **FD2** 确认按钮的 `disabled={… && !folderAck}` 摘成 `disabled={false}` → 红 **1**：
 *    正是"几十本得显式勾一下"那条（其余八条不动，说明锁与面板是两格）
 *  - **FD3** 边界挪一格：`> FOLDER_IMPORT_ACK_MIN` → `>=` → 红 **1**：正好 50 本那条。
 *    **FD2/FD3 各一刀**：把常量整个改掉会同时红两条，看不出"锁的逻辑"与"边界的取值"
 *  - **FD4** 两处过滤漂开：`processFiles` 退回自己那份（只认 `.txt`，少 `.epub`）→ 红 **1**：
 *    "面板说的本数＝真解析的次数"。夹具里那只 `.epub` 与那只 `A.TXT` 就是这一刀的取样
 *  - **FD5** 摘掉面板 wrapper 的 `stopPropagation` → 红 **1**：点「取消」顺手把文件选择器打开了
 *    （面板挂在上传卡片**里面**，而那张卡片的 `onClick` 就是"选文件"）
 *  - **FD6** `confirmFolderImport` 里去掉 `setPendingFolder(null)` → 红 **1**：确认之后面板没收走
 *  - **FD7** `cancelFolderImport` 里去掉 `setNotice(...)` → 红 **1**：取消之后界面一句不说
 *  - **FD8** 与 FD1 同一处改动，但**在浏览器层打**（`e2e/specs/b2-shelf.spec.ts` 的 B19）→
 *    B19 红 1（`找不到 getByText(/找到 2 本小说/)`）。这一刀是必需的：本文件把
 *    `useFileParser` 整只 mock 了，"确认之后真上架"那一半只有 B19 穿得过去
 */

const parseFile = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useFileParser", () => ({
  useFileParser: () => ({ parseFile, isParsing: false, progress: 0, warning: undefined }),
}));
vi.mock("@/db/repositories", () => ({
  loadAllNovelMeta: vi.fn(async () => []),
  deleteNovel: vi.fn(async () => undefined),
  loadNovel: vi.fn(async () => null),
}));
vi.mock("@/db/database", () => ({
  sharedDB: { ragCache: { toArray: vi.fn(async () => []) } },
  getUserDB: () => ({
    novels: { put: vi.fn(async () => undefined) },
    chapters: { put: vi.fn(async () => undefined) },
    transaction: (_m: string, _t1: unknown, _t2: unknown, fn: () => Promise<void>) => fn(),
  }),
}));
vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) }));
vi.mock("@/lib/broadcast", () => ({ broadcast: { onDataChanged: () => () => undefined, send: vi.fn() } }));
vi.mock("@/rag/model-loader", () => ({ ensureModelReady: vi.fn(async () => true) }));
vi.mock("@/rag/engines", () => ({ resolveModelKey: () => "X", getEngineDisplayName: (e: string) => e }));
vi.mock("@/rag/build-index", () => ({ buildAndPollRAGIndex: vi.fn(), downloadAndCacheIndex: vi.fn() }));
vi.mock("@/rag/rag-cache-utils", () => ({ onCacheEviction: () => () => undefined }));
vi.mock("@/sync/pending-leave", () => ({ enqueuePendingLeave: vi.fn(), clearPendingLeave: vi.fn() }));
vi.mock("@/components/common/NovelBuildWindow", () => ({ NovelBuildWindow: () => null }));

const folderInput = () => document.querySelector<HTMLInputElement>("#novel-folder-input");

/** 把一批 `File` 真的递给那只 `webkitdirectory` input：jsdom 里 `input.files` 只能这么换 */
function pickFolder(files: File[]) {
  const el = folderInput();
  expect(el, "桌面那条 webkitdirectory 支路必须在 DOM 里").not.toBeNull();
  Object.defineProperty(el, "files", { value: files, configurable: true });
  fireEvent.change(el!);
}

const novel = (name: string, bytes = 3) => new File(["x".repeat(bytes)], name, { type: "text/plain" });

/** 面板上那句数量（确认按钮的可访问名里带着同一份数），取不到就返回 null */
function countedInPanel(): number | null {
  const m = screen.queryByText(/找到 \d+ 本小说/)?.textContent?.match(/找到 (\d+) 本小说/);
  return m ? Number(m[1]) : null;
}

beforeEach(() => {
  parseFile.mockReset();
  parseFile.mockResolvedValue(null);
});

describe("从文件夹导入：先算后动", () => {
  it("选完文件夹只报数量，确认之前一本都不许入库", () => {
    render(<BookSelect />);
    pickFolder([novel("a.txt"), novel("b.txt"), novel("c.txt")]);

    expect(screen.getByText(/找到 3 本小说/), "选完就该把'这一批有几本'摊在界面上").toBeInTheDocument();
    expect(parseFile, "没确认之前不许开始解析——这正是这一格的全部意义").not.toHaveBeenCalled();
  });

  it("面板说的本数必须等于真解析的次数（两处过滤不许漂）", async () => {
    render(<BookSelect />);
    // 夹具里混着一只非小说文件和一只大写后缀：面板与入库走同一份过滤才对得上
    pickFolder([novel("a.txt"), novel("b.txt"), novel("A.TXT"), novel("c.epub"), novel("photo.png")]);
    const n = countedInPanel();
    expect(n, "面板没报出数量").not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /确认导入/ }));
    await waitFor(() => expect(parseFile).toHaveBeenCalledTimes(n!));
    const names = parseFile.mock.calls.map((c) => (c[0] as File).name);
    expect(names, "非小说文件被喂进了解析").not.toContain("photo.png");
  });

  it("取消就不导，并且如实回执「一本书都没导入」", () => {
    render(<BookSelect />);
    pickFolder([novel("a.txt"), novel("b.txt")]);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(parseFile).not.toHaveBeenCalled();
    expect(screen.getByText(/已取消，一本书都没导入/)).toBeInTheDocument();
    expect(screen.queryByText(/找到 \d+ 本小说/)).toBeNull();
  });

  it("文件夹里一本小说都没有：说清楚，且不长出确认按钮", () => {
    render(<BookSelect />);
    pickFolder([novel("photo.png"), novel("doc.pdf")]);

    expect(screen.getByText(/未找到 \.txt 或 \.epub 文件/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /确认导入/ })).toBeNull();
    expect(parseFile).not.toHaveBeenCalled();
  });

  it("点了确认面板就收走：第二下点不到东西，不会把同一批导两遍", async () => {
    render(<BookSelect />);
    pickFolder([novel("a.txt"), novel("b.txt"), novel("c.txt")]);
    fireEvent.click(screen.getByRole("button", { name: /确认导入/ }));
    await waitFor(() => expect(parseFile).toHaveBeenCalledTimes(3));

    expect(screen.queryByRole("button", { name: /确认导入/ }), "确认之后那颗按钮还挂着，第二下就是双份").toBeNull();
    expect(parseFile).toHaveBeenCalledTimes(3);
  });

  it("面板上的按钮不许顺手打开文件选择器（卡片整块就是「点这里选文件」）", () => {
    render(<BookSelect />);
    pickFolder([novel("a.txt")]);
    const clicked: string[] = [];
    const realClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function (this: HTMLInputElement) { clicked.push(this.id); };
    try {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    } finally {
      HTMLInputElement.prototype.click = realClick;
    }
    expect(clicked, "点「取消」结果把系统文件选择器打开了").not.toContain("novel-file-input");
  });

  it("文件夹里几十本时确认默认锁着，必须显式勾一下才让继续", () => {
    render(<BookSelect />);
    pickFolder(Array.from({ length: 51 }, (_, i) => novel(`n${i}.txt`)));

    expect(screen.getByText(/找到 51 本小说/)).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: /勾上才继续/ });
    const go = screen.getByRole("button", { name: /确认导入/ });
    expect(go).toBeDisabled();
    fireEvent.click(box);
    expect(go, "两个相反的值：勾上之后必须真的能点").toBeEnabled();
    expect(parseFile).not.toHaveBeenCalled();
  });

  it("正常数量不该多那一次勾选（保护格）", () => {
    render(<BookSelect />);
    pickFolder(Array.from({ length: 6 }, (_, i) => novel(`m${i}.txt`)));

    expect(screen.queryByRole("checkbox", { name: /勾上才继续/ })).toBeNull();
    expect(screen.getByRole("button", { name: /确认导入/ })).toBeEnabled();
  });

  it("边界那一格钉住：正好 50 本仍不多要勾选", () => {
    render(<BookSelect />);
    pickFolder(Array.from({ length: 50 }, (_, i) => novel(`k${i}.txt`)));

    expect(screen.queryByRole("checkbox", { name: /勾上才继续/ })).toBeNull();
    expect(screen.getByRole("button", { name: /确认导入/ })).toBeEnabled();
  });
});
