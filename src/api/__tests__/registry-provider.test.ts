/**
 * api/registry.ts — 「选哪条腿 + 不许缓存」首次有直接判据
 *
 * 这只文件只有 16 行，但它站在一次真事故上面：provider 一旦缓存，
 * 用户改了 API key 之后旧 key 还在用（`agents/utils.ts`、`useSummarizer.ts` 都拿它当唯一出口）。
 * 之前 base-agent / graph-agent / map-agent / output-reserve / useSummarizer 那些测试
 * 全都把 `getProvider` 整只 mock 掉，于是这 16 行没有任何一行被直接指着。
 *
 * 判的三件事：
 * 1. 腿按 `config.format` 选，不按 id/name/model 猜（用户自建的中转站常把 name 写成「Claude 中转」）；
 * 2. 运行时脏 format（导入的备份、旧版本 localStorage 里会带进来）兜底走 openai 那条腿，不许抛；
 * 3. 每次调用现造 provider，传下去的就是当前这一份 config——改 key 之后必须换掉整个 provider。
 *
 * 有意不判的格子：
 * - `clearProviderCache()` 是个空函数，**全仓零调用者**（只剩定义那一行）。按「死代码不写判据」的口径
 *   不判它，也不替它把"保留接口兼容"的说法钉成契约——删要单独一笔（先例 `de9203e`、`c8fe20a`）。
 * - 两条腿内部的行为（超时、SSE、请求体）归 `providers/*.test.ts` 与真厂商那一档，这里不重复判。
 * - `AIProvider` 的字段形状：registry 不生产也不校验字段，判它等于判 mock 自己。
 *
 * 桩的形状不是真 `AIProvider`（只带三个观察面字段），所以取用要过一道 `Made` 的 cast——
 * 这道 cast 只出现在 `make()` 一处，别让它在十条用例里各写一遍。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderConfig } from "../types";
import { getProvider } from "../registry";

const M = vi.hoisted(() => ({
  openai: vi.fn(),
  anthropic: vi.fn(),
  made: 0,
}));

vi.mock("../providers/openai", () => ({ createOpenAIProvider: M.openai }));
vi.mock("../providers/anthropic", () => ({ createAnthropicProvider: M.anthropic }));

/** 桩吐回来的那一面：哪条腿、绑的哪份 config、第几个现造的 */
interface Made {
  leg: "openai" | "anthropic";
  cfg: ProviderConfig;
  made: number;
}

function cfg(over?: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: "p1",
    format: "openai",
    name: "默认中转",
    apiKey: "sk-old",
    baseUrl: "https://gw.example/v1",
    model: "gpt-4o-mini",
    ...over,
  };
}

/** 走一遍真 registry，把结果按桩那一面取出来 */
function make(over?: Partial<ProviderConfig>): Made {
  return getProvider(cfg(over)) as unknown as Made;
}

beforeEach(() => {
  M.openai.mockReset();
  M.anthropic.mockReset();
  M.made = 0;
  // 忠实桩：每次调用现造一个对象——真工厂就是闭包各自绑 config，
  // 要是桩返回同一个共享对象，registry 加回缓存也看不出来
  M.openai.mockImplementation((c: ProviderConfig) => {
    M.made += 1;
    return { leg: "openai", cfg: c, made: M.made };
  });
  M.anthropic.mockImplementation((c: ProviderConfig) => {
    M.made += 1;
    return { leg: "anthropic", cfg: c, made: M.made };
  });
});

describe("选腿", () => {
  it("format 是 openai：走 openai 那条腿，anthropic 一次都不该被叫", () => {
    expect(make({ format: "openai" }).leg).toBe("openai");
    expect(M.openai).toHaveBeenCalledTimes(1);
    expect(M.anthropic).not.toHaveBeenCalled();
  });

  it("format 是 anthropic：走 anthropic 那条腿，openai 一次都不该被叫", () => {
    expect(make({ format: "anthropic" }).leg).toBe("anthropic");
    expect(M.anthropic).toHaveBeenCalledTimes(1);
    expect(M.openai).not.toHaveBeenCalled();
  });

  it("工厂给回来的对象原样交出去：registry 不加工、不包一层", () => {
    const made = { leg: "anthropic", cfg: cfg(), made: 99 };
    M.anthropic.mockReturnValue(made);
    expect(getProvider(cfg({ format: "anthropic" })) as unknown).toBe(made);
  });

  it("脏 format（备份导入／旧版 localStorage 带进来的）兜底走 openai，不许抛也不许换腿", () => {
    const dirty = cfg({ format: "azure" as unknown as ProviderConfig["format"] });
    expect(() => getProvider(dirty)).not.toThrow();
    expect(getProvider(dirty) as unknown as Made).toMatchObject({ leg: "openai" });
    expect(M.anthropic).not.toHaveBeenCalled();
  });

  it("format 整个缺失也照样兜底 openai：这一发要能发出去，不能白屏", () => {
    const noFormat = { ...cfg(), format: undefined } as unknown as ProviderConfig;
    expect(getProvider(noFormat) as unknown as Made).toMatchObject({ leg: "openai" });
    expect(M.anthropic).not.toHaveBeenCalled();
  });

  it("腿只看 format：id/name/model 写成 Claude 样子的 openai 配置不许被换腿", () => {
    const lookalike = make({
      format: "openai",
      id: "claude-through-gw",
      name: "Claude 中转",
      model: "claude-3-5-sonnet",
    });
    expect(lookalike.leg).toBe("openai");
    expect(M.anthropic).not.toHaveBeenCalled();
  });

  it("反方向同理：id/name/model 写成 GPT 样子的 anthropic 配置不许被换回 openai 腿", () => {
    const rev = make({ format: "anthropic", id: "openai-ish", name: "GPT 代理", model: "gpt-4o" });
    expect(rev.leg).toBe("anthropic");
    expect(M.openai).not.toHaveBeenCalled();
  });
});

