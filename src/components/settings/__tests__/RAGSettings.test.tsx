// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// 这些模块在 import 期会拉起 embedding/下载逻辑，测试里全部换成空壳
vi.mock("@/rag/model-loader", () => ({
  ALL_ENGINES: [],
  downloadModel: vi.fn(),
  getMirrorOptions: () => [],
}));
vi.mock("@/rag/index", () => ({ clearCache: vi.fn() }));
vi.mock("@/rag/rag-cache-utils", () => ({ updateRagCacheSize: vi.fn() }));

import { RAGSettings } from "@/components/settings/RAGSettings";
import { useUIStore } from "@/stores/ui-store";

function setMobile(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, writable: true, configurable: true });
  // 组件用的是 useMediaQuery("(max-width: 767px)")，不是 innerWidth：只改 innerWidth 的话
  // 旧的 !isMobile 门槛在 jsdom 里照样放行（matchMedia 缺失时 hook 返回 false），
  // 这条用例就变成假阳性判别。这里让 matchMedia 跟着宽度走。
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query)?.[1];
      const matches = max ? width <= Number(max) : false;
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
  window.dispatchEvent(new Event("resize"));
}

describe("RAGSettings 的调试模式入口", () => {
  beforeEach(() => {
    vi.stubGlobal("BroadcastChannel", class {
      onmessage: ((e: MessageEvent) => void) | null = null;
      postMessage() {}
      close() {}
    });
    useUIStore.setState({ debugMode: false });
  });

  it("手机宽度下也渲染调试模式开关（自检入口在手机上必须能打开）", () => {
    setMobile(390);
    render(<RAGSettings />);
    const toggle = screen.getByRole("button", { name: "已关闭" });
    fireEvent.click(toggle);
    expect(useUIStore.getState().debugMode).toBe(true);
    setMobile(1280);
  });
});
