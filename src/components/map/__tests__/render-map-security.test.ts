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
