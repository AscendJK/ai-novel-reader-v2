/**
 * App 这一层的组合：谁在屏上、崩了给什么。
 *
 * 为什么要单独钉：`ErrorBoundary` 自己那张兜底脸有判据（`error-boundaries.test.tsx`），
 * 但"App 真的把它套上了"没有——把 `<ErrorBoundary>` 摘掉，整屏变白这件事一条用例都不会
 * 报红；三只子件少一只同理（没横幅、没提示都不报错）。覆盖地板把 `src/App.tsx` 列在
 * 第 2 档就是这个形状：浏览器每次加载它，断言从没穿过它。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/** 崩在哪一只子件上：三只都试一遍，任意一只崩都不该留下白屏 */
let broken: "none" | "AppLayout" | "UpdateBanner" | "ToastContainer" = "none";

vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: () => {
    if (broken === "AppLayout") throw new Error("书架崩了一段");
    return <div data-testid="AppLayout" />;
  },
}));
vi.mock("@/components/common/UpdateBanner", () => ({
  UpdateBanner: () => {
    if (broken === "UpdateBanner") throw new Error("更新横幅崩了一段");
    return <div data-testid="UpdateBanner" />;
  },
}));
vi.mock("@/components/common/Toast", () => ({
  ToastContainer: () => {
    if (broken === "ToastContainer") throw new Error("通知容器崩了一段");
    return <div data-testid="ToastContainer" />;
  },
}));

const DefaultApp = (await import("@/App")).default;

/** 边界吃掉的错误 React 会整段 console.error，与产品无关 */
function silenceReactErrorLogs(): () => void {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mockRestore();
}

afterEach(() => {
  broken = "none";
  cleanup();
});

describe("App 的组合", () => {
  it("三只子件都在屏上：少一只是「没横幅、没提示」这种不报红的坏", () => {
    render(<DefaultApp />);
    expect(screen.getByTestId("AppLayout")).toBeInTheDocument();
    expect(screen.getByTestId("UpdateBanner")).toBeInTheDocument();
    expect(screen.getByTestId("ToastContainer")).toBeInTheDocument();
  });

  it("任意一只子件崩掉，屏幕上都是兜底那张脸加两枚出口，而不是白屏", () => {
    const restore = silenceReactErrorLogs();
    try {
      for (const which of ["AppLayout", "UpdateBanner", "ToastContainer"] as const) {
        broken = which;
        const { unmount } = render(<DefaultApp />);
        expect(
          screen.getByRole("button", { name: "重试" }),
          `${which} 崩了之后没有兜底 UI：整屏是白的`,
        ).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "刷新页面" })).toBeInTheDocument();
        unmount();
      }
    } finally {
      restore();
    }
  });
});
