/**
 * `NovelBuildWindow` 状态窗口本体的直接判据（地板第 1 档·建索引那一屏，118 行）
 *
 * 这一屏是"读者要不要继续等"的唯一出处，判断全在四档互斥与进度换算上：
 * 1) **`open` 是总闸**（`:25`）：关着就一个字都不画。
 * 2) **四档互斥**（`:27-30`、`:45-58`）：排队 / 构建中（building·loading·encoding 三种都算）/
 *    完成（done·ready）/ 失败，标题与图标必须同一档，不许同时挂两只图标。
 * 3) **进度换算**（`:31`、`:67-72`）：`total` 缺时进度条给 `undefined`（不确定态）而不是 0%，
 *    文字说「准备中...」；有 `total` 才写 `current / total · pct%`；`current` 缺当 0；四舍五入。
 *    排队那一档**不许**有进度条（它前面还有别人的任务，进度是骗人的）。
 * 4) **排队位置要换算成"前面还有几个"**（`:79`）：第 1 位 = 前面 0 个；报不出位置写 `?`。
 * 5) **出口按调用方给不给**（`:94-103`）：`onRetry` / `onFallbackToTFIDF` 没给就不画那枚按钮，
 *    不许画一枚点了没反应的。关闭按 `novelId + engine` 两个参数走（`:38`）——只交引擎会关错窗口。
 *
 * ## 刻意没判的两格
 * ## 刻意没判的一格
 * ② `:84` 的 `message` 内容归 store 侧那档判，这里只判"message 有就摆出来"。
 *
 * ## 2026-09-26：原先"刻意没判 ①"那一格已经修完并锁进判据
 * 之前 `:50-57` 那条三元链的兜底是「索引构建失败」，于是没被四档认出的状态一律顶着"失败"。
 * 当时以为 `idle` 是无人生产的死枚举——**查错了**：`SummaryPanel.tsx:175` 会把第一次轮询回来的
 * rag 侧 `"none"` 映射成 `"idle"`，而窗口早在 `startBuild` 就 `open: true`，所以"点完构建 → 窗口
 * 从『正在构建检索索引』翻成『索引构建失败』、既没有失败详情也没有重试按钮"是**今天就走得到的假话**；
 * 同一行那个 `as BuildStatusType` 还会把 rag 侧更宽的 `"downloading"` 偷渡进来，也掉进"失败"。
 * 修法是给三元链一个中性兜底（「正在准备构建」）＋ 未覆盖态照样转圈，**不**删 `"idle"`、
 * **不**逐值补分支。判据按"穷尽 + 未知值"写，见 `兜底不许说「失败」` 那个 describe。
 *
 * ## 变异台账见文件末尾
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import type { NovelBuildStatus, BuildStatusType } from "@/stores/build-store";

const H = vi.hoisted(() => ({
  dismiss: null as null | ((...a: unknown[]) => void),
  progressValues: [] as unknown[],
}));

vi.mock("@/components/ui/progress", async () => {
  const R = await import("react");
  return {
    Progress: (props: { value?: number }) => {
      H.progressValues.push(props.value);
      return R.createElement("div", { "data-testid": "progress" });
    },
  };
});
vi.mock("@/stores/build-store", () => ({
  useBuildStore: (sel: (s: { dismissWindow: (...a: unknown[]) => void }) => unknown) =>
    sel({ dismissWindow: (...a: unknown[]) => H.dismiss?.(...a) }),
}));

import { NovelBuildWindow } from "../NovelBuildWindow";

const ENG = "Xenova/bge-small-zh-v1.5";

const build = (over: Partial<NovelBuildStatus> = {}): NovelBuildStatus => ({
  novelId: "n1",
  engine: ENG,
  status: "building",
  message: "正在分块",
  current: 250,
  total: 1000,
  open: true,
  startTime: 0,
  lastUpdate: 0,
  ...over,
});

const mount = (b: Partial<NovelBuildStatus> = {}, extra: { onRetry?: () => void; onFallbackToTFIDF?: () => void } = {}) =>
  render(<NovelBuildWindow build={build(b)} {...extra} />);
const icons = () => document.querySelectorAll("svg");

beforeEach(() => {
  H.dismiss = vi.fn();
  H.progressValues = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ================================================================ 总闸与关闭
describe("open 是总闸，关闭按 书 id + 引擎 走", () => {
  it("open 为假：一个字都不画", () => {
    mount({ open: false });
    expect(screen.queryByRole("button")).toBeNull();
    expect(icons()).toHaveLength(0);
  });

  it("关闭按钮要有名可读", () => {
    mount();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });

  it("关闭要同时交这本书与这个引擎（只交一个会关错窗口）", () => {
    mount({ novelId: "n7", engine: "Xenova/gte-small" });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(H.dismiss).toHaveBeenCalledWith("n7", "Xenova/gte-small");
  });
});

// ================================================================ 四档标题与图标
describe("四档互斥：标题、图标、颜色同一档", () => {
  it("排队：标题带第几位，图标是蓝色转圈，位置报不出写问号", () => {
    const { unmount } = mount({ status: "queued", queuePosition: 3 });
    expect(screen.getByText("排队中 (第 3 位)")).toBeTruthy();
    expect(document.querySelector("svg.text-blue-400")).toBeTruthy();
    unmount();
    cleanup();
    mount({ status: "queued" });
    expect(screen.getByText("排队中 (第 ? 位)")).toBeTruthy();
  });

  it("building / loading / encoding 三种都算构建中，图标是主色转圈", () => {
    for (const status of ["building", "loading", "encoding"] as const) {
      cleanup();
      mount({ status });
      expect(screen.getByText("正在构建检索索引")).toBeTruthy();
      expect(document.querySelector("svg.text-primary")).toBeTruthy();
      // 还没建完就别预告自动关闭
      expect(screen.queryByText("窗口将自动关闭...")).toBeNull();
    }
  });

  it("done 与 ready 都算完成：绿勾 + 那句自动关闭", () => {
    const { unmount } = mount({ status: "done" });
    expect(screen.getByText("索引构建完成")).toBeTruthy();
    expect(document.querySelector("svg.text-green-500")).toBeTruthy();
    expect(screen.getByText("窗口将自动关闭...")).toBeTruthy();
    unmount();
    cleanup();
    mount({ status: "ready" });
    expect(screen.getByText("索引构建完成")).toBeTruthy();
  });

  it("失败：红色警示图标 + 那句失败标题", () => {
    mount({ status: "error", error: "配额不够" });
    expect(screen.getByText("索引构建失败")).toBeTruthy();
    expect(document.querySelector("svg.text-destructive")).toBeTruthy();
  });

  it("任何时刻只挂一只状态图标（四档不许同时亮）", () => {
    for (const status of ["queued", "building", "done", "error"] as const) {
      cleanup();
      mount({ status, queuePosition: 2 });
      // 一只是状态图标，一只是关闭那枚 X
      expect(icons()).toHaveLength(2);
    }
  });

  it("引擎名原样摆出来（读者要能认出选的是哪只模型）", () => {
    mount({ engine: "custom/我的模型" });
    expect(screen.getByText("custom/我的模型")).toBeTruthy();
  });

  it("状态消息总在", () => {
    mount({ message: "已编码 12 块" });
    expect(screen.getByText("已编码 12 块")).toBeTruthy();
  });
});

// ================================================================ 进度
describe("进度条与那行数字", () => {
  it("有 total：进度条给百分比，文字写 current / total · pct%", () => {
    mount({ status: "building", current: 250, total: 1000 });
    expect(H.progressValues).toEqual([25]);
    expect(screen.getByText("250 / 1000 · 25%")).toBeTruthy();
  });

  it("total 报不出：进度条走不确定态（undefined），文字说「准备中...」", () => {
    mount({ status: "building", total: 0, current: 0 });
    expect(H.progressValues).toEqual([undefined]);
    expect(screen.getByText("准备中...")).toBeTruthy();
    expect(screen.queryByText(/0 \/ 0/)).toBeNull();
  });

  it("current 缺当 0，不算成 NaN", () => {
    mount({ status: "building", current: undefined as unknown as number, total: 100 });
    expect(H.progressValues).toEqual([0]);
    expect(screen.getByText("0 / 100 · 0%")).toBeTruthy();
  });

  it("除不尽的四舍五入取整", () => {
    mount({ status: "building", current: 1, total: 3 });
    expect(H.progressValues).toEqual([33]);
    expect(screen.getByText("1 / 3 · 33%")).toBeTruthy();
  });

  it("排队那一档不许画进度条（前面还有别人的任务）", () => {
    mount({ status: "queued", queuePosition: 2, total: 1000, current: 0 });
    expect(H.progressValues).toEqual([]);
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it("完成那一档也不许留进度条", () => {
    mount({ status: "done", total: 1000, current: 1000 });
    expect(H.progressValues).toEqual([]);
  });
});

// ================================================================ 排队换算
describe("排队位置换算成「前面还有几个」", () => {
  it("第 1 位 = 前面 0 个（不是 1 个）", () => {
    mount({ status: "queued", queuePosition: 1 });
    expect(screen.getByText("前面还有 0 个任务")).toBeTruthy();
  });

  it("第 4 位 = 前面 3 个", () => {
    mount({ status: "queued", queuePosition: 4 });
    expect(screen.getByText("前面还有 3 个任务")).toBeTruthy();
  });

  it("报不出位置就写问号，不写 NaN", () => {
    mount({ status: "queued" });
    expect(screen.getByText("前面还有 ? 个任务")).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});

// ================================================================ 失败出口
describe("失败那一屏的出口按调用方给不给", () => {
  it("有 error 文本才画那一段", () => {
    const { unmount } = mount({ status: "error", error: "上下文超限" });
    expect(screen.getByText("上下文超限")).toBeTruthy();
    unmount();
    cleanup();
    const r2 = mount({ status: "error", error: undefined });
    expect(r2.container.querySelectorAll("p.text-xs.text-destructive")).toHaveLength(0);
  });

  it("给了 onRetry 才有重试，点了就走它", () => {
    const retry = vi.fn();
    mount({ status: "error", error: "炸了" }, { onRetry: retry });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("给了 onFallbackToTFIDF 才有退回，点了就走它", () => {
    const fb = vi.fn();
    mount({ status: "error", error: "炸了" }, { onFallbackToTFIDF: fb });
    fireEvent.click(screen.getByRole("button", { name: "退回 TF-IDF" }));
    expect(fb).toHaveBeenCalledTimes(1);
  });

  it("两个回调都没给：一枚操作按钮都不画（只剩关闭）", () => {
    mount({ status: "error", error: "炸了" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("没失败就别给重试与退回", () => {
    mount({ status: "building" }, { onRetry: vi.fn(), onFallbackToTFIDF: vi.fn() });
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "退回 TF-IDF" })).toBeNull();
  });
});

// ================================================================ 状态兜底不许撒谎
describe("兜底不许说「失败」：状态这一格要穷尽，将来加一档必须在这里红", () => {
  /** store 联合里的全部取值（`downloading` 不在里面，但它会从调用方被 `as` 偷渡进来） */
  const ALL: BuildStatusType[] = ["idle", "queued", "loading", "building", "encoding", "ready", "done"];

  it.each(ALL.filter((s) => s !== "error"))("%s 顶着窗口时不许出现「失败」二字", (status) => {
    mount({ status });
    expect(screen.queryByText(/失败/)).toBeNull();
    cleanup();
  });

  it("调用方偷渡进来的态（`downloading`／将来任何未知值）也不许说失败", () => {
    // SummaryPanel.tsx:175 是 `progress.status as BuildStatusType`——rag 那一侧的联合比 store 的宽
    // （多一个 "downloading"），所以这里判的是"未知值进来时窗口说什么"，不是"枚举里有它"。
    // 要绕两层才进得来，正是因为调用方那句 as 把类型系统骗过去了。
    for (const status of ["downloading", "wat-不知道"] as unknown as BuildStatusType[]) {
      mount({ status });
      expect(screen.queryByText(/失败/), status).toBeNull();
      cleanup();
    }
  });

  it("没被排队／构建／完成三档认出的态要有转圈，不许看着像卡死在那儿", () => {
    // 只数「正在转的那只」：右上角关闭那枚 X 也是 svg，拿 icons().length 判会永远绿。
    const spinning = () => document.querySelectorAll("svg[class*='animate-spin']").length;
    mount({ status: "idle" });
    expect(spinning(), "idle 态连只转圈都没有，配上「正在准备」才不像死机").toBeGreaterThan(0);
    cleanup();
    mount({ status: "downloading" as unknown as BuildStatusType });
    expect(spinning()).toBeGreaterThan(0);
    cleanup();
    // 反向一头：完成与失败不许还在转
    mount({ status: "done" });
    expect(spinning()).toBe(0);
  });
});

