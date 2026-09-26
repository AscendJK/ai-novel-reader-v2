/**
 * map-agent 判别力测试
 *
 * 守两类静默故障：
 *  1) 喂给模型的目录错了（序号错位 / 千章书不抽样直接把请求顶到 400 / 拿成另一本书）；
 *  2) 模型返回的 JSON 被"善意补全"成看起来合法、实则残缺的地图（少一半地点、势力引用被清空）。
 * 地图一旦校验不通过就必须整体失败——结果会直接 saveMap 入库，半成品没有回头路。
 * 唯一的例外是父级对不上：那种坏法降级 + 记进 parentMissing（见"父级对不上时的可见降级"）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Novel } from "@/parsers/types";
import { mapAgent } from "../map-agent";
import { estimateTokens } from "@/api/token-manager";

const repo = vi.hoisted(() => ({ loadNovel: vi.fn() }));
const chat = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({ config: undefined as unknown }));

vi.mock("@/db/repositories", () => ({ loadNovel: repo.loadNovel }));
vi.mock("@/api/registry", () => ({ getProvider: () => ({ format: "openai", chat }) }));
vi.mock("@/stores/api-store", () => ({
  useAPIStore: { getState: () => ({ getActiveProvider: () => store.config }) },
}));

const SMALL_CONFIG = {
  id: "p1", format: "openai" as const, name: "t", apiKey: "k", baseUrl: "u",
  model: "map-small-model", contextWindow: 8192, maxTokens: 4096,
};
const BIG_CONFIG = {
  id: "p1", format: "openai" as const, name: "t", apiKey: "k", baseUrl: "u",
  model: "map-big-model", contextWindow: 128000, maxTokens: 32768,
};

function makeNovel(chapterCount: number, id = "book-1", title = "《测试书》"): Novel {
  return {
    id, title, author: "某作者", fileName: "f.txt", fileFormat: "txt",
    totalChars: 1000, chapterCount, createdAt: 1, updatedAt: 1,
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-ch-${i}`, novelId: id, index: i, title: `第${i + 1}章 标题`,
      content: `第${i + 1}章正文`, startOffset: 0, endOffset: 10,
    })),
  };
}

/** 一份完全合法、字段齐全的地图 JSON */
function validMap(over?: Record<string, unknown>) {
  return JSON.stringify({
    layers: [
      { level: 1, name: "天下", description: "整个世界" },
      { level: 2, name: "州域", description: "二级区域" },
    ],
    places: [
      { id: "1", name: "洛阳", type: "都城", level: 1, parentId: "", description: "帝都", importance: 9, x: 500, y: 500, affiliation: "王朝" },
      { id: "2", name: "虎牢关", type: "关隘", level: 2, parentId: "1", description: "天下雄关", importance: 7, x: 600, y: 520, affiliation: "王朝" },
    ],
    regions: [{ name: "中原", places: ["1", "2"] }],
    forces: [{ id: "f1", name: "王朝", type: "朝廷", places: ["1", "2"] }],
    ...over,
  });
}

function reply(content: string) {
  return { content, tokensUsed: { input: 10, output: 20, total: 30 } };
}

/** 取第 n 次请求里真正发给模型的用户 prompt */
function promptOf(callIndex = 0): string {
  return chat.mock.calls[callIndex][0].messages[1].content as string;
}

async function run(overrides?: Record<string, unknown>) {
  return await mapAgent.run({ novelId: "book-1", onStatus: vi.fn(), ...overrides } as never);
}

beforeEach(() => {
  repo.loadNovel.mockReset();
  chat.mockReset();
  store.config = SMALL_CONFIG;
  repo.loadNovel.mockResolvedValue(makeNovel(3));
});

