/**
 * `ApiSettings` 自己那份契约（地板第 2 档第十四批）。
 *
 * 这一屏是"用户手填的数进 AI 预算"的唯一入口，历史上这片账最多（批次 L 那一整族都从这来）。
 * 子面板（RAG/TTS/存储/导出/ProviderSelect）与 `syncClient` 全换成"只记挂载次数"的桩，
 * 两个 store 用**真**的（`addProvider` 按 id 覆盖、`setOfflineMode` 落 localStorage，
 * 这两件事都必须真跑才判得出来），`token-manager` 也用真的——placeholder 那条要的就是
 * "界面说的数和表里的数是同一个"。
 *
 * 判的十一格，每格都对应一种"坏了不报错、只是悄悄不对"：
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
 * 8) 只有**窗口**那一格的 placeholder 与说明里的括号数跟着 `getMatchedModelInfo` 走；
 *    输出那一格与表无关（表里的"输出上限"那一列已删），换模型名不许它改一个字。
 * 9) 离线模式：`resetAutoOffline()` 必须**先于**翻档调用（顺序反了自动检测会立刻把它拨回去），
 *    且"开"要过 confirm、"关"不过。
 * 10) 四块子面板各挂一次——摘掉任何一块，症状是"这一屏少了整功能"。
 * 11) 保存落库的四串必须 trim 过（门槛按 trim 判空、存原值是两回事），并且**后果单独钉一条**：
 *     存进去的地址拼出来的请求 URL 不许带 %20、存进去的模型名还得匹配得上预算表。
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
 * 未 trim 的原值。——**这条已经修完并有判据了**（第 11 格），顺手更正一处旧账：原先记的理由是
 * "粘贴带 \r\n 的 key 会撞 `Headers.set` 的非法值 TypeError"，**那个形状在本屏不可达**——
 * 单行 `<input>` 按规范会剥掉所有 ASCII 换行（jsdom `HTMLInputElement-impl` 走
 * `sanitizeValueByType` → `stripNewlines`，浏览器同规则，实测这条前提断言直接红给我看过）。
 * 真可达的是另外两种：地址的尾随空格进 URL 编成 `%20`（服务商 404）、模型名带首尾空格匹配不上
 * 预算表（`getMatchedModelInfo` 只做精确 + startsWith，窗口静默落兜底 128,000，只有黄字提示；
 * 输出那一格现在与表无关，未匹配不再有"默认小上限"这回事）。
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

/**
 * 卡片里那两枚图标按钮**按可访问名**认，而且名里必须带配置名（`aria-label="编辑 甲"`）。
 * 两代坑都在这行上：以前按 `svg.lucide-pen`、`svg.lucide-trash-2` 类名定位，等于把"读屏念不出
 * 这枚按钮"写进判据；只写 `编辑` 又漏掉真正会出事的那一半——屏上几张卡片长得几乎一样
 * （差一个「当前」徽章），读屏报"编辑按钮"人不知道按下去改的是哪一条。
 */