/* ================================================================ 变异台账

产品代码基线：src/components/common/NovelBuildWindow.tsx，sha256 前 8 位 `4fa8025a`（4103 字节），全程一行未改。
控制组 24 条全绿。19 轮：每一刀 = 一次手改 + 一次全跑，跑完按字节基线还原并当场核 SHA；
全轮 markers=1、transform_failed=0、diff_lines=0、SHA 核回 `4fa8025a`。

| 刀 | 改了什么 | 红了什么 |
| --- | --- | --- |
| W1 | 摘掉 `if (!open) return null` 总闸 | 「open 为假一个字都不画」 |
| W2 | 关闭只交书 id，引擎写死成 tfidf | 「关闭要同时交这本书与这个引擎」 |
| W3 | 摘掉关闭按钮的 `aria-label` | 2 条（有名可读 + 那两枚按钮的定位） |
| W4 | `isBuilding` 不再算 encoding | 「三种都算构建中」 |
| W5 | `isDone` 不再算 ready | 「done 与 ready 都算完成」 |
| W6 | 标题里位置报不出时空着（去掉 `\|\| "?"`） | 「排队中 (第 ? 位)」 |
| W7b | 去掉进度条那半句 `!isQueued &&`（**等价变异**） | 0 红——`status` 一次只有一个值，排队时 `isBuilding` 恒假，那半句在这层不可能改行为；不硬造判据，改由 W7a 管住真正的那半 |
| W7a | 进度条不分档，什么状态都画 | 2 条（排队与完成都不许留进度条） |
| W8 | `value={total ? pct : undefined}` 写成 `value={pct}` | 「total 报不出走不确定态」 |
| W9 | 那行文字不再判 `total` | 「准备中...」 |
| W10 | `pct` 里 `current \|\| 0` 去掉兜底 | 「current 缺当 0 不算 NaN」 |
| W10b | 那行文字里 `current ?? 0` 去掉兜底（与 W10 是两个位点） | 同一条判据 |
| W11 | 去掉 `Math.round` | 「除不尽的四舍五入取整」 |
| W12 | 「前面还有 N 个」不再减一 | 2 条（第 1 位=0 个、第 4 位=3 个） |
| W13 | 没有 error 文本也摆那一段 | 「有 error 才画那段」（靠数 `p.text-xs.text-destructive` 咬住） |
| W14 | 没给 `onRetry` 也画重试 | 「两个回调都没给一枚操作按钮都不画」 |
| W15 | 出口整块不再看 `isError` | 「没失败就别给重试与退回」 |
| W16 | 「窗口将自动关闭...」不再看 `isDone` | 「构建中不许预告自动关闭」 |
| W17 | 构建中那只图标不再看 `isBuilding`，两只状态图标同时亮 | 「任何时刻只挂一只状态图标」 |

**两个位点同一条判据要分开记**：W10 与 W10b 红的是同一个名字（`current` 缺当 0 在 `pct` 与那行文字里
各有一份兜底），刀标签才是归属证据；只记一刀就等于漏判另一处。
**W7b 这一轮是等价变异**：`!isQueued &&` 在 status 互斥的前提下恒真，摘掉没有任何可观察后果——
所以这一只真正判住的是"进度条只在构建中画"（W7a），不是那半句防御。
*/

