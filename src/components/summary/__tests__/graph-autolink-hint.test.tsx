/**
 * 图谱「兜底关系链」的可见标注
 *
 * 模型一条关系都没回时，`graph-agent.ts` 会按人物顺序补一条链（label 一律是「关联」）。
 * 补链本身留着（界面不至于空网），但它**长得和真关系一模一样**——用户会把它当成
 * 模型读出来的分析。R-E7（真后端真厂商）就是被这一点逼着改判据的：光看界面上的
 * 「N 条关系」根本分不清是哪一种。所以补出来的边带 `autoLinked` 标记，界面必须说出来。
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CharacterGraphSection } from "../../summary/shared/CharacterGraphSection";
import type { GraphData } from "@/hooks/useSummarizer";

function graph(edges: GraphData["edges"]): GraphData {
  return {
    nodes: [
      { id: "令狐冲", group: "主角", description: "华山派大弟子" },
      { id: "任盈盈", group: "主角", description: "日月神教圣姑" },
      { id: "岳不群", group: "反派", description: "华山派掌门" },
    ],
    edges,
  };
}

function renderSection(g: GraphData) {
  return render(
    <CharacterGraphSection
      isOpen={false}
      onClick={vi.fn()}
      loading={false}
      graphData={g}
      onGenerate={vi.fn(async () => {})}
      onRegenerate={vi.fn(async () => {})}
    />,
  );
}

const autoTwo: GraphData["edges"] = [
  { source: "令狐冲", target: "任盈盈", label: "关联", autoLinked: true },
  { source: "任盈盈", target: "岳不群", label: "关联", autoLinked: true },
];

describe("兜底关系链要说出来", () => {
  it("全是补出来的链时，提示行报出条数并说清不是模型给的", () => {
    renderSection(graph(autoTwo));
    const line = screen.getByText(/不是模型/);
    expect(line.textContent).toContain("2");
    // 计数行还在，且说的数与提示行对得上（别一边说 2 条关系、一边说 0）
    expect(screen.getByText(/3 个角色 · 2 条关系/)).toBeTruthy();
  });

  it("模型真回了关系就不许出现这条提示（否则诚实的图谱被污成有假线）", () => {
    renderSection(graph([
      { source: "令狐冲", target: "任盈盈", label: "恋人" },
      { source: "令狐冲", target: "岳不群", label: "师徒" },
    ]));
    expect(screen.queryByText(/不是模型/)).toBeNull();
  });

  it("混着的时候只报补出来的那几条的数量", () => {
    renderSection(graph([
      { source: "令狐冲", target: "任盈盈", label: "恋人" },
      { source: "任盈盈", target: "岳不群", label: "关联", autoLinked: true },
    ]));
    const line = screen.getByText(/不是模型/);
    expect(line.textContent).toContain("1");
    expect(line.textContent).not.toContain("2 条");
  });
});
