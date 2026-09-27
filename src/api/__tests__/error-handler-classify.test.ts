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
import { APIError, handleFetchError, isEmptyResultError, emptyResultNote, classifyTransportFailure } from "../error-handler";

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

/**
 * 空正文那句"到底该说什么"也住在这里，而且只有这一份。
 *
 * 它原先是 `providers/openai.ts` 里的模块私有函数，而现在两条腿都会遇到"一个字正文都没回"：
 * OpenAI 格式的证据在 `usage.completion_tokens_details.reasoning_tokens`，Anthropic 格式没有那个
 * 字段（它的思考是 `content` 里的 thinking 块，预算记在 `usage.output_tokens`）。各自抄一份文案的
 * 下场就是同一件事在两家嘴里说法不一样，而 agent 认的锚只有前缀——文案漂移没人能发现。
 *
 * 判的是这只内核自己的三格：**有证据才说思考吃满**、**说了就得给出口**、**没证据时那三种猜测
 * 不许被换成一句编出来的话**。两条腿各自"确实在读这一份"由 `providers.test.ts` 里两边的
 * 措辞判据看着（那里各下一刀改这只内核，两腿同红才是搬家真的成立）。
 *
 * ## 变异台账（2026-09-27 本机；内核基线 error-handler.ts `a74f0b65`）
 * 5 条判据、3 把刀，每轮一把、跑完立刻 `cp` 还原 + `cmp`（三次都回到 a74f0b65）。
 * 每刀同时跑 `providers.test.ts`，因为这一档要看的正是"改这里的字，那条腿会不会跟着红"：
 * - G1 句里的 `${reasoningTokens}` 换成 `${0}`          4 红：本档 1 条 + OpenAI 三条措辞判据
 *   （**这一刀就是搬家的证据**：动的是 error-handler.ts，openai.ts 一个字没改却红了三条）
 * - G2 整段判断废掉（`false && …`，恒说三种猜测）       7 红：本档 3 条 + OpenAI 4 条
 * - G3 门槛 `> 0` 挪成 `>= 0`（有字段就当思考吃满）      2 红：本档"0 不许编"那条 + OpenAI
 *   流式"reasoning_tokens 明确为 0"那条——与搬家前 N1 同一格，读数从 1 红变 2 红是因为内核自己
 *   也补了一格。
 * 过程账（别学）：G1 第一次打的时候**只红 1 条**——OpenAI 那三条当时写的是 `toContain("8192")`，
 * 而报错句尾本来就带"原始响应：…"，8192 在那段里躺着，谁都糊得过去。断言换成整句
 * `toContain("4100 token 花在思考上")` + 夹具把两个数字改开之后重打同一刀才是 4 红。
 */
describe("emptyResultNote：有证据才说思考吃满，说了就要给出口", () => {
  it("带正数的 reasoning token → 点名思考吃满，并把那个数字写出来", () => {
    const s = emptyResultNote(8192);
    expect(s).toContain("8192");
    expect(s).toContain("思考");
  });

  it("说了思考吃满就必须给出口：关思考与调大上限两条都在话里", () => {
    const s = emptyResultNote(2048);
    expect(s).toContain("关闭思考");
    expect(s).toContain("调大输出上限");
  });

  it("两句不许同时出现：说了思考吃满就不许再猜那三种原因（否则等于没证据）", () => {
    expect(emptyResultNote(1)).not.toContain("模型名称不存在");
  });

  it("token 数为 0（真·没思考）→ 保留原来那三种猜测，不许编一个原因", () => {
    const s = emptyResultNote(0);
    expect(s).toContain("模型名称不存在");
    expect(s).not.toContain("思考");
  });

  it("厂商压根没给那个字段 / 给的不是数字 → 同样不许说成思考吃满", () => {
    for (const v of [undefined, null, "8192", {}, NaN]) {
      const s = emptyResultNote(v);
      expect(s, `坏证据 ${JSON.stringify(v) ?? String(v)} 被说成了思考吃满`).toContain("模型名称不存在");
      expect(s).not.toContain("token 花在思考上");
    }
  });
});

