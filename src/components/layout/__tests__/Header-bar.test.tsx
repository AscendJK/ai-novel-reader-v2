/**
 * 地板第 1 档：`Header.tsx` 这排顶栏首次被直接判。
 *
 * 为什么单独钉：顶栏是每一屏都在的东西，可它此前**一条直接判据都没有**——`AppLayout-shell`
 * 那批是把 `Header` 整只桩掉的（`AppLayout-shell.test.tsx:62` 只记下 props），e2e 里只有
 * D7 判过「退出按钮不被遮罩盖住」那一格遮挡。于是这只文件自己替全站做的六类决定全在裸奔：
 * 进书/书架两态各露哪几枚按钮、主题那枚的图标与提示文案配不配对、离线徽章走的是
 * 「手动离线」还是「自动离线」那套语义、点徽章只是开详情还是直接假装上线、用户名从哪来、
 * 模型下载那行显示什么。
 *
 * 口径：**只判这只文件自己做的决定**。store 用真的（`theme` / `offlineMode` 必须真翻才判得出
 * 接线），`syncClient` 换成一只可改写的假对象（它内部是 WebSocket + 定时器，接真的一条都跑不起来），
 * 图标桩成 `<svg data-icon=名字>`（真 lucide 的 svg 认不出用的是哪一只）。
 * 刻意不判的两格：`:165` 退出按钮的 `relative z-50` 遮挡层级（e2e D7 在真浏览器里判，jsdom 不算层叠）；
 * `memo`（性能，不是行为）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useUIStore } from "@/stores/ui-store";
import { useRAGStore } from "@/stores/rag-store";
import { Header } from "@/components/layout/Header";

type Props = {
  inBook: boolean;
  bookTitle?: string;
  onBack: () => void;
  onSettings: () => void;
  onNotes: () => void;
};

type IconProps = { className?: string };

const m = vi.hoisted(() => ({
  sync: {
    user: "" as string | null,
    isAutoOffline: false,
    isLoggedIn: false,
    resetAutoOffline: vi.fn(),
    pushNow: vi.fn(async () => {}),
    logout: vi.fn(),
  },
  log: [] as string[],
})) as unknown as {
  sync: {
    user: string | null;
    isAutoOffline: boolean;
    isLoggedIn: boolean;
    resetAutoOffline: ReturnType<typeof vi.fn>;
    pushNow: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
  };
  log: string[];
};

// `syncClient` 是模块级单例（`sync-client.ts:772` new 出来就带 WebSocket 与 30s 定时器），
// 这里只判 Header 怎么用它，所以换成一只字段可改、方法可数的假对象。
vi.mock("@/sync/sync-client", () => ({ syncClient: m.sync }));

vi.mock("lucide-react", () => {
  const icon = (name: string) => (p: IconProps) => <svg data-icon={name} className={p.className} />;
  return {
    ArrowLeft: icon("ArrowLeft"),
    Book: icon("Book"),
    Settings: icon("Settings"),
    Moon: icon("Moon"),
    Sun: icon("Sun"),
    LogOut: icon("LogOut"),
    User: icon("User"),
    StickyNote: icon("StickyNote"),
    WifiOff: icon("WifiOff"),
    Wifi: icon("Wifi"),
    Loader2: icon("Loader2"),
  };
});

const back = vi.fn();
const settings = vi.fn();
const notes = vi.fn();
const confirm = vi.fn();

let view: ReturnType<typeof render>;

function show(over: Partial<Props> = {}) {
  view = render(<Header inBook={false} bookTitle="洛阳旧事" onBack={back} onSettings={settings} onNotes={notes} {...over} />);
  return view;
}

const el = (sel: string) => view.container.querySelector(sel);
const iconCount = (name: string) => view.container.querySelectorAll(`[data-icon='${name}']`).length;
const btn = (name: string) => screen.getByRole("button", { name });
/** 弹窗「点外面关掉」那层遮罩（`:94` 与 `:157` 各一枚，同一时刻只可能开着一枚） */
const overlay = () => document.querySelector('div[class*="fixed inset-0"]') as HTMLElement;

function offlineBadge() {
  const found = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.getAttribute("title") || "").includes("离线模式 - 点击查看详情"),
  );
  expect(found, "离线徽章得是枚按得动的按钮").toBeTruthy();
  return found as HTMLButtonElement;
}

