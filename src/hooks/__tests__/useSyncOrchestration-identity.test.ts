// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * `useSyncOrchestration` 的身份链（覆盖地板第 2 档：这只 656 行的 hook 之前一行
 * hook 层判据都没有，而里面躺着四条"注释记着丢过什么东西"的语义）。
 *
 * 为什么值得单独钉：这四条错的形状都不是"报错"，是**静默**——
 * - 踢下线多清一个键 → 重登变成新设备，服务器 knownDevices 留残留；
 * - 删除当前用户时"是否当前用户"在 logout 之后才判断 → 清理分支永久失活；
 * - 换用户不重读 API 配置 → 设置页显示"暂无配置"而数据其实还在库里；
 * - 服务器明确拒绝时不回滚身份 → 落进没有 novels 的幻影库（round 2 R-14）。
 *
 * 网络与 IndexedDB 全部桩掉（这里判的是"哪几个键、哪几个 store、什么顺序"，
 * 真库帮不上忙）；四个 zustand store 用真的——要判的就是它们的内容。
 */

const syncClient = vi.hoisted(() => ({
  user: "",
  login: vi.fn(),
  // 忠实桩：真 logout 会清掉 sync-username。不清的话"wasCurrentUser 要在 logout 之前
  // 拍快照"那一刀变异根本演不出来（handleDeleteUser 的判断依据就永远是对的）
  logout: vi.fn(() => { localStorage.removeItem("sync-username"); }),
  syncOnce: vi.fn(async () => undefined),
  pushNow: vi.fn(async () => undefined),
  start: vi.fn(),
  setTimerSyncGate: vi.fn(),
  checkUserOnline: vi.fn(async () => null),
  resetAutoOffline: vi.fn(),
  markServerUnreachable: vi.fn(),
  setUsername: vi.fn(),
}));
vi.mock("@/sync/sync-client", () => ({ syncClient }));

const setCurrentUser = vi.hoisted(() => vi.fn());
const deleteUserDB = vi.hoisted(() => vi.fn(async () => undefined));
/** novels.count() 恒为 0：避开"本地有数据，保留还是清除？"那次 confirm，让流程可预测 */
const getUserDB = vi.hoisted(() => vi.fn(() => ({ novels: { count: async () => 0 } })));
vi.mock("@/db/database", () => ({ getUserDB, setCurrentUser, deleteUserDB }));

const apiFetch = vi.hoisted(() => vi.fn(async () => ({ ok: false, status: 599, json: async () => [] })));
const getEffectiveServerUrl = vi.hoisted(() => vi.fn(() => ""));
vi.mock("@/lib/api-client", () => ({ apiFetch, getEffectiveServerUrl }));

const deleteUserData = vi.hoisted(() => vi.fn(async () => undefined));
const addLocalUser = vi.hoisted(() => vi.fn());
const removeLocalUser = vi.hoisted(() => vi.fn());
const getLocalUsers = vi.hoisted(() => vi.fn(() => [] as string[]));
vi.mock("@/db/repositories", () => ({
  loadAllNovels: vi.fn(async () => []),
  loadSummaries: vi.fn(async () => []),
  cleanupDeletedRecords: vi.fn(async () => undefined),
  loadNovel: vi.fn(async () => null),
  deleteUserData, addLocalUser, removeLocalUser, getLocalUsers,
  renameUserScopedSettings: vi.fn(async () => 0),
}));

const loadFromDB = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/stores/api-store", () => ({
  useAPIStore: Object.assign((s: (x: { loadFromDB: typeof loadFromDB }) => unknown) => s({ loadFromDB }), {
    getState: () => ({ loadFromDB }),
  }),
}));

const cancelAllAiTasks = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai-task-queue", () => ({ cancelAllAiTasks }));
vi.mock("@/lib/ai-state", () => ({ getAiRunning: () => false }));

const broadcastSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/broadcast", () => ({ broadcast: { send: broadcastSend, on: vi.fn(), close: vi.fn() } }));

vi.mock("@/sync/sync-bridge", () => ({ gatherChanges: vi.fn(), applyServerData: vi.fn(async () => undefined) }));
vi.mock("@/sync/pending-leave", () => ({ flushPendingLeaves: vi.fn(async () => undefined) }));
vi.mock("@/sync/novel-reconciliation", () => ({
  shouldDownloadNovel: vi.fn(() => false),
  shouldDeleteLocalNovel: vi.fn(() => false),
  rekeyNovelOwnedRows: vi.fn(async () => undefined),
}));
vi.mock("@/rag/model-loader", () => ({ downloadModel: vi.fn(async () => undefined) }));
vi.mock("@/lib/toast-store", () => ({ showToast: vi.fn() }));