describe("地图任务的取数与请求参数", () => {
  it("地图只要章节目录，绝不把全书正文读进内存", async () => {
    chat.mockResolvedValue(reply(validMap()));
    await run();
    expect(repo.loadNovel).toHaveBeenCalledWith("book-1", undefined, false);
  });

  it("目录带真实章节序号（序号错位＝模型引用错章）", async () => {
    chat.mockResolvedValue(reply(validMap()));
    await run();
    const p = promptOf();
    expect(p).toContain("1. 第1章 标题");
    expect(p).toContain("2. 第2章 标题");
    expect(p).toContain("3. 第3章 标题");
    expect(p).not.toContain("0. 第1章");
  });

  it("目录永远来自按 novelId 加载到的那本书（不串号）", async () => {
    repo.loadNovel.mockImplementation(async (id: string) =>
      id === "book-1" ? makeNovel(2, "book-1", "真本书") : makeNovel(2, "other", "另一本书"));
    chat.mockResolvedValue(reply(validMap()));
    await run({ preloadedNovel: makeNovel(2, "stale-book", "上一本书") });
    const p = promptOf();
    expect(p).toContain("《真本书》");
    expect(p).not.toContain("上一本书");
    expect(p).not.toContain("另一本书");
  });

  it("千章书的目录按预算抽样：保首尾、等距、并如实标注", async () => {
    repo.loadNovel.mockResolvedValue(makeNovel(1000));
    chat.mockResolvedValue(reply(validMap()));
    await run();
    const p = promptOf();
    const catalogLines = p.split("\n").filter((l) => /^\d+\. 第\d+章 标题$/.test(l));
    expect(catalogLines.length).toBeGreaterThan(1);
    expect(catalogLines.length).toBeLessThan(1000);
    expect(catalogLines[0]).toBe("1. 第1章 标题");
    expect(catalogLines[catalogLines.length - 1]).toBe("1000. 第1000章 标题");
    expect(p).toContain("等距抽样");
    expect(p).toContain("共 1000 章");
  });

  it("目录抽样的预算与发出去的输出预留同源（不许一边按 4096 留、一边要 16384）", async () => {
    // 这里原来是两处不同的数：目录按 4096 的输出预留算，请求却发 `min(上限, 16384)`。
    // 等于地图向服务商要了 16384 的输出，只给整张图留出 4096——严格校验
    // `input + max_tokens ≤ 窗口` 的服务商在长书上必 400（`graph-agent.ts` 的注释
    // 警告的就是这一格，它自己那两处本来就同值）。
    repo.loadNovel.mockResolvedValue(makeNovel(1000));
    // gpt-4o 表内 16384 输出上限；12k 窗口把预留钳到 12000−600−512 = 10888，
    // 目录因此只配拿 (12000−10888−600)×0.25 = 128 tokens。
    store.config = { ...SMALL_CONFIG, model: "gpt-4o", contextWindow: 12000, maxTokens: undefined };
    chat.mockResolvedValue(reply(validMap()));
    await run();
    const req = chat.mock.calls[0][0];
    const lines = promptOf().split("\n").filter((l) => /^\d+\. 第\d+章 标题$/.test(l));
    expect(lines.length).toBeGreaterThan(1);
    expect(estimateTokens(lines.join("\n")))
      .toBeLessThanOrEqual(Math.floor((12000 - (req.max_tokens as number) - 600) * 0.25));
  });
  it("max_tokens 既不超过模型上限也不超过 16384，并把取消信号透传", async () => {
    // gpt-4o 表内上限正好 16384：用户没填上限时，16384 是硬顶（这条保护原样保留）
    store.config = { ...BIG_CONFIG, model: "gpt-4o", maxTokens: undefined };
    chat.mockResolvedValue(reply(validMap()));
    const controller = new AbortController();
    await run({ signal: controller.signal });
    const req = chat.mock.calls[0][0];
    expect(req.max_tokens).toBe(16384);
    expect(req.signal).toBe(controller.signal);
    expect(req.temperature).toBe(0.3);
  });

  it("用户在设置里填过上限时地图照他的走——过去 16384 这个常数把 8192 之外的都要不回来", async () => {
    store.config = BIG_CONFIG; // 128k 窗口 / 用户填 32768
    chat.mockResolvedValue(reply(validMap()));
    await run();
    expect(chat.mock.calls[0][0].max_tokens).toBe(32768);
  });

  it("信号已经 abort 时一次都不许调用厂商（取消不许被当成一次普通失败去重试）", async () => {
    chat.mockResolvedValue(reply(validMap()));
    const controller = new AbortController();
    controller.abort();
    const r = await run({ signal: controller.signal });
    expect(chat).not.toHaveBeenCalled();
    expect(r.success).toBe(false);
    expect(r.cancelled).toBe(true);
  });

  it("输出上限只有 4096 的模型不能被顶到 16384（直接 400）", async () => {
    chat.mockResolvedValue(reply(validMap()));
    await run();
    expect(chat.mock.calls[0][0].max_tokens).toBe(4096);
  });
});

