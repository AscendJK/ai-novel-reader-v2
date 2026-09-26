/**
 * `StorageManager` 面板本体的直接判据（地板第 1 档·存储管理那一屏，277 行）
 *
 * 这一屏管的是"用户敢不敢点清理"：数字要准、口径要一致、点下去删了什么要说得出口。
 * 最贵的几处都在这里：
 * 1) **回执的归属**（`:94-96`）：动作自己报得出数量就用它那句，报不出才回落到「清理完成」。
 *    反过来（通用文案无条件覆盖）会把"清理残留"的 `已清理 N 个残留文件` 永远盖掉——真踩过。
 * 2) **三条清理腿不许串**（`:186-190`）：`rag-index` / `tts-cache` / `embedding-models` 各按
 *    `cat.id` 分岔；串了的后果是"点清索引，把 380MB 语音模型删了"。
 * 3) **TTS 那一腿的顺序与吞异常**（`:100-107`）：先停正在读的音、再删缓存、再释放内存里的 worker；
 *    manager 取不到（返回 null / 取的时候抛错）和 worker 释放失败都要**吃掉异常继续往下走**。
 * 4) **进度条的三档与封顶**（`:146-152`）：>95 红、>80 黄、否则主色；宽度封顶 100%；
 *    `quota === 0` 时占比取 0——不然除零会把 `NaN%` 写进 style。
 * 5) **busy 那一闸**（`:196`）：任何一发在跑时**所有**清理入口一起 disable（不只当前那枚），
 *    否则点第二发会并发删两类。
 *
 * ## 本档刻意没判的四格（别让"这只有测试了"盖住）
 * ① 初始加载 effect 里的 `cancelled`（`:63`）判不到：卸载后组件不存在，"没有再 setState"
 *    在这一层没有可观察后果（React 18 也不告警）。
 * ② `formatBytes` 的进制与小数位归 `storage-stats` 自己那档判，这里只判"面板把哪个字节数交给它"。
 * ③ `refresh()` 失败那条腿不判：它 try/finally 没有 catch，`onClick={refresh}` 抛出的 rejection
 *    没人接 → 判它会给测试引一条 unhandled rejection 噪音（产品口径见本轮汇报，不在这里偷改）。
 * ④ `CATEGORY_ICONS[未知 id]` 取到 undefined 就渲染空图标——没有可观察判断，不锁。
 *
 * ## 变异台账见文件末尾
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, cleanup, within } from "@testing-library/react";
import type { StorageBreakdown, StorageCategory } from "@/lib/storage-stats";

// ---------------------------------------------------------------- 依赖桩
const H = vi.hoisted(() => ({
  breakdown: null as unknown,
  breakdownErr: null as Error | null,
  /** 非 null 时 getStorageBreakdown 挂在这只 promise 上（判「并发拿」用） */
  bdGate: null as Promise<void> | null,
  modelInfo: { modelFiles: new Map<string, { count: number; bytes: number }>(), orphanCount: 0, orphanBytes: 0 },
  downloaded: [] as string[],
  calls: [] as string[],
  /** TTS manager 三档：正常 / 没有活跃 manager / 取的时候抛错 */
  managerMode: "ok" as "ok" | "null" | "throw",
  orphan: 0,
  orphanErr: null as unknown,
  orphanGate: null as Promise<void> | null,
  delGate: null as Promise<void> | null,
  allGate: null as Promise<void> | null,
  confirmReturn: true,
}));

const stats = vi.hoisted(() => ({ breakdownCalls: 0, formatCalls: 0 }));

vi.mock("@/lib/storage-stats", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("@/lib/storage-stats");
  return {
    ...mod,
    getStorageBreakdown: async () => {
      stats.breakdownCalls += 1;
      if (H.bdGate) await H.bdGate;
      if (H.breakdownErr) throw H.breakdownErr;
      return H.breakdown as StorageBreakdown;
    },
    formatBytes: (n: number) => {
      stats.formatCalls += 1;
      return mod.formatBytes(n);
    },
  };
});

