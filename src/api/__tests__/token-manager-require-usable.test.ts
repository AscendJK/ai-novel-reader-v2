/**
 * requireUsableInput —— 预算不够就直接失败的那道闸门
 *
 * 它是 summarizer / useSummarizer（章节总结、范围总结、问答）唯一的入口守卫：
 * 放行了就会把只剩指令本的 prompt 发给模型，模型凭章节标题 hallucinate 出一篇
 * “总结”并正常入库（round 2 R-07）。round 3 R-73 又是它：抛错的位置在 startTask
 * 之后，把 AI 运行态永久锁住、连带静默停掉同步。所以它的边界值和报错文案都要锁。
 */
import { describe, it, expect } from "vitest";
import {
  requireUsableInput,
  computeAvailableInput,
  resolveOutputReserve,
  getTokenBudget,
  setDiscoveredContextWindow,
  MIN_USABLE_INPUT_TOKENS,
  MIN_OUTPUT_RESERVE,
  type TokenBudget,
} from "../token-manager";

/** 造预算：`maxOutputTokens` 现在是"用户填的或学到的"，不填就没有上限（表里那一列已删） */
const budget = (contextWindow: number, maxOutputTokens?: number): TokenBudget => ({
  contextWindow,
  maxOutputTokens,
});

describe("getTokenBudget 的用户自定义输出上限", () => {
  // 报错文案让用户"调低输出上限"，而这个值在模型命中预算表时被丢掉——两条路径必须一致
  it("模型命中预算表时，用户填的输出上限仍然算数", () => {
    const b = getTokenBudget("gpt-4o", undefined, 4096);
    expect(b.maxOutputTokens).toBe(4096);
    expect(b.contextWindow).toBe(128000); // 窗口仍取表里的
  });

  it("版本化模型走前缀匹配时也一样", () => {
    const b = getTokenBudget("gpt-4o-mini-2024-07-18", undefined, 2048);
    expect(b.maxOutputTokens).toBe(2048);
    expect(b.contextWindow).toBe(128000);
  });

  it("服务端自报过上下文长度时，用户上限也不能被表值顶掉", () => {
    setDiscoveredContextWindow("某未知模型-x", 32000);
    const b = getTokenBudget("某未知模型-x", undefined, 1024);
    expect(b.contextWindow).toBe(32000);
    expect(b.maxOutputTokens).toBe(1024);
  });

  it("不填用户上限也不学：输出侧一个数都不造（表里那一列 2026-09-27 已删）", () => {
    // 老期望是 `16384`——那是按模型名从表里查出来的"最大输出"。删它的原因见 `getTokenBudget` 头上：
    // 未命中就落 4096，而 4096 正好是推理型厂商"思考吃满、正文一个字都不回"的那道闸。
    expect(getTokenBudget("gpt-4o").maxOutputTokens).toBeUndefined();
  });

  it("用户调低输出上限要真的换回更多输入空间", () => {
    // 走调用点真实的链路：预留由 `resolveOutputReserve` 算，输入空间按那个预留扣。
    const wide = computeAvailableInput(getTokenBudget("gpt-4o", undefined, 16384), resolveOutputReserve(getTokenBudget("gpt-4o", undefined, 16384), 16384));
    const tight = computeAvailableInput(getTokenBudget("gpt-4o", undefined, 2048), resolveOutputReserve(getTokenBudget("gpt-4o", undefined, 2048), 16384));
    expect(tight).toBeGreaterThan(wide);
  });
});

describe("requireUsableInput", () => {
  it("刚好够用（available === 下限）时放行，并原样返回可用量", () => {
    // ctx=2000：safetyMargin=min(1000,100)=100；预留走唯一出处（1388）→ 2000-1388-100=512
    const b = budget(2000);
    const reserve = resolveOutputReserve(b, 1388, "问答");
    expect(computeAvailableInput(b, reserve)).toBe(MIN_USABLE_INPUT_TOKENS);
    expect(requireUsableInput(b, reserve, "问答")).toBe(MIN_USABLE_INPUT_TOKENS);
  });

  it("调用点绕过预留自己超要时直接拒，且文案里的数字与 computeAvailableInput 同源", () => {
    // available = ctx − 整份要的输出 − min(1000, 5%ctx)。**不再拿表里的上限改写这一份扣减**，
    // 所以调用点超要会直接把可用量压到 0（老口径下它会被钳成 1388，量出来是 511）。
    const b = budget(1998, 1388);
    const available = computeAvailableInput(b, 2048);
    expect(available).toBe(0);
    let msg = "";
    try {
      requireUsableInput(b, 2048, "问答");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(`可用输入约 ${available} tokens`);
    expect(msg).toContain("上下文窗口不足以生成问答");
  });

  it("拒绝理由带上调用方给的名字——用户要知道是哪件事做不了", () => {
    const b = budget(1000, 512);
    expect(() => requireUsableInput(b, 512, "章节总结")).toThrow(/章节总结/);
    expect(() => requireUsableInput(b, 512, "人物关系图")).toThrow(/人物关系图/);
    expect(() => requireUsableInput(b, 512)).toThrow(/该请求/); // 默认措辞
  });

  it("窗口极小时可用量报 0 而不是负数（负数会让下游按“截到负数字符”把正文切光）", () => {
    const b = budget(500, 4096);
    expect(computeAvailableInput(b, 4096)).toBe(0);
    expect(() => requireUsableInput(b, 4096, "问答")).toThrow(/可用输入约 0 tokens/);
  });

  /**
   * **这条的口径 2026-09-27 翻了一次**。老的那条叫「按模型上限计，不报调用方要的数」，防的也是真坑：
   * 那时预留会被表里的模型上限改写（要 8000、实际只给 1000），文案若报 8000，用户就会去调
   * "输出上限"，而那个设置当时根本不参与这件事——调了也没用。
   * 现在表里那一列删了，`resolveOutputReserve` 出来多少就真扣多少，"报实际扣的那个数"才不说假话。
   */
  it("文案里的\"输出预留\"就是真正拿去扣的那个数（不再有第二个数冒充它）", () => {
    const b = budget(520, 1000);
    let msg = "";
    let reserve = Number.NaN;
    try {
      reserve = resolveOutputReserve(b, 8000, "图谱");
    } catch (e) {
      msg = (e as Error).message;
    }
    // 窗口连一档像样的输出都供不起 → 守卫自己抛，报的是它当时试的那个 `MIN_OUTPUT_RESERVE`
    expect(Number.isNaN(reserve)).toBe(true);
    expect(msg).toContain(`输出预留 ${MIN_OUTPUT_RESERVE}`);
    expect(msg).toContain("窗口 520");
    expect(msg).toContain("调低输出上限");
    expect(msg).not.toContain("输出预留 8000");
  });

  it("放行时返回值就是下游拿来当字符预算的那个数（两处口径不许漂移）", () => {
    const b = budget(200_000, 8192);
    expect(requireUsableInput(b, 4096, "范围总结")).toBe(computeAvailableInput(b, 4096));
  });
});