describe("地图 JSON 的解析：不许静默补全", () => {
  it("纯 JSON 正常解析并原样返回", async () => {
    chat.mockResolvedValue(reply(validMap()));
    const r = await run();
    expect(r.success).toBe(true);
    const places = (r.data as { mapData: { places: { id: string }[] } }).mapData.places;
    expect(places.map((p) => p.id)).toEqual(["1", "2"]);
    expect(r.tokensUsed).toBe(20);
  });

  it("Markdown 围栏 + 前后说明文字仍能解析（老实现会稳定报解析失败）", async () => {
    chat.mockResolvedValue(reply(`好的，以下是《测试书》的地图：\n\`\`\`json\n${validMap()}\n\`\`\`\n希望有帮助。`));
    const r = await run();
    expect(r.success).toBe(true);
  });

  it("被 max_tokens 截断的输出按既有决策修复闭合后收下（地图侧独有）", async () => {
    const full = validMap();
    // 模拟输出在 regions 之前被掐断：layers/places 完整，闭合括号缺失
    chat.mockResolvedValue(reply(full.slice(0, full.indexOf('"regions"'))));
    const r = await run();
    expect(r.success).toBe(true);
    const mapData = (r.data as { mapData: { layers: unknown[]; places: unknown[] } }).mapData;
    expect(mapData.layers.length).toBe(2);
    expect(mapData.places.length).toBe(2);
  });

  it("完全没有 JSON 时明确失败，不返回空地图壳", async () => {
    chat.mockResolvedValue(reply("抱歉，我无法根据目录生成地图。"));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toBe("未能从 AI 响应中解析有效的地图数据。请检查 API 是否正常工作，或尝试使用其他模型。");
    expect(r.data).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("结构齐但内容为空的 JSON 必须失败（空地图不许入库）", async () => {
    chat.mockResolvedValue(reply(JSON.stringify({ layers: [], places: [], regions: [], forces: [] })));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toBe("layers 为空或不是数组");
    expect(r.data).toBeUndefined();
  });

  it("provider 交回空 content（choices 为 null 一类的空壳响应）时报错而不是产出空地图", async () => {
    chat.mockResolvedValue({ content: undefined, tokensUsed: { input: 0, output: 0, total: 0 } } as never);
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toContain("空响应，请检查 API 配置");
    expect(r.data).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(2);
  });
});

describe("地图结构校验", () => {
  async function runWithMap(map: string) {
    chat.mockResolvedValue(reply(map));
    return await run();
  }

  it("level 1 必须唯一：多一个就拒绝（两个顶级=地图无根）", async () => {
    const r = await runWithMap(validMap({
      layers: [
        { level: 1, name: "天下", description: "a" },
        { level: 1, name: "四海", description: "b" },
      ],
    }));
    expect(r.success).toBe(false);
    expect(r.error).toBe("level 1 必须唯一，当前有 2 个");
  });

  it("一个 level 1 都没有也拒绝", async () => {
    const r = await runWithMap(validMap({
      layers: [{ level: 2, name: "州", description: "" }],
    }));
    expect(r.success).toBe(false);
    expect(r.error).toBe("level 1 必须唯一，当前有 0 个");
  });

  it("层级缺 name 时拒绝", async () => {
    const r = await runWithMap(validMap({ layers: [{ level: 1, name: "", description: "" }] }));
    expect(r.success).toBe(false);
    expect(r.error).toContain("层级缺少 level 或 name");
  });

  it("地点 ID 重复时拒绝（重复 ID 会让父子关系指向随机节点）", async () => {
    const r = await runWithMap(validMap({
      places: [
        { id: "1", name: "洛阳", type: "城", level: 1, parentId: "", description: "", importance: 5, x: 100, y: 100, affiliation: "" },
        { id: "1", name: "长安", type: "城", level: 1, parentId: "", description: "", importance: 5, x: 200, y: 200, affiliation: "" },
      ],
    }));
    expect(r.success).toBe(false);
    expect(r.error).toBe("地点 ID 重复: 1");
  });

  it("地点缺 id 或 name 时拒绝", async () => {
    const r = await runWithMap(validMap({
      places: [{ id: "", name: "无名", type: "城", level: 1, parentId: "", description: "", importance: 1, x: 0, y: 0, affiliation: "" }],
    }));
    expect(r.success).toBe(false);
    expect(r.error).toContain("地点缺少 id 或 name");
  });

  it("坐标落在 0/1000 边界上是合法的（边界值不是越界）", async () => {
    const r = await runWithMap(validMap({
      places: [
        { id: "1", name: "极西", type: "城", level: 1, parentId: "", description: "", importance: 5, x: 0, y: 0, affiliation: "" },
        { id: "2", name: "极东", type: "城", level: 1, parentId: "", description: "", importance: 5, x: 1000, y: 1000, affiliation: "" },
      ],
    }));
    expect(r.success).toBe(true);
  });

  it("坐标越界（含负数与 1001）时拒绝并报出是哪个地点", async () => {
    for (const bad of [{ x: 1001, y: 500 }, { x: 500, y: 1001 }, { x: -1, y: 500 }, { x: 500, y: -1 }]) {
      chat.mockResolvedValue(reply(validMap({
        places: [
          { id: "1", name: "洛阳", type: "城", level: 1, parentId: "", description: "", importance: 5, x: 500, y: 500, affiliation: "" },
          { id: "2", name: "虎牢关", type: "关", level: 2, parentId: "1", description: "", importance: 5, ...bad, affiliation: "" },
        ],
      })));
      const r = await run();
      expect(r.success).toBe(false);
      expect(r.error).toContain("地点 虎牢关 的坐标超出范围");
    }
  });

  it("坐标是 \"abc\" / null / 缺失 / Infinity 时必须拒绝", async () => {
    // 旧判据 `x < 0 || x > 1000` 对非数字恒为 false：非法坐标能一路穿过校验入库，
    // 最后在 renderConnections 里拼出 x2="NaN"，父子连线静默消失（界面只看不出少了线）。
    for (const bad of [
      { x: "abc", y: 520 },
      { x: null, y: 520 },
      { y: 520 },
      { x: 600, y: "" },
      { x: 600, y: Number.POSITIVE_INFINITY },
    ]) {
      chat.mockResolvedValue(reply(validMap({
        places: [
          { id: "1", name: "洛阳", type: "城", level: 1, parentId: "", description: "", importance: 5, x: 500, y: 500, affiliation: "" },
          { id: "2", name: "虎牢关", type: "关", level: 2, parentId: "1", description: "", importance: 5, ...bad, affiliation: "" },
        ],
      })));
      const r = await run();
      expect(r.success, `坐标 ${JSON.stringify(bad)} 不该被收下`).toBe(false);
      expect(r.error).toContain("地点 虎牢关 的坐标不是有效数字");
    }
  });

  it("模型把坐标写成 \"620\" 这种数字字符串时收下，并归一成 number 再入库", async () => {
    const r = await runWithMap(validMap({
      places: [
        { id: "1", name: "洛阳", type: "城", level: 1, parentId: "", description: "", importance: 5, x: 500, y: 500, affiliation: "" },
        { id: "2", name: "虎牢关", type: "关", level: 2, parentId: "1", description: "", importance: 5, x: "620", y: "480", affiliation: "" },
      ],
    }));
    expect(r.success).toBe(true);
    const places = (r.data as { mapData: { places: { id: string; x: unknown; y: unknown }[] } }).mapData.places;
    const gate = places.find((p) => p.id === "2")!;
    expect(gate.x).toBe(620);
    expect(gate.y).toBe(480);
  });

  it("parentId 指向不存在的地点时降级为顶级并清空父引用，有效父子关系不动", async () => {
    const r = await runWithMap(validMap());
    expect(r.success).toBe(true);
    const places = (r.data as { mapData: { places: { id: string; parentId: string; level: number }[] } }).mapData.places;
    expect(places.find((p) => p.id === "2")!.parentId).toBe("1");
    expect(places.find((p) => p.id === "2")!.level).toBe(2);

    chat.mockResolvedValue(reply(validMap({
      places: [
        { id: "1", name: "洛阳", type: "城", level: 1, parentId: "", description: "", importance: 5, x: 100, y: 100, affiliation: "" },
        { id: "2", name: "虎牢关", type: "关", level: 3, parentId: "ghost", description: "", importance: 5, x: 200, y: 200, affiliation: "" },
      ],
    })));
    const r2 = await run();
    expect(r2.success).toBe(true);
    const orphan = (r2.data as { mapData: { places: { id: string; parentId: string; level: number }[] } }).mapData.places
      .find((p) => p.id === "2")!;
    expect(orphan.parentId).toBe("");
    expect(orphan.level).toBe(1);
  });

  it("势力与区域里引用不存在的地点被过滤，合法引用保留", async () => {
    const r = await runWithMap(validMap({
      regions: [{ name: "中原", places: ["1", "ghost-region"] }],
      forces: [{ id: "f1", name: "王朝", type: "朝廷", places: ["2", "ghost-force"] }],
    }));
    expect(r.success).toBe(true);
    const mapData = (r.data as { mapData: { regions: { places: string[] }[]; forces: { places: string[] }[] } }).mapData;
    expect(mapData.regions[0].places).toEqual(["1"]);
    expect(mapData.forces[0].places).toEqual(["2"]);
  });

  it("regions / forces 缺失时归一为空数组而不是判失败", async () => {
    const bare = JSON.parse(validMap()) as Record<string, unknown>;
    delete bare.regions;
    delete bare.forces;
    const r = await runWithMap(JSON.stringify(bare));
    expect(r.success).toBe(true);
    const mapData = (r.data as { mapData: { regions: unknown[]; forces: unknown[] } }).mapData;
    expect(mapData.regions).toEqual([]);
    expect(mapData.forces).toEqual([]);
  });

  it("势力缺 id 或 name 时拒绝", async () => {
    const r = await runWithMap(validMap({ forces: [{ id: "", name: "", type: "门派", places: ["1"] }] }));
    expect(r.success).toBe(false);
    expect(r.error).toContain("势力缺少 id 或 name");
  });

  it("区域缺 name 时拒绝", async () => {
    const r = await runWithMap(validMap({ regions: [{ name: "", places: ["1"] }] }));
    expect(r.success).toBe(false);
    expect(r.error).toContain("区域缺少 name");
  });
});

describe("地图的重试与错误分类", () => {
  it("第一次解析失败后，第二次把错误原文塞回 prompt 并成功", async () => {
    chat
      .mockResolvedValueOnce(reply("我想了想，但没有输出 JSON"))
      .mockResolvedValueOnce(reply(validMap()));
    const r = await run();
    expect(r.success).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(promptOf(1)).toContain("【上次生成的输出有误】");
    expect(promptOf(1)).toContain("未能解析到 JSON 数据");
    // 第一次请求不带纠错提示
    expect(promptOf(0)).not.toContain("【上次生成的输出有误】");
  });

  it("CORS 被拦时立即失败，不再撞第二次", async () => {
    chat.mockRejectedValue(new Error("Failed to fetch: CORS 跨域请求被阻止"));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toContain("CORS 策略阻止");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("空响应（全空白）不能被当成成功的空地图", async () => {
    chat.mockResolvedValue(reply("   \n  "));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toContain("空响应");
    expect(promptOf(1)).toContain("API 返回了空响应");
  });

  it("超时后重试一次并带上超时提示", async () => {
    chat
      .mockRejectedValueOnce(new Error("上游 524 Bad Gateway"))
      .mockResolvedValueOnce(reply(validMap()));
    const r = await run();
    expect(r.success).toBe(true);
    expect(promptOf(1)).toContain("API 请求超时");
  });
});

/**
 * 空正文的降级重发（2026-09-27 真厂商实测之后加的）。
 *
 * `sensenova-6.8-flash-lite` 这类默认开思考的模型，会把整份输出预算花在思考上
 * （实测 `completion_tokens=8192 / reasoning_tokens=8192 / 正文 0 字`），于是地图这种
 * "必须回一大份 JSON 才成得了"的任务一个字都拿不到。制作人定的口径是**质量优先**：
 * 第一发照旧让模型想（不许一上来就把思考关掉），只有确认这一发是"空正文"，第二发才带
 * `thinking:false` 重发。所以两头都要钉：该关的时候必须关，不该关的时候不许关。
 *
 * ## 变异台账（12 刀全咬红；四只产品文件各自重抓基线，跑完 `cmp` 还原）
 * 基线：`openai.ts 6cc4d805` / `error-handler.ts 2c101385` / `map-agent.ts 078478c3` /
 * `graph-agent.ts eada7c70`。每轮固定读数 `markers=1 / markers_left=0 / sha 回到基线`，
 * 对照轮（四只测试文件一起跑）135 条全绿、红=0。
 * - provider 那一层（`providers.test.ts` 的「请求级 thinking 覆盖配置级」5 条）
 *   T1 只认配置级、忽略请求级      2 红（false 没生效 + true 顶不开配置，两格各一条）
 *   T2 反过来"没显式说开就发 disabled" 1 红（两边都没设那一格——多发的字段会砸在不支持它的模型上）
 *   T2b 任何显式值都发 disabled     2 红（请求级 true 与配置级 true 各一条）
 * - 判"是不是空正文"那一层（`error-handler-classify.test.ts` 的 5 条）
 *   T3 判得太宽（凡 `^API ` 开头都算） 1 红（"超时/CORS/限流/解析失败都不算"那条）
 *   T4 只认「空结果」漏掉「空响应」    1 红（agent 自己那句空白正文那条）
 *   T5 不再要求它是 Error            1 红（裸字符串也算错那条）
 * - agent 那一层（本文件 6 条 + `graph-agent.test.ts` 5 条）
 *   T6 地图第一发就关思考   4 红（"照旧开思考"＋"第一发不许带"＋超时那条＋解析失败那条）
 *   T7 记了 flag 却从不交出去 2 红（该降级的两条）
 *   T8 空白正文那一支不记 flag 1 红（provider 没抛错那条）
 *   T9 抛错那一支不记 flag     1 红（provider 抛空正文那条）——**T8/T9 是两条腿各一刀**：
 *     空正文有两种写法（抛错 / 回空白），只接一支的另一支就会静默不降级。
 *   T10 图谱第一发就关思考 3 红、T11 图谱抛错支不记 flag 1 红、T12 图谱空白正文支不记 flag 1 红
 * 12 刀没有一记 0 红。
 */
describe("空正文才降级：第二发带 thinking:false 重发", () => {
  const EMPTY_BODY =
    "API 返回了空结果（流式响应无内容）。模型把 8192 token 花在思考上、一个字正文都没回" +
    "（思考与正文共用同一份输出预算）。可以在设置里关闭思考，或调大输出上限。原始响应：{}";

  it("第一发照旧开思考：请求参数里不许出现 thinking", async () => {
    chat.mockResolvedValue(reply(validMap()));
    await run();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0].thinking).toBeUndefined();
  });

  it("第一发回空正文 → 第二发必须带 thinking:false，而第一发不许带", async () => {
    chat
      .mockRejectedValueOnce(new Error(EMPTY_BODY))
      .mockResolvedValueOnce(reply(validMap()));
    const r = await run();
    expect(r.success).toBe(true);
    expect(chat.mock.calls[0][0].thinking).toBeUndefined();
    expect(chat.mock.calls[1][0].thinking).toBe(false);
  });

  it("provider 没抛错、只回了空白正文，同样算空正文要降级", async () => {
    chat
      .mockResolvedValueOnce(reply("   \n  "))
      .mockResolvedValueOnce(reply(validMap()));
    const r = await run();
    expect(r.success).toBe(true);
    expect(chat.mock.calls[1][0].thinking).toBe(false);
  });

  it("超时那种失败不是空正文，第二发不许顺手关思考", async () => {
    chat
      .mockRejectedValueOnce(new Error("上游 524 Bad Gateway"))
      .mockResolvedValueOnce(reply(validMap()));
    await run();
    expect(chat.mock.calls[1][0].thinking).toBeUndefined();
  });

  it("回了字但解析不出 JSON 也不算空正文（那是模型在瞎写，不是没字）", async () => {
    chat
      .mockResolvedValueOnce(reply("我想了想，但没有输出 JSON"))
      .mockResolvedValueOnce(reply(validMap()));
    await run();
    expect(chat.mock.calls[1][0].thinking).toBeUndefined();
  });

  it("降级那一发仍然空正文就到此为止：总共两发，不无限重烧配额", async () => {
    chat.mockRejectedValue(new Error(EMPTY_BODY));
    const r = await run();
    expect(r.success).toBe(false);
    expect(chat).toHaveBeenCalledTimes(2);
  });
});

describe("父级对不上时的可见降级", () => {
  async function runWithMap(map: string) {
    chat.mockResolvedValue(reply(map));
    return await run();
  }
  const place = (over: Record<string, unknown>) => ({
    id: "9", name: "黑木崖", type: "秘境", level: 2, parentId: "1",
    description: "", importance: 5, x: 300, y: 300, affiliation: "", ...over,
  });
  const mapWith = (places: unknown[]) => validMap({
    places: [
      { id: "1", name: "洛阳", type: "都城", level: 1, parentId: "", description: "", importance: 9, x: 500, y: 500, affiliation: "" },
      ...places,
    ],
  });

  it("parentId 指向不存在的地点：降级成顶级并记进 parentMissing（以前只往控制台打一行）", async () => {
    const r = await runWithMap(mapWith([place({ parentId: "ghost" })]));
    expect(r.success).toBe(true);
    const map = (r.data as { mapData: { places: { id: string; parentId: string; level: number }[]; parentMissing?: string[] } }).mapData;
    expect(map.places.find((p) => p.id === "9")).toMatchObject({ parentId: "", level: 1 });
    expect(map.parentMissing).toEqual(["黑木崖"]);
  });

  it("自称 level 2 却没写 parentId：不再整图失败，同样降级并记录", async () => {
    const before = await runWithMap(mapWith([place({ parentId: "" })]));
    expect(before.success).toBe(true);   // 旧行为：error = "地点 黑木崖 的 level > 1 但没有 parentId"
    const map = (before.data as { mapData: { places: { id: string; level: number }[]; parentMissing?: string[] } }).mapData;
    expect(map.places.find((p) => p.id === "9")!.level).toBe(1);
    expect(map.parentMissing).toEqual(["黑木崖"]);
  });

  it("父子关系正常时不带 parentMissing（旧地图也不会突然多出一行提示）", async () => {
    const r = await runWithMap(validMap());
    expect(r.success).toBe(true);
    const map = (r.data as { mapData: { parentMissing?: string[] } }).mapData;
    expect(map.parentMissing).toBeUndefined();
  });

  it("两种坏法同时出现时记在同一份清单里（判据同源，不许再分叉）", async () => {
    const r = await runWithMap(mapWith([
      place({ id: "9", name: "黑木崖", parentId: "ghost" }),
      place({ id: "10", name: "梅庄", parentId: "" }),
    ]));
    expect(r.success).toBe(true);
    const map = (r.data as { mapData: { parentMissing?: string[] } }).mapData;
    expect(map.parentMissing).toEqual(["黑木崖", "梅庄"]);
  });

  it("顶级地点带一个不存在的上级：只清引用、level 仍是 1，也要记下来", async () => {
    const r = await runWithMap(mapWith([place({ level: 1, parentId: "ghost", name: "孤山" })]));
    expect(r.success).toBe(true);
    const map = (r.data as { mapData: { places: { id: string; level: number; parentId: string }[]; parentMissing?: string[] } }).mapData;
    expect(map.places.find((p) => p.id === "9")).toMatchObject({ level: 1, parentId: "" });
    expect(map.parentMissing).toEqual(["孤山"]);
  });

  it("parentId 写着自己：id 存在不等于父级成立，地点不能当自己的上级", async () => {
    const r = await runWithMap(mapWith([place({ parentId: "9" })]));
    expect(r.success).toBe(true);
    const map = (r.data as { mapData: { places: { id: string; parentId: string; level: number }[]; parentMissing?: string[] } }).mapData;
    expect(map.places.find((p) => p.id === "9")).toMatchObject({ parentId: "", level: 1 });
    expect(map.parentMissing).toEqual(["黑木崖"]);
  });

  it("降级不豁免其它判据：level 依然无效时还是整图失败", async () => {
    const r = await runWithMap(mapWith([place({ level: 0, parentId: "ghost" })]));
    expect(r.success).toBe(false);
    expect(r.error).toContain("level 无效");
  });

  // ↓ 批次 W：环。`ids.has(parentId)` 对"互指"恒为真，所以这一类坏法一直过检
  //   （自引用那格在 `0e92e6b` 修掉了，同类里只剩环）。
  type PlacesOf = { id: string; name: string; parentId: string; level: number }[];
  const readMap = (data: unknown) =>
    (data as { mapData: { places: PlacesOf; parentMissing?: string[] } }).mapData;

  it("两个地点互为上级：那是环，不是父子——两边都降级并记进清单", async () => {
    const r = await runWithMap(mapWith([
      place({ id: "9", name: "黑木崖", parentId: "10" }),
      place({ id: "10", name: "梅庄", parentId: "9" }),
    ]));
    expect(r.success).toBe(true);
    const map = readMap(r.data);
    expect(map.places.find((p) => p.id === "9")).toMatchObject({ parentId: "", level: 1 });
    expect(map.places.find((p) => p.id === "10")).toMatchObject({ parentId: "", level: 1 });
    expect(map.parentMissing).toEqual(["黑木崖", "梅庄"]);
  });

  it("三个地点转一圈成环：环上每一格都被拆掉，不是只拆最后一个", async () => {
    const r = await runWithMap(mapWith([
      place({ id: "9", name: "黑木崖", parentId: "11" }),
      place({ id: "10", name: "梅庄", parentId: "9" }),
      place({ id: "11", name: "绿竹巷", parentId: "10" }),
    ]));
    expect(r.success).toBe(true);
    const map = readMap(r.data);
    for (const id of ["9", "10", "11"]) {
      expect(map.places.find((p) => p.id === id)).toMatchObject({ parentId: "", level: 1 });
    }
    expect(map.parentMissing).toEqual(["黑木崖", "梅庄", "绿竹巷"]);
  });

  it("挂在环外的合法子级不许被牵连：它的上级真实存在，就还是二级地点", async () => {
    const r = await runWithMap(mapWith([
      place({ id: "9", name: "黑木崖", parentId: "10" }),
      place({ id: "10", name: "梅庄", parentId: "9" }),
      place({ id: "11", name: "绿竹巷", parentId: "9" }),
    ]));
    expect(r.success).toBe(true);
    const map = readMap(r.data);
    // 11 的上级 9 在环里被降级成顶级，但"9 存在且不是 11 自己"这条没变 → 11 保持二级
    expect(map.places.find((p) => p.id === "11")).toMatchObject({ parentId: "9", level: 2 });
    expect(map.parentMissing).toEqual(["黑木崖", "梅庄"]);
  });

  it("一条正常深链（1←9←11）不触发环检测：一条都不记", async () => {
    const r = await runWithMap(mapWith([
      place({ id: "9", name: "黑木崖", parentId: "1" }),
      place({ id: "11", name: "绿竹巷", parentId: "9" }),
    ]));
    expect(r.success).toBe(true);
    const map = readMap(r.data);
    expect(map.places.find((p) => p.id === "11")).toMatchObject({ parentId: "9", level: 2 });
    expect(map.parentMissing).toBeUndefined();
  });
});
