/**
 * ToastContainer：一条提示的寿命。
 *
 * 为什么要单独钉：那两句同步提示（`sync-reconnected` / `sync-offline`）e2e 判过"出现过"
 * （`e2e/specs/e-sync.spec.ts:164,202`），但**消失**没有任何一层看着——toast 挂的是
 * `fixed bottom-4 right-4 z-[100]`（`Toast.tsx:44`），右下角那一坨不自己走就会一直压着内容。
 * 两条判据各自的靶子都不一样：五秒自动收尾走的是 toast-store 里的定时器，手动关走的是
 * 容器上那条 filter。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { ToastContainer } from "@/components/common/Toast";
import { showToast } from "@/lib/toast-store";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("一条提示的寿命", () => {
  it("各按自己出现的时间走，不许后一条把前一条一起带走", () => {
    render(<ToastContainer />);
    act(() => {
      showToast("第一条", "info");
    });
    expect(screen.getByText("第一条"), "showToast 到容器上屏这条接线得通").toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      showToast("第二条", "warn");
    });
    act(() => {
      vi.advanceTimersByTime(2000); // 第一条满 5 秒，第二条才两秒
    });
    expect(screen.queryByText("第一条")).toBeNull();
    expect(screen.getByText("第二条"), "定时器要是清就整堆清，第二条会被提前抹掉").toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText("第二条")).toBeNull();
  });

  it("点某一行的 X 只关掉那一行", () => {
    render(<ToastContainer />);
    act(() => {
      showToast("甲", "info");
      showToast("乙", "success");
    });
    const closeButtons = screen.getAllByLabelText("关闭通知");
    expect(closeButtons).toHaveLength(2);

    fireEvent.click(closeButtons[0]);
    expect(screen.queryByText("甲")).toBeNull();
    expect(screen.getByText("乙")).toBeInTheDocument();
  });
});