import { useSyncOrchestration } from "@/hooks/useSyncOrchestration";
import { useNovelStore } from "@/stores/novel-store";
import { useSummaryStore } from "@/stores/summary-store";
import { useUIStore } from "@/stores/ui-store";

const USER_OLD = "orch-old";
const USER_NEW = "orch-new";

/** 把"当前用户的内存态"弄脏：旧用户的书、正在读的书、进度、摘要 */
function dirtyWithOldUser() {
  useNovelStore.setState({
    novels: [{ id: "old-book", title: "旧用户的书" } as never],
    currentNovel: { id: "old-book", title: "旧用户的书" } as never,
    readingPositions: { "old-book": { chapterId: "c1", chapterIndex: 0, scrollTop: 10, updatedAt: 5 } },
  });
  useSummaryStore.getState().setSummaries([{ id: "s1", novelId: "old-book", content: "旧用户的总结" } as never]);
}

let alerts: string[];
let reloads: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  syncClient.user = "";
  alerts = [];
  vi.stubGlobal("alert", (msg: unknown) => { alerts.push(String(msg)); });
  reloads = vi.fn();
  Object.defineProperty(window, "location", {
    value: { reload: reloads, href: "http://localhost/" }, writable: true, configurable: true,
  });
  useNovelStore.setState({ novels: [], currentNovel: null, readingPositions: {} });
  useSummaryStore.getState().setSummaries([]);
  useUIStore.getState().setOfflineMode(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function hook() {
  const onSyncReady = vi.fn();
  const setLocalUsers = vi.fn();
  const { result } = renderHook(() => useSyncOrchestration({ onSyncReady, setLocalUsers }));
  return { result, onSyncReady, setLocalUsers };
}

describe("被踢下线", () => {
  it("清掉身份与水位，但设备标识 sync-clientId 必须留着（否则重登变成新设备）", async () => {
    localStorage.setItem("sync-username", USER_OLD);
    localStorage.setItem("sync-token", "tok");
    localStorage.setItem("sync-auto-offline", "1");
    localStorage.setItem(`novel-reader-last-sync-time:${USER_OLD}`, "123");
    localStorage.setItem("sync-clientId", "device-abc");
    // 别人的水位不许被这次踢下线带走
    localStorage.setItem(`novel-reader-last-sync-time:${USER_NEW}`, "999");

    const { result } = hook();
    await act(async () => { await result.current.handleKicked(USER_OLD); });

    expect(localStorage.getItem("sync-username")).toBeNull();
    expect(localStorage.getItem("sync-token")).toBeNull();
    expect(localStorage.getItem("sync-auto-offline")).toBeNull();
    expect(localStorage.getItem(`novel-reader-last-sync-time:${USER_OLD}`)).toBeNull();
    expect(localStorage.getItem("sync-clientId"), "清了 clientId 等于把这台机器变成一台新机器").toBe("device-abc");
    expect(localStorage.getItem(`novel-reader-last-sync-time:${USER_NEW}`)).toBe("999");
    expect(reloads).toHaveBeenCalledTimes(1);
  });

  it("同一轮里重复回调只处理一次（reload 不许叠加）", async () => {
    const { result } = hook();
    await act(async () => {
      await result.current.handleKicked(USER_OLD);
      await result.current.handleKicked(USER_OLD);
    });
    expect(reloads).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveLength(1);
  });
});

describe("删除本地用户", () => {
  it("删的是当前登录用户：设备标识与水位一并清掉（判断依据要在 logout 之前拍快照）", async () => {
    localStorage.setItem("sync-username", USER_OLD);
    localStorage.setItem("sync-clientId", "device-abc");
    localStorage.setItem(`novel-reader-last-sync-time:${USER_OLD}`, "123");
    localStorage.setItem("sync-auto-offline", "1");
    syncClient.user = USER_OLD;

    const { result } = hook();
    await act(async () => { await result.current.handleDeleteUser(USER_OLD); });

    expect(deleteUserData).toHaveBeenCalledWith(USER_OLD);
    expect(localStorage.getItem("sync-clientId")).toBeNull();
    expect(localStorage.getItem(`novel-reader-last-sync-time:${USER_OLD}`)).toBeNull();
    expect(localStorage.getItem("sync-auto-offline")).toBeNull();
  });

  it("删的是别人：当前用户的三个键一个都不许动", async () => {
    localStorage.setItem("sync-username", USER_OLD);
    localStorage.setItem("sync-clientId", "device-abc");
    localStorage.setItem("sync-auto-offline", "1");
    syncClient.user = USER_OLD;

    const { result } = hook();
    await act(async () => { await result.current.handleDeleteUser(USER_NEW); });

    expect(deleteUserData).toHaveBeenCalledWith(USER_NEW);
    expect(localStorage.getItem("sync-clientId"), "删别人不该把这台机器的设备标识也带走").toBe("device-abc");
    expect(localStorage.getItem("sync-auto-offline")).toBe("1");
  });
});

describe("登录换用户", () => {
  it("旧用户留在内存里的书/进度/摘要必须清空，且本标签页要重读 API 配置", async () => {
    localStorage.setItem("sync-username", USER_OLD);
    dirtyWithOldUser();
    syncClient.login.mockResolvedValue({ success: true });

    const { result } = hook();
    await act(async () => { await result.current.handleLogin(USER_NEW); });

    const s = useNovelStore.getState();
    expect(s.novels).toEqual([]);
    expect(s.currentNovel).toBeNull();
    expect(s.readingPositions).toEqual({});
    expect(useSummaryStore.getState().summaries).toEqual([]);
    // 这条就是"退出→换名登录→再登回来，设置页显示暂无 API 配置"那处修法的落点
    expect(loadFromDB).toHaveBeenCalled();
    expect(broadcastSend).toHaveBeenCalledWith("user-switched", USER_NEW);
    expect(setCurrentUser).toHaveBeenCalledWith(USER_NEW);
  });

  it("在飞的 AI 任务要在换绑定之前作废（否则下一位用户看见不属于他的结果）", async () => {
    localStorage.setItem("sync-username", USER_OLD);
    syncClient.login.mockResolvedValue({ success: true });

    const { result } = hook();
    await act(async () => { await result.current.handleLogin(USER_NEW); });

    expect(cancelAllAiTasks.mock.invocationCallOrder[0])
      .toBeLessThan(setCurrentUser.mock.invocationCallOrder[0]);
  });

  it("登录成功后要读回这个用户自己的阅读进度（离线重登不回第一章）", async () => {
    localStorage.setItem("sync-username", USER_OLD);
    localStorage.setItem(`novel-reader-positions:${USER_NEW}`, JSON.stringify({
      "new-book": { chapterId: "c7", chapterIndex: 6, scrollTop: 40, updatedAt: 9 },
    }));
    syncClient.login.mockResolvedValue({ success: true });

    const { result } = hook();
    await act(async () => { await result.current.handleLogin(USER_NEW); });

    expect(useNovelStore.getState().readingPositions["new-book"]?.chapterId).toBe("c7");
  });
});

describe("登录失败的两种待遇", () => {
  it("服务器明确拒绝（404/409）且之前有身份：整体回滚到旧名字，并把原因说给用户听", async () => {
    localStorage.setItem("sync-username", USER_OLD);
    dirtyWithOldUser();
    syncClient.login.mockResolvedValue({ success: false, error: "用户不存在" });

    const { result } = hook();
    await act(async () => { await result.current.handleLogin(USER_NEW); });

    expect(localStorage.getItem("sync-username"), "停在被拒的名字上=落进幻影库").toBe(USER_OLD);
    expect(setCurrentUser).toHaveBeenLastCalledWith(USER_OLD);
    expect(broadcastSend).toHaveBeenLastCalledWith("user-switched", USER_OLD);
    expect(alerts.some((a) => a.includes("用户不存在"))).toBe(true);
    expect(result.current.loginError, "这条路径上登录界面已经撤了（下面立刻 onSyncReady），"
      + "红字递不到用户眼前，所以这一格仍走弹窗——把它改成红字＝用户什么都不知道").toBeNull();
    expect(useNovelStore.getState().novels).toEqual([]);
  });

  it("之前没有登录身份：人被留在登录界面，原因要交给界面那根红字，不再弹窗", async () => {
    // 真后端实测过的形状：租户名 43 字符 → 服务端只收 2-30 → 400 {error:"用户名需 2-30 个字符"}。
    // 旧写法这里只有 window.alert，而 AppLayout.tsx:42 那句现成的红字永远渲染不出来。
    syncClient.login.mockResolvedValue({ success: false, error: "用户名需 2-30 个字符" });

    const { result } = hook();
    await act(async () => { await result.current.handleLogin(USER_NEW); });

    expect(localStorage.getItem("sync-username"), "回到未登录态，人还在登录界面").toBeNull();
    expect(result.current.loginError, "界面上那句红字读的就是这个值").toBe("用户名需 2-30 个字符");
    expect(alerts, "人就在现场，弹窗只会挡住输入框与提交按钮").toHaveLength(0);
  });

  it("重试成功之后要把上一次的原因收回去（挂着旧话＝告诉用户还在失败）", async () => {
    syncClient.login.mockResolvedValueOnce({ success: false, error: "用户名需 2-30 个字符" });
    const { result } = hook();
    await act(async () => { await result.current.handleLogin(USER_NEW); });
    expect(result.current.loginError).toBe("用户名需 2-30 个字符");

    syncClient.login.mockResolvedValue({ success: true });
    await act(async () => { await result.current.handleLogin(USER_NEW); });

    expect(result.current.loginError, "这一发已经登进去了，红字不许还留着上一次的原因").toBeNull();
    expect(alerts).toHaveLength(0);
  });

  it("网络错误（没有 error）：保留名字按离线登录，不许当成被拒回滚", async () => {
    localStorage.setItem("sync-username", USER_OLD);
    syncClient.login.mockRejectedValue(new Error("fetch failed"));

    const { result } = hook();
    await act(async () => { await result.current.handleLogin(USER_NEW); });

    expect(localStorage.getItem("sync-username"), "外网抖一下就把用户踢回旧名字，是拿错当失败").toBe(USER_NEW);
    expect(setCurrentUser).toHaveBeenLastCalledWith(USER_NEW);
    expect(alerts).toHaveLength(0);
    expect(result.current.loginError, "离线登录按设计是成功的，红字写出来就是假失败").toBeNull();
  });

  it("不管走哪条退出路径，登录门控都要解除（残留=定时器永久停摆）", async () => {
    syncClient.login.mockResolvedValue({ success: false, error: "用户不存在" });
    const { result } = hook();
    await act(async () => { await result.current.handleLogin(USER_NEW); });

    const calls = syncClient.setTimerSyncGate.mock.calls.map((c) => c[0]);
    expect(calls[0], "prepareSync 先关闸").toBe(true);
    expect(calls[calls.length - 1], "最后一步必须是放开").toBe(false);
  });
});

/**
 * 变异台账：登录失败的原因搬到界面上（2026-09-27 深夜，六刀逐条实跑）
 *
 * 判据先立红的读数：三处新增/加强之前是 6 红 23 绿（`useSyncOrchestration-identity` 4 红、
 * `AppLayout-shell` 2 红）。新增的 `UsernameLogin-error.test.tsx` 两条一上来就是绿的——
 * 那行红字本来就在产品里，死的是上游，上游已经用 L1~L5 立过红了，这里不假称"立红"。
 *
 * 三份基线快照都在台架目录（还原一律 `cp` 快照，不许 `git restore`——同一批文件里带着未提交的
 * 改动）：`useSyncOrchestration.ts` sha `7f16fd2c`、`AppLayout.tsx` sha `c5f175a9`、
 * `UsernameLogin.tsx` sha `cc62e069`。每刀跑完都是 markers=0、sha 回到上面那个值。
 *
 * - L1 摘掉 `handleLogin` 入口的 `setLoginError(null)` → 红 1：重试收回那条。
 * - L2 被拒分支回到旧写法（只 `window.alert`，不递红字）→ 红 2：无身份那条 + 重试收回那条。
 * - L3 回滚分支也写红字（＝两条退出路径都当红字能用）→ 红 1：只有"之前有身份"那条，
 *   它判的是 `loginError` 必须为 null——登录界面下一行就被 `onSyncReady()` 撤了，递过去没人看见。
 * - L4 外壳写死 `error={null}`（回到那次死通道）→ 红 2：`AppLayout-shell` 的"收到同一句"+"收回去"。
 * - L5 外壳自己造句 `error={loginError ?? "登录失败"}` → 红 2："收回去" + "不许凭空递一句话"；
 *   "收到同一句"照样绿，因为原因非空时 `??` 不生效——这一刀证明第三条判据盯的是那句空话。
 * - L6 `UsernameLogin.tsx` 那行 `{error && …}` 摘掉渲染 → 红 1：`UsernameLogin-error` 第一条。
 *
 * 没有一刀 0 红。三段链路（hook 报原因 / 外壳递 prop / 组件画出来）各有自己的哨兵。
 */
