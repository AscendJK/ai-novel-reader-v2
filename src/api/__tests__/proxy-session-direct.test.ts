/**
 * proxy-session 本体首次有直接判据
 *
 * 已有的 `providers-proxy-session.test.ts` 是从 openai / anthropic 两家 provider **外面**打的：
 * 它量的是"这一腿走完之后用户拿到什么"，中间那 15 行怎么认标记、什么时候重试、响应体丢没丢，
 * 换个 provider 形状就可能悄悄不一样。这一只直接 import `proxyWithSessionRetry`，
 * 给它喂手搓的假响应（只需要 status / headers / body.cancel 三样），判四件事：
 *
 * 1. 认得出"后端在说自己不认识你这个会话"——必须 401 **且** `x-proxy-auth: required` 同时成立。
 *    只看状态码会把 sensenova 那类网关用 401 表达的"密钥/模型无权访问"误判成本地会话失效，
 *    既白重注册一次，又把"去检查密钥"这条正确建议盖掉。
 * 2. 只重试一次，且续期在第二次发出去**之前**完成（反过来等于拿旧 token 再撞一次墙）。
 * 3. 报出来的是哪一种错：apiCode=auth、带上状态码、文案自己说清"这不是 API Key 的问题"，
 *    且"续期没成"和"续期后仍 401"两条路是同一句话。
 * 4. 被丢弃的响应体要 cancel（不消费会挂着连接），而**放行**的响应体一个字节都不许动
 *    （那是流式正文，取消掉就把后面的内容读空了）。
 *
 * 有意不判的格子（写了理由，不是漏）：
 * - 会话失效之后要不要往 `syncClient` 里塞事件、要不要弹全局提示：那是调用点和 store 的事。
 * - `refreshSession` 自己怎么做单飞、怎么重注册：归 `sync-client` 的判据。
 * - statusCode 到底取第一次还是第二次的 401：两条路里 `isLocalSessionLost` 都要求状态码
 *   正好是 401，取哪一个都同一个值——那是等价变异，钉它只会挡住日后想报别的码。
 * - 读表头时用 `"x-proxy-auth"` 还是 `"X-Proxy-Auth"`：`Headers.get` 本来就大小写不敏感，
 *   两种写法互为等价变异。真跨层的约定是"服务端下发什么名、我们认不认得"，那由第一条用例
 *   钉住（假响应用的是服务端实际的 `X-Proxy-Auth` 写法）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { refreshSession } = vi.hoisted(() => ({ refreshSession: vi.fn() }));
vi.mock("@/sync/sync-client", () => ({ syncClient: { refreshSession } }));

import { proxyWithSessionRetry } from "../providers/proxy-session";
import { APIError } from "../error-handler";

/** 只需要三样：status、headers.get、body.cancel——真 Response 的其余部分这里用不到 */
interface FakeResp {
  status: number;
  headers: Headers;
  body: { cancel: () => Promise<void>; calls: number } | null;
  tag: string;
}

function fake(
  status: number,
  opts?: { proxyAuth?: string | null; noBody?: boolean; cancelRejects?: boolean },
): FakeResp {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts?.proxyAuth !== null && opts?.proxyAuth !== undefined) {
    headers.set("X-Proxy-Auth", opts.proxyAuth);
  }
  const body: FakeResp["body"] = opts?.noBody
    ? null
    : {
        calls: 0,
        cancel: () => {
          if (body) body.calls++;
          return opts?.cancelRejects ? Promise.reject(new Error("cancel 自己炸了")) : Promise.resolve();
        },
      };
  return { status, headers, body, tag: `#${status}${opts?.proxyAuth ? "+标记" : ""}` };
}

/** 唯一的类型断言点：把假响应交给只碰那三样的被测函数 */
function asResponse(r: FakeResp): Response {
  return r as unknown as Response;
}

/** 按脚本一格格发出去的 send，并留一条时间线（谁先谁后是判据，不是巧合） */
function scriptedSend(...items: FakeResp[]) {
  const log: string[] = [];
  let i = 0;
  const send = vi.fn(async () => {
    const r = items[i++];
    log.push(`send${i}`);
    return asResponse(r);
  });
  return { send, log, calls: () => send.mock.calls.length };
}

const LOST = () => fake(401, { proxyAuth: "required" });
const UPSTREAM_401 = () => fake(401, { proxyAuth: null });
const OK = () => fake(200, { proxyAuth: null });

beforeEach(() => {
  refreshSession.mockReset();
});

