/**
 * 开着应用不动的时候，新版本靠什么被发现。
 *
 * 为什么要单独钉：SW 那两条出口里，「装上之后弹横幅、点『更新』真的换人接管」H3 在真
 * Service Worker 上判过，「刷不到隔离就放弃」H2 判过 reload 次数上限；只剩
 * `main.tsx:53` 那一句 `setInterval(() => registration.update(), 30 * 60 * 1000)` 没人看着。
 * 它坏起来的形状是不报错、也不弹任何东西：应用一挂几小时，后端发了新版也查不到。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** 每 30 分钟那一格究竟查了几次 */
const updateCalls = vi.fn();

vi.mock("virtual:pwa-register", () => ({
  registerSW: () => async () => {},
}));
vi.mock("@/lib/logger", () => ({ installConsoleCapture: () => () => {} }));
vi.mock("../App", () => ({ default: () => null }));

const originalSW = navigator.serviceWorker;

beforeEach(() => {
  vi.useFakeTimers();
  updateCalls.mockClear();
  document.body.innerHTML = '<div id="root"></div>';
  // jsdom 没有 serviceWorker，`"serviceWorker" in navigator` 恒假 → 要判的那一段整块被跳过
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ update: updateCalls }) },
  });
});

afterEach(() => {
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: originalSW });
  vi.useRealTimers();
  vi.resetModules();
  document.body.innerHTML = "";
});

describe("挂着不动时的 SW 复查", () => {
  it("每 30 分钟查一次：没到点不许查，到点查一次，再挂 30 分钟再查一次", async () => {
    await import("../main");
    await vi.advanceTimersByTimeAsync(0); // 放行 navigator.serviceWorker.ready 那一段

    expect(updateCalls, "刚接管就查一轮是白耗一次请求").not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(updateCalls, "29 分钟那一格不该提前查——写成了分钟就会在这儿红").not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(updateCalls).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(updateCalls, "查过一轮就不排下一轮的写法，两格之后才看得见").toHaveBeenCalledTimes(2);
  });
});
