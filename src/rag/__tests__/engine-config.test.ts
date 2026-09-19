/**
 * 引擎白名单与 modelKey 解析（round 3 批次 D）
 *
 * `server/lib/engine-config.js` 此前是双重空白：既没有单测也没有探针可达，
 * 而它决定服务端拿哪个模型建库。
 * 关键是原型链上的键：`ENGINE_MODEL_MAP["constructor"]` 是真值，
 * 用对象取值的写法就会把 Object 构造函数当 modelKey 交给下游。
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error - 后端 JS 模块无类型声明
const cfg = await import("../../../server/lib/engine-config.js");
const { resolveModelKey, isAllowedEngine, allowedEngineList, VALID_ENGINES, DEFAULT_ENGINE } = cfg as {
  resolveModelKey: (e: unknown) => unknown;
  isAllowedEngine: (e: unknown) => boolean;
  allowedEngineList: () => string[];
  VALID_ENGINES: Set<string>;
  DEFAULT_ENGINE: string;
};

const PROTO_KEYS = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"];

describe("引擎白名单", () => {
  it("白名单内每个引擎都原样解析出自己的 modelKey", () => {
    for (const e of allowedEngineList()) {
      expect(isAllowedEngine(e)).toBe(true);
      expect(resolveModelKey(e)).toBe(e);
    }
    expect(allowedEngineList().sort()).toEqual([...VALID_ENGINES].sort());
  });

  it("未知引擎退回默认模型，且返回值必须是字符串", () => {
    for (const bad of ["", "not-an-engine", "Xenova/evil", undefined, null, 0, {}, []]) {
      expect(resolveModelKey(bad)).toBe(DEFAULT_ENGINE);
    }
  });

  it("原型链上的键不得通过白名单", () => {
    for (const key of PROTO_KEYS) {
      expect(isAllowedEngine(key)).toBe(false);
    }
  });

  it("原型链上的键不得让 resolveModelKey 吐出非字符串（对象取值写法会漏）", () => {
    for (const key of PROTO_KEYS) {
      const resolved = resolveModelKey(key);
      expect(typeof resolved).toBe("string");
      expect(VALID_ENGINES.has(resolved as string)).toBe(true);
    }
  });
});