describe("认得出这到底是哪一种 401", () => {
  it("401 且带 x-proxy-auth: required → 判成本地会话失效，去续期（表头名大小写不影响）", async () => {
    refreshSession.mockResolvedValue(true);
    const { send, log } = scriptedSend(LOST(), OK());
    await proxyWithSessionRetry(send);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["send1", "send2"]);
  });

  it("同样 401、没有那个标记 → 原样交回那一个响应，一次都不许重注册", async () => {
    const first = UPSTREAM_401();
    const { send } = scriptedSend(first);
    const out = await proxyWithSessionRetry(send);
    expect(out).toBe(asResponse(first));
    expect(refreshSession).not.toHaveBeenCalled();
    expect(first.body?.calls).toBe(0);
  });

  it("标记在但值不是 required（如 missing）→ 仍按厂商的 401 处理", async () => {
    const first = fake(401, { proxyAuth: "missing" });
    const { send } = scriptedSend(first);
    const out = await proxyWithSessionRetry(send);
    expect(out).toBe(asResponse(first));
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it("只有 401 才算会话失效：403 带同样的标记也原样交回", async () => {
    const first = fake(403, { proxyAuth: "required" });
    const { send } = scriptedSend(first);
    const out = await proxyWithSessionRetry(send);
    expect(out).toBe(asResponse(first));
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

describe("续期与那唯一一次重试", () => {
  it("续期成功 → 第二次发出去，并把第二次的响应原样交回", async () => {
    refreshSession.mockResolvedValue(true);
    const first = LOST();
    const second = OK();
    const { send } = scriptedSend(first, second);
    const out = await proxyWithSessionRetry(send);
    expect(out).toBe(asResponse(second));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("时间线：续期没落地之前不许发第二次（先发的等于拿旧 token 再撞一次墙）", async () => {
    const { send, log } = scriptedSend(LOST(), OK());
    refreshSession.mockImplementation(async () => {
      await Promise.resolve();
      log.push("renew");
      return true;
    });
    await proxyWithSessionRetry(send);
    expect(log).toEqual(["send1", "renew", "send2"]);
  });

  it("续期回 false → 第二次根本不发，直接抛会话失效", async () => {
    refreshSession.mockResolvedValue(false);
    const first = LOST();
    const { send } = scriptedSend(first, OK());
    const err = await proxyWithSessionRetry(send).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.body?.calls).toBe(1);
  });

  it("续期后仍被拒 → 抛会话失效，且到此为止：只发两次、只续一次", async () => {
    refreshSession.mockResolvedValue(true);
    const { send, log } = scriptedSend(LOST(), LOST(), OK());
    const err = await proxyWithSessionRetry(send).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(send).toHaveBeenCalledTimes(2);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["send1", "send2"]);
  });
});

describe("报出来的是哪一句", () => {
  it("抛的是 APIError：apiCode=auth，状态码带上被拒那次的 401", async () => {
    refreshSession.mockResolvedValue(false);
    const { send } = scriptedSend(LOST());
    const err = (await proxyWithSessionRetry(send).catch((e) => e)) as APIError;
    expect(err.apiCode).toBe("auth");
    expect(err.statusCode).toBe(401);
  });

  it("文案自己说清这不是 API Key 的问题，并给出出口", async () => {
    refreshSession.mockResolvedValue(false);
    const { send } = scriptedSend(LOST());
    const err = (await proxyWithSessionRetry(send).catch((e) => e)) as APIError;
    expect(err.message).toContain("不是 API Key 的问题");
    expect(err.message).toContain("重新登录");
    // classifyError 对 401 的措辞会把人支去检查密钥，这里不许是它
    expect(err.message).not.toMatch(/API Key 错误|已过期或无权访问/);
  });

  it("「续期没成」和「续期后仍 401」两条路给用户的是同一句话", async () => {
    refreshSession.mockResolvedValue(false);
    const a = (await proxyWithSessionRetry(scriptedSend(LOST()).send).catch((e) => e)) as APIError;
    refreshSession.mockResolvedValue(true);
    const b = (await proxyWithSessionRetry(
      scriptedSend(LOST(), LOST()).send,
    ).catch((e) => e)) as APIError;
    expect(b.message).toBe(a.message);
  });
});

describe("被丢掉的那具响应体", () => {
  it("命中会话失效时，第一个响应体 cancel 一次（不消费会挂着连接）", async () => {
    refreshSession.mockResolvedValue(true);
    const first = LOST();
    const { send } = scriptedSend(first, OK());
    await proxyWithSessionRetry(send);
    expect(first.body?.calls).toBe(1);
  });

  it("重试后仍失效：第二具响应体同样 cancel 掉", async () => {
    refreshSession.mockResolvedValue(true);
    const second = LOST();
    const { send } = scriptedSend(LOST(), second);
    await proxyWithSessionRetry(send).catch(() => {});
    expect(second.body?.calls).toBe(1);
  });

  it("放行成功的那一具响应体一个字节都不许动（那是流式正文）", async () => {
    refreshSession.mockResolvedValue(true);
    const second = OK();
    const { send } = scriptedSend(LOST(), second);
    await proxyWithSessionRetry(send);
    expect(second.body?.calls).toBe(0);
  });

  it("cancel 自己炸了不许盖掉真正要抛的会话失效", async () => {
    refreshSession.mockResolvedValue(false);
    const unhandled: unknown[] = [];
    const spy = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", spy);
    try {
      const { send } = scriptedSend(fake(401, { proxyAuth: "required", cancelRejects: true }));
      const err = (await proxyWithSessionRetry(send).catch((e) => e)) as APIError;
      expect(err).toBeInstanceOf(APIError);
      expect(err.message).toContain("不是 API Key 的问题");
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", spy);
    }
  });

  it("响应没有 body（null）时不炸，照常报会话失效", async () => {
    refreshSession.mockResolvedValue(false);
    const { send } = scriptedSend(fake(401, { proxyAuth: "required", noBody: true }));
    const err = await proxyWithSessionRetry(send).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
  });
});

// ── 变异台账（还原法：字节基线 sha256=acd85ac6… / 2333 B，一刀一跑一还原）────────────────
//
// 17 刀全部至少打红一条，没有一轮 0 红；每轮 markers=1、transform_failed=0、markers_left=0、
// diff_lines=0、sha 回到基线。16 条用例每一条都被至少一刀指名打红过（下面括注红数与首条红名）。
//
// P0-对照                        16 全绿
// P1-认失只看状态码（摘掉标记判断）  2 红：无标记那一条 ／ 标记值不是 required 那一条
// P2-有标记就算（不看值）           1 红：标记值不是 required
// P3-状态码放宽成 >=400            1 红：403 带同样的标记也原样交回
// P4-第一具响应体不丢              2 红：续期回 false（连带 body.cancel 计数）／ 第一具 cancel 一次
// P5-成功那一具也被 cancel          1 红：放行的那一具一个字节都不许动
// P6-摘掉「续期没成就不重试」        6 红：续期回 false ／ apiCode+statusCode ／ 文案 ／ 同一句话 ／
//                                      cancel 炸了 ／ body 为 null——整条"续期失败就如实报"的路径全塌
// P7-失效后再撞第三次              2 红：只发两次只续一次 ／ 同一句话（第三条路的话术不再来自 sessionLost）
// P8-续期没落地就先发第二次         2 红：时间线（日志成 send1,send2,renew）／ 续期回 false（promise 已发出去）
// P9-把续期前那一具交回去           1 红：交回的是第二次那一个对象
// P10-apiCode 从 auth 改成 server  1 红：抛的是 APIError 那一条
// P11-文案换成 classifyError 那一句 2 红：文案自己说清 ／ cancel 炸了（那条也断言正文）
// P12-两条失效路两套话术            1 红：同一句话
// P13-cancel 的拒绝没人接           1 红：cancel 炸了那条——监听 unhandledRejection 抓到一次未接的拒绝
// P14-丢掉 ?.（body 为 null 时抛 TypeError） 1 红：body 为 null 不炸
// P15-状态码写死成 502             1 红：statusCode=401 那条
// P16-标记值改成服务端不发的 "lost"  11 红：认失那一面整片塌（正面路径全废，只剩"不该认失"的负向用例还绿）
// P17-重试后失效的第二具没丢         1 红：第二具同样 cancel 掉
//
// 记两笔方法上的账：
// 1) P8 那种"顺序"刀必须自己造时间线（在 mock 里往 log 推一笔），只看调用次数是量不出先后相反的；
//    而且这条判据与"续期回 false 不许发第二次"是两条独立的判据——P8 两条一起红，缺一条另一条兜住。
// 2) P16 这种"两侧串不上"的刀是跨层约定的唯一判据：客户端与服务端各改各的都不会有单测报错，
//    只有把标记值挪开一位才看得见这面墙其实靠一个字串撑着。服务端那侧的对应判据在 probe:proxy
//    （X-Proxy-Auth 出现在响应里）与 server/routes/proxy.js。