function iconButtons(which: "编辑" | "删除", name: string): HTMLButtonElement[] {
  return screen.getAllByRole("button", { name: `${which} ${name}` });
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
    render(<ApiSettings />);
    fireEvent.click(iconButtons("编辑", "未命名")[0]);
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

/** 填进表单、保存，返回落库那一条。四串都带首尾空白——正是要判的东西。 */
function saveMessyProvider() {
  render(<ApiSettings />);
  openAddForm();
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "  甲配置  " } });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: " sk-a " } });
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://x/v1 " } });
  fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: " deepseek-chat " } });
  // 前提：首尾空白真留在控件里。**换行留不住**——单行 input 按规范剥掉所有 ASCII 换行
  // （jsdom `sanitizeValueByType` → `stripNewlines`，浏览器同规则），所以"粘贴带 \r\n 的 key
  // 撞 `Headers.set` 非法值"这个形状在本屏**不可达**，别拿它当这两条判据的理由。
  expect(screen.getByLabelText("Base URL")).toHaveValue("https://x/v1 ");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  return state().providers[0];
}

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

  it("存进库的四串都 trim 过——门槛按 trim 判空、存原值是两回事", () => {
    const saved = saveMessyProvider();
    expect(saved, "粘贴带进来的首尾空白不许进库").toMatchObject({
      name: "甲配置",
      apiKey: "sk-a",
      baseUrl: "https://x/v1",
      model: "deepseek-chat",
    });
  });

  /**
   * 后果单独一条：不只看"存进去的字符串长什么样"，还看**那两个数会被谁拿去用**。
   * 两半合成一次 `toEqual`——分开写的话先红的那条会把后面那条吃掉（同一条测试里的顺序坑）。
   */
  it("带空格的原值进了库会怎么坏：地址编成 %20、模型名对不上预算表", () => {
    const saved = saveMessyProvider();
    expect({
      // 尾随空格进 URL 被 WHATWG 编成 %20 → 服务商 404
      href: new URL(`${saved.baseUrl}/chat/completions`).href,
      // 模型名只做精确 + startsWith、不 trim → 匹配不上就静默落兜底窗口 128,000（只有黄字提示）
      matchedKey: getMatchedModelInfo(saved.model)?.matchedKey ?? null,
    }).toEqual({ href: "https://x/v1/chat/completions", matchedKey: "deepseek-chat" });
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
    render(<ApiSettings />);

    fireEvent.click(iconButtons("删除", "乙")[0]);
    expect(state().activeProviderId, "删除按钮的点击不许冒泡到卡片").toBe("p1");
    expect(state().providers, "confirm 回 false 时一条都不许少").toHaveLength(2);
    // 「删除」按下去只能弹确认框，不许顺手把编辑表单打开——这条也是把两枚标签串位时的现场
    expect(screen.queryByLabelText("API Key"), "点删除不该出现编辑表单").toBeNull();

    fireEvent.click(iconButtons("编辑", "乙")[0]);
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
    render(<ApiSettings />);
    fireEvent.click(iconButtons("删除", "甲")[0]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(state().providers.map((p) => p.id)).toEqual(["p2"]);
  });

  it("两枚按钮念得出「编辑 甲」——屏上几张卡片长得几乎一样，只念「编辑」会按错一条", () => {
    useAPIStore.setState({
      providers: [
        provider({ id: "p1", name: "甲", apiKey: "sk-1" }),
        provider({ id: "p2", name: "", apiKey: "" }),
      ],
      activeProviderId: "p1",
      loaded: true,
    });
    render(<ApiSettings />);
    // 名字从**卡片上写着的那句**取，不写死——这样"aria-label 与屏上名字不同源"也判得出来
    // （「未命名」那一档尤其要紧：兜底文案改了而 aria-label 没跟着改，读屏和眼睛就是两套名字）
    for (const shown of ["甲", "未命名"]) {
      const title = screen.getByText(shown);
      for (const which of ["编辑", "删除"] as const) {
        expect(screen.getAllByRole("button", { name: `${which} ${title.textContent}` }),
          `可访问名该是「${which} + 屏上那句名字」`).toHaveLength(1);
      }
    }
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

  it("匹配到模型时：只有窗口那一格跟表走", () => {
    const info = getMatchedModelInfo("gemini-pro");
    expect(info, "前提：gemini-pro 在表里，且它的窗口不等于兜底值").toBeTruthy();
    expect(info!.budget.contextWindow).not.toBe(128000);

    render(<ApiSettings />);
    openAddForm();
    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "gemini-pro" } });

    expect(screen.getByLabelText("上下文窗口（可选）")).toHaveAttribute(
      "placeholder", String(info!.budget.contextWindow));
    expect(screen.getByText(/✅ 匹配到 gemini-pro/)).toBeInTheDocument();
    expect(screen.getByText(/模型的最大输入 token 数/).textContent).toContain(
      info!.budget.contextWindow.toLocaleString());
  });

  it("输出那一格与表无关：换个模型名，placeholder 与说明逐字不变（表里那一列已删）", () => {
    render(<ApiSettings />);
    openAddForm();
    const output = screen.getByLabelText("最大输出 token（可选）") as HTMLInputElement;
    const helpText = () => screen.getByText(/模型单次调用的最大输出/).textContent;
    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "gemini-pro" } });
    const onTable = { ph: output.placeholder, help: helpText() };
    // 说明里给的是**任务预设**那几个数，不是按模型名猜出来的天花板
    expect(onTable.help, "要说清留空时每个任务要多少").toContain("16,384");
    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "不存在的模型xyz" } });
    expect(output.placeholder).toBe(onTable.ph);
    expect(helpText()).toBe(onTable.help);
  });

  it("没匹配到模型时：窗口落到兜底值并黄字说明，输出那一格的说法不变", () => {
    render(<ApiSettings />);
    openAddForm();
    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: "不存在的模型xyz" } });

    expect(screen.getByLabelText("上下文窗口（可选）")).toHaveAttribute("placeholder", "128000");
    expect(screen.getByText(/⚠️ 未匹配到已知模型/)).toBeInTheDocument();
    expect(screen.getByText(/模型的最大输入 token 数/).textContent).toContain("128,000");
    // 过去这里跟着掉到"默认 4,096"——那是表里猜的输出上限，删列之后未匹配不再有"默认小上限"
    expect(screen.getByLabelText("最大输出 token（可选）")).toHaveAttribute(
      "placeholder", "留空＝按任务该要多少要多少");
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