vi.mock("@/rag/index", () => ({
  clearCache: vi.fn(() => { H.calls.push("rag"); }),
}));
vi.mock("@/rag/rag-cache-utils", () => ({
  updateRagCacheSize: vi.fn(async () => { H.calls.push("rag-size"); }),
}));
vi.mock("@/tts/tts-cache", () => ({
  clearCache: vi.fn(async () => { H.calls.push("tts"); }),
  cleanupOrphanFiles: vi.fn(async () => {
    if (H.orphanGate) await H.orphanGate;
    if (H.orphanErr) throw H.orphanErr;
    return H.orphan;
  }),
}));
vi.mock("@/rag/model-loader", () => ({
  clearAllModelCache: vi.fn(async () => {
    if (H.allGate) await H.allGate;
    H.calls.push("models-all");
  }),
  deleteModelCache: vi.fn(async (key: string) => {
    if (H.delGate) await H.delGate;
    H.calls.push(`models-one:${key}`);
    return 1;
  }),
  getTransformersCacheInfo: vi.fn(async () => H.modelInfo),
}));
vi.mock("@/stores/rag-store", () => ({
  useRAGStore: (sel: (s: { downloadedModels: Set<string> }) => unknown) =>
    sel({ downloadedModels: new Set(H.downloaded) }),
}));
vi.mock("@/tts/tts-manager", () => ({
  getActiveTTSManager: vi.fn(() => {
    if (H.managerMode === "throw") throw new Error("引擎模块还没初始化");
    if (H.managerMode === "null") return null;
    return { stop: () => { H.calls.push("stop"); } };
  }),
}));
vi.mock("@/tts/zipvoice-engine", () => ({
  resetWorker: vi.fn(() => { H.calls.push("worker"); }),
}));

const cat = (over: Partial<StorageCategory>): StorageCategory => ({
  id: "user-data",
  label: "小说数据",
  description: "书架与章节正文",
  bytes: 1024,
  cleanable: false,
  ...over,
});

const bd = (over: Partial<StorageBreakdown> = {}): StorageBreakdown => ({
  support: true,
  usage: 1000,
  quota: 10000,
  elapsed: 12,
  categories: [
    cat({}),
    cat({ id: "rag-index", label: "RAG 索引缓存", description: "语义检索索引", bytes: 2048, cleanable: true }),
    cat({ id: "tts-cache", label: "TTS 语音模型", description: "离线朗读模型", bytes: 4096, cleanable: true }),
    cat({ id: "embedding-models", label: "嵌入模型", description: "模型文件", bytes: 8192, cleanable: true }),
    cat({ id: "config", label: "配置与设置", description: "阅读进度、API 配置", bytes: 512 }),
  ],
  ...over,
});

/** 分类行：label 那个 <p> 往上最近的带边框圆角容器就是这一行 */
const row = (label: string) => screen.getByText(label).closest("div.rounded-lg") as HTMLElement;
const cleanBtn = (label: string) => within(row(label)).getByRole("button", { name: "清理" });
/** 模型行：key 那个 <p> 的父级是内层 flex，再往上一级才是整行（删除按钮在行尾） */
const modelRow = (key: string) =>
  within(screen.getByText(key).parentElement!.parentElement as HTMLElement);
const bar = () => document.querySelector("div.w-full.h-2 > div") as HTMLElement | null;
const spin = (root: HTMLElement) => root.querySelector("svg.animate-spin");

/** 等初始加载那几只 Promise 落地（含动态 import 与 setState） */
async function settled() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount() {
  const { StorageManager } = await import("../StorageManager");
  return render(<StorageManager />);
}

