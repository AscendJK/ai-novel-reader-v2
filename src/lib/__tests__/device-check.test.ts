/**
 * 真机自检模块的纯逻辑测试（清单/事实/导出/探针）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  DEVICE_CHECKLIST, buildReport, loadCheckState, saveCheckState,
  installProbes, collectFacts, type Fact,
} from "../device-check";
import { useScreenWakeLock } from "@/hooks/useScreenWakeLock";

vi.mock("@/tts/tts-manager", () => ({
  getActiveTTSManager: () => h.manager(),
}));

/** 可控的"当前朗读会话"：runtime=null 表示没有会话（沿用原有若干用例的口径） */
const h = vi.hoisted(() => {
  const state = { runtime: null as string | null };
  return {
    state,
    manager: () => (state.runtime === null ? null : { describeRuntime: () => state.runtime as string }),
  };
});

function makeFacts(): Fact[] {
  return [
    { label: "crossOriginIsolated / SharedArrayBuffer", value: "false / true", level: "ok" },
    { label: "存储配额", value: "剩余 120.0MB", level: "warn" },
    { label: "系统语音（Web Speech）", value: "0 个 voice，其中中文 0 个", level: "bad" },
  ];
}

beforeEach(() => {
  localStorage.clear();
});

describe("清单与勾选状态", () => {
  it("每项都有唯一 id 与「怎么做/应看到」两段说明", () => {
    const ids = DEVICE_CHECKLIST.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of DEVICE_CHECKLIST) {
      expect(item.how.length).toBeGreaterThan(5);
      expect(item.expect.length).toBeGreaterThan(5);
    }
  });

  it("清单覆盖批次 5 遗留的 iOS 关键场景", () => {
    const ids = DEVICE_CHECKLIST.map((i) => i.id);
    for (const must of ["resume-after-interrupt", "double-tap-continue", "mute-switch", "background-restore", "auto-next-chapter", "rate-change-while-paused", "offline-cold-start", "screen-off-listening"]) {
      expect(ids).toContain(must);
    }
  });

  it("熄屏听声那条要能与「切后台」分开做，并要求留下可比数字", () => {
    const item = DEVICE_CHECKLIST.find((i) => i.id === "screen-off-listening");
    expect(item, "清单只验「回来之后状态对不对」，没验「熄屏那段时间还在不在读」").toBeTruthy();
    expect(item?.how).toContain("电源键");
    expect(item?.how).toContain("不要按 Home");   // 按 Home 走的是另一条路（切后台），两件事不能混做
    expect(item?.how).toContain("引擎");          // 三档引擎的结论不同，不记引擎等于没测
    expect(item?.expect).toContain("段号");
  });

  it("勾选状态持久化到 localStorage 并可回读", () => {
    expect(loadCheckState()).toEqual({});
    saveCheckState({ "mute-switch": true });
    expect(loadCheckState()["mute-switch"]).toBe(true);
  });
});

describe("buildReport", () => {
  it("导出文本含事实、级别标记与勾选状态", () => {
    const text = buildReport(makeFacts(), { "mute-switch": true });
    expect(text).toContain("环境事实");
    expect(text).toContain("crossOriginIsolated / SharedArrayBuffer: false / true");
    expect(text).toContain("✱ 系统语音");     // bad 级别带醒目前缀
    expect(text).toContain("✅ 侧边静音键两种位置各试一次");
    expect(text).toContain("⬜");
  });

  it("事实尚未采集时也不崩（只有清单）", () => {
    const text = buildReport([], {});
    expect(text).toContain("【环境事实】");
    expect(text).toContain("【手动清单】");
  });
});

describe("collectFacts", () => {
  it("至少给出 COI、存储、IndexedDB、语音、运行时几项，且每项有级别", async () => {
    const facts = await collectFacts();
    const labels = facts.map((f) => f.label).join("|");
    expect(labels).toContain("crossOriginIsolated");
    expect(labels).toContain("IndexedDB 可写");
    expect(labels).toContain("朗读运行时");
    for (const f of facts) expect(["ok", "warn", "bad", "info"]).toContain(f.level);
  });

  it("没有朗读会话时运行时项给出可行动的说明，而不是抛错", async () => {
    const facts = await collectFacts();
    const runtime = facts.find((f) => f.label === "朗读运行时");
    expect(runtime?.value).toContain("没有朗读会话");
  });

  it("COI 那一项报出「为等 SW 接管自刷了几次」，刷到上限要看得出来", async () => {
    // 手机上开不了 devtools。`main.tsx` 刷到上限之后就永久停在非隔离态，症状是
    // 浏览器朗读起不动模型；那一行只写 false / true 的话，"还在刷"和"已经放弃了"
    // 看起来一模一样，排查只能靠猜。
    sessionStorage.clear();
    sessionStorage.setItem("coi-reload-count", "3");
    const givenUp = (await collectFacts()).find((f) => f.label.startsWith("crossOriginIsolated"));
    expect(givenUp?.value).toContain("3 次");
    expect(givenUp?.value).toContain("上限");

    sessionStorage.setItem("coi-reload-count", "1");
    const midway = (await collectFacts()).find((f) => f.label.startsWith("crossOriginIsolated"));
    expect(midway?.value).toContain("1 次");
    expect(midway?.value).not.toContain("上限");
    sessionStorage.clear();
  });
});

