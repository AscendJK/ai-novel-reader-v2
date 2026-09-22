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

// 跨标签通知必须走共享 broadcast 单例：mock 掉它并捕获订阅，用来抓"又手写一个
// BroadcastChannel"的回归（R-75 的病因就是收发两端通道名/载荷格式都不一致）
const subscriptions = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@/lib/broadcast", () => ({
  broadcast: {
    on: (type: string, handler: () => void) => {
      subscriptions.set(type, handler);
      return () => { subscriptions.delete(type); };
    },
    send: vi.fn(),
    close: vi.fn(),
  },
}));

import { RAGSettings } from "@/components/settings/RAGSettings";
import { useUIStore } from "@/stores/ui-store";
import { useRAGStore } from "@/stores/rag-store";

function setMobile(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, writable: true, configurable: true });
  // 口径修正（2026-09-22 地板重算时量出来的）：**RAGSettings 现在不按 JS 断点分支**——
  // `useMediaQuery("(max-width: 767px)")` 那套早就不在这只组件里了，全仓只剩
  // `src/hooks/useMediaQuery.ts` 一个定义、没有任何 import。所以这条用例的"手机宽度"那一半
  // 已经没有判别力（改宽度不改 DOM）。留这段 helper 只是让 jsdom 里的 matchMedia 有确定行为；
  // 真要钉"自检入口在手机上摸得到"，那属于窄屏浏览器层（G 组）的活。
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
    subscriptions.clear();
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

  it("通过共享 broadcast 订阅“模型下载完成”，另一标签下载后本页刷新", () => {
    useRAGStore.setState({ downloadedModels: new Set(["Xenova/bge-small-zh-v1.5"]) });
    const before = useRAGStore.getState().downloadedModels;

    render(<RAGSettings />);

    const notify = subscriptions.get("model-download-complete");
    expect(notify).toBeTypeOf("function"); // 收发不同通道/比字符串的那个 bug 会红在这里
    notify!();

    const after = useRAGStore.getState().downloadedModels;
    expect(after).not.toBe(before); // 换了引用才会触发重渲染，内容仍来自原集合
    expect([...after]).toEqual([...before]);
  });
});
