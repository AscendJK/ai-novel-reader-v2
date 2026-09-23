/**
 * 400 的两种"超限"必须分得开：喂进去的原文太长 ≠ 要的输出太长
 *
 * 之前所有带 maximum / limit / token / length 字样的 400 都归到 `context_length`，
 * 于是厂商说"max_tokens 太大"时界面回的是"请尝试使用支持更长上下文的模型，或拆分成
 * 较短的请求"——两条建议都没指到病因（该调的是设置里那个「最大输出 token」）。抬了默认
 * 输出预算之后这条路真会走到：未收录的模型按表默认给上限，用户手工填 8192 就可能顶到
 * 厂商的输出处上。（污染窗口那位风险早在 `extractContextLength` 挡掉了：它认出"这是在
 * 讲输出"就不返回数字，所以本修的是判读，不是花钱。）
 */
import { describe, it, expect } from "vitest";
import { APIError, handleFetchError } from "../error-handler";

async function classify(status: number, body: unknown): Promise<APIError> {
  const res = new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const err = await handleFetchError(res).then(() => null, (e) => e);
  expect(err, "handleFetchError 必须抛 APIError").toBeInstanceOf(APIError);
  return err as APIError;
}

/** 厂商原话要留在文案里：那里面带着"真上限是多少"，用户照着调才有数 */
function withMessage(msg: string) {
  return { error: { message: msg, type: "invalid_request_error" } };
}

describe("输入侧超限：仍然判成 context_length", () => {
  it("OpenAI 经典句式（提到 completion 也不算输出侧）", async () => {
    const e = await classify(400, withMessage(
      "This model's maximum context length is 8192 tokens. However, you requested 12000 tokens (12000 in your prompt; 0 for the completion). Please reduce the length of the messages or completion.",
    ));
    expect(e.apiCode).toBe("context_length");
    expect(e.message).toContain("上下文长度");
  });

  it("Anthropic 的 prompt is too long", async () => {
    const e = await classify(400, withMessage("prompt is too long: 210000 tokens > 200000 maximum"));
    expect(e.apiCode).toBe("context_length");
  });

  it("中文厂商的输入长度超限", async () => {
    const e = await classify(400, withMessage("输入长度超过模型上下文上限，请减少传入文本"));
    expect(e.apiCode).toBe("context_length");
  });
});

describe("输出侧超限：不许再算成上下文长度", () => {
  // 变异：删掉输出侧那一支 → 这一组四条全红在 apiCode 上；
  //       把两支的顺序颠倒（先判输出）→ 上面"输入侧"三条与下面混合句式红
  it("OpenAI 的 Invalid 'max_tokens'", async () => {
    const e = await classify(400, withMessage("Invalid 'max_tokens': 16000. Ensure that 'max_tokens' is between '1' and '4096'."));
    expect(e.apiCode).toBe("output_limit");
  });

  it("Anthropic 的 max_tokens 大于允许值", async () => {
    const e = await classify(400, withMessage("max_tokens: 64000 is greater than the maximum allowed for this model: 8192"));
    expect(e.apiCode).toBe("output_limit");
  });

  it("中文厂商的「输出长度」超限", async () => {
    const e = await classify(400, withMessage("输出长度超过模型限制，最大支持 4096 tokens"));
    expect(e.apiCode).toBe("output_limit");
  });

  it("文案指向「最大输出 token」，不再支使用更长上下文的模型", async () => {
    const e = await classify(400, withMessage("Invalid 'max_tokens': 16000. Ensure that 'max_tokens' is between '1' and '4096'."));
    expect(e.message).toContain("最大输出");
    expect(e.message).not.toContain("更长上下文");
    // 真上限的数字来自厂商原话，界面上一眼就能照着调
    expect(e.message).toContain("4096");
  });

  it("error 直接是字符串的错误体也认得出来（部分 OpenAI 兼容厂商这么回）", async () => {
    const e = await classify(400, { error: "max_tokens is too large: 16000, model maximum is 4096" });
    expect(e.apiCode).toBe("output_limit");
  });
});

describe("既讲上下文又讲输出时，以上下文为准（少花钱优先）", () => {
  it("同时出现 context 与 max_tokens 的混合句式", async () => {
    const e = await classify(400, withMessage(
      "context length exceeded: reduce the prompt or the max_tokens (context is 8192)",
    ));
    expect(e.apiCode).toBe("context_length");
  });
});