describe("installProbes", () => {
  let lines: string[];
  beforeEach(() => { lines = []; });
  afterEach(() => { vi.restoreAllMocks(); });

  it("记录可见性与页面存活事件，卸载后不再记录", () => {
    const off = installProbes((l) => lines.push(l));
    expect(lines.some((l) => l.includes("探针已挂载"))).toBe(true);

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("freeze"));
    expect(lines.some((l) => l.includes("visibilitystate") || l.includes("可见性"))).toBe(true);
    expect(lines.some((l) => l.includes("pagehide"))).toBe(true);
    expect(lines.some((l) => l.includes("冻结"))).toBe(true);

    off();
    const n = lines.length;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(lines.length).toBe(n);
  });

  it("未捕获的 Promise 拒绝进入时间线（iOS 上这是唯一线索）", () => {
    const off = installProbes((l) => lines.push(l));
    // 只把 reason 交给监听器；promise 字段用已解决的 promise，否则会造出真·未处理拒绝
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve(),
      reason: new Error("boom"),
    }));
    expect(lines.some((l) => l.includes("boom"))).toBe(true);
    off();
  });

  it("屏幕唤醒锁被系统收走这件事，自己爬进时间线", async () => {
    const off = installProbes((l) => lines.push(l));
    const listeners = new Map<string, () => void>();
    const sentinel = {
      release: vi.fn(() => Promise.resolve()),
      addEventListener: vi.fn((t: string, fn: () => void) => listeners.set(t, fn)),
    };
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: async () => sentinel },
    });
    const { unmount } = renderHook(() => useScreenWakeLock(true, "探针-锁"));
    await act(async () => {});
    act(() => { listeners.get("release")?.(); }); // 熄屏/切后台：系统强制收锁

    // 认"已放开"这件事本身：只要求"唤醒锁 + 标签"的话，"到手"那行也算命中
    expect(lines.some((l) => l.includes("探针-锁") && l.includes("已放开")), `时间线里没有这一句：${lines.join(" | ")}`).toBe(true);
    unmount();

    // 面板关掉之后不能再往这一份时间线里推：漏掉一次，下次打开面板就能看到两遍
    off();
    const n = lines.length;
    const second = renderHook(() => useScreenWakeLock(true, "探针-锁退订后"));
    await act(async () => {});
    second.unmount();
    expect(lines.length, "installProbes 返回的 off() 没把唤醒锁这条订上/退干净").toBe(n);
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
  });
});

describe("屏幕唤醒锁事实行（息屏还在不在读，第一眼要看的地方）", () => {
  afterEach(() => { delete (navigator as unknown as { wakeLock?: unknown }).wakeLock; });
  const lockFact = async () => (await collectFacts()).find((f) => f.label.includes("唤醒锁"));

  it("这一行存在，并且说清「是不是安全上下文」——非 HTTPS 根本申请不到锁", async () => {
    const wl = await lockFact();
    expect(wl, "息屏保活是移动端朗读的头号疑点，自检里却一行都不报").toBeTruthy();
    expect(wl?.value).toContain("安全上下文");
    expect(wl?.value).toMatch(/还没申请过|持有中|未持有|已放开|申请被拒/);
  });

  it("真持有着就如实报「持有中」，不是只报 API 在不在", async () => {
    const listeners = new Map<string, () => void>();
    const sentinel = {
      release: vi.fn(() => Promise.resolve()),
      addEventListener: vi.fn((t: string, fn: () => void) => listeners.set(t, fn)),
    };
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => sentinel } });
    const { unmount } = renderHook(() => useScreenWakeLock(true, "自检-持有"));
    await act(async () => {});

    expect((await lockFact())?.value).toContain("持有中");
    unmount();
  });

  it("申请被拒时那一行要写出为什么没锁（省电模式与非 HTTPS 长得不一样，不能都成「没锁」）", async () => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } },
    });
    renderHook(() => useScreenWakeLock(true, "自检-被拒"));
    await act(async () => {});

    const value = (await lockFact())?.value ?? "";
    expect(value).toContain("自检-被拒");
    expect(value).toContain("NotAllowedError");
  });
});