/**
 * 「这一发没拿到答案，而且是路的问题」——两样，待遇正好相反，所以必须分得开：
 *  · `timeout`：到期了。厂商/代理可能只是慢，再撞一发是划算的（地图就是这么做的）。
 *  · `unreachable`：请求根本没出浏览器（CORS 被拦、地址写错、断网）。再撞一发只是白等。
 *
 * 为什么要单独立一处：`map-agent.ts` 过去自己抄了一遍判法，
 * 拿 `err.message.includes("CORS" | "blocked" | "524")` 去认——**全仓没有任何一条代码会
 * 产生带 "CORS" 或 "blocked" 的错误**（浏览器 fetch 出不了门抛的是 `TypeError: Failed to fetch`；
 * `blocked` 只有 IndexedDB 那只在用），那一支于是从来走不到，真被 CORS 拦下时地图会白撞第二发。
 * 524 也不该按字面认：代理到期回的是 HTTP 504，`classifyError` 给它的是 `apiCode: "server"`。
 *
 * 夹具只准用**真会出现的原话**：每条都注着它是谁、在哪一行抛的。
 * 编一句产不出来的话，判据就会绿而产品坏（这一格上一版就是这么踩的）。
 */
describe("classifyTransportFailure：路的问题分两样，认不到就算认不到", () => {
  it("provider 两条腿各自到期的原话算 timeout（openai.ts:52、anthropic.ts:41 抛的就是这句）", () => {
    expect(classifyTransportFailure(new Error("直连超时（30 秒无响应），请检查网络或 API 地址"))).toBe("timeout");
    expect(classifyTransportFailure(new Error("代理超时（120 秒无响应），请检查网络或 API 地址"))).toBe("timeout");
  });

  it("服务端代理到期回的是 HTTP 504（server/routes/proxy.js:211），那也算 timeout", async () => {
    const e = await classify(504, { error: "代理请求超时（3分钟），API 服务器响应过慢" });
    expect(e.apiCode, "504 在 classifyError 里归 server，所以只认 apiCode=network 的那版判不到这一格").toBe("server");
    expect(classifyTransportFailure(e)).toBe("timeout");
  });

  // 524 单独一条：厂商挂在 Cloudflare 上的源站超时。跟 504 合在一条里时，
  // "只摘掉 524" 与 "整个状态码那一支没了" 会红同一个名字，归不了因。
  it("厂商挂在 Cloudflare 上的源站超时（524）同样算 timeout", () => {
    expect(classifyTransportFailure(new APIError("API 服务器错误 (524)：服务暂时不可用。", "server", 524, ""))).toBe("timeout");
  });

  it("请求出不了浏览器算 unreachable：三家引擎的原话各一条", () => {
    // Chromium / Edge
    expect(classifyTransportFailure(new TypeError("Failed to fetch"))).toBe("unreachable");
    // Safari
    expect(classifyTransportFailure(new TypeError("Load failed"))).toBe("unreachable");
    // Firefox
    expect(classifyTransportFailure(new TypeError("NetworkError when attempting to fetch resource."))).toBe("unreachable");
  });

  it("厂商答过了就不算路的问题：认证、限流、输出超限一律 null（白重头发是把同一份 token 花两遍）", async () => {
    const auth = await classify(401, { error: { message: "Invalid API key" } });
    const rate = await classify(429, { error: { message: "Too Many Requests" } });
    const out = await classify(400, withMessage("max_tokens is not less or equal to 262144"));
    for (const e of [auth, rate, out]) {
      expect(classifyTransportFailure(e), `${e.apiCode} 被当成了路的问题`).toBeNull();
    }
  });

  it("「一个字正文都没回」归 isEmptyResultError 管，这一把不许抢（抢了就分不出该关思考还是该重试）", () => {
    const empty = new APIError("API 返回了空结果（流式响应无内容）。", "server", 200, "data: [DONE]");
    expect(isEmptyResultError(empty), "夹具得先是空正文").toBe(true);
    expect(classifyTransportFailure(empty)).toBeNull();
  });

  it("用户取消两样都不是（否则点停止会被当成一次网络失败再撞一发）", () => {
    const aborted = new DOMException("The user aborted a request.", "AbortError");
    expect(classifyTransportFailure(aborted)).toBeNull();
  });

  it("认不到的一律 null：解析失败、裸字符串、undefined 都不许猜成 timeout 或 unreachable", () => {
    for (const v of [new Error("Unexpected token } in JSON at position 42"), "Failed to fetch", undefined, null, 42]) {
      expect(classifyTransportFailure(v), `${JSON.stringify(v) ?? String(v)} 被猜成了路的问题`).toBeNull();
    }
  });
});
