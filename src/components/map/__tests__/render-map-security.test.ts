/**
 * 地图 SVG 注入防护测试（round 2 批次 3 / R-37）
 */

import { describe, it, expect } from "vitest";
import { renderMapToSvg, escapeXml } from "../renderMap";
import type { MapData } from "@/agents/types";

const hostile = `甲城</text><script>alert(1)</script><circle foo="bar"`;

const map: MapData = {
  places: [
    { id: 'p1"><img src=x onerror=alert(1)>', name: hostile, type: hostile, x: 300, y: 400, level: 2, importance: 7, affiliation: hostile, description: hostile },
    // 非法坐标：NaN<0 || NaN>1000 恒为 false，旧实现能一路穿过校验
    { id: "p2", name: "坏坐标城", type: "城", x: Number.NaN, y: "abc" as unknown as number, level: 2, importance: 999, affiliation: "", description: "" },
  ],
  layers: [
    { id: "l1", name: hostile, level: 1 },
    { id: "l2", name: "郡县", level: 2 },
  ],
  connections: [],
} as unknown as MapData;

describe("escapeXml", () => {
  it("转义五个 XML 特殊字符", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });
  it("空值安全", () => {
    expect(escapeXml(undefined)).toBe("");
    expect(escapeXml(null)).toBe("");
  });
});

describe("renderMapToSvg 注入防护", () => {
  const svg = renderMapToSvg(map);

  it("模型产出的文本不能闭合标签注入脚本", () => {
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("</text><script");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("模型产出的引号不能从属性里逃逸", () => {
    // 原文里的未转义引号如果进了 data-id="..."，就能拼出额外属性
    expect(svg).not.toContain('data-id="p1"><img');
    expect(svg).toContain("&quot;");
  });

  it("地名与势力名以转义形式出现在文本节点", () => {
    expect(svg).toContain("甲城&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("非法坐标退化到画面中心而不是产出 NaN 路径", () => {
    expect(svg).not.toContain("NaN");
  });
});

/**
 * 连线路径单独一组：上面那份 fixture 里两个地点都没有 parentId，
 * renderConnections 直接把它们过滤掉了——所以 "不出现 NaN" 那条断言一直没看过连线代码。
 */
describe("renderMapToSvg 父子连线", () => {
  const linked: MapData = {
    places: [
      { id: "a", name: "天下", type: "域", x: 300, y: 400, level: 1, importance: 9, affiliation: "", description: "" },
      { id: "b", name: "洛阳", type: "都城", x: 500, y: 500, level: 2, parentId: "a", importance: 8, affiliation: "", description: "" },
      // 模型漏坐标是真实形态：x 是 NaN、y 是字符串，旧实现拼出 x2="NaN"，整条线不渲染
      { id: "c", name: "虎牢关", type: "关隘", x: Number.NaN, y: "620", level: 3, parentId: "b", importance: 7, affiliation: "", description: "" },
    ],
    layers: [
      { id: "l1", name: "天下", level: 1 },
      { id: "l2", name: "州郡", level: 2 },
      { id: "l3", name: "关隘", level: 3 },
    ],
    connections: [],
  } as unknown as MapData;

  const svg = renderMapToSvg(linked);

  it("带父级的地点确实渲染出了连线（否则下面的断言是空过）", () => {
    expect(svg).toContain("<line");
  });

  it("非法坐标的连线退化到中心，不产出 x2=\"NaN\" 让线消失", () => {
    expect(svg).not.toContain("NaN");
  });
});