describe("朗读现场采样（熄屏那 60~90 秒得在时间线里留下脚印）", () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    h.state.runtime = null;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    h.state.runtime = null;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  const sampled = () => lines.filter((l) => l.includes("朗读现场"));

  it("段号一动就记一行，并带上页面可见性", () => {
    const off = installProbes((l) => lines.push(l));
    h.state.runtime = "engine=server chunk=3/12 缓冲池=2段";
    vi.advanceTimersByTime(3_000);
    expect(sampled().some((l) => l.includes("chunk=3/12") && l.includes("页面=visible")), lines.join(" | ")).toBe(true);

    h.state.runtime = "engine=server chunk=4/12 缓冲池=2段";
    vi.advanceTimersByTime(3_000);
    expect(sampled().some((l) => l.includes("chunk=4/12")), "段号往前走了，时间线却看不出来——熄屏期间听没听就成了猜").toBe(true);
    off();
  });

  it("毫无变化时不许刷屏，但静默太久要留一行「还在」", () => {
    const off = installProbes((l) => lines.push(l));
    h.state.runtime = "engine=server chunk=3/12";
    vi.advanceTimersByTime(3_000);
    const n = sampled().length;
    expect(n).toBe(1);

    vi.advanceTimersByTime(3_000 * 5); // 15 秒毫无变化：不该跟着刷 5 行
    expect(sampled().length, "每 3 秒抄一遍会把导出窗口（最近 120 行）刷满").toBe(n);

    vi.advanceTimersByTime(3_000 * 20); // 再静默下去要靠心跳证明探针没死
    expect(sampled().length).toBeGreaterThan(n);
    off();
  });

  it("亮屏/熄屏本身就要记一行（页面=hidden 是熄屏的起点锚）", () => {
    const off = installProbes((l) => lines.push(l));
    h.state.runtime = "engine=server chunk=3/12";
    vi.advanceTimersByTime(3_000);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    vi.advanceTimersByTime(3_000); // 段号没动，只有可见性动了

    expect(sampled().some((l) => l.includes("页面=hidden")), lines.join(" | ")).toBe(true);
    off();
  });

  it("面板关掉之后不许再采样（否则后台定时器会把时间线刷爆）", () => {
    const off = installProbes((l) => lines.push(l));
    h.state.runtime = "engine=server chunk=3/12";
    vi.advanceTimersByTime(3_000);
    off();

    const n = lines.length;
    h.state.runtime = "engine=server chunk=9/9";
    vi.advanceTimersByTime(60_000);
    expect(lines.length).toBe(n);
  });
});

/**
 * 停摆补记（09-28 一次性台架量出来的那一格）。
 *
 * 台架读数：把页面 JS 主线程停住 30 秒（`Debugger.pause`），导出的时间线在那 30 秒里
 * **一行都没有**，恢复之后才补出 3 行「朗读现场」；而挂在页面外的独立 AudioContext
 * 显示那 30 秒里音频走了 36.12 秒。也就是说"没行"既可能是"没在读"，也可能是
 * "探针自己没能跑"——而旧注释教的读法正是"停在某一段再无新行 = 停了"，那是假话。
 * 这一档要的是：探针醒过来时自己承认"我漏了 N 秒"，把沉默变成有名字的沉默。
 *
 * 刀账（同一处改动打进产品后当场还原并对 `sha256sum`）：
 * - Z4 摘掉「探针停摆 N 秒」那一行 → 红 4；浏览器层 P3 红 1
 * - Z6 与 Z4 是同一刀的两种折法（整行不 push），重打一遍读数仍是红 4——这一趟只为把
 *   新加的「7.5 秒要报」纳进红名里
 * - Z5 停摆阈值 `RUNTIME_SAMPLE_MS * 2` → `* 3` → **第一次红 0**：原先那条边界判据写着
 *   "6.5 秒"，但假时钟下 `advanceTimersByTime` 不拨 `Date`，采样到的间隔根本不是拨的那个数。
 *   改成"报出来的秒数落在 6 与 9 之间"两条各钉一头之后 → 红 1
 * - 保护格「每拍都按时到就不许多出停摆行」在 Z4/Z5/Z6 三刀下都没红过，它守的是"不许手松"
 */
