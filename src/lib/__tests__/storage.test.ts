/**
 * safeGet / safeSet / safeGetBool / safeGetNum（src/lib/storage.ts）
 *
 * 这只模块唯一的取用方是 `src/stores/ui-store.ts`（字号、行距、主题、自动翻页那十几个初始值
 * 全从它读），而它存在的**唯一理由**是"localStorage 在隐私模式 / 配额满的时候会抛"。
 * 所以判据的重心不是"读得到写得了"，而是两件事：
 * 1. **不许把异常抛到界面上**——一抛就是整个阅读器打不开（四个出口各钉一条）；
 * 2. **回落的是哪一个值**——默认值只在"炸了"那一格生效，"没存过"另有规矩。
 *    这两格混起来的症状是"设置看着像没保存"。
 *
 * 环境事实（本机实测，别照着猜）：
 * - `vi.spyOn(Storage.prototype, "getItem")` **拦不住** `localStorage.getItem`：
 *   jsdom 的 localStorage 不是 `Storage.prototype` 的实例（`Object.getPrototypeOf(localStorage) === Storage.prototype` 为 false），
 *    spy 装上之后直接调用照样返回 null。所以"让它炸"走换掉整个 `globalThis.localStorage` 这条路。
 * - jsdom 里 `setItem(k, "")` 之后 `getItem(k)` 回的是 **null**（真浏览器回 ""），
 *   所以"存过但值为空串"这一格在 jsdom 判不到，这一档不写它（`ui-store.ts:31` 本来就用 `||` 兜住了空串）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { safeGet, safeSet, safeGetBool, safeGetNum } from "../storage";

const realStorage = globalThis.localStorage;
/** 装进去的那一发被记在这里，用来证明"确实炸过"而不是"根本没装上 spy" */
let blown: string[];

function installThrowingStorage(throws: { getItem?: boolean; setItem?: boolean }): void {
  const store = new Map<string, string>();
  const boom = (name: "getItem" | "setItem"): never => {
    blown.push(name);
    throw new DOMException(`${name}: The operation is insecure.`, "SecurityError");
  };
  const fake = {
    getItem: (k: string) => (throws.getItem ? boom("getItem") : store.get(String(k)) ?? null),
    setItem: (k: string, v: string) => {
      if (throws.setItem) boom("setItem");
      store.set(String(k), String(v));
    },
    removeItem: (k: string) => { store.delete(String(k)); },
    clear: () => store.clear(),
    key: () => null,
    length: store.size,
  };
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
}

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: realStorage, configurable: true, writable: true });
  vi.restoreAllMocks();
});

describe("safeGet / safeSet：异常不许外抛，落盘要真的落", () => {
  afterEach(() => localStorage.clear());

  it("写进去的东西读得回来，而且键名一字不差（真落进 localStorage）", () => {
    safeSet("novel-reader-font-size", "22");
    expect(realStorage.getItem("novel-reader-font-size")).toBe("22");
    expect(safeGet("novel-reader-font-size")).toBe("22");
  });

  it("第二次写是覆盖，不是叠一份", () => {
    safeSet("k", "第一次");
    safeSet("k", "第二次");
    expect(safeGet("k")).toBe("第二次");
  });

  it("没存过的键给 null", () => {
    expect(safeGet("没这个键")).toBeNull();
  });

  it("getItem 抛异常 → null，且不往外抛（隐私模式打开阅读器不该白屏）", () => {
    blown = [];
    installThrowingStorage({ getItem: true });
    expect(() => safeGet("novel-reader-theme")).not.toThrow();
    expect(safeGet("novel-reader-theme")).toBeNull();
    expect(blown.length, "前置没立住：压根没模拟到抛异常").toBeGreaterThan(0);
  });

  it("setItem 抛异常（配额满）→ 不抛，调用方后面的语句继续跑", () => {
    blown = [];
    installThrowingStorage({ setItem: true });
    let ranAfterSet = false;
    expect(() => {
      safeSet("novel-reader-theme", "dark");
      ranAfterSet = true;
    }).not.toThrow();
    expect(ranAfterSet, "set 抛出来会把 store 的 setter 整段打断").toBe(true);
    expect(blown).toEqual(["setItem"]);
  });
});

describe("safeGetBool：只有字符串 true 算真，默认值只在炸掉时管用", () => {
  afterEach(() => localStorage.clear());

  it('存 "true" → true', () => {
    realStorage.setItem("novel-reader-debug", "true");
    expect(safeGetBool("novel-reader-debug")).toBe(true);
  });

  it('存 "false" → false（不许把"存过"当成真）', () => {
    realStorage.setItem("novel-reader-debug", "false");
    expect(safeGetBool("novel-reader-debug")).toBe(false);
  });

  it("存别的写法（1 / yes / TRUE / 带空格）都不算真——只认字符串 true", () => {
    for (const raw of ["1", "yes", "TRUE", " true"]) {
      realStorage.setItem("k", raw);
      expect(safeGetBool("k"), `值 ${JSON.stringify(raw)} 不该被当成真`).toBe(false);
    }
  });

  it("键不存在 → false，**即使 defaultVal 给了 true**（钉住现有形状：defaultVal 只管异常那一格）", () => {
    expect(safeGetBool("没这个键", true)).toBe(false);
  });

  it("getItem 抛异常 → 用 defaultVal，两侧各给一个相反的值", () => {
    blown = [];
    installThrowingStorage({ getItem: true });
    expect(safeGetBool("k", true)).toBe(true);
    expect(safeGetBool("k", false)).toBe(false);
    expect(blown.length, "前置没立住").toBeGreaterThan(0);
  });
});

