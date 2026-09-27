/**
 * B2 第一只：`AppLayout` 的"此刻屏上该是哪一块"与两枚弹窗的收口
 *
 * 这只文件是整应用的外壳：四块主视图（书架 / 阅读 / 设置 / 笔记）的互斥条件、两枚浮层
 * （快捷键帮助、前后端版本不一致）、全局三枚快捷键都写在它里面。覆盖地板量到它
 * "浏览器天天加载、没人断言"——e2e 判的是走位之后的界面，外壳里那几道条件表达式改坏了，
 * 浏览器层要红得看运气。
 *
 * 口径：**只判这只文件自己替调用点做的决定**，子面板全换成"记下挂了几次、收到哪些 props"
 * 的桩，store 用真的（`currentNovel` / `debugMode` 这几格必须真翻才判得出条件）。
 * 刻意不判的两格：主题落到 `documentElement` 的 class（e2e A 组判过）；`:110-140` 那套 GC
 * 节流（`cleanupDeletedRecords` 只删软删除记录，跑早跑晚没有用户可感知后果，立判据＝装饰）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { useNovelStore } from "@/stores/novel-store";
import { useUIStore } from "@/stores/ui-store";

type Binding = { key: string; shift?: boolean; action: () => void; description?: string };
type HeaderProps = { inBook: boolean; onSettings: () => void; onNotes: () => void; onBack: () => void };
type LoginProps = { localUsers: string[]; onLogin: (u: string) => Promise<void>; onDelete: (u: string) => void; error?: string | null };

const m = vi.hoisted(() => ({
  mounts: [] as string[],
  header: [] as HeaderProps[],
  login: [] as LoginProps[],
  loginError: null as string | null,
  registered: [] as Binding[],
  helpLists: [] as Binding[],
  helpClose: [] as Array<() => void>,
  mismatch: [] as Array<{ frontend: string; backend: string }>,
  mismatchClose: [] as Array<() => void>,
  syncReadyCbs: [] as Array<() => void>,
})) as unknown as {
  mounts: string[];
  header: HeaderProps[];
  login: LoginProps[];
  loginError: string | null;
  registered: Binding[];
  helpLists: Binding[];
  helpClose: Array<() => void>;
  mismatch: Array<{ frontend: string; backend: string }>;
  mismatchClose: Array<() => void>;
  syncReadyCbs: Array<() => void>;
};

/**
 * 子面板的桩：挂载才算一次（渲染不算），行为一概不判（那是各只面板自己的判据）。
 * 记在 `useEffect(..., [])` 里而不是函数体里——外壳一次状态变化会连带重渲染整棵子树，
 * 按渲染计数的话"重挂了几次"这一格永远虚高。
 */
function panel(name: string) {
  return () => {
    const Comp = () => {
      useEffect(() => {
        m.mounts.push(name);
      }, []);
      return <div data-testid={name} />;
    };
    return Comp;
  };
}