beforeEach(async () => {
  // 模块桩在整个文件里只造一次，计数不清零会跨测试累加（踩过：1 次读成 3 次）
  const ml = await import("@/rag/model-loader");
  const z = await import("@/tts/zipvoice-engine");
  vi.mocked(ml.getTransformersCacheInfo).mockClear();
  vi.mocked(z.resetWorker).mockClear();
  stats.breakdownCalls = 0;
  stats.formatCalls = 0;
  H.breakdown = bd();
  H.breakdownErr = null;
  H.bdGate = null;
  H.modelInfo = { modelFiles: new Map([["bge-m3", { count: 4, bytes: 5000 }]]), orphanCount: 0, orphanBytes: 0 };
  H.downloaded = [];
  H.calls = [];
  H.managerMode = "ok";
  H.orphan = 0;
  H.orphanErr = null;
  H.orphanGate = null;
  H.delGate = null;
  H.allGate = null;
  H.confirmReturn = true;
  vi.spyOn(window, "confirm").mockImplementation(() => H.confirmReturn);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ================================================================ 加载与刷新
describe("初始加载：转圈、并发拿数、失败也要把转圈停下来", () => {
  it("首帧在统计中（数字没回来之前不摆空的分类行）", async () => {
    const { unmount } = await mount();
    expect(screen.getByText("正在统计存储占用...")).toBeTruthy();
    expect(screen.queryByText("RAG 索引缓存")).toBeNull();
    unmount();
  });

  it("拿数回来：分类行按 breakdown 画，转圈消失", async () => {
    await mount();
    await settled();
    expect(screen.getByText("RAG 索引缓存")).toBeTruthy();
    expect(screen.queryByText("正在统计存储占用...")).toBeNull();
  });

  it("占用与模型信息并发拿（排队等的话，第一只 DB 卡住整屏就黑着）", async () => {
    let release = () => {};
    H.bdGate = new Promise<void>((r) => { release = r; });
    const ml = await import("@/rag/model-loader");
    await mount();
    await settled();
    // 占用那一发还挂着，模型信息已经拿过了 →  Promise.all，不是先后 await
    expect(vi.mocked(ml.getTransformersCacheInfo)).toHaveBeenCalledTimes(1);
    expect(screen.getByText("正在统计存储占用...")).toBeTruthy();
    await act(async () => { release(); });
    H.bdGate = null;
  });

  it("统计失败：转圈停下、不画半截明细，也不把异常抛上屏", async () => {
    H.breakdownErr = new Error("配额 API 不可用");
    await mount();
    await settled();
    expect(screen.queryByText("正在统计存储占用...")).toBeNull();
    expect(screen.queryByText("RAG 索引缓存")).toBeNull();
  });

  it("刷新：两只各再拿一发；拿数期间按钮按住、明细不闪回转圈", async () => {
    await mount();
    await settled();
    const btn = screen.getByRole<HTMLButtonElement>("button", { name: /刷新/ });
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    expect(spin(btn)).toBeTruthy();
    // loading=true 但已有数字：不许把明细换成转圈（闪一下像数据没了）
    expect(screen.getByText("RAG 索引缓存")).toBeTruthy();
    expect(screen.queryByText("正在统计存储占用...")).toBeNull();
    await settled();
    expect(btn.disabled).toBe(false);
    expect(spin(btn)).toBeNull();
    expect(stats.breakdownCalls).toBe(2);
    const ml = await import("@/rag/model-loader");
    expect(vi.mocked(ml.getTransformersCacheInfo)).toHaveBeenCalledTimes(2);
  });
});

// ================================================================ 总览与进度条
describe("总览那一块：support 闸门、三档颜色、封顶、除零", () => {
  it("support 为假时整块不画（拿不到配额就别装成拿得到）", async () => {
    H.breakdown = bd({ support: false });
    await mount();
    await settled();
    expect(screen.queryByText(/浏览器存储用量/)).toBeNull();
    expect(bar()).toBeNull();
  });

  it("用量与配额都过 formatBytes（面板自己不做单位换算）", async () => {
    H.breakdown = bd({ usage: 1024, quota: 10240 });
    await mount();
    await settled();
    const line = screen.getByText(/浏览器存储用量/).parentElement as HTMLElement;
    // 顺序也要判：只查两个字符串在不在，用量与配额互换照样绿（K12 就是这样漏掉的）
    expect(line.textContent).toMatch(/1\.0 KB \/ 10\.0 KB/);
  });

  it("进度条宽度就是占比，颜色三档各判一次", async () => {
    H.breakdown = bd({ usage: 5000, quota: 10000 });
    const r1 = await mount();
    await settled();
    expect(bar()!.style.width).toBe("50%");
    expect(bar()!.className).toContain("bg-primary");
    r1.unmount();
    cleanup();

    H.breakdown = bd({ usage: 8500, quota: 10000 });
    const r2 = await mount();
    await settled();
    expect(r2.container.querySelector("div.w-full.h-2 > div")!.className).toContain("bg-amber-500");
    r2.unmount();
    cleanup();

    H.breakdown = bd({ usage: 9600, quota: 10000 });
    await mount();
    await settled();
    expect(bar()!.className).toContain("bg-destructive");
  });

  it("阈值边界：80% 还是主色、95% 还是黄色（> 不是 >=）", async () => {
    H.breakdown = bd({ usage: 8000, quota: 10000 });
    const r1 = await mount();
    await settled();
    expect(bar()!.className).toContain("bg-primary");
    r1.unmount();
    cleanup();

    H.breakdown = bd({ usage: 9500, quota: 10000 });
    await mount();
    await settled();
    expect(bar()!.className).toContain("bg-amber-500");
  });

  it("用量超过配额：宽度封顶 100%（不许把 >100% 写进 style）", async () => {
    H.breakdown = bd({ usage: 30000, quota: 10000 });
    await mount();
    await settled();
    expect(bar()!.style.width).toBe("100%");
  });

  it("配额为 0：占比取 0，不把 NaN% 上屏", async () => {
    H.breakdown = bd({ usage: 500, quota: 0 });
    await mount();
    await settled();
    expect(bar()!.style.width).toBe("0%");
    expect(bar()!.style.width).not.toContain("NaN");
  });
});

// ================================================================ 分类行
describe("分类行：明细怎么拼、只有可清理的才给出口", () => {
  it("每类一行：label、字节数、说明三件齐", async () => {
    await mount();
    await settled();
    expect(row("RAG 索引缓存").textContent).toContain("语义检索索引");
    expect(within(row("RAG 索引缓存")).getByText("2.0 KB").tagName).toBe("SPAN");
  });

  it("cleanable 为假不画清理出口（小说数据与配置不是这里能删的东西）", async () => {
    await mount();
    await settled();
    expect(screen.getAllByRole<HTMLButtonElement>("button", { name: "清理" })).toHaveLength(3);
    expect(within(row("小说数据")).queryByRole("button", { name: "清理" })).toBeNull();
    expect(within(row("配置与设置")).queryByRole("button", { name: "清理" })).toBeNull();
  });

  it("有 detail 就带括号，没有就不画空括号", async () => {
    H.breakdown = bd({
      categories: [cat({ id: "rag-index", label: "带明细的一类", description: "向量索引", detail: "3 本书", cleanable: true })],
    });
    const r1 = await mount();
    await settled();
    expect(screen.getByText("向量索引（3 本书）")).toBeTruthy();
    r1.unmount();
    cleanup();

    H.breakdown = bd({ categories: [cat({ id: "rag-index", label: "没明细的一类", description: "向量索引" })] });
    await mount();
    await settled();
    expect(screen.getByText("向量索引")).toBeTruthy();
    expect(screen.queryByText("（）")).toBeNull();
  });
});

// ================================================================ 三条清理腿
describe("三条清理腿各删各的：确认、分岔、顺序、并发闸", () => {
  it("点清理先问确认，取消就一个字节都不动", async () => {
    H.confirmReturn = false;
    await mount();
    await settled();
    fireEvent.click(cleanBtn("RAG 索引缓存"));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(H.calls).toEqual([]);
    expect(screen.queryByText(/清理完成/)).toBeNull();
  });

  it("确认文案说的是这一腿的后果", async () => {
    await mount();
    await settled();
    fireEvent.click(cleanBtn("RAG 索引缓存"));
    await settled();
    const text = String(vi.mocked(window.confirm).mock.calls[0][0]);
    expect(text).toContain("重新构建索引");
    expect(text).toContain("不影响小说正文");
  });

  it("rag-index 那一腿：清索引 + 重算缓存大小，不碰 TTS 与模型", async () => {
    await mount();
    await settled();
    fireEvent.click(cleanBtn("RAG 索引缓存"));
    await settled();
    expect(H.calls).toEqual(["rag", "rag-size"]);
    expect(H.calls).not.toContain("tts");
    expect(H.calls).not.toContain("models-all");
  });

  it("tts-cache 那一腿按顺序：先停正在读的音、再删缓存、再释放 worker", async () => {
    await mount();
    await settled();
    fireEvent.click(cleanBtn("TTS 语音模型"));
    await settled();
    expect(H.calls).toEqual(["stop", "tts", "worker"]);
    // 这一腿的确认文案要说清"谁不受影响、要重下多少"——删 380MB 不能只说"确认清理"
    const text = String(vi.mocked(window.confirm).mock.calls[0][0]);
    expect(text).toContain("380MB");
    expect(text).toContain("服务端推理");
    expect(text).toContain("重新下载");
  });

  it("没有活跃 manager 也照删（不是正在朗读就不该拦住的）", async () => {
    H.managerMode = "null";
    await mount();
    await settled();
    fireEvent.click(cleanBtn("TTS 语音模型"));
    await settled();
    expect(H.calls).toEqual(["tts", "worker"]);
  });

  it("取 manager 时抛错也照删（异常不许把这一腿截断）", async () => {
    H.managerMode = "throw";
    await mount();
    await settled();
    fireEvent.click(cleanBtn("TTS 语音模型"));
    await settled();
    expect(H.calls).toEqual(["tts", "worker"]);
    expect(screen.getByText(/清理完成/)).toBeTruthy();
  });

  it("worker 释放失败也照删，回执仍算成功", async () => {
    const z = await import("@/tts/zipvoice-engine");
    vi.mocked(z.resetWorker).mockImplementationOnce(() => { throw new Error("模型没加载"); });
    await mount();
    await settled();
    fireEvent.click(cleanBtn("TTS 语音模型"));
    await settled();
    expect(H.calls).toContain("tts");
    expect(H.calls).not.toContain("worker");
    expect(screen.getByText("清理完成")).toBeTruthy();
  });

  it("embedding-models 那一腿删的是整类缓存（与这一行报的字节数同一口径）", async () => {
    await mount();
    await settled();
    fireEvent.click(cleanBtn("嵌入模型"));
    await settled();
    expect(H.calls).toEqual(["models-all"]);
    expect(H.calls).not.toContain("rag");
    const text = String(vi.mocked(window.confirm).mock.calls[0][0]);
    expect(text).toContain("嵌入模型");
    expect(text).toContain("不影响小说正文");
  });

  it("任何一发在跑时所有清理入口一起按住，且只有跑的那一发出转圈", async () => {
    let release = () => {};
    H.orphanGate = new Promise<void>((r) => { release = r; });
    await mount();
    await settled();
    const btns = screen.getAllByRole<HTMLButtonElement>("button", { name: "清理" });
    expect(btns).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /清理残留/ }));
    await settled();
    expect(screen.getAllByRole<HTMLButtonElement>("button", { name: "清理" }).every((b) => b.disabled)).toBe(true);
    expect(spin(row("嵌入模型"))).toBeNull();
    expect(spin(screen.getByText("TTS 残留文件清理").closest("div.rounded-lg") as HTMLElement)).toBeTruthy();
    await act(async () => { release(); });
    H.orphanGate = null;
    await settled();
    expect(screen.getAllByRole<HTMLButtonElement>("button", { name: "清理" }).every((b) => !b.disabled)).toBe(true);
  });

  it("跑的那一枚出转圈，别只变灰（三处 spinner 各按自己的 busyAction）", async () => {
    let release = () => {};
    H.allGate = new Promise<void>((r) => { release = r; });
    await mount();
    await settled();
    fireEvent.click(cleanBtn("嵌入模型"));
    await act(async () => { await Promise.resolve(); });
    expect(spin(row("嵌入模型"))).toBeTruthy();
    expect(spin(row("RAG 索引缓存"))).toBeNull();
    expect(spin(row("TTS 语音模型"))).toBeNull();
    expect(spin(screen.getByText("TTS 残留文件清理").closest("div.rounded-lg") as HTMLElement)).toBeNull();
    await act(async () => { release(); });
    H.allGate = null;
    await settled();
    expect(spin(row("嵌入模型"))).toBeNull();
  });

  it("跑完要重新统计一次（不然屏上还留着删掉之前的字节数）", async () => {
    await mount();
    await settled();
    const before = stats.breakdownCalls;
    fireEvent.click(cleanBtn("RAG 索引缓存"));
    await settled();
    await settled();
    expect(stats.breakdownCalls).toBe(before + 1);
    expect(stats.breakdownCalls).toBe(2);
  });

  it("每一腿的 busyAction 用自己的名字（单只模型那一行不算分类行的忙）", async () => {
    await mount();
    await settled();
    fireEvent.click(cleanBtn("TTS 语音模型"));
    await settled();
    expect(spin(row("TTS 语音模型"))).toBeNull();
    expect(spin(row("RAG 索引缓存"))).toBeNull();
  });
});

