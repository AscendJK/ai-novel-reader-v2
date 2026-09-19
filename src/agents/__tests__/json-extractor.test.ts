/**
 * json-extractor 测试
 */

import { describe, it, expect } from "vitest";
import { extractJSON } from "../json-extractor";

describe("extractJSON", () => {
  it("应正常解析合法 JSON", () => {
    expect(extractJSON('{"a": 1}')).toEqual({ a: 1 });
  });

  it("字符串值中的 URL 不应被注释剥离截断", () => {
    // 旧实现用 /\/\/.*$/gm 全局删注释，会把 "https://..." 截成 "https:"
    const input = '{"url": "https://example.com/a", "n": 1}';
    expect(extractJSON(input)).toEqual({ url: "https://example.com/a", n: 1 });
  });

  it("应删除字符串之外的单行注释", () => {
    const input = `{
      // 这是注释
      "a": 1, // 行尾注释
      "b": "文本 // 不是注释"
    }`;
    expect(extractJSON<{ a: number; b: string }>(input)).toEqual({
      a: 1,
      b: "文本 // 不是注释",
    });
  });

  it("字符串内的 // 出现在转义引号后仍不被误删", () => {
    const input = '{"s": "say \\"hi\\" at https://x.com", "ok": true}';
    expect(extractJSON(input)).toEqual({ s: 'say "hi" at https://x.com', ok: true });
  });

  it("应剥离 markdown 代码块包裹", () => {
    const input = '```json\n{"a": 2}\n```';
    expect(extractJSON(input)).toEqual({ a: 2 });
  });

  it("应移除尾逗号", () => {
    const input = '{"a": [1, 2, 3,],}';
    expect(extractJSON(input)).toEqual({ a: [1, 2, 3] });
  });

  it("应从混杂文本中提取第一个平衡的 JSON 对象（字符串内花括号不干扰）", () => {
    const input = '结果如下：{"text": "包含 } 和 { 的字符串", "v": 2} 以上。';
    expect(extractJSON(input)).toEqual({ text: "包含 } 和 { 的字符串", v: 2 });
  });

  it("截断修复：闭合未完成的 JSON（fixTruncated）", () => {
    const input = '{"a": 1, "items": [{"n": "x"}, {"n": "y"';
    const result = extractJSON<{ a: number; items: { n: string }[] }>(input, { fixTruncated: true });
    expect(result).not.toBeNull();
    expect(result?.a).toBe(1);
    expect(result?.items.length).toBeGreaterThanOrEqual(1);
  });

  it("完全无法解析时返回 null", () => {
    expect(extractJSON("这不是 JSON")).toBeNull();
  });

  // ── 围栏剥离（round 2 R-38）───────────────────────────────
  it("前缀说明文字 + ```json 围栏仍能提取", () => {
    const r = extractJSON<{ nodes: number[] }>(
      '以下是 JSON：\n```json\n{"nodes": [1,2]}\n```\n希望有帮助'
    );
    expect(r).toEqual({ nodes: [1, 2] });
  });

  it("只有开头围栏没有闭合（输出被截断）不导致整体失败", () => {
    const r = extractJSON<{ a: number }>('说明：\n```json\n{"a": 1}');
    expect(r).toEqual({ a: 1 });
  });

  it("围栏内带尾逗号也能解析", () => {
    const r = extractJSON<{ list: number[] }>('```json\n{"list": [1,2,],}\n```');
    expect(r).toEqual({ list: [1, 2] });
  });

  it("JSON 字符串值里的三反引号不被当成围栏", () => {
    const r = extractJSON<{ code: string }>('{"code": "``` 不是围栏 ```"}');
    expect(r).toEqual({ code: "``` 不是围栏 ```" });
  });
});