/* ================================================================ 2026-09-26 追加：兜底那一格
 * 这批**改了产品**（标题链加中性兜底 + 未覆盖态给转圈），字节基线当场重抓：
 * `4fa8025a`(4103 B) → **`29242199`(4646 B)**。判据 24 → 33 条（穷举七档 + 偷渡值 + 转圈两头）。
 * 跑法 %TEMP%\knife-nbw.sh <刀号>（跑完自动按基线还原并核 SHA）。
 * - **N1／N1b 两记作废，而且是一记新坑**：`MUT-` 注释写在 JSX 表达式收尾的 `}` **之后**，
 *   esbuild 不报错、`markers` 也照样是 1，但那行注释被当成 children **渲染进了 DOM**；
 *   又因为我给注释起的名字里带着「失败」二字，12 条判"不许出现失败"的用例全被**刀自己**污染。
 *   两条规则：① 标记要么放进表达式内部（收尾那个右花括号**之前**），要么写进组件体的行注释；
 *   ② **刀上别写判据要判的那个词**。
 * - N1c 只把兜底那一格换成「索引构建失败」 → **2 红**：`idle` 那条 + 「调用方偷渡进来的态」那条。
 *   其余 31 条不动，说明这一改只挪了兜底、没碰四档本来的文案。
 * - N2 未覆盖态不给转圈 → **1 红**（转圈那条）。
 * - N3 `isPending` 写成只认 `status === "idle"` → **1 红**（还是转圈那条；**标题那条不红**，
 *   因为兜底分支本来就穷尽）。这一刀读出来的是：修法要的是"兜底形状"，不是逐值列举——
 *   只认 idle 那种改法转圈会塌、标题却看不出来，所以两头都得判。
 * - D0 = D0b = 33 条全绿，每轮 markers=1 / transform_failed=0 / markers_left=0 / 还原 SHA 回 `29242199`。
 */