/**
 * 「默认不填，但要给用户足够和清晰的提示」——制作人 2026-09-27 晚拍的口径。
 *
 * 为什么提示值得单独判：这一屏是"用户手填的数进 AI 预算"的唯一入口，而**留空与填了是两条不同的路**
 * （留空＝按任务该要多少要多少、撞了由厂商教；填了＝一份天花板压所有任务）。说不清的症状不是报错，
 * 是用户凭一句话把 8,192 填进来、然后发现地图和图谱写一半就停，却不知道为什么。
 *
 * 四条是立红写的（现在的文案没有这几句）；两条是**保护性**的（现在就绿，写在这里是防"下次简化文案
 * 顺手把它删了"——按老规矩如实标注，不当成立红的成绩）。六条**都另下过一刀验牙**，见下面 `W1..W6`。
 *
 * **变异台账（基线 `ApiSettings.tsx` sha256 `a7f05d4fcb1b4d34…`，每刀跑完 `cp` 回基线并当场核 sha）**：
 * 命令固定为「`diff 基线 现文件 | grep -c '^<'` 取删行数 → `CI=1 npx vitest run <本文件>` → 去 ANSI 数
 * `^  ×`」。`markers` 这里读的是**被删掉的源行数**（一段说明折成两行字面量就是 2），不是一刀两刀的分。
 * - `W1` 把「建议：留空。」换回老口径「一般不用填。」（markers=1）→ **红 1**：`结论摆在前面：明写「建议：留空」`
 * - `W2` 删掉逐档那一条 bullet（markers=2，同一段）→ **红 1**：`留空那一档把每个任务要多少全列出来`
 *   （`地图` 那条与 `此消彼长` 那条没跟着红，因为它们读的是别的 bullet——这句是"删多"时最容易混账的地方）
 * - `W3` 删掉窗口说明里「也不用你查表…这一场会话…」那行（markers=1）→ **红 1**：`窗口那一格：要说清…`
 * - `W4` 把「关闭思考」那三行实话换回老的「对不支持该参数的非推理模型不产生影响」（markers=3）→ **红 1**：`「关闭思考」不许承诺每家都吃这一套`
 * - `W5` 把「你填 8,192，地图本来要 16,384…」换成不含数值的模糊说法（markers=2）→ **红 1**：`填了的代价要举到具体那一档`
 *   ——这条与 `W6` 是给两条**保护性**判据补的牙：它们写下来时就绿，但"绿"不等于"判得住"，摘掉对应那半句它们各自红了，所以是真判据。
 * - `W6` 掏空「输出留得越多…原文就越少…卡片上写明」那半句、只留引子（markers=2）→ **红 1**：`输出与原文此消彼长要说清`
 * - `W0` 对照：0 刀时本文件 29 条全绿（sha 与基线逐字节相同）。
 */
