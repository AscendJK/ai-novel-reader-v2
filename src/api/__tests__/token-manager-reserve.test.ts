/**
 * `resolveOutputReserve` —— 输出预留的唯一出处
 *
 * 为什么要有这个函数：过去每个 AI 任务把输出预算写成字面常数，并以
 * `Math.min(模型或用户的上限, 常数)` 同时决定"发出去的 max_tokens"和"输入侧留多少"。
 * 于是设置页那句「填写后优先使用……设为模型自身上限即可避免回答被截断」是假的：
 * 用户填 8192，人物分析与时间线仍然只拿到 4096（真厂商实测：`deepseek-flash` 在 4096 里
 * 把预算全花在 reasoning 上，正文 0 字）。
 *
 * 但预留与可用输入是 1:1 兑换（实测：128k 窗口 N 2048→8192 把可用输入 124,952→118,808；
 * 32k 窗口 + 上限 8192 时范围总结能带的整章数 9→7）。所以让路必须带钳制：
 * **抬预留不许把输入挤到 `requireUsableInput` 的门下**。
 */
import { describe, it, expect } from "vitest";
import {
  resolveOutputReserve,
  getTokenBudget,
  computeAvailableInput,
  requireUsableInput,
  MIN_USABLE_INPUT_TOKENS,
  type TokenBudget,
} from "../token-manager";

/** 未命中预算表的模型（表默认输出上限 4096）+ 显式窗口，逐条控制两个变量 */
const budget = (contextWindow: number, userCap?: number): TokenBudget =>
  getTokenBudget("reserve-probe-model", contextWindow, userCap);

describe("用户没填输出上限时：行为与今天一字不差", () => {
  it("逐档等于任务预设本身：没有任何别的数再压它一层", () => {
    // 老的那条叫「逐档等于旧的 Math.min(上限, 常数)（表默认 4096）」——那个"上限"是预算表按模型名
    // 猜出来的，猜小了就把分析类要的 8192 压成 4096（真厂商实测：思考吃满、正文 0 字）。
    // 那一列 2026-09-27 删了，所以这里逐档断言"要多少拿多少"，窗口 128k 时它不该成为阻力。
    const b = budget(128000);
    for (const taskDefault of [1024, 2048, 4096, 8192, 16384]) {
      expect(resolveOutputReserve(b, taskDefault, "任务")).toBe(taskDefault);
    }
  });

  it("用户没填就没有让路这回事：不许凭空造一个上限", () => {
    expect(getTokenBudget("reserve-probe-model", 128000).userMaxOutputTokens).toBeUndefined();
    expect(getTokenBudget("reserve-probe-model", 128000, 8192).userMaxOutputTokens).toBe(8192);
  });
});

describe("用户填过输出上限时常数让路", () => {
  it("填 8192：任务默认 4096 也要拿到 8192（旧实现卡死在 4096）", () => {
    const b = budget(128000, 8192);
    expect(resolveOutputReserve(b, 4096, "人物关系分析")).toBe(8192);
  });

  it("填 8192：小默认（章节摘要 1024）同样抬得动", () => {
    const b = budget(128000, 8192);
    expect(resolveOutputReserve(b, 1024, "章节总结")).toBe(8192);
  });

  it("用户填得比表值低时仍然算数（钳低不是钳高）", () => {
    const b = budget(128000, 2048);
    expect(resolveOutputReserve(b, 4096, "剧情时间线")).toBe(2048);
  });
});

describe("窗口钳制：抬预留不许新增「上下文不足」", () => {
  it("窗口装不下用户上限时按窗口钳，且此后 requireUsableInput 必过", () => {
    // W=8192：safetyMargin=min(1000,409)=409 → 钳到 8192−409−512=7271
    const b = budget(8192, 8192);
    const reserve = resolveOutputReserve(b, 1024, "章节总结");
    expect(reserve).toBe(8192 - 409 - MIN_USABLE_INPUT_TOKENS);
    expect(() => requireUsableInput(b, reserve, "章节总结")).not.toThrow();
  });

  it("预留与可用输入 1:1 兑换：钳制只砍超出窗口的部分，不多扣", () => {
    const wide = budget(128000, 8192);
    const narrow = budget(8192, 8192);
    expect(resolveOutputReserve(wide, 1024, "章节总结")).toBe(8192);
    const r = resolveOutputReserve(narrow, 1024, "章节总结");
    expect(computeAvailableInput(narrow, r)).toBeGreaterThanOrEqual(MIN_USABLE_INPUT_TOKENS);
    // 同一个预留值放进 128k 窗口，可用输入恰好少这么多（钉的是"没有第二处隐藏扣减"）
    expect(computeAvailableInput(wide, r)).toBe(128000 - 1000 - r);
  });

  it("窗口小到连最小可用输入都给不出时照旧报错，并点名是哪个任务", () => {
    // 1000−50(5%)−512 = 438：预留抬到能写东西的最小值 512 之后，可用输入只剩 438
    const b = budget(1000, 2048);
    expect(() => resolveOutputReserve(b, 4096, "问答")).toThrow(/上下文窗口不足以生成问答/);
    expect(() => resolveOutputReserve(b, 4096, "问答")).toThrow(/可用输入约 438 tokens/);
  });

  it("用户故意把上限调到很小（256）时照他的话办，不报「上下文不足」", () => {
    // 设置页那个数字框只有 min=128 没有 max，256 填得进来。窗口够大时这是合法偏好，
    // 不是预算事故——把它报错等于替用户改主意。
    const b = budget(128000, 256);
    expect(resolveOutputReserve(b, 4096, "章节总结")).toBe(256);
  });
});
