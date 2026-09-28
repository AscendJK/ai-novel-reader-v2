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
import { APIError, handleFetchError } from "@/api/error-handler";
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

/**
 * 厂商把这一发切断了的形状：`finish_reason=length` → provider 会带 `truncated:true`。
 * 真读数（2026-09-28，deepseek-flash 打小说地图）：`completion=8192 / 思考 8080 / 正文 246 字`。
 */
function replyCut(content: string) {
  return { ...reply(content), truncated: true };
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

/**
 * 提示词里曾经同时写着两句相反的话：规则 5 说「河流、山脉…不作为独立地点」（`:280`），
 * 而 type 举例与体量要求（「确保覆盖…山脉、河流」）又把它们当点位要。模型只能挑一句听——
 * **这就是同一本书两次生成、有时冒出一条河有时没有的源头**，与喂不喂正文无关。
 * 口径由制作人 2026-09-28 定：**保留"不生成自然地理元素"，改掉顶着它的两句**。
 *
 * 判据按**节 + 行**取词面而不是钉整句字面：只钉旧字面的话，把「山脉」挪个位置抄回来就混过去了；
 * 而全文取行又不行——规则 5 与体量要求都提自然地形，不分会互相顶包。
 * 本批先以整句字面立红（2 红），随后按节收紧；收紧后四条在改好的产品上全绿，牙由下面四刀证明。
 *
 * 刀账 **MP1..MP4**（基线：`map-agent.ts` 修好后 sha256 0dd1411c4d905477；变异前源码 cfdd0d56）：
 *  MP1 摘掉规则 5 那一行 → 红 1「规则 5」；
 *  MP2 把「山脉」塞回 type 举例行 → 红 1「type 举例行」；
 *  MP3 把「山脉、河流」塞回覆盖行（出口行仍在，含同样的词）→ 红 1「确保覆盖行」——这条同时证明分节是对的；
 *  MP4 删掉体量要求里的自然地形出口行（= 只删不写）→ 红 1「另起一行给出口」。
 *  四刀各自只红一条，逐刀反向编辑还原，末了 sha256 与基线逐字相同。
 *  如实记一笔：MP4 的盘状态是在跑它之前就被误改出来的（还原 MP3 时多带走了出口行），
 *  靠 `git diff` 才发现；读数本身有效（那一盘确实只少了出口行），但**顺序上它不是一刀一回的产物**。
 */
describe("地图提示词不许自己跟自己打架", () => {
  const NATURAL = ["山脉", "河流", "湖泊", "海洋"];
  /** 按【节】取词面：规则 5 与体量要求都提自然地形，全文取行会让两节互相顶包 */
  function section(head: string): string {
    const p = promptOf();
    const from = p.indexOf(head);
    if (from < 0) return "";
    const rest = p.slice(from + head.length);
    const next = rest.search(/^【[一二三四五六七八九]、/m);
    return next < 0 ? rest : rest.slice(0, next);
  }
  const lineIn = (head: string, key: string) =>
    section(head).split("\n").find((l) => l.includes(key)) ?? "";
  const SCALE = "【三、内容体量要求】";

  it("规则 5「不生成自然地理元素」那行原样送出（改的是冲突，不是取消它）", async () => {
    chat.mockResolvedValue(reply(validMap()));
    await run();
    expect(promptOf()).toContain("- 不生成自然地理元素：河流、山脉、湖泊、海洋等自然地形不作为独立地点");
  });

  it("type 举例行里不许出现自然地形（那是在教模型把河当地点）", async () => {
    chat.mockResolvedValue(reply(validMap()));
    await run();
    const l = lineIn("【二、自主发挥区域", "地点类型 type：");
    expect(l).not.toBe("");
    for (const w of NATURAL) expect(l).not.toContain(w);
  });

  it("「确保覆盖」那一行里不许出现自然地形", async () => {
    chat.mockResolvedValue(reply(validMap()));
    await run();
    const l = lineIn(SCALE, "确保覆盖");
    expect(l).not.toBe("");
    expect(l).toContain("城市");
    for (const w of NATURAL) expect(l).not.toContain(w);
  });

  it("自然地形在体量要求里另起一行给出口（写进 description 与方位参照），不是简单删掉", async () => {
    chat.mockResolvedValue(reply(validMap()));
    await run();
    const l = lineIn(SCALE, "自然地形");
    expect(l).not.toBe("");
    expect(l).toContain("description");
    expect(l).toContain("不作为独立地点");
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

/**
 * 「路的问题」两样分得开（收口笔 C，2026-09-28）
 *
 * `map-agent.ts` 过去自己抄了一遍错误分类：`err.message.includes("CORS" | "blocked" | "524" | "超时")`。
 * 抄出来的那三串里 **没有一串是真会出现的形状**：全仓没有任何代码会产生带 "CORS"/"blocked" 的错误
 * （浏览器 fetch 出不了门只给 `TypeError: Failed to fetch`；"blocked" 只有 IndexedDB 那只在用），
 * 真到期的是代理回过来的 HTTP 504（`server/routes/proxy.js:211`），它不带 "524" 字样。
 * 于是那一支"立即失败、别再撞"永远走不到，而该按超时重试的那一发掉进了"未知错误"。
 * 现在判法只有一处：`error-handler.ts` 的 `classifyTransportFailure`。
 *
 * ## 刀账 P1..P5（对照 = 0 刀时 78 条全绿：本文件 51 + `error-handler-classify.test.ts` 27）
 * 基线 sha256 前 16 位：`error-handler.ts` = `d32b38132903d323`、`map-agent.ts` = `10d72ae121cf77db`；
 * 每刀 markers=1，跑完 `cp` 还原并当场核 sha，盘上 `MUT-` 残留 0。
 * - **P1** 摘掉 `APIError` 那一支（只看 message）→ 红 3：504、524 各一条，加本文件那条真·504。
 * - **P2** 只把 524 摘掉 → 红 1：正是 524 那条。**524 必须单独一条 `it`**：跟 504 合在一条里时
 *   P1 与 P2 会红同一个名字，掉了一个数字这种事就没归属了（这一版一开始就踩到，拆开重打的）。
 * - **P3** 摘掉 "unreachable" 那一支 → 红 2：分类层与地图层各一条（真·fetch 失败会白撞第二发）。
 * - **P4** 反向："凡 APIError 都算超时" → 红 2：「厂商答过了不算路的问题」＋「空正文不许抢」。
 * - **P5** 搬家证据、刀在**另一只文件**：`map-agent.ts` 退回老那版手抄 → 红 2（都在本文件），
 *   分类层那 27 条全 ✓ —— 递进去的判法真在用它，不是自证。
 * - **P6** 摘掉「不是 Error 就直接 null」那道闸 → 红 1：正是「认不到的一律 null」那条
 *   （拿 `undefined` 去取 `.message` 会抛，而不是悄悄返回 null）。那一行有牙，不是防崩的装饰。
 *
 * 「厂商这一场不接」（401/402/429 别白撞第二发）那四条判据的刀在 `error-handler-classify.test.ts`
 * 顶部记着（**Q1 地图不接 → 红 3；Q4 只摘限流栏 → 三层各红一条 429；Q6 改认字面 → 本文件全绿、
 * 只有分类层咬得住**）。刀账总表在那边，这里不重复一份，免得两边改口不同步。
 */
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

  /**
   * 夹具换成**真会出现的原话**（2026-09-28，收口笔 C）。
   *
   * 老夹具是 `new Error("Failed to fetch: CORS 跨域请求被阻止")` —— 后面那半句是编的：
   * 浏览器 fetch 出不了门只给 `TypeError: Failed to fetch`，全仓没有任何代码会带上"CORS"字样。
   * 于是那一版判据绿着，而产品上真被 CORS 拦下时**走不到**"立即失败"那一支：地图会白撞第二发。
   * 老那条编码的意思（被拦→不重试→说人话）两头都还钉着，只是钉在真形状上。
   */
  it("请求出不了浏览器（真·fetch 失败）：立即失败，不再白撞第二发", async () => {
    chat.mockRejectedValue(new TypeError("Failed to fetch"));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toContain("CORS");
    // 盯这句里只有**唯一出处**才有的那半句（刀账 TF3/TF4 在 `graph-agent.test.ts`）：
    // 只认 "CORS" 的话，谁把手抄的字面塞回地图都咬不住——两份句子会各说各的话。
    expect(r.error).toContain("后端没在跑");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("空响应（全空白）不能被当成成功的空地图", async () => {
    chat.mockResolvedValue(reply("   \n  "));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toContain("空响应");
    expect(promptOf(1)).toContain("API 返回了空响应");
  });

  /**
   * 老夹具 `new Error("上游 524 Bad Gateway")` 同样是编的：代理到期真实回的是
   * **HTTP 504**（`server/routes/proxy.js:211`），过 `classifyError` 之后是一枚
   * `apiCode:"server"` 的 `APIError`。按字面认 "524" 的那版判不到它——那一格今天会红。
   */
  it("代理到期（真·HTTP 504）算超时：重试一次，并把超时提示带回 prompt", async () => {
    chat
      .mockRejectedValueOnce(new APIError(
        "API 服务器错误 (504)：服务暂时不可用，请稍后重试。如果持续出现，可能是模型厂商服务中断。",
        "server", 504, '{"error":"代理请求超时（3分钟），API 服务器响应过慢"}',
      ))
      .mockResolvedValueOnce(reply(validMap()));
    const r = await run();
    expect(r.success).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(promptOf(1)).toContain("API 请求超时");
  });

  it("provider 那条腿自己到期（原话带「超时」字样）也算超时，不许掉进「未知错误」", async () => {
    chat
      .mockRejectedValueOnce(new Error("直连超时（30 秒无响应），请检查网络或 API 地址"))
      .mockResolvedValueOnce(reply(validMap()));
    const r = await run();
    expect(r.success).toBe(true);
    expect(promptOf(1)).toContain("API 请求超时");
  });

  /**
   * 厂商"答了、但答的是这一场不接"的三种：401 认证、402 额度、429 限流。
   * 今天它们掉进 `map-agent.ts` 最后那行「未知错误」→ **立刻白撞第二发**：
   * Key 不会自己变对、额度不会自己回来，而限流最坏是第二发把窗口继续往后推。
   * 夹具一律走 `handleFetchError`——那样拿到的是产品真会抛的那枚 `APIError`，
   * 而不是手搓一句厂商根本不会那样说的话（笔 C 就是被假夹具骗过去的那格）。
   */
  async function vendorError(status: number, message: string): Promise<APIError> {
    const res = new Response(JSON.stringify({ error: { message } }), { status });
    return await handleFetchError(res).then(() => null, (e) => e) as APIError;
  }

  it("429 限流：立即失败、不许撞第二发，界面拿厂商那句（含 429）", async () => {
    chat.mockRejectedValue(await vendorError(429, "Too Many Requests"));
    const r = await run();
    expect(r.success).toBe(false);
    expect(chat, "限流时候发＝再撞一次同一个答案，还把窗口往后推").toHaveBeenCalledTimes(1);
    expect(r.error).toContain("429");
  });

  it("401 认证失败：同样一发就收手（Key 不会自己变对，重发是把 token 再花一遍）", async () => {
    chat.mockRejectedValue(await vendorError(401, "Invalid API key"));
    const r = await run();
    expect(r.success).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(r.error).toContain("认证失败");
  });

  it("402 额度用尽：一发就收手，说的是额度不是『服务暂时不可用』", async () => {
    chat.mockRejectedValue(await vendorError(402, "Insufficient balance"));
    const r = await run();
    expect(r.success).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(r.error).toContain("额度");
  });

  /** 反向保护：不许为了省事把"厂商答过的一切错误"都归成不重试——500 那种真值得再撞一发 */
  it("500 服务器错误仍然撞第二发（那一类是瞬时故障，不是『这一场不接』）", async () => {
    chat
      .mockRejectedValueOnce(await vendorError(500, "internal server error"))
      .mockResolvedValueOnce(reply(validMap()));
    const r = await run();
    expect(r.success).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
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
    // 夹具用真形状（HTTP 504 过 classifyError 的那枚 APIError），理由见上面那条超时判据
    chat
      .mockRejectedValueOnce(new APIError(
        "API 服务器错误 (504)：服务暂时不可用，请稍后重试。如果持续出现，可能是模型厂商服务中断。",
        "server", 504, "",
      ))
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

/**
 * 「空正文才降级」漏掉的那一半：厂商把预算花在思考上、**挤出半截 JSON**（制作人在
 * 2026-09-28 拍：算，与空正文同等对待——这就是"质量优先"那条口径的一次收窄，
 * 因为对地图来说半截 JSON 与一个字都没有是同一件事：整张图没有）。
 *
 * 真读数：`vbatch-deepseek-0928` 那一跑，地图第一发 `completion_tokens=8192 /
 * reasoning_tokens=8080 / 正文 246 字 / finish_reason=length`，产品没认它是空正文，
 * 于是第二发照旧开思考，那一发才真的一个字没回；用户看到的是「API 返回了空结果」，
 * 而真正的原因（上限被压到 8192）两发都没说出来。
 *
 * 三头各钉一格，缺一刀就红：
 *  1. 截断的半截 JSON → 第二发必须关思考，而第一发不许关；
 *  2. **反向那一头**：回了完整一份而厂商没标截断（`reply`）→ 第二发不许关思考
 *     （就是上面那条「回了字但解析不出 JSON 也不算空正文」，它是这一批的对照组，别删）；
 *  3. 截断但已经拼出一张可用地图 → 一发就收手，不许多烧配额
 *     （09-23 实测过 `4852 字 / finish_reason=length` 仍然可用那种形状）。
 *
 * ## 变异台账（2026-09-28 实跑；provider 那一层的四刀 AA1..AA4 记在 `providers.test.ts` 档头）
 * 基线与还原核对同那一批：`openai.ts 7c96dc39…` / `anthropic.ts 1301fad7…` /
 * `map-agent.ts e41b4ec2…` / `graph-agent.ts b86b72f6…`，对照轮（0 刀）175 条全绿、reds=0。
 *  - AA5 map 摘掉 `if (response.truncated) sawTruncated = true;` → 红 1（本文件那条主判据）
 *  - AA6 graph 摘掉同一行 → 红 1（`graph-agent.test.ts` 那条同名主判据）——**两边各一刀**：
 *    两文件里那条标题一字不差，归因靠"改了哪只文件 + `FAIL` 行的文件名"，别只数红数
 *  - AA7 map 把那一读改成"切断就地 `continue`（不交给解析）" → 红 1（一发就收手那条）
 *     ——这一刀是"过度修"的形状：只把降级接上、不留住"截断仍可用"那一格，当场就看不出差别
 * 三刀无一记 0 红。
 */
describe("回包被输出上限切断也算这一发没成：第二发带 thinking:false", () => {
  const CUT = '{"places":[{"id":"1","name":"洛阳","level":1,"x":500,"y":500},{"id":"2","name":"虎牢关","level":2,"parentId":"1","x":';

  it("第一发是切断的半截 JSON → 第二发关思考重发，而第一发不许带", async () => {
    chat.mockResolvedValueOnce(replyCut(CUT)).mockResolvedValueOnce(reply(validMap()));
    const r = await run();
    expect(r.success).toBe(true);
    expect(chat.mock.calls[0][0].thinking).toBeUndefined();
    expect(chat.mock.calls[1][0].thinking).toBe(false);
  });

  it("切断但仍然拼出一张可用地图：一发就收手，不许多烧配额", async () => {
    chat.mockResolvedValueOnce(replyCut(validMap()));
    const r = await run();
    expect(r.success).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("降级那一发仍然被切断 → 总共两发就收手", async () => {
    chat.mockResolvedValue(replyCut(CUT));
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