describe("输出与窗口那两格的提示", () => {
  const openOutputHint = () => {
    render(<ApiSettings />);
    openAddForm();
    return {
      output: screen.getByText(/模型单次调用的最大输出/).textContent || "",
      context: screen.getByText(/模型的最大输入 token 数/).textContent || "",
      thinking: screen.getByText(/推理模型默认/).textContent || "",
    };
  };

  it("结论摆在前面：明写「建议：留空」", () => {
    // 老文案只有「一般不用填」四个字夹在长段落中间——"一般"不是口径，用户读不出默认该动还是不该动
    const { output } = openOutputHint();
    expect(output).toMatch(/建议[：:]\s*留空/);
  });

  it("留空那一档把每个任务要多少全列出来（五档数一个不许少）", () => {
    const { output } = openOutputHint();
    // 2,048（范围总结／问答）与 8,192（全书总览／图谱）老文案压根没提，用户只能猜"留空是不是都按一个很小的值"
    for (const n of ["2,048", "4,096", "8,192", "16,384"]) {
      expect(output, `留空那一档该说明 ${n} 是谁要的`).toContain(n);
    }
  });

  it("填了的代价要举到具体那一档：地图会被一起压下去（保护性：现在就绿）", () => {
    const { output } = openOutputHint();
    expect(output).toContain("地图");
    expect(output).toMatch(/你填 8,192[^\n]*16,384|16,384[^\n]*8,192/);
  });

  it("输出与原文此消彼长要说清，并且界面会写明（保护性：现在就绿）", () => {
    const { output } = openOutputHint();
    expect(output).toMatch(/输出留得越多[^\n]*原文[^\n]*越少/);
    expect(output).toMatch(/没送出去|注明/);
  });

  it("窗口那一格：要说清「厂商回了真实窗口，这一场会话自己会按它算」", () => {
    // 代码里那一支（`discoveredContextWindows`）早就有，界面上从来没提——于是用户以为只能自己查表填死
    const { context } = openOutputHint();
    expect(context).toMatch(/回[^\n]{0,12}真实窗口|报错里[^\n]{0,10}窗口/);
    expect(context).toMatch(/这一场会话|这场会话/);
  });

  it("「关闭思考」不许承诺每家都吃这一套，并给出那种家的退路", () => {
    // 老那句"对不支持该参数的非推理模型不产生影响"是假话的一半：今天实测 modelscope **是推理型、
    // 带着该字段仍回 982 帧／正文 0 字**（`thinking:{type:"disabled"}` 它压根不理）。
    const { thinking } = openOutputHint();
    expect(thinking).toMatch(/不是每家都理|有的厂商不理/);
    expect(thinking).toMatch(/抬[^\n]{0,6}预算|预算抬大|少要点正文/);
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

describe("「当前」那枚徽章的主色从哪儿来", () => {
  it("主色只来自 Badge 的 default 底，调用点那一份手写 bg-primary 已删", () => {
    // `ApiSettings.tsx` 过去写的是 `<Badge className="text-[10px] bg-primary shrink-0">`——
    // variant 留空即 default，而 default 底就是 "border-transparent bg-primary text-primary-foreground…"。
    // 同值覆盖看着像"特意挑了主色"，实际在做一件事：**把 base 那份盖成看不见的冗余**，
    // 于是"摘掉 base 的 bg-primary"这一刀在本文件里 0 红（基线实测，见 ui/badge 台账）。
    useAPIStore.setState({
      providers: [provider({ id: "p1", name: "甲", apiKey: "sk-1" })],
      activeProviderId: "p1",
      loaded: true,
    });
    render(<ApiSettings />);
    const cls = (screen.getByText("当前") as HTMLElement).className.split(/\s+/);
    expect(cls).toContain("bg-primary"); // 裸 token：hover:bg-primary/80 是另一格
    expect(cls).toContain("text-[10px]"); // 调用点给的两条不冲突的还在
    expect(cls).toContain("shrink-0");
  });
});
