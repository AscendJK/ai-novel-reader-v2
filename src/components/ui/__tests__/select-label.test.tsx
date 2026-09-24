/**
 * `ui/select` 与 `ui/label` 的"自己那份契约"判据（地板第 2 档第十三批·外壳档）。
 *
 * 这两只是 shadcn 那套薄壳，产品逻辑一行都没有——所以这里**不判 Radix 的行为**，
 * 只判这个文件替调用点做的那三个决定（全应用用它们的只有三只文件：`ProviderSelect`
 * 与 `ExportPanel` 用 select，`ApiSettings` 与 `ProviderSelect` 用 label），
 * 坏起来的形状都是"设置页某一格悄悄不对了"：
 * 1) **选中值靠 `ItemText` 回显**：`SelectItem` 把 children 包进 `ItemText`，触发器上
 *    那句当前值就是从这里取的。哪天有人"精简"成直接放 children，症状是**下拉选完，
 *    框里回到空白**——选项本身照样能选，所以两层界面都不一定看得出来。
 * 2) **`cn` 是"合并"不是"顶掉"**：调用点都往这些原子上挂自己的 `className`
 *    （`ProviderSelect.tsx:21` 的 `w-full`、`ExportPanel.tsx:136` 的 `flex-1 h-8 text-xs`、
 *    `ApiSettings` 那七行 `text-xs`）。坏法是把它写成 `className ?? 默认`，症状是**焦点环、
 *    禁用置灰这些不冲突的默认一起丢掉**，而界面看着"还是那个下拉"。
 * 3) **`id` 要能穿到触发器上**：`ProviderSelect.tsx:16/21` 那对 `Label htmlFor` ↔
 *    `SelectTrigger id` 就是靠 `{...props}` 透传成立的，点标签聚焦不到控件、读屏也念不出名字。
 *
 * 量不到的一格，写在明处：`SelectContent` 走 `Portal` + 默认 `position="popper"`，
 * 它们的真后果（列表不被设置页那只滚动容器裁掉、能滚到最后一项）只有真浏览器量得到。
 * 这一档只判"这两个决定有没有照走"——portal 用"列表不在触发器子树里"钉，popper 用它
 * 独有的两套类钉（Content 上按侧平移的两条 + Viewport 上消费 `var(--radix-select-trigger-*)`
 * 的两条）——真裁切留给浏览器层：**浏览器层现在唯一的下拉判据 B16 打的是原生
 * `<select>`（`BookSelect.tsx:616`），这只组件在 e2e 一条都没有**，已记账到"还欠的"里。
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../select";
import { Label } from "../label";

const OPTIONS = { a: "第一本", b: "第二本", c: "第三本" };

/** 一只受控下拉：默认开着，用例只管看它渲染成什么样。 */
function pickers(props: { value?: string; onValueChange?: (v: string) => void; open?: boolean } = {}) {
  const onValueChange = props.onValueChange ?? vi.fn();
  return render(
    <Select open={props.open ?? true} value={props.value ?? "b"} onValueChange={onValueChange}>
      <SelectTrigger id="picked" data-testid="trigger" aria-label="挑一本">
        <SelectValue placeholder="还没选" />
      </SelectTrigger>
      <SelectContent data-testid="content">
        <SelectGroup>
          {Object.entries(OPTIONS).map(([v, label]) => (
            <SelectItem key={v} value={v}>{label}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>,
  );
}

beforeAll(() => {
  // Radix 的开合挂在 pointer 事件上，并会去摸 pointer capture 与 scrollIntoView——
  // 这两个 jsdom 都没实现，不补的话"列表根本没渲染"会被读成产品坏了
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.releasePointerCapture = (id: number) => id;
  proto.hasPointerCapture = () => false;
});

describe("ui/select：选中值的回显来源", () => {
  it("触发器上那句当前值来自 ItemText——选完却显示空，就是这条断了", () => {
    pickers({ value: "c" });
    expect(screen.getByTestId("trigger")).toHaveTextContent("第三本");
    // 占位符只属于"一个都没选中"那一档，有值时不许还挂着
    expect(screen.getByTestId("trigger")).not.toHaveTextContent("还没选");
  });

  it("没选过的时候才显示 placeholder", () => {
    render(
      <Select open={false}>
        <SelectTrigger data-testid="trigger"><SelectValue placeholder="还没选" /></SelectTrigger>
        <SelectContent><SelectItem value="a">第一本</SelectItem></SelectContent>
      </Select>,
    );
    expect(screen.getByTestId("trigger")).toHaveTextContent("还没选");
  });

  it("点一个选项要把新值交回调用方（onValueChange 是两个调用点唯一的出口）", () => {
    const onValueChange = vi.fn();
    pickers({ value: "b", onValueChange });
    expect(screen.queryByRole("listbox"), "前提：列表这一档在 jsdom 里真开了").toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "第三本" }));
    expect(onValueChange).toHaveBeenCalledWith("c");
  });
});