// ================================================================ 回执口径
describe("回执：谁有信息谁说话", () => {
  it("动作报得出数量就用它那句（通用文案不许盖掉）", async () => {
    H.orphan = 3;
    await mount();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: /清理残留/ }));
    await settled();
    expect(screen.getByText("已清理 3 个残留文件")).toBeTruthy();
    expect(screen.queryByText("清理完成")).toBeNull();
    // 这一发只删孤儿，确认框要许下"必需文件不动"
    expect(String(vi.mocked(window.confirm).mock.calls[0][0])).toContain("必需清单");
  });

  it("一个孤儿都没有也要回话，不许静默", async () => {
    H.orphan = 0;
    await mount();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: /清理残留/ }));
    await settled();
    expect(screen.getByText("没有发现残留文件")).toBeTruthy();
  });

  it("动作报不出（返回 void）才回落到通用文案「清理完成」", async () => {
    await mount();
    await settled();
    fireEvent.click(cleanBtn("RAG 索引缓存"));
    await settled();
    expect(screen.getByText("清理完成")).toBeTruthy();
  });

  it("失败要说「清理失败：原因」，并且不画成功样", async () => {
    H.orphanErr = new Error("存储被别的标签页锁住");
    await mount();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: /清理残留/ }));
    await settled();
    const p = screen.getByText(/清理失败/);
    expect(p.textContent).toContain("存储被别的标签页锁住");
    expect(p.className).toContain("text-destructive");
    expect(p.className).not.toContain("text-green-600");
  });

  it("抛的不是 Error 也要把原因说出口（String 兜底，不许只剩「清理失败：」）", async () => {
    H.orphanErr = "磁盘只读";
    await mount();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: /清理残留/ }));
    await settled();
    expect(screen.getByText(/清理失败/).textContent).toBe("清理失败：磁盘只读");
  });

  it("失败之后所有入口要放开（不然整屏出口永久按住）", async () => {
    H.orphanErr = new Error("炸了");
    await mount();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: /清理残留/ }));
    await settled();
    expect(screen.getAllByRole<HTMLButtonElement>("button", { name: "清理" }).every((b) => !b.disabled)).toBe(true);
  });

  it("下一次动作开始时清掉上一条回执（在飞的那一发不许顶着旧数字）", async () => {
    H.orphan = 2;
    await mount();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: /清理残留/ }));
    await settled();
    expect(screen.getByText("已清理 2 个残留文件")).toBeTruthy();

    let release = () => {};
    H.orphanGate = new Promise<void>((r) => { release = r; });
    fireEvent.click(screen.getByRole("button", { name: /清理残留/ }));
    await act(async () => { await Promise.resolve(); });
    // 这一发还没跑完：旧那句还在的话读者会以为"已经删完 2 个"
    expect(screen.queryByText(/已清理/)).toBeNull();
    await act(async () => { release(); });
    H.orphanGate = null;
    await settled();
    expect(screen.getAllByText("已清理 2 个残留文件")).toHaveLength(1);
  });
});

