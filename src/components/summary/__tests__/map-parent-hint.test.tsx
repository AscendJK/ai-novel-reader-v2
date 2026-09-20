/**
 * 地图面板上"上级没找到"那一行（批次 I）
 *
 * 模型给的 parentId 对不上时，地点会被降级成顶级放置——数据不能因为一次幻觉整图作废，
 * 但也不能把猜出来的层级当成事实。这一行提示就是让降级可见；它一旦静默消失，用户看到的
 * 就是一张"莫名少了父子关系"的地图。
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NovelMapSection } from "../../summary/shared/NovelMapSection";
import type { MapData } from "@/agents/types";

function mapWith(over: Partial<MapData>): MapData {
  return {
    layers: [
      { level: 1, name: "天下", description: "" },
      { level: 2, name: "州域", description: "" },
    ],
    places: [
      { id: "1", name: "洛阳", type: "都城", level: 1, parentId: "", description: "", importance: 9, x: 500, y: 500, affiliation: "" },
      { id: "2", name: "黑木崖", type: "秘境", level: 1, parentId: "", description: "", importance: 6, x: 300, y: 300, affiliation: "" },
    ],
    regions: [],
    forces: [],
    ...over,
  };
}

function renderMap(mapData: MapData) {
  return render(
    <NovelMapSection
      novelId="book-1"
      isOpen
      loading={false}
      mapData={mapData}
      onClick={vi.fn()}
      onGenerate={vi.fn(async () => {})}
      onRegenerate={vi.fn(async () => {})}
    />
  );
}

describe("上级没找到的提示行", () => {
  it("列出被降级的地点名与数量", () => {
    renderMap(mapWith({ parentMissing: ["黑木崖", "梅庄"] }));
    const line = screen.getByText(/上级没找到/);
    expect(line.textContent).toContain("2 个地点");
    expect(line.textContent).toContain("黑木崖");
    expect(line.textContent).toContain("梅庄");
  });

  it("超过三个只点名前三个，其余折成「等」", () => {
    renderMap(mapWith({ parentMissing: ["A崖", "B庄", "C寺", "D峰", "E谷"] }));
    const line = screen.getByText(/上级没找到/);
    expect(line.textContent).toContain("5 个地点");
    expect(line.textContent).toContain("A崖");
    expect(line.textContent).toContain("C寺");
    expect(line.textContent).not.toContain("D峰");   // 手机上不能把提示撑成一段话
    expect(line.textContent).toContain("等");
  });

  it("没有 parentMissing（正常地图与历史旧地图）时这行不存在", () => {
    renderMap(mapWith({}));
    expect(screen.queryByText(/上级没找到/)).toBeNull();
  });

  it("清单是空数组时也不显示（旧数据里可能留着一只空数组）", () => {
    renderMap(mapWith({ parentMissing: [] }));
    expect(screen.queryByText(/上级没找到/)).toBeNull();
  });
});