describe("ui/select：className 是合并，不是顶掉", () => {
  it("消费者给的 h-8 挤掉默认的 h-10，但焦点环、禁用置灰这些不冲突的还得在", () => {
    const { unmount } = render(
      <Select open={false}>
        <SelectTrigger className="h-8 w-full" data-testid="trigger"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="a">第一本</SelectItem></SelectContent>
      </Select>,
    );
    const cls = String(screen.getByTestId("trigger").className);
    expect(cls).toContain("h-8");
    expect(cls).not.toContain("h-10");
    expect(cls).toContain("focus:ring-2");
    expect(cls).toContain("disabled:opacity-50");
    expect(cls).toContain("items-center");
    unmount();

    pickers();
    const item = screen.getByRole("option", { name: "第二本" });
    expect(String(item.className)).toContain("pl-8");
    expect(String(item.className)).toContain("data-[disabled]:opacity-50");
  });

  it("列表默认走 popper 那一套尺寸类（Radix 自己的默认是 item-aligned，这只文件特意改掉它）", () => {
    pickers();
    // role="listbox" 就落在 Content 那只元素上，portal 的宿主 div 是它的父级且没有 class
    const content = screen.getByRole("listbox");
    const cls = String(content.className);
    // 这四条按侧平移只属于 popper 分支（这里钉两条），position 回到 Radix 默认就一行都没有
    expect(cls).toContain("data-[side=bottom]:translate-y-1");
    expect(cls).toContain("data-[side=top]:-translate-y-1");
    // Viewport 不是第一个孩子：Radix 先插一只 <style>（transform-origin），按角色取
    const viewport = content.querySelector('[role="presentation"]') as HTMLElement;
    expect(viewport, "前提：Viewport 这一层在列表里找得到").toBeTruthy();
    const v = String(viewport.className);
    expect(v).toContain("min-w-[var(--radix-select-trigger-width)]");
    expect(v).toContain("h-[var(--radix-select-trigger-height)]");
  });

  it("列表渲染在 Portal 里，不在触发器那棵子树内（否则会被设置页的滚动容器裁掉）", () => {
    const { container } = pickers();
    const trigger = screen.getByTestId("trigger");
    const listbox = screen.getByRole("listbox");
    expect(trigger.contains(listbox)).toBe(false);
    // 真出 portal 的证据是"它不在本次渲染的那棵子树里"——只判 body 的话，去掉 Portal 照样绿
    expect(container.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);
  });

  it("触发器要能把 id / disabled 这些原生属性穿下去（Label 的 htmlFor 靠它对上号）", () => {
    render(
      <Select open={false}>
        <SelectTrigger id="active-provider" disabled data-testid="trigger"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="a">第一本</SelectItem></SelectContent>
      </Select>,
    );
    const trigger = screen.getByTestId("trigger");
    expect(trigger).toHaveAttribute("id", "active-provider");
    expect(trigger).toBeDisabled();
  });
});

describe("ui/label：那只 <label> 该带的东西", () => {
  it("渲染成真 label 并把 for 指到控件 id（点标签能聚焦、读屏念得出名字）", () => {
    render(
      <div>
        <Label htmlFor="active-provider">API 提供商</Label>
        <Select open={false}>
          <SelectTrigger id="active-provider" data-testid="trigger"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="a">第一本</SelectItem></SelectContent>
        </Select>
      </div>,
    );
    const label = screen.getByText("API 提供商");
    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveAttribute("for", "active-provider");
    expect(screen.getByRole("combobox", { name: "API 提供商" })).toBeInTheDocument();
  });

  it("给了自己的 className 也不许丢掉不冲突的默认（peer-disabled 那两条与字重）", () => {
    render(<Label htmlFor="x" className="text-xs" data-testid="label">上限</Label>);
    const cls = String(screen.getByTestId("label").className);
    expect(cls).toContain("text-xs");
    expect(cls).not.toContain("text-sm");
    expect(cls).toContain("font-medium");
    expect(cls).toContain("peer-disabled:cursor-not-allowed");
    expect(cls).toContain("peer-disabled:opacity-70");
    // 刻意不判 leading-none：tailwind-merge 把 font-size 与 line-height 算同一族，
    // 实测 text-xs 会连 leading-none 一起吃掉。哪天"补回"它，是改库的行为不是修 bug。
  });
});
