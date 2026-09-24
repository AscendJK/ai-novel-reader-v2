/**
 * `ApiSettings` 自己那份契约（地板第 2 档第十四批）。
 *
 * 这一屏是"用户手填的数进 AI 预算"的唯一入口，历史上这片账最多（批次 L 那一整族都从这来）。
 * 子面板（RAG/TTS/存储/导出/ProviderSelect）与 `syncClient` 全换成"只记挂载次数"的桩，
 * 两个 store 用**真**的（`addProvider` 按 id 覆盖、`setOfflineMode` 落 localStorage，
 * 这两件事都必须真跑才判得出来），`token-manager` 也用真的——placeholder 那条要的就是
 * "界面说的数和表里的数是同一个"。
 *
 * 判的十格，每格都对应一种"坏了不报错、只是悄悄不对"：
 * 1) `newId()` 不许撞号：`api-store.ts:63-66` 的 `addProvider` 是"同 id 就覆盖"，所以两次
 *    添加如果给出同一个 id，症状是**第一份配置无声消失**。
 * 2) 「编辑 API」/「添加 API」按 id 在不在列表里分，不按名字、不按是不是当前。
 * 3) 保存门槛用 `trim()` 判空——只填几个空格时按钮必须是死的。
 * 4) 卡片里那两枚图标按钮不许顺手把那条切成"当前"（`:120` 的 stopPropagation）。
 * 5) 删除要过 `window.confirm`，取消时一发都不发。
 * 6) 「当前使用的 API」那张卡按**带 key 的配置数**出现（`:80`）——按配置数的话，一条没 key 的
 *    配置会让卡片出现而里面那只下拉是空的。
 * 7) 「流式响应」的默认勾着必须与发送侧同源（`openai.ts:20`/`anthropic.ts:16` 都是
 *    `config.stream !== false`）：写成 `=== true` 就是界面显示"没开"而请求里一直在开。
 * 8) 两个预算输入的 placeholder 与说明里那个括号数，跟着 `getMatchedModelInfo` 走。
 * 9) 离线模式：`resetAutoOffline()` 必须**先于**翻档调用（顺序反了自动检测会立刻把它拨回去），
 *    且"开"要过 confirm、"关"不过。
 * 10) 四块子面板各挂一次——摘掉任何一块，症状是"这一屏少了整功能"。
 *
 * **刻意不判的三格**（都实测过"没有后果"，写了就是装饰性判据）：
 * ① 两个 number 输入留空时存 `undefined` 而不是 `NaN` 会不会算坏预算——`getTokenBudget`
 *    两侧都有 `&& > 0` 的钳制（`token-manager.ts`），NaN 进不去。所以这里只判"清空之后落库
 *    那份是未填"（有一格判据），不把它夸大成"否则请求会炸"。
 * ② 「关闭思考」那格的三态（`false` ↔ `undefined`）——发送侧只认 `thinking === false`
 *    （`openai.ts:71`），`true` 与 `undefined` 完全等价，塌成两态没有用户可见差别。
 * ③ `min`/`step` 这两个原生属性——这一屏没有 `<form>` 提交路径，浏览器校验根本不参与，
 *    它们是装饰（真要拦"填了 512 以下"得写在产品代码里）。
 * 另有一处**读到的缺陷没在这里判**（要改产品代码，已单独报给制作人）：`handleSave` 存的是
 * 未 trim 的原值，粘贴进来的 key 若含换行会撞 `Headers.set` 的非法值 TypeError。
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const m = vi.hoisted(() => ({
  panes: { rag: 0, tts: 0, storage: 0, export: 0, provider: 0 },
  resetCalls: 0,
  offlineAtReset: null as boolean | null,
  readOffline: null as null | (() => boolean),
}));

vi.mock("../RAGSettings", () => ({
  RAGSettings: () => { m.panes.rag++; return null; },
}));
vi.mock("../TTSSettings", () => ({
  TTSSettings: () => { m.panes.tts++; return null; },
}));
vi.mock("../StorageManager", () => ({
  StorageManager: () => { m.panes.storage++; return null; },
}));
vi.mock("../ExportPanel", () => ({
  ExportPanel: () => { m.panes.export++; return null; },
}));
vi.mock("../ProviderSelect", () => ({
  ProviderSelect: () => { m.panes.provider++; return null; },
}));
vi.mock("@/sync/sync-client", () => ({
  syncClient: {
    resetAutoOffline: () => {
      m.resetCalls++;
      m.offlineAtReset = m.readOffline ? m.readOffline() : null;
    },
  },
}));

import { ApiSettings } from "../ApiSettings";
import { useAPIStore } from "@/stores/api-store";
import { useUIStore } from "@/stores/ui-store";
import { getMatchedModelInfo } from "@/api/token-manager";
import type { ProviderConfig } from "@/api/types";

function provider(over: Partial<ProviderConfig> & { id: string }): ProviderConfig {
  return { format: "openai", name: "", apiKey: "", baseUrl: "", model: "", ...over };
}

const state = () => useAPIStore.getState();

/** 卡片里那两枚图标按钮没有可访问名（已单独报给制作人），只能按图标类名定位。 */
function iconButtons(container: HTMLElement, which: "pen" | "trash") {
  const cls = which === "pen" ? "lucide-pen" : "lucide-trash-2";
  return Array.from(container.querySelectorAll(`button svg.${cls}`))
    .map((svg) => svg.closest("button") as HTMLButtonElement);
}

