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
 * ① `:50-57` 标题那条三元链的兜底是「索引构建失败」，于是 `status === "idle"` 且 `open` 时
 *    会顶着"失败"的标题、却没有失败详情也没有重试按钮。**这是可疑行为，没锁进判据**
 *    （锁了就等于给这个症状发钱），已在本轮汇报里单独列出等制作人定口径。
 * ② `:84` 的 `message` 内容归 store 侧那档判，这里只判"message 有就摆出来"。
 *
 * ## 变异台账见文件末尾
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import type { NovelBuildStatus } from "@/stores/build-store";

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