describe("探针停摆要自己认账（不能把「探针没跑」留给读的人当成「没在读」）", () => {
  let lines: string[];
  const T0 = new Date(2026, 8, 28, 21, 0, 0).getTime();

  beforeEach(() => {
    lines = [];
    h.state.runtime = "engine=server chunk=3/12 缓冲池=2段";
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    h.state.runtime = null;
  });

  const stall = () => lines.filter((l) => l.includes("停摆"));
  const secondsOf = (l: string) => Number(/停摆\s*([\d.]+)\s*秒/.exec(l)?.[1] ?? NaN);

  it("墙钟走了 30 秒而定时器一拍没跑：醒来必须补一行，且秒数对得上", () => {
    const off = installProbes((l) => lines.push(l));
    vi.advanceTimersByTime(3_000); // 正常一拍
    expect(stall(), "刚挂上就报停摆，等于把每一段都算成断档").toHaveLength(0);

    vi.setSystemTime(T0 + 30_000); // 熄屏那 30 秒：墙钟在走，一个定时器都没醒
    vi.advanceTimersByTime(3_000);

    expect(stall().length, lines.join(" | ")).toBe(1);
    const gap = secondsOf(stall()[0]);
    expect(gap, `报出来的秒数对不上实际停摆：${stall()[0]}`).toBeGreaterThanOrEqual(29);
    expect(gap).toBeLessThanOrEqual(34);
    off();
  });

  it("秒数要跟着停摆长度变（写死一个数会被这条抓住）", () => {
    const off = installProbes((l) => lines.push(l));
    vi.advanceTimersByTime(3_000);
    vi.setSystemTime(T0 + 3_000 + 9_000); // 短的一次：约 9 秒
    vi.advanceTimersByTime(3_000);
    const shortGap = secondsOf(stall()[0]);
    expect(shortGap).toBeGreaterThanOrEqual(8);
    expect(shortGap).toBeLessThanOrEqual(14);

    lines.length = 0;
    const off2 = installProbes((l) => lines.push(l));
    vi.advanceTimersByTime(3_000);
    vi.setSystemTime(T0 + 3_000 + 40_000);
    vi.advanceTimersByTime(3_000);
    const longGap = secondsOf(stall()[0]);
    expect(longGap).toBeGreaterThan(shortGap);
    off(); off2();
  });

  /**
   * 阈值的两头各取一次。注意假时钟的算法：`advanceTimersByTime` 只拨定时器、不拨 `Date`，
   * 所以采样到的间隔 = 这一拍 `Date.now()` − 上一拍 `Date.now()`，与我在这两条里"多拨了几秒"无关。
   * 7.5 秒落在现行阈值（6 秒）之外、又落在"阈值挪大到 9 秒"之下——两头都钉住才有牙。
   */
  it("停摆 7.5 秒要报（阈值 6 秒；把它挪到 9 秒就漏报，这一条当场红）", () => {
    const off = installProbes((l) => lines.push(l));
    vi.advanceTimersByTime(3_000); // 正常一拍
    vi.setSystemTime(T0 + 7_500);
    vi.advanceTimersByTime(3_000);
    expect(stall().length, `7.5 秒没报停摆（阈值被挪大了）：${lines.join(" | ")}`).toBe(1);
    expect(secondsOf(stall()[0]), stall()[0]).toBeCloseTo(7.5, 1);
    off();
  });

  it("慢到 4.5 秒还不算停摆（阈值往前挪到 3 秒就会多报，这一条当场红）", () => {
    const off = installProbes((l) => lines.push(l));
    vi.advanceTimersByTime(3_000);
    vi.setSystemTime(T0 + 4_500);
    vi.advanceTimersByTime(3_000);
    expect(stall(), `4.5 秒就报停摆太手松：${lines.join(" | ")}`).toHaveLength(0);
    off();
  });

  it("每拍都按时到就不许多出停摆行（保护格：只有红过一次的停摆行才算有牙）", () => {
    const off = installProbes((l) => lines.push(l));
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(3_000);
      vi.setSystemTime(T0 + (i + 1) * 3_000);
    }
    expect(stall(), lines.join(" | ")).toHaveLength(0);
    expect(lines.filter((l) => l.includes("朗读现场")).length).toBeGreaterThan(0);
    off();
  });

  it("停摆那一行要排在恢复后的第一枚现场行之前（顺序反了就对不上时间轴）", () => {
    const off = installProbes((l) => lines.push(l));
    vi.advanceTimersByTime(3_000);
    vi.setSystemTime(T0 + 30_000);
    vi.advanceTimersByTime(3_000);
    const i = lines.findIndex((l) => l.includes("停摆"));
    const j = lines.findIndex((l, k) => k > i && l.includes("朗读现场"));
    expect(i, lines.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(j, "停摆行后面没有现场行：这一行没能把断档两头接起来").toBeGreaterThan(i);
    off();
  });

  it("清单里熄屏那一条不许再教「数行数 / 段号往前爬」这种读法", () => {
    const item = DEVICE_CHECKLIST.find((i) => i.id === "screen-off-listening");
    expect(item?.expect).toContain("停摆");
    expect(item?.expect).toContain("时刻");
    expect(item?.expect, "停摆期间一行都不会写，数行数会把「探针没跑」读成「没在读」").not.toContain("往前爬");
  });
});
