/**
 * UpdateBanner：横幅怎么来、怎么走。
 *
 * 为什么要单独钉：发版那条链在浏览器层判过（H3：真 SW 换新之后点「更新」真的换人接管），
 * 但**撤掉它**这条路没有任何一层看着——`忽略` 与 `知道了` 那两枚按钮的 onClick 写错、
 * 或者状态没清，横幅会常驻。它挂的是 `fixed bottom-4 left-1/2 z-[200]`（`:24`），
 * 正压在底栏那一排翻页按钮上面：关不掉就是翻页被挡。
 *
 * 分工要说清：事件名那一头一尾的配对（`main.tsx:40` 派发 ↔ 这里监听）是 H3 在真 SW
 * 更新里判的；这儿判的是"事件进来之后面板上发生了什么、又怎么撤掉"。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { UpdateBanner } from "@/components/common/UpdateBanner";

function fire(name: string): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(name));
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("横幅的出现与撤掉", () => {
  it("没收到事件时一个字都不挂：常驻一条底部横条就是挡屏", () => {
    render(<UpdateBanner />);
    expect(screen.queryByText("有新版本可用")).toBeNull();
    expect(screen.queryByText("离线资源已缓存")).toBeNull();
  });

  it("点「忽略」要真的把横幅撤掉：它压在底栏那一排翻页按钮上面", () => {
    render(<UpdateBanner />);
    fire("sw-need-refresh");
    expect(screen.getByText("有新版本可用")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    expect(screen.queryByText("有新版本可用"), "关不掉的横幅会一直挡住翻页那一排").toBeNull();
  });

  it("离线就绪是另一句说法，点「知道了」也得撤掉", () => {
    render(<UpdateBanner />);
    fire("sw-offline-ready");
    expect(screen.getByText("离线资源已缓存")).toBeInTheDocument();
    expect(screen.queryByText("有新版本可用"), "离线就绪不该说成有新版本").toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.queryByText("离线资源已缓存")).toBeNull();
  });

  it("两件事都发生过：先给「有新版本」那一张，撤掉之后离线那张还在（不许被一起吞掉）", () => {
    render(<UpdateBanner />);
    fire("sw-offline-ready");
    fire("sw-need-refresh");
    expect(screen.getByText("有新版本可用")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    expect(screen.getByText("离线资源已缓存"), "忽略的是新版本，不是离线回执").toBeInTheDocument();
  });
});