function openAddForm() {
  fireEvent.click(screen.getByRole("button", { name: "添加 API" }));
}

function fillKey(value: string) {
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value } });
}

beforeEach(() => {
  m.panes = { rag: 0, tts: 0, storage: 0, export: 0, provider: 0 };
  m.resetCalls = 0;
  m.offlineAtReset = null;
  m.readOffline = () => useUIStore.getState().offlineMode;
  useAPIStore.setState({ providers: [], activeProviderId: null, loaded: true });
  useUIStore.setState({ offlineMode: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("添加与编辑的身份", () => {
  it("连点两次「添加 API」各存一条：撞号就等于静默吃掉第一份配置", () => {
    // 冻住时钟：不冻的话两次点击跨了不同毫秒，`Date.now()` 自己就把 id 分开了，
    // 这条量的是机器耗时而不是"随机段在不在"（第一版就是这么逃掉那一刀的）
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    render(<ApiSettings />);
    openAddForm();
    fillKey("sk-第一个");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    openAddForm();
    fillKey("sk-第二个");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const ids = state().providers.map((p) => p.id);
    expect(state().providers).toHaveLength(2);
    expect(new Set(ids).size, "两次 newId() 不许给出同一个 id").toBe(2);
  });

  it("标题按「这条在不在列表里」分编辑/添加——没名字的老配置也得写「编辑 API」", () => {
    useAPIStore.setState({
      providers: [provider({ id: "p1", name: "", apiKey: "" })],
      activeProviderId: null,
      loaded: true,
    });
    const { container } = render(<ApiSettings />);
    fireEvent.click(iconButtons(container, "pen")[0]);
    expect(screen.getByRole("heading", { name: "编辑 API" })).toBeInTheDocument();

    openAddForm();
    expect(screen.getByRole("heading", { name: "添加 API" })).toBeInTheDocument();
  });

  it("没给 onBack 就不许出现返回条；给了就点得动", () => {
    const { unmount } = render(<ApiSettings />);
    expect(screen.queryByRole("button", { name: "返回" })).toBeNull();
    unmount();

    const onBack = vi.fn();
    render(<ApiSettings onBack={onBack} />);
    const back = screen.getByRole("button", { name: "返回" });
    // 返回条必须钉在顶上：它摘掉 sticky 的话，长页面里滚到离线模式就回不去了
    expect(String(back.closest("div")?.className)).toContain("sticky");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("保存的门槛与出口", () => {
  it("key 只填空格时保存按钮是死的（门槛按 trim 后判空）", () => {
    render(<ApiSettings />);
    openAddForm();
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    fillKey("   ");
    expect(save, "几个空格不算配了 key").toBeDisabled();
    fillKey("sk-真key");
    expect(save).toBeEnabled();
  });

  it("保存之后表单要关掉；点取消则一条都不落库", () => {
    render(<ApiSettings />);
    openAddForm();
    fillKey("sk-甲");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(state().providers).toHaveLength(1);

    openAddForm();
    fillKey("sk-乙");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(state().providers).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });
});

describe("列表卡片：点哪儿算哪儿", () => {
  it("点卡片里的编辑/删除不许顺手把那条切成「当前」", () => {
    useAPIStore.setState({
      providers: [
        provider({ id: "p1", name: "甲", apiKey: "sk-1" }),
        provider({ id: "p2", name: "乙", apiKey: "sk-2" }),
      ],
      activeProviderId: "p1",
      loaded: true,
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = render(<ApiSettings />);

    fireEvent.click(iconButtons(container, "trash")[1]);
    expect(state().activeProviderId, "删除按钮的点击不许冒泡到卡片").toBe("p1");
    expect(state().providers, "confirm 回 false 时一条都不许少").toHaveLength(2);

    fireEvent.click(iconButtons(container, "pen")[1]);
    expect(state().activeProviderId).toBe("p1");
    expect(screen.getByLabelText("API Key")).toHaveValue("sk-2");
  });

  it("confirm 回 true 时删的正是那一条，另一条留着", () => {
    useAPIStore.setState({
      providers: [
        provider({ id: "p1", name: "甲", apiKey: "sk-1" }),
        provider({ id: "p2", name: "乙", apiKey: "sk-2" }),
      ],
      activeProviderId: "p1",
      loaded: true,
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = render(<ApiSettings />);
    fireEvent.click(iconButtons(container, "trash")[0]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(state().providers.map((p) => p.id)).toEqual(["p2"]);
  });

  it("卡片上的第二行：配了 key 说「模型 · 地址」，没配就说「未配置」", () => {
    useAPIStore.setState({
      providers: [
        provider({ id: "p1", name: "甲", apiKey: "sk-1", model: "deepseek-chat", baseUrl: "https://x/v1" }),
        provider({ id: "p2", name: "乙", apiKey: "", model: "gpt-4o" }),
      ],
      activeProviderId: null,
      loaded: true,
    });
    render(<ApiSettings />);
    expect(screen.getByText("deepseek-chat · https://x/v1")).toBeInTheDocument();
    expect(screen.getByText("未配置")).toBeInTheDocument();
  });
});

describe("「当前使用的 API」那张卡的出口", () => {
  it("只有一条没 key 的配置时不许出现那张卡（里面那只下拉本来就是空的）", () => {
    useAPIStore.setState({
      providers: [provider({ id: "p1", name: "甲", apiKey: "" })],
      activeProviderId: null,
      loaded: true,
    });
    render(<ApiSettings />);
    expect(screen.queryByText("当前使用的 API")).toBeNull();
    expect(m.panes.provider).toBe(0);
  });

  it("有一条带 key 的配置时那张卡要出现（切换靠 ProviderSelect，不在这里重复）", () => {
    useAPIStore.setState({
      providers: [provider({ id: "p1", name: "甲", apiKey: "sk-1" })],
      activeProviderId: "p1",
      loaded: true,
    });
    render(<ApiSettings />);
    expect(screen.getByText("当前使用的 API")).toBeInTheDocument();
    expect(m.panes.provider).toBe(1);
  });
});

describe("表单默认值与提示要跟着真表走", () => {
  it("新建时「流式响应」是勾着的，取消勾选存的是 false", () => {
    render(<ApiSettings />);
    openAddForm();
    const stream = screen.getByLabelText("流式响应") as HTMLInputElement;
    // 发送侧是 `config.stream !== false`（openai.ts:20 / anthropic.ts:16），
    // 所以"没填"就等于开——界面显示成没勾，就是在骗用户
    expect(stream.checked, "默认值必须与发送侧同一个口径").toBe(true);

    fireEvent.click(stream);
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(state().providers[0].stream).toBe(false);
  });

  it("匹配到模型时：两个 placeholder 与两行说明里的数都来自表", () => {
    const info = getMatchedModelInfo("gemini-pro");
    expect(info, "前提：gemini-pro 在表里，且它的两个数都不等于兜底值").toBeTruthy();
    expect(info!.budget.contextWindow).not.toBe(128000);
    expect(info!.budget.maxOutputTokens).not.toBe(4096);

    render(<ApiSettings />);
    openAddForm();
    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "gemini-pro" } });

    expect(screen.getByLabelText("上下文窗口（可选）")).toHaveAttribute(
      "placeholder", String(info!.budget.contextWindow));
    expect(screen.getByLabelText("最大输出 token（可选）")).toHaveAttribute(
      "placeholder", String(info!.budget.maxOutputTokens));
    expect(screen.getByText(/✅ 匹配到 gemini-pro/)).toBeInTheDocument();
    expect(screen.getByText(/模型的最大输入 token 数/).textContent).toContain(
      info!.budget.contextWindow.toLocaleString());
    expect(screen.getByText(/模型单次调用的最大输出/).textContent).toContain(
      info!.budget.maxOutputTokens.toLocaleString());
  });

  it("没匹配到模型时：placeholder 与括号数一起落到兜底值，且黄字要说明", () => {
    render(<ApiSettings />);
    openAddForm();
    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "不存在的模型xyz" } });

    expect(screen.getByLabelText("上下文窗口（可选）")).toHaveAttribute("placeholder", "128000");
    expect(screen.getByLabelText("最大输出 token（可选）")).toHaveAttribute("placeholder", "4096");
    expect(screen.getByText(/⚠️ 未匹配到已知模型/)).toBeInTheDocument();
    expect(screen.getByText(/模型的最大输入 token 数/).textContent).toContain("128,000");
    expect(screen.getByText(/模型单次调用的最大输出/).textContent).toContain("4,096");
  });

  it("填过的预算值不许被 placeholder 顶掉，清空则回到未填", () => {
    render(<ApiSettings />);
    openAddForm();
    const ctx = screen.getByLabelText("上下文窗口（可选）");
    fireEvent.change(ctx, { target: { value: "200000" } });
    expect(ctx).toHaveValue(200000);
    fireEvent.change(ctx, { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(state().providers[0].contextWindow).toBeUndefined();
  });
});

describe("离线模式那一格", () => {
  it("关→开要过 confirm；取消时既不翻档也不动自动检测", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ApiSettings />);
    fireEvent.click(screen.getByRole("button", { name: "开启离线模式" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().offlineMode).toBe(false);
    expect(m.resetCalls, "没确认就不许把自动检测清掉").toBe(0);
  });

  it("确认之后 resetAutoOffline 恰好一次，且发生在翻档之前", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ApiSettings />);
    fireEvent.click(screen.getByRole("button", { name: "开启离线模式" }));
    expect(m.resetCalls).toBe(1);
    // 顺序反了的后果：先翻成离线、再清自动检测，检测那条路会立刻把它拨回去
    expect(m.offlineAtReset, "清理自动检测时，界面还得停在未翻档的那一侧").toBe(false);
    expect(useUIStore.getState().offlineMode).toBe(true);
  });

  it("开→关不弹 confirm（关掉离线不该再拦一道）", () => {
    useUIStore.setState({ offlineMode: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ApiSettings />);
    fireEvent.click(screen.getByRole("button", { name: "关闭离线模式" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(useUIStore.getState().offlineMode).toBe(false);
  });
});

describe("这一屏的整块出口", () => {
  it("RAG / TTS / 存储 / 导出四块各挂一次", () => {
    render(<ApiSettings />);
    expect(m.panes).toEqual({ rag: 1, tts: 1, storage: 1, export: 1, provider: 0 });
  });
});