describe("不许缓存：改 key 之后必须换掉整个 provider", () => {
  it("同一份 config 连调两次：现造两个，第二次不许拿第一次那个", () => {
    const one = make();
    const two = make();
    expect(M.openai).toHaveBeenCalledTimes(2);
    expect(two).not.toBe(one);
    expect(two.made).toBe(one.made + 1);
  });

  it("改了 API key 再来一发：这一发绑的必须是新 key（旧 key 继续用就是当初那个事故）", () => {
    const before = make({ apiKey: "sk-old" });
    const after = make({ apiKey: "sk-new" });
    expect(before.cfg.apiKey).toBe("sk-old");
    expect(after.cfg.apiKey).toBe("sk-new");
    expect(after).not.toBe(before);
  });

  it("工厂收到的就是当前这一份配置：id/key/model/baseUrl 都得带上，不许拿上一次的残留", () => {
    // 不判"是不是同一个对象"——registry 传一份浅拷贝并不影响任何行为，
    // 要判的是交下去的这份内容就是当前这份
    const c = cfg({ apiKey: "sk-x", model: "m-x", baseUrl: "https://x.example/v1" });
    getProvider(c);
    expect(M.openai.mock.calls[0][0]).toMatchObject({
      id: "p1", apiKey: "sk-x", model: "m-x", baseUrl: "https://x.example/v1",
    });

    const c2 = cfg({ id: "p2", apiKey: "sk-y" });
    getProvider(c2);
    expect(M.openai.mock.calls[1][0]).toMatchObject({ id: "p2", apiKey: "sk-y" });
  });

  it("改 id／改 baseUrl 之后各拿各的：前一个 provider 不许被后续调用改写", () => {
    const a = make({ id: "a", baseUrl: "https://a.example/v1" });
    const b = make({ id: "b", baseUrl: "https://b.example/v1" });
    expect(a.cfg.id).toBe("a");
    expect(a.cfg.baseUrl).toBe("https://a.example/v1");
    expect(b.cfg.id).toBe("b");
    expect(b.cfg.baseUrl).toBe("https://b.example/v1");
    expect(a).not.toBe(b);
  });

  it("两条腿交错调用也各走各的，缓存更不许跨腿串台", () => {
    const o1 = make({ format: "openai", id: "same" });
    const an = make({ format: "anthropic", id: "same" });
    const o2 = make({ format: "openai", id: "same" });
    expect(o1.leg).toBe("openai");
    expect(an.leg).toBe("anthropic");
    expect(o2.leg).toBe("openai");
    expect(o2).not.toBe(an);
    expect(M.openai).toHaveBeenCalledTimes(2);
    expect(M.anthropic).toHaveBeenCalledTimes(1);
  });
});

/*
 * ── 变异台账 ──
 * 产品基线：src/api/registry.ts 568 字节，sha256 前缀 9870ab38
 * 每轮：一次手改一处（带 MUT- 标记）→ 跑本文件 → 按字节基线还原 → 当场核 SHA。
 * 14 轮 = 11 轮刀（9 把不同的刀，G1/G4 在判据加强后各重打一遍）+ 3 轮对照。
 * 每轮 markers=1（对照轮 0）、transform_failed=0、markers_left=0、diff_lines=0、sha=9870ab38。
 * 跑法：bash %TEMP%\knife-reg.sh <刀号>；台账原文 %TEMP%\ledger-reg.txt
 *
 * 刀号                        红  这一刀摘掉了什么 / 谁红着指出来
 * G0 对照                      0  不动产品：12 条全绿
 * G1 两支对调                 10  `!== "anthropic"`：两条腿几乎整体反转
 * G2 anthropic 支整条没了      4  Claude 配置静默走 openai 腿——症状是"请求发出去了但格式不对"，不报错
 * G3 默认腿换成 anthropic      7  兜底那条腿走错：脏 format／缺失 format／openai 正常配置一起红
 * G4 把按 id 的缓存加回来      6  当初那个真事故的形状：改了 key 还是旧 provider
 * G5 交下去的那一份丢了 key    2  只咬"内容得是当前这份"那两条（见下"改过一次判据"）
 * G6 出去之前包一层            1  registry 加工/包对象：只有"原样交出去"那条红
 * G7 顺手按名字猜腿            1  `/claude/i.test(name||model)`：只有"腿只看 format"那条红
 * G8 脏 format 改成抛错        2  兜底那一半没了：备份导入带脏值时整条 AI 链路炸在白屏上
 * G1b 两支对调（重打）         10  读数与 G1 一致
 * G4b 按 id 缓存（重打）        6  读数与 G4 一致
 * G9 按对象引用 memo           0  **有意不判**：`api-store.ts:83` 的 updateProvider 每次都
 *                               `{...p, ...config}` 换新对象（全仓也搜不到就地改写 config 字段的写法），
 *                               所以按引用 memo 不可能把旧 key 留下来；判死它只是挡一条正当优化。
 * G10 收尾对照                 0  全部还原后 12 条仍全绿
 *
 * 改过一次判据：第一条写法是 `expect(mock.calls[0][0]).toBe(config)`——**判成了对象引用同一**。
 * registry 传一份浅拷贝并不影响任何行为，那是 over-pin；换成按内容判（id/key/model/baseUrl 都得带上）。
 * 换完先重跑对照（G5对照＝0 红），再重打受影响的 G1b/G4b，读数没变。
 *
 * 产品代码一行没动（每轮还原后 SHA 与基线一致）。
 */
