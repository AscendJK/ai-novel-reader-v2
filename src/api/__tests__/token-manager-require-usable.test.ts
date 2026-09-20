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
  MIN_USABLE_INPUT_TOKENS,
  type TokenBudget,
} from "../token-manager";

/** 造一个刚好让 available == MIN 的预算：available = ctx - min(agentMax, maxOut) - min(1000, 5%ctx) */
const budget = (contextWindow: number, maxOutputTokens: number): TokenBudget => ({
  contextWindow,
  maxOutputTokens,
});

describe("requireUsableInput", () => {
  it("刚好够用（available === 下限）时放行，并原样返回可用量", () => {
    // ctx=2000：safetyMargin=min(1000,100)=100，输出预留 2048→按模型上限 1388 → 2000-1388-100=512
    const b = budget(2000, 1388);
    expect(computeAvailableInput(b, 2048)).toBe(MIN_USABLE_INPUT_TOKENS);
    expect(requireUsableInput(b, 2048, "问答")).toBe(MIN_USABLE_INPUT_TOKENS);
  });

  it("差一个 token 就拒，并且文案里的数字与 computeAvailableInput 同源", () => {
    // available = ctx - min(agentMax, maxOut) - min(1000, 5%ctx) = 1998 - 1388 - 99
    const b = budget(1998, 1388);
    const available = computeAvailableInput(b, 2048);
    expect(available).toBe(MIN_USABLE_INPUT_TOKENS - 1);
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

  it("文案里的“输出预留”按模型上限计，不报调用方要的数——否则用户会去调错的那个设置", () => {
    // agent 想要 8000，模型上限只有 1000：available = 1500 - 1000 - 75 = 425 < 512 → 拒
    const b = budget(1500, 1000);
    let msg = "";
    try {
      requireUsableInput(b, 8000, "图谱");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("输出预留 1000");
    expect(msg).not.toContain("输出预留 8000");
    expect(msg).toContain("窗口 1500");
  });

  it("放行时返回值就是下游拿来当字符预算的那个数（两处口径不许漂移）", () => {
    const b = budget(200_000, 8192);
    expect(requireUsableInput(b, 4096, "范围总结")).toBe(computeAvailableInput(b, 4096));
  });
});