describe("safeGetNum：回落的是默认值，不是 NaN / 半个数 / 越界值", () => {
  afterEach(() => localStorage.clear());

  it("正常值原样回来（含小数）", () => {
    realStorage.setItem("novel-reader-line-height", "1.8");
    expect(safeGetNum("novel-reader-line-height", 9)).toBe(1.8);
  });

  it('存 "0" → 0，不许被"空值判断"吃回默认值', () => {
    realStorage.setItem("novel-reader-para-spacing", "0");
    expect(safeGetNum("novel-reader-para-spacing", 8)).toBe(0);
  });

  it("没存过 → 默认值", () => {
    expect(safeGetNum("没这个键", 18)).toBe(18);
  });

  it("读不出数字（abc / 全是空格 / nan）→ 默认值，不许把 NaN 交出去", () => {
    for (const raw of ["abc", "   ", "nan"]) {
      realStorage.setItem("k", raw);
      const got = safeGetNum("k", 5);
      expect(Number.isNaN(got), `值 ${JSON.stringify(raw)} 落成了 NaN`).toBe(false);
      expect(got).toBe(5);
    }
  });

  it("parseFloat 的形状：尾巴上的垃圾被丢掉（1.8px → 1.8）", () => {
    realStorage.setItem("k", "1.8px");
    expect(safeGetNum("k", 1)).toBe(1.8);
  });

  it("validator 通过就用存的那份，越界就回落默认", () => {
    const inRange = (v: number) => v >= 10 && v <= 150;
    realStorage.setItem("novel-reader-graph-char-limit", "80");
    expect(safeGetNum("novel-reader-graph-char-limit", 50, inRange)).toBe(80);
    realStorage.setItem("novel-reader-graph-char-limit", "9999");
    expect(safeGetNum("novel-reader-graph-char-limit", 50, inRange)).toBe(50);
  });

  it("没给 validator 时任何数字都放行（含负数与超大值——钳位是调用方的事）", () => {
    realStorage.setItem("k", "-3");
    expect(safeGetNum("k", 7)).toBe(-3);
    realStorage.setItem("k", "999999");
    expect(safeGetNum("k", 7)).toBe(999999);
  });

  it("getItem 抛异常 → 默认值，而且不去惊动 validator", () => {
    const validator = vi.fn(() => true);
    blown = [];
    installThrowingStorage({ getItem: true });
    expect(safeGetNum("k", 42, validator)).toBe(42);
    expect(validator, "读都读不到，拿什么校验").not.toHaveBeenCalled();
    expect(blown.length, "前置没立住").toBeGreaterThan(0);
  });
});

/**
 * 判别力台账（2026-09-27 本机，`npx vitest run src/lib/__tests__/storage.test.ts`）。
 * 基线：src/lib/storage.ts = sha256 1f3fe1cd…（产品侧唯一的改动是**删掉 safeRemove**：
 * 全仓 grep 只有它自己那一行定义，唯一的取用方 `ui-store.ts:2` 拿的是另外四只）。
 * 每刀手工下一处、跑完 `cp` 回基线并核 sha。九刀，没有一刀 0 红：
 *
 *  S1 摘掉 safeGet 的 try/catch → 1 红（隐私模式那一格）
 *  S2 摘掉 safeSet 的 try/catch → 1 红（配额满那一格：调用方后面的语句要被拖断）
 *  S3 `=== "true"` 换成 `!== "false"` → 2 红（"1/yes/TRUE/带空格"那格 + "键不存在"那格）
 *  S4 让 defaultVal 也管"没存过"那一格 → 1 红。**这条钉的是现有形状**：将来真要改成
 *     "没存过就用默认"，它会先红着逼调用方一起过一遍（今天两只调用方都没传 defaultVal）。
 *  S5 `if (stored)` 换成 `if (Number(stored))` → 2 红（存着的 0 被当成没存）
 *  S6 摘掉 `!isNaN(parsed)` → 1 红（abc 落成 NaN 交出去）
 *  S7 整个不读 validator → 1 红（越界值被放行）
 *  S8 `parseFloat` 换成 `Number` → 2 红（"1.8px" 与 "   " 两格都露出来：Number("   ") 是 0）
 *  S9 读写偷偷加一层键名前缀 → 2 红（"键名一字不差"与"第二次写是覆盖"）
 *
 * **判不到的一格**（写在这里，而不是拿恒真断言假装判住）：存过但值是空串。
 * 真浏览器 `setItem(k,"")` 之后 `getItem(k)` 回 ""，jsdom 回 null（本机实测：length 是 1、
 * `"k" in localStorage` 却是 false），这一档纯 jsdom 所以判不到；`ui-store.ts:31` 本来就用
 * `||` 兜住了空串，不构成风险。
 */