// ================================================================ 已下载模型
describe("已下载模型那一块：一只一行、缺文件要明说", () => {
  it("一只都没下载：整块不画", async () => {
    await mount();
    await settled();
    expect(screen.queryByText("已下载的嵌入模型")).toBeNull();
  });

  it("下载了几只就几行，报的是各自的模型 key", async () => {
    H.downloaded = ["bge-m3", "bge-small"];
    await mount();
    await settled();
    expect(screen.getByText("已下载的嵌入模型")).toBeTruthy();
    expect(screen.getByText("bge-m3")).toBeTruthy();
    expect(screen.getByText("bge-small")).toBeTruthy();
  });

  it("缓存文件缺失要说出口（下载记录在、文件却没了）", async () => {
    H.downloaded = ["bge-m3", "vanished", "zero-count"];
    H.modelInfo = {
      modelFiles: new Map([
        ["bge-m3", { count: 4, bytes: 5000 }],
        ["zero-count", { count: 0, bytes: 0 }],
      ]),
      orphanCount: 0,
      orphanBytes: 0,
    };
    await mount();
    await settled();
    expect(modelRow("bge-m3").getByText("4 文件 · 4.9 KB")).toBeTruthy();
    expect(modelRow("vanished").getByText("缓存文件缺失")).toBeTruthy();
    // 有条目但一个文件都没有：也算缺失（不然读起来像"缓存着 0 个文件"）
    expect(modelRow("zero-count").getByText("缓存文件缺失")).toBeTruthy();
  });

  it("有文件但报不出字节：只说文件数，不编一个 0 B", async () => {
    H.downloaded = ["zero-bytes"];
    H.modelInfo = { modelFiles: new Map([["zero-bytes", { count: 2, bytes: 0 }]]), orphanCount: 0, orphanBytes: 0 };
    await mount();
    await settled();
    expect(modelRow("zero-bytes").getByText("2 文件").textContent).not.toContain("B");
  });

  it("单只模型的删除按 key 走，且先过确认框", async () => {
    H.downloaded = ["bge-m3"];
    await mount();
    await settled();
    fireEvent.click(modelRow("bge-m3").getByRole("button"));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(window.confirm).mock.calls[0][0])).toContain("bge-m3");
    await settled();
    expect(H.calls).toEqual(["models-one:bge-m3"]);
  });

  it("确认取消：单只也不许删", async () => {
    H.downloaded = ["bge-m3"];
    H.confirmReturn = false;
    await mount();
    await settled();
    fireEvent.click(modelRow("bge-m3").getByRole("button"));
    await settled();
    expect(H.calls).toEqual([]);
  });

  it("只有正在删的那只出转圈，别只按住不转", async () => {
    H.downloaded = ["bge-m3", "bge-small"];
    let release = () => {};
    H.delGate = new Promise<void>((r) => { release = r; });
    await mount();
    await settled();
    fireEvent.click(modelRow("bge-m3").getByRole("button"));
    await act(async () => { await Promise.resolve(); });
    expect(spin(modelRow("bge-m3").getByRole("button"))).toBeTruthy();
    expect(spin(modelRow("bge-small").getByRole("button"))).toBeNull();
    expect((modelRow("bge-small").getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); });
    H.delGate = null;
    await settled();
    expect(H.calls).toEqual(["models-one:bge-m3"]);
    expect(spin(modelRow("bge-m3").getByRole("button"))).toBeNull();
  });
});

