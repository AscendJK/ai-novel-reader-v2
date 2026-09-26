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
import { APIError, handleFetchError, isEmptyResultError } from "../error-handler";

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

/**
 * 「这一发一个字正文都没回」这个形状要有一个唯一的判法。
 *
 * 为什么要有它：agent 的降级重发（空正文才关思考）靠它认失败，而失败有两种写法——provider 抛的那句
 * 与 agent 自己判空白正文时写的那句。判据两头都要钉：**认得全**（两种写法都算），
 * **不顺手扩大化**（超时、CORS、限流、解析失败都不算——那些情况下关掉思考是白关，
 * 还会把"质量优先"的口径悄悄改掉）。
 */
describe("isEmptyResultError：只认「一个字正文都没回」这一种失败", () => {
  it("provider 的新措辞（带 reasoning_tokens 那版）算", () => {
    expect(isEmptyResultError(new Error(
      "API 返回了空结果（流式响应无内容）。模型把 8192 token 花在思考上、一个字正文都没回。原始响应：{}"
    ))).toBe(true);
  });

  it("provider 的旧措辞同样算：认的是前缀，不跟着文案改口", () => {
    expect(isEmptyResultError(new Error(
      "API 返回了空结果（流式响应无内容）。可能原因：模型名称不存在或无权访问、请求参数不被支持。"
    ))).toBe(true);
    expect(isEmptyResultError(new Error("API 返回了空结果（choices 为空），模型：x。"))).toBe(true);
  });

  it("agent 自己判出来的那句空白正文也算（provider 没抛错的那条腿）", () => {
    expect(isEmptyResultError(new Error("API 返回了空响应"))).toBe(true);
  });

  it("超时 / CORS / 限流 / 解析失败都不算——那些时候关思考是白关", () => {
    for (const msg of [
      "上游 524 Bad Gateway",
      "Failed to fetch: CORS 跨域请求被阻止",
      "请求过于频繁（429 RateLimitExceeded）",
      "未能从 AI 响应中解析有效的地图数据",
      "API 返回错误：model not found",
    ]) {
      expect(isEmptyResultError(new Error(msg)), `不该认：${msg}`).toBe(false);
    }
  });

  it("不是 Error 的东西一律不算（字符串与 undefined 都试）", () => {
    expect(isEmptyResultError("API 返回了空结果")).toBe(false);
    expect(isEmptyResultError(undefined)).toBe(false);
    expect(isEmptyResultError(null)).toBe(false);
  });
});