/** 离线徽章的两种语义：手动离线（自己关的）与自动离线（服务器不可达） */
function setOffline(manual: boolean) {
  useUIStore.setState({ offlineMode: true });
  m.sync.isAutoOffline = !manual;
}

beforeEach(() => {
  m.log.length = 0;
  back.mockReset();
  settings.mockReset();
  notes.mockReset();
  m.sync.user = "";
  m.sync.isAutoOffline = false;
  m.sync.isLoggedIn = false;
  // mockClear 而不是 mockReset：Reset 会把 pushNow 的 async 实现也抹掉，返回 undefined
  m.sync.resetAutoOffline.mockClear();
  m.sync.pushNow.mockClear();
  m.sync.logout.mockClear();
  confirm.mockReset();
  confirm.mockReturnValue(true);
  vi.stubGlobal("confirm", confirm);
  localStorage.clear();
  useUIStore.setState({ theme: "light", offlineMode: false } as never);
  useRAGStore.setState({ currentDownload: null, downloadProgress: "" } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("进书与书架两态各露哪几枚出口", () => {
  it("进书：「书架」那枚接的是 onBack，别的回调一发都不碰", () => {
    show({ inBook: true });
    expect(el('[data-icon="ArrowLeft"]'), "回退得有个向左的箭头").toBeTruthy();
    fireEvent.click(btn("书架"));
    expect(back).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled();
    expect(notes).not.toHaveBeenCalled();
  });

  it("进书：书名从 props 来并带书名号，不是空的占位", () => {
    show({ inBook: true });
    expect(screen.getByText("《洛阳旧事》")).toBeInTheDocument();
    expect(screen.queryByText("AI 小说精读助手"), "进书后顶栏不再打应用名").toBeNull();
  });

  it("进书：「全部笔记」收起来——阅读中顶栏不该留一枚把整屏换掉的按钮", () => {
    show({ inBook: true });
    expect(el('[data-icon="StickyNote"]')).toBeNull();
  });

  it("书架：没有回退，应用名与「全部笔记」在位，点它走 onNotes", () => {
    show();
    expect(el('[data-icon="ArrowLeft"]')).toBeNull();
    expect(screen.getByText("AI 小说精读助手")).toBeInTheDocument();
    fireEvent.click(btn("全部笔记"));
    expect(notes).toHaveBeenCalledTimes(1);
  });

  it("设置与主题两枚在两种态下都在（inBook 不许把它们圈掉）", () => {
    show({ inBook: true });
    fireEvent.click(btn("设置"));
    expect(el('[data-icon="Moon"]')).toBeTruthy();
    view.unmount();
    show();
    fireEvent.click(btn("设置"));
    expect(el('[data-icon="Moon"]'), "书架态同样有主题开关").toBeTruthy();
    expect(settings).toHaveBeenCalledTimes(2);
  });
});

describe("主题那枚", () => {
  it("亮色时提示「暗色模式」、图标是月亮（点和示反了就是骗人）", () => {
    show();
    expect(btn("暗色模式")).toBeTruthy();
    expect(iconCount("Moon")).toBe(1);
    expect(iconCount("Sun")).toBe(0);
  });

  it("暗色时提示「亮色模式」、图标是太阳", () => {
    useUIStore.setState({ theme: "dark" });
    show();
    expect(btn("亮色模式")).toBeTruthy();
    expect(iconCount("Sun")).toBe(1);
    expect(iconCount("Moon")).toBe(0);
  });

  it("点它真的翻档并记住，不是只翻一次显示", () => {
    show();
    fireEvent.click(btn("暗色模式"));
    expect(useUIStore.getState().theme, "必须走 toggleTheme：写死一档的话暗色点回去就坏了").toBe("dark");
    expect(localStorage.getItem("novel-reader-theme")).toBe("dark");
    fireEvent.click(btn("亮色模式"));
    expect(useUIStore.getState().theme).toBe("light");
    expect(localStorage.getItem("novel-reader-theme")).toBe("light");
  });
});

describe("在线/离线那一枚", () => {
  it("在线时是一枚绿色 Wifi，点下去进离线", () => {
    show();
    fireEvent.click(btn("在线 - 点击切换到离线模式"));
    expect(useUIStore.getState().offlineMode).toBe(true);
  });

  it("进离线那一下不推送、也不重置自动离线（人都还没上线）", () => {
    m.sync.isLoggedIn = true;
    show();
    fireEvent.click(btn("在线 - 点击切换到离线模式"));
    expect(m.sync.pushNow, "切离线时推送会把还没同步的改动打在断掉的链路上").not.toHaveBeenCalled();
    expect(m.sync.resetAutoOffline).not.toHaveBeenCalled();
  });

  it("离线时那枚绿色「在线」收起来，换成语义正确的徽章", () => {
    setOffline(true);
    show();
    expect(screen.queryByRole("button", { name: "在线 - 点击切换到离线模式" })).toBeNull();
    expect(offlineBadge().getAttribute("title")).toBe("手动离线模式 - 点击查看详情");
  });

  it("手动离线 = 蓝底 + Wifi 满格（是我自己关的，不是断线）", () => {
    setOffline(true);
    show();
    const badge = offlineBadge();
    expect(badge.textContent).toContain("手动离线");
    expect(badge.className).toContain("text-blue-500");
    expect(badge.querySelector('[data-icon="Wifi"]'), "自己关的离线不该画成断线").toBeTruthy();
    expect(badge.querySelector('[data-icon="WifiOff"]')).toBeNull();
  });

  it("自动离线 = 琥珀底 + WifiOff + 文案只说「离线」", () => {
    setOffline(false);
    show();
    const badge = offlineBadge();
    expect(badge.textContent).toContain("离线");
    expect(badge.textContent, "服务器自己断的不能写成用户手动开的").not.toContain("手动");
    expect(badge.className).toContain("text-amber-500");
    expect(badge.querySelector('[data-icon="WifiOff"]'), "断线就得画成断线").toBeTruthy();
    expect(badge.querySelector('[data-icon="Wifi"]')).toBeNull();
  });

  it("点徽章只开详情弹窗，不许假装上线", () => {
    setOffline(false);
    show();
    fireEvent.click(offlineBadge());
    expect(useUIStore.getState().offlineMode, "自动离线点一下不该直接上线——服务器可能还没起来").toBe(true);
    expect(m.sync.resetAutoOffline).not.toHaveBeenCalled();
    expect(screen.getByText("自动离线模式")).toBeInTheDocument();
  });

  it("弹窗再点徽章收起来，两轮 toggle 都跟得上", () => {
    setOffline(true);
    show();
    fireEvent.click(offlineBadge());
    expect(screen.getByText("手动离线模式")).toBeInTheDocument();
    fireEvent.click(offlineBadge());
    expect(screen.queryByText("手动离线模式")).toBeNull();
  });
});

describe("离线详情弹窗与「切换回在线」", () => {
  it("手动离线的文案不提「服务器不可达」，也不吓唬重新认证", () => {
    setOffline(true);
    show();
    fireEvent.click(offlineBadge());
    expect(screen.getByText("您手动开启了离线模式，服务器同步已暂停。")).toBeInTheDocument();
    expect(screen.queryByText(/重新认证/), "自己关的离线不该提示要重新登录").toBeNull();
  });

  it("自动离线才说服务器不可达，并把「同账号其他设备可能被踢」讲出来", () => {
    setOffline(false);
    show();
    fireEvent.click(offlineBadge());
    expect(screen.getByText("服务器不可达，已自动切换到离线模式。")).toBeInTheDocument();
    expect(screen.getByText(/重新认证/)).toBeInTheDocument();
  });

  it("「切换回在线」一次做完三件事：重置自动离线、退出离线、关掉弹窗", () => {
    m.sync.isLoggedIn = true;
    setOffline(false);
    show();
    fireEvent.click(offlineBadge());
    fireEvent.click(btn("切换回在线"));
    expect(m.sync.resetAutoOffline, "不清 autoOffline 的话回到在线仍被当成断线重连").toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().offlineMode).toBe(false);
    expect(screen.queryByText("切换回在线")).toBeNull();
  });

  it("登录状态才在回在线时立刻推一把", () => {
    m.sync.isLoggedIn = true;
    setOffline(true);
    show();
    fireEvent.click(offlineBadge());
    fireEvent.click(btn("切换回在线"));
    expect(m.sync.pushNow).toHaveBeenCalledTimes(1);
  });

  it("没登录就不推（匿名 pushNow 只会砸一次无用的请求）", () => {
    m.sync.isLoggedIn = false;
    setOffline(true);
    show();
    fireEvent.click(offlineBadge());
    fireEvent.click(btn("切换回在线"));
    expect(m.sync.pushNow).not.toHaveBeenCalled();
    expect(useUIStore.getState().offlineMode).toBe(false);
  });

  it("点遮罩只关弹窗，不碰离线状态", () => {
    setOffline(false);
    show();
    fireEvent.click(offlineBadge());
    fireEvent.click(overlay());
    expect(screen.queryByText("自动离线模式")).toBeNull();
    expect(useUIStore.getState().offlineMode).toBe(true);
    expect(m.sync.resetAutoOffline).not.toHaveBeenCalled();
  });
});

describe("用户名那一簇", () => {
  it("sync 还没初始化时从本地档案取回用户名（刷新后顶栏不该先是空的）", () => {
    m.sync.user = null;
    localStorage.setItem("sync-username", "甲");
    show();
    expect(btn("甲")).toBeTruthy();
  });

  it("已登录的名字优先于本地档案", () => {
    m.sync.user = "乙";
    localStorage.setItem("sync-username", "甲");
    show();
    expect(btn("乙")).toBeTruthy();
  });

  it("两处都没有时整簇不挂——不能留一枚对着空用户的退出按钮", () => {
    m.sync.user = null;
    show();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
    expect(iconCount("LogOut")).toBe(0);
  });

  it("点用户名展开浮层显示同一支名字，再点收起", () => {
    m.sync.user = "乙";
    show();
    // 只看浮层那一格：触发按钮里本来就写着同一个名字，按文本查会把自己算进去
    const popovers = () =>
      Array.from(view.container.querySelectorAll("div.bg-popover")).filter((d) => d.textContent === "乙");
    expect(popovers(), "没点之前不该挂着浮层").toHaveLength(0);
    fireEvent.click(btn("乙"));
    expect(popovers()).toHaveLength(1);
    fireEvent.click(btn("乙"));
    expect(popovers(), "再点一次该收起").toHaveLength(0);
  });

  it("退出前先问一句，说「不」就一发都不发", () => {
    m.sync.user = "乙";
    confirm.mockReturnValue(false);
    show();
    fireEvent.click(btn("退出登录"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(m.sync.logout).not.toHaveBeenCalled();
    expect(m.log).toEqual([]);
  });

  it("确认退出：先断链再刷页，顺序反了会把 reload 甩在清理前头", () => {
    m.sync.user = "乙";
    const original = window.location;
    const reload = vi.fn(() => m.log.push("reload"));
    m.sync.logout.mockImplementation(() => m.log.push("logout"));
    Object.defineProperty(window, "location", { value: { reload, href: "http://localhost/" }, writable: true });
    try {
      show();
      fireEvent.click(btn("退出登录"));
      expect(m.log).toEqual(["logout", "reload"]);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", { value: original, writable: true });
    }
  });
});

describe("模型下载那一行", () => {
  it("没在下载时整行不占位", () => {
    act(() => {
      useRAGStore.setState({ currentDownload: "Xenova/bge-small-zh-v1.5/model.onnx", downloadProgress: "tokenizer 50%" } as never);
    });
    show();
    expect(iconCount("Loader2")).toBe(1);
    act(() => {
      useRAGStore.setState({ currentDownload: null, downloadProgress: "" } as never);
    });
    expect(iconCount("Loader2"), "下载结束还挂着转圈就说谎了").toBe(0);
  });

  it("有进度文案就用它，悬停提示也是它", () => {
    useRAGStore.setState({ currentDownload: "Xenova/bge/model.onnx", downloadProgress: "tokenizer 0.5/2.1MB (24%)" } as never);
    show();
    expect(screen.getByText("tokenizer 0.5/2.1MB (24%)")).toBeInTheDocument();
    expect(screen.getByText("tokenizer 0.5/2.1MB (24%)").closest("[title]")?.getAttribute("title")).toBe(
      "tokenizer 0.5/2.1MB (24%)",
    );
  });

  it("进度还没来时报出引擎名，不是整条带路径的 modelKey", () => {
    useRAGStore.setState({ currentDownload: "Xenova/bge-small-zh-v1.5/model.onnx", downloadProgress: "" } as never);
    show();
    expect(screen.getByText("下载 model.onnx...")).toBeInTheDocument();
    expect(screen.queryByText(/Xenova/), "用户看不懂仓库路径").toBeNull();
  });

  it("modelKey 不带斜杠时也不空转", () => {
    useRAGStore.setState({ currentDownload: "gte", downloadProgress: "" } as never);
    show();
    expect(screen.getByText("下载 gte...")).toBeInTheDocument();
  });
});