// ================================================================ 底部
describe("底部：统计耗时与那句「小说数据去书架删」", () => {
  it("拿得到数才报耗时", async () => {
    await mount();
    await settled();
    const p = screen.getByText(/统计耗时 12ms/);
    expect(p.textContent).toContain("小说数据在书架中删除");
  });

  it("没拿到数时那一格是空的（不许说「统计耗时 undefined」）", async () => {
    H.breakdownErr = new Error("炸");
    await mount();
    await settled();
    expect(screen.queryByText(/统计耗时/)).toBeNull();
  });
});

/* ================================================================ 变异台账

产品代码基线：src/components/settings/StorageManager.tsx，sha256 前 8 位 `3a71da12`（12987 字节），
全程一行未改。控制组 42 条全绿（无 act 警告）。每一刀 = 一次手改 + 一次全跑，跑完立刻按字节基线还原；
36 轮全部 markers=1、还原后 diff_lines=0、SHA 当场核回 `3a71da12`。

| 刀 | 改了什么 | 红了什么 |
| --- | --- | --- |
| K1 | `runCleanup` 的 `if (!window.confirm(...)) return` 只问不看结果 | 取消一个字节不动（分类 + 单只模型）2 条 |
| K2 | 回执改成无条件「清理完成」 | 谁有信息谁说话那一组 3 条（含在飞那条） |
| K3 | 摘掉取 manager 外层的 try/catch | 「取 manager 抛错也照删」 |
| K4 | `if (manager)` 改成 `manager!.stop()`（**等价变异**） | 0 红——K3 证明外层 try/catch 会吃掉 TypeError，这一格在这层没有可观察后果，故不判 |
| K5 | 把 `await clearTTSCache()` 挪到停音之前 | 「先停音、再删、再释放」的顺序 |
| K6 | 摘掉 `resetWorker()` 的 try/catch | 「worker 释放失败也照删」 |
| K7 | `cat.id === "rag-index"` 改调 `cleanTTS()` | 腿的副作用 + 确认文案 2 条 |
| K8 | 摘掉 `cat.cleanable &&` | 「非可清理不画出口」+ 并发闸计数 |
| K9 | 分类行 `disabled` 改成只按当前那枚 | 「所有入口一起按住」 |
| K10 | 模型行 `disabled` 同上 | 「别只按住不转」 |
| K11 | 分类行转圈条件写死 false | 「跑的那一枚出转圈」 |
| K12 | 总览把 usage 与 quota 互换（**0 红**） | 判据只看两个字符串在不在，不看顺序——覆盖洞，见下 |
| K12b | 同上，判据改成 `toMatch(/1\.0 KB \/ 10\.0 KB/)` 后重跑 | 「用量与配额都过 formatBytes」 |
| K13 | `usagePct > 95` 改 `>=` | 阈值边界那一格（95% 该黄） |
| K14 | `usagePct > 80` 改 `>=` | 阈值边界那一格（80% 该主色） |
| K15 | 去掉 `Math.min(usagePct, 100)` | 「宽度封顶 100%」 |
| K16 | `quota > 0` 改 `quota >= 0` | 「配额为 0 取 0，不上 NaN%」 |
| K17 | 总览的 `breakdown.support` 闸摘掉 | 「support 为假整块不画」 |
| K18 | `loading && !breakdown` 改成 `loading` | 「刷新期间明细不闪回转圈」 |
| K19 | 初始加载 `Promise.all` 改先后 `await` | 「两只 DB 并发拿」 |
| K20 | 没有 detail 也画括号 | 「不画空括号」 |
| K21 | 摘掉 `setMessage(null)` | 「在飞的那一发不许顶着旧数字」 |
| K22 | 非 Error 的抛值兜底改成写死「未知错误」 | 「String 兜底把原因说出口」 |
| K23 | 摘掉跑完的 `await refresh()` | 「跑完重新统计一次」 |
| K24 | `downloadedModels.size > 0` 改 `>= 0` | 「一只都没下载整块不画」 |
| K25 | `files && files.count > 0` 改 `files` | 「count===0 也算缓存文件缺失」 |
| K26 | 字节那段不再判 `bytes > 0`，硬拼 ` · 0 B` | 「报不出字节就只说文件数」 |
| K27 | 模型行转圈条件写死 false | 「只有正在删的那只出转圈」 |
| K28 | 清理残留那枚转圈写死 false | 「所有入口按住 + 跑的那枚转圈」 |
| K29 | `runCleanup` 的 id 从 `model-${key}` 改成 `model-x` | 同一判据的另一半：id 与 ternary 必须成对 |
| K30 | RAG 腿确认文案改成「确认清理？」 | 「确认文案说这一腿的后果」 |
| K31 | TTS 腿文案删掉 380MB / 服务端推理 / 重新下载 | 那一腿的顺序判据（同条带文案） |
| K32 | 嵌入模型腿文案改成「确认清理？」 | 整类删除那条的文案断言 |
| K33 | 清理残留文案删掉「必需清单」那句承诺 | 「动作报得出数量就用它那句」 |
| K34 | 摘掉 finally 里的 `setBusyAction(null)` | 6 条：失败后放开、三处转圈归属、在飞回执、按住与释放 |
| K35 | 底部那句不再判 `breakdown` 是否存在 | 「没拿到数那一格是空的」 |
| K36 | 初始加载的 `.catch` 不再 `setLoading(false)` | 「统计失败转圈也要停下」 |

**K12 那一轮不是等价变异，是我漏判**：`{formatBytes(usage)} / {formatBytes(quota)}` 互换后两个字符串都还在，
`toContain` 两条各绿一次。把判据换成带顺序的正则重跑（K12b）才咬住。带斜杠的"A / B"式展示，判"在不在"等于没判。

## 刻意没判的（与文件头同一份账）
① `cancelled`（卸载后不再 setState）② `formatBytes` 的进制与小数位 ③ `refresh()` 失败那条腿
（try/finally 无 catch，判它会引一条 unhandled rejection 噪音）④ `CATEGORY_ICONS` 未知 id 渲染空图标。
*/
