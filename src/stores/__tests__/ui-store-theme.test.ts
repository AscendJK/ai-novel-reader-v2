/**
 * 首次进入应用时"用哪套配色"是从哪来的。
 *
 * 为什么要单独钉：`ui-store.ts:4-8` 是全项目唯一读 `matchMedia` 的地方，而且它跑在
 * **模块加载期**（`create()` 的初始 state 里），所以判据必须每例重新 import 一次才能
 * 走到；`src/test/setup.ts` 那只 `matchMedia` 桩恒返回 `matches: false`，不改它就只能
 * 看到"浅色"这半边——深色那一路此前没有任何一条判据（覆盖地板量出来的）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const THEME_KEY = "novel-reader-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** 系统设置成深色了吗：桩在被调用的那一刻读这个变量，所以赋值要发生在 import 之前 */
let systemDark = false;

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  systemDark = false;
  localStorage.clear();
  // 直接赋值而不是 vi.stubGlobal：setup.ts 那只 defineProperty 给了 writable 但没给 configurable
  window.matchMedia = ((query: string) => {
    const matches = systemDark && query === DARK_QUERY;
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  }) as typeof window.matchMedia;
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.resetModules();
});

/** 重新加载一次 store，等于"关掉页面再打开"：初始 state 会重新算 */
async function boot(stored?: string) {
  localStorage.removeItem(THEME_KEY);
  if (stored !== undefined) localStorage.setItem(THEME_KEY, stored);
  vi.resetModules();
  const { useUIStore } = await import("../ui-store");
  return useUIStore;
}

describe("初始主题", () => {
  it("系统是深色 → 进来就是深色（查的必须是 dark 那一句，写成 light 就恒假）", async () => {
    systemDark = true;
    const store = await boot();
    expect(store.getState().theme).toBe("dark");
  });

  it("系统是浅色 → 进来是浅色", async () => {
    const store = await boot();
    expect(store.getState().theme).toBe("light");
  });

  it("用户在应用里选过浅色：下次进来不许被系统的深色翻掉", async () => {
    systemDark = true;
    const store = await boot("light");
    expect(store.getState().theme, "库里读到的必须盖过系统，否则用户每次刷新都被重置").toBe("light");
  });

  it("库里存的是别的值（旧版本/手工改脏）：落回系统那一路，而不是把脏字符串当主题", async () => {
    systemDark = true;
    const store = await boot("blue");
    expect(store.getState().theme).toBe("dark");
  });
});

describe("主题写回库里", () => {
  it("toggleTheme 与 setTheme 都写库：不写的话上面那条「库里盖过系统」在真机上根本走不到", async () => {
    systemDark = true;
    const store = await boot();
    expect(store.getState().theme).toBe("dark");

    store.getState().toggleTheme();
    expect(localStorage.getItem(THEME_KEY)).toBe("light");

    store.getState().setTheme("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(store.getState().theme).toBe("dark");
  });
});
