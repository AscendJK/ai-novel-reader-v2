// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * 两只错误边界的默认兜底。
 *
 * 为什么要单独钉：`App.tsx:8` 用的是不带 `fallback` 的 `<ErrorBoundary>`，
 * `AppLayout.tsx:253`、`ReadingPanel.tsx:121,164` 用的是不带 `fallback` 的
 * `<LocalErrorBoundary name="…">`——也就是说崩了之后用户看到的就是这里的**默认 UI**，
 * 而它此前没有任何一层看着：浏览器套没有一条用例触发过渲染抛错，单测也没碰过这两只文件
 * （覆盖地板第 2 档量出来的）。症状会是"崩了以后是白屏"却没人报红。
 */
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { LocalErrorBoundary } from "@/components/common/LocalErrorBoundary";

/**
 * 会抛错的子组件，抛/不抛读一个模块级开关而不是 props：
 * 边界的"重试"只做一件事——把 `hasError` 清掉让 React 重渲染一次子树。要演"修好病因再重试"，
 * 就得让**点击之后那一次渲染**不再抛错；用 props 的话点击时 props 没变，测的就不是重试了。
 */
let broken = true;
function Boom() {
  if (broken) throw new Error("渲染时炸了一段");
  return <p>正文还在</p>;
}

/** React 对被边界吃掉的错误会整段 console.error，与产品无关，全部静音 */
function silenceReactErrorLogs() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mockRestore();
}

beforeEach(() => {
  broken = true;
});

afterEach(() => vi.restoreAllMocks());

describe("ErrorBoundary（整应用那一层）", () => {
  it("没出事时只渲染 children，兜底一个字都不许出现", () => {
    const restore = silenceReactErrorLogs();
    broken = false;
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("正文还在")).toBeInTheDocument();
    expect(screen.queryByText("出错了")).toBeNull();
    expect(screen.queryByRole("button", { name: "刷新页面" })).toBeNull();
    restore();
  });

  it("子组件抛错 → 说「出错了」、把病因原话摆出来，并留重试与刷新两条出口", () => {
    const restore = silenceReactErrorLogs();
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("出错了")).toBeInTheDocument();
    // 错误原话必须在界面上：只 console.error 等于用户看不出为什么没了
    expect(screen.getByText("渲染时炸了一段")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新页面" })).toBeInTheDocument();
    expect(screen.queryByText("正文还在")).toBeNull();
    restore();
  });

  it("病因还在时点「重试」不许白屏，要退回兜底并且出口还在", () => {
    const restore = silenceReactErrorLogs();
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("出错了")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新页面" })).toBeInTheDocument();
    restore();
  });

  it("把病因修好再点「重试」，内容要真的回来、兜底整块消失", () => {
    const restore = silenceReactErrorLogs();
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("正文还在")).toBeInTheDocument();
    expect(screen.queryByText("出错了")).toBeNull();
    expect(screen.queryByText("渲染时炸了一段")).toBeNull();
    restore();
  });

  it("「刷新页面」接的是 location.reload，不许是个死按钮", () => {
    const restore = silenceReactErrorLogs();
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { value: { reload, href: "http://localhost/" }, writable: true });
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新页面" }));
    expect(reload).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "location", { value: original, writable: true });
    restore();
  });
});

describe("LocalErrorBoundary（面板那一层）", () => {
  it("带 name 时说的是「某某加载失败」，不带 name 时才是通用那句", () => {
    const restore = silenceReactErrorLogs();
    const { unmount } = render(
      <LocalErrorBoundary name="ReadingPanel">
        <Boom />
      </LocalErrorBoundary>,
    );
    expect(screen.getByText("ReadingPanel 加载失败")).toBeInTheDocument();
    expect(screen.queryByText("组件加载失败")).toBeNull();
    unmount();

    render(
      <LocalErrorBoundary>
        <Boom />
      </LocalErrorBoundary>,
    );
    expect(screen.getByText("组件加载失败")).toBeInTheDocument();
    restore();
  });

  it("给了自定义 fallback 就完全用它的，默认那句不许漏出来", () => {
    const restore = silenceReactErrorLogs();
    render(
      <LocalErrorBoundary name="SummaryPanel" fallback={<p>换一块面板</p>}>
        <Boom />
      </LocalErrorBoundary>,
    );
    expect(screen.getByText("换一块面板")).toBeInTheDocument();
    expect(screen.queryByText("SummaryPanel 加载失败")).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    restore();
  });

  it("onError 拿到的是那个 Error 本体，边界自己不吃掉病因", () => {
    const restore = silenceReactErrorLogs();
    const onError = vi.fn();
    render(
      <LocalErrorBoundary name="DataMgr" onError={onError}>
        <Boom />
      </LocalErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe("渲染时炸了一段");
    restore();
  });

  it("把病因修好再点「重试」，同一块面板要重新渲染出内容", () => {
    const restore = silenceReactErrorLogs();
    render(
      <LocalErrorBoundary name="ReadingPanel">
        <Boom />
      </LocalErrorBoundary>,
    );
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("正文还在")).toBeInTheDocument();
    expect(screen.queryByText("ReadingPanel 加载失败")).toBeNull();
    restore();
  });
});