vi.mock("../Header", () => ({
  Header: (props: HeaderProps) => {
    useEffect(() => {
      m.header.push(props);
    });
    return <div data-testid="Header" />;
  },
}));
vi.mock("../BookSelect", () => ({ BookSelect: panel("BookSelect")() }));
vi.mock("@/components/reader/ReadingPanel", () => ({ ReadingPanel: panel("ReadingPanel")() }));
vi.mock("@/components/settings/ApiSettings", () => ({ ApiSettings: panel("ApiSettings")() }));
vi.mock("@/components/notes/GlobalNotes", () => ({ GlobalNotes: panel("GlobalNotes")() }));
// 登录这块要判"外壳递出去的那句失败原因"，所以 props 每次渲染都记（同 Header 的取法）
vi.mock("@/components/login/UsernameLogin", () => ({
  UsernameLogin: (props: LoginProps) => {
    useEffect(() => {
      m.login.push(props);
    });
    return <div data-testid="UsernameLogin" />;
  },
}));
vi.mock("@/components/common/DebugPanel", () => ({ DebugPanel: panel("DebugPanel")() }));
vi.mock("@/components/common/LocalErrorBoundary", () => ({
  LocalErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/common/ShortcutHelp", () => ({
  ShortcutHelp: (props: { shortcuts: Binding[]; onClose: () => void }) => {
    useEffect(() => {
      m.mounts.push("ShortcutHelp");
      m.helpLists.length = 0;
      m.helpLists.push(...props.shortcuts);
      m.helpClose.push(props.onClose);
      // 桩只记挂载那一次：外壳每次渲染都给一支新数组，带 deps 就会重复计数
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="ShortcutHelp" />;
  },
}));
vi.mock("@/components/common/VersionMismatchDialog", () => ({
  VersionMismatchDialog: (props: { frontend: string; backend: string; onClose: () => void }) => {
    useEffect(() => {
      m.mounts.push("VersionMismatchDialog");
      m.mismatch.push({ frontend: props.frontend, backend: props.backend });
      m.mismatchClose.push(props.onClose);
      // 同上：只记挂载那一次
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="VersionMismatchDialog" />;
  },
}));
// 注册口桩成"把最后一次注册的那一批原样交出来"：判的是外壳注册了哪几条、每条按下去动什么
vi.mock("@/hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: (bindings: Binding[]) => {
    m.registered.length = 0;
    m.registered.push(...bindings);
  },
}));
vi.mock("@/hooks/useSyncOrchestration", () => ({
  useSyncOrchestration: (o: { onSyncReady: () => void }) => {
    m.syncReadyCbs.push(o.onSyncReady);
    // loginError 每次渲染现取：外壳如果把它记在第一次，第二次就看不见"收回去"
    return { handleLogin: vi.fn(), handleDeleteUser: vi.fn(), startSync: vi.fn(), loginError: m.loginError };
  },
}));
vi.mock("@/rag/model-loader", () => ({
  setupModelLoader: vi.fn(),
  verifyDownloadedModels: vi.fn(async () => {}),
}));
vi.mock("@/rag/rag-cache-utils", () => ({
  setCurrentNovelIdGetter: vi.fn(),
  onCacheEviction: vi.fn(),
}));
vi.mock("@/lib/broadcast", () => ({
  broadcast: {
    onSyncComplete: () => () => {},
    onUserSwitched: () => () => {},
    onLogout: () => () => {},
    onDataChanged: () => () => {},
  },
}));
vi.mock("@/sync/sync-client", () => ({ syncClient: { isLoggedIn: false, user: "甲" } }));
vi.mock("@/lib/api-client", () => ({ getServerUrl: () => "https://backend.invalid" }));
vi.mock("@/lib/check-version", () => ({ checkVersion: vi.fn() }));
vi.mock("@/db/repositories", () => ({
  loadAllNovels: vi.fn(async () => []),
  loadSummaries: vi.fn(async () => []),
  getLocalUsers: () => ["甲"],
  cleanupDeletedRecords: vi.fn(async () => {}),
}));
vi.mock("@/db/database", () => ({
  setCurrentUser: vi.fn(),
  sharedDB: { ragCache: { toArray: async () => [] } },
}));

const { AppLayout } = await import("@/components/layout/AppLayout");
const { checkVersion } = await import("@/lib/check-version");
const check = vi.mocked(checkVersion);

// `setCurrentNovel` 会真去挑章节（`novel-store.ts:104` 读 `novel.chapters[0]`），样本得带得上
const BOOK = { id: "n1", title: "洛阳旧事", chapterCount: 1, chapters: [{ id: "c1", index: 0, title: "第一章" }] } as never;

function binding(key: string): Binding {
  const found = m.registered.find((b) => b.key === key);
  expect(found, `外壳注册了哪几枚快捷键是可判的：找不到 key=${key}`).toBeDefined();
  return found as Binding;
}

/** 走 Header 那两枚按钮的真实路径（外壳只认这两个回调） */
function clickHeader(which: "onSettings" | "onNotes" | "onBack"): HeaderProps {
  const props = m.header[m.header.length - 1];
  act(() => {
    props[which]();
  });
  return props;
}

function count(name: string): number {
  return m.mounts.filter((x) => x === name).length;
}

/** 登录界面最后一次收到的 props（外壳每次渲染都重记，取最后一格） */
function loginProps(): LoginProps {
  const last = m.login[m.login.length - 1];
  expect(last, "这块没挂上就谈不上递了什么").toBeDefined();
  return last as LoginProps;
}

beforeEach(() => {
  m.mounts.length = 0;
  m.header.length = 0;
  m.login.length = 0;
  m.loginError = null;
  m.registered.length = 0;
  m.helpLists.length = 0;
  m.helpClose.length = 0;
  m.mismatch.length = 0;
  m.mismatchClose.length = 0;
  m.syncReadyCbs.length = 0;
  localStorage.setItem("sync-username", "甲");
  useUIStore.setState({ debugMode: false, offlineMode: false, theme: "light" });
  act(() => {
    useNovelStore.getState().setCurrentNovel(null);
  });
  check.mockReset();
  check.mockResolvedValue({ match: true, frontend: "2.4.0", backend: "2.4.0" } as never);
});

describe("四块主视图谁在屏上", () => {
  it("没进书时阅读那块是「藏着」而不是「没挂」——面板状态才活得下来", () => {
    render(<AppLayout />);
    expect(screen.getByTestId("BookSelect")).toBeInTheDocument();
    const wrapper = screen.getByTestId("ReadingPanel").parentElement;
    expect(wrapper, "阅读那块得一直在 DOM 里").not.toBeNull();
    expect((wrapper as HTMLElement).style.display, "没进书时它是 display:none").toBe("none");
  });

  it("进书 → 退回书架 → 再进书：阅读面板一条都没重挂", () => {
    render(<AppLayout />);
    expect(count("ReadingPanel")).toBe(1);
    for (const next of [BOOK, null, BOOK]) {
      act(() => {
        useNovelStore.getState().setCurrentNovel(next as never);
      });
    }
    expect(count("ReadingPanel"), "改成条件挂载就会把它里面的滚动位置与 AI 面板状态一起丢掉").toBe(1);
  });

  it("进书之后：书架让位、阅读那块不再藏着", () => {
    render(<AppLayout />);
    act(() => {
      useNovelStore.getState().setCurrentNovel(BOOK);
    });
    expect(screen.queryByTestId("BookSelect")).toBeNull();
    expect((screen.getByTestId("ReadingPanel").parentElement as HTMLElement).style.display).not.toBe("none");
  });

  it("设置遮罩：开的时候书架让位、阅读那块仍然藏着，「返回」之后书架回来", () => {
    render(<AppLayout />);
    act(() => {
      useNovelStore.getState().setCurrentNovel(BOOK);
    });
    clickHeader("onSettings");
    expect(screen.getByTestId("ApiSettings")).toBeInTheDocument();
    expect(screen.queryByTestId("BookSelect")).toBeNull();
    expect((screen.getByTestId("ReadingPanel").parentElement as HTMLElement).style.display,
      "设置页底下压着阅读器的话，窄屏上点设置会点到下一页").toBe("none");
    clickHeader("onBack");
    expect(screen.queryByTestId("ApiSettings")).toBeNull();
    act(() => {
      useNovelStore.getState().setCurrentNovel(null);
    });
    expect(screen.getByTestId("BookSelect"), "关掉遮罩要回得到书架，否则这一屏是条死路").toBeInTheDocument();
  });

  it("笔记遮罩只在没有书的时候出现：正在读的时候点「笔记」不许盖住阅读器", () => {
    render(<AppLayout />);
    clickHeader("onNotes");
    expect(screen.getByTestId("GlobalNotes")).toBeInTheDocument();
    expect(screen.queryByTestId("BookSelect"), "笔记遮罩开着时书架得让位，否则两层叠着").toBeNull();
    act(() => {
      useNovelStore.getState().setCurrentNovel(BOOK);
    });
    expect(screen.queryByTestId("GlobalNotes"), "进书之后笔记入口换成阅读器内那一条，外壳这块必须让位")
      .toBeNull();
  });

  it("同步完成那一刻：登录遮罩撤掉，书架换一只实例（key 靠的是 syncReady）", () => {
    localStorage.removeItem("sync-username");
    render(<AppLayout />);
    expect(screen.getByTestId("UsernameLogin")).toBeInTheDocument();
    // 书架在遮罩底下是挂着的——"没登录不读库"那道闸在 BookSelect 自己里面（BookSelect.tsx:96），
    // 外壳这一层判的是遮罩与重挂，不去替它判。
    expect(count("BookSelect")).toBe(1);
    act(() => {
      m.syncReadyCbs[m.syncReadyCbs.length - 1]();
    });
    expect(screen.queryByTestId("UsernameLogin")).toBeNull();
    expect(count("BookSelect"), "同步完成要重挂一次，否则看不到同步进来的书").toBe(2);
  });

  it("debugMode 关着的时候 DebugPanel 一条都不挂（它是取证入口，不是常驻浮层）", () => {
    render(<AppLayout />);
    expect(count("DebugPanel")).toBe(0);
    act(() => {
      useUIStore.setState({ debugMode: true });
    });
    expect(count("DebugPanel")).toBe(1);
  });
});

/**
 * 登录失败的那句话怎么到屏上：`useSyncOrchestration` 报原因 → 外壳递成 `error` prop →
 * `UsernameLogin.tsx:313` 那句现成的红字。这一段以前是**死的**：外壳自己 `useState(null)`
 * 却没有 setter（AppLayout.tsx:42），所以登录失败只剩系统弹窗。
 * 判"接线"而不是判"红字长什么样"——后者是 UsernameLogin 自己的事。
 */
describe("登录失败的原因要递到登录界面那根红字上", () => {
  it("hook 报了原因 → 登录界面收到同一句（外壳自己不造话）", () => {
    localStorage.removeItem("sync-username");
    m.loginError = "用户名需 2-30 个字符";
    render(<AppLayout />);
    expect(loginProps().error, "这句就是屏上那行红字的内容").toBe("用户名需 2-30 个字符");
  });

  it("原因收回去之后红字跟着没有：外壳每次渲染现取，不是记住第一次", () => {
    localStorage.removeItem("sync-username");
    m.loginError = "用户不存在";
    render(<AppLayout />);
    expect(loginProps().error).toBe("用户不存在");

    m.loginError = null;
    act(() => {
      useUIStore.getState().setOfflineMode(true);
    });
    expect(loginProps().error, "已经重试成功了还挂着上一次的原因＝告诉用户仍在失败").toBeNull();
  });

  it("没失败过的时候不许凭空递一句话", () => {
    localStorage.removeItem("sync-username");
    render(<AppLayout />);
    expect(loginProps().error ?? null, "凭空一句红字比没有更糟").toBeNull();
  });
});

describe("三枚全局快捷键", () => {
  it("Escape 一次关三块：设置、笔记、快捷键帮助", () => {
    render(<AppLayout />);
    clickHeader("onSettings");
    clickHeader("onNotes");
    act(() => {
      binding("?").action();
    });
    expect(screen.getByTestId("ApiSettings")).toBeInTheDocument();
    expect(screen.getByTestId("ShortcutHelp")).toBeInTheDocument();
    act(() => {
      binding("Escape").action();
    });
    expect(screen.queryByTestId("ApiSettings"), "Escape 只管一块的话，另一块会一直挡屏").toBeNull();
    expect(screen.queryByTestId("GlobalNotes")).toBeNull();
    expect(screen.queryByTestId("ShortcutHelp")).toBeNull();
  });

  it("「?」是开关不是单向打开：连着按两次要回到没有面板", () => {
    render(<AppLayout />);
    act(() => {
      binding("?").action();
    });
    expect(screen.getByTestId("ShortcutHelp")).toBeInTheDocument();
    act(() => {
      binding("?").action();
    });
    expect(screen.queryByTestId("ShortcutHelp")).toBeNull();
  });

  it("帮助面板上念的前三条就是注册进去的那三条（同源，不许另立一份说法）", () => {
    render(<AppLayout />);
    act(() => {
      binding("?").action();
    });
    const registered = m.registered.map((b) => `${b.key}=${b.description}`);
    expect(registered.length, "外壳注册了几条是可判的").toBeGreaterThanOrEqual(3);
    expect(m.helpLists.slice(0, registered.length).map((b) => `${b.key}=${b.description}`)).toEqual(registered);
  });

  it("帮助面板里那六条「阅读器自己的键」是占位说明：外壳不许把它们注册成真会动的键", () => {
    render(<AppLayout />);
    act(() => {
      binding("?").action();
    });
    const listed = m.helpLists.map((b) => b.key);
    expect(listed).toEqual(expect.arrayContaining(["ArrowLeft", "ArrowRight", " ", "+", "-", "i"]));
    expect(m.registered.map((b) => b.key), "空格/方向键的真绑定在阅读器里，外壳再注册一份会双触发")
      .not.toContain(" ");
  });
});

describe("版本不一致那枚弹窗", () => {
  it("登录之前一次都不查（未登录时后端必然不通，弹出来是假警报）", () => {
    localStorage.removeItem("sync-username");
    render(<AppLayout />);
    expect(check).not.toHaveBeenCalled();
  });

  it("版本一致时不许出现；不一致时两个版本号各归各的位置", async () => {
    check.mockResolvedValue({ match: false, frontend: "2.4.0", backend: "2.3.0" } as never);
    await act(async () => {
      render(<AppLayout />);
    });
    expect(m.mismatch).toEqual([{ frontend: "2.4.0", backend: "2.3.0" }]);
    expect(screen.getByTestId("VersionMismatchDialog")).toBeInTheDocument();
  });

  it("用户点了「继续使用」之后，60 秒轮询不许再把它弹回来（否则这屏关不掉）", async () => {
    vi.useFakeTimers();
    try {
      check.mockResolvedValue({ match: false, frontend: "2.4.0", backend: "2.3.0" } as never);
      await act(async () => {
        render(<AppLayout />);
      });
      expect(count("VersionMismatchDialog")).toBe(1);
      act(() => {
        m.mismatchClose[m.mismatchClose.length - 1]();
      });
      expect(screen.queryByTestId("VersionMismatchDialog")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(180_000);
      });
      expect(count("VersionMismatchDialog"), "关掉之后还在弹＝用户被劫持").toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
