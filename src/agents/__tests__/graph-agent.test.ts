/**
 * graph-agent（人物关系图谱）判别力测试
 *
 * 守三件事：
 *  1) 上下文选取——RAG 预检索与"回退采样"两条路径各喂哪些章，超长 prompt 是否真的降级；
 *  2) 串号——《A》的图谱绝不能拿《B》的正文/书名去生成；
 *  3) 解析——残缺 JSON 必须失败。图谱侧**不开** fixTruncated，被截断的输出不能
 *     被"修"成一份少几个人的图谱（那是项目既定决策，不是待修的宽容度问题）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Novel } from "@/parsers/types";
import { characterGraphAgent } from "../graph-agent";
import { useUIStore } from "@/stores/ui-store";

const repo = vi.hoisted(() => ({ loadNovel: vi.fn() }));
const chat = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({ config: undefined as unknown }));

vi.mock("@/db/repositories", () => ({ loadNovel: repo.loadNovel }));
vi.mock("@/api/registry", () => ({ getProvider: () => ({ format: "openai", chat }) }));
vi.mock("@/stores/api-store", () => ({
  useAPIStore: { getState: () => ({ getActiveProvider: () => store.config }) },
}));

/** 8192 窗口 / 4096 输出：可用输入约 3687 tokens */
const SMALL_CONFIG = {
  id: "p1", format: "openai" as const, name: "t", apiKey: "k", baseUrl: "u",
  model: "graph-small-model", contextWindow: 8192, maxTokens: 4096,
};
/** 输出上限高于 8192 的模型：图谱的 8192 上限必须生效 */
const BIG_CONFIG = {
  id: "p1", format: "openai" as const, name: "t", apiKey: "k", baseUrl: "u",
  model: "graph-big-model", contextWindow: 128000, maxTokens: 32768,
};

function makeNovel(chapterCount: number, id = "book-1", title = "笑傲测试"): Novel {
  return {
    id, title, author: "某作者", fileName: "f.txt", fileFormat: "txt",
    totalChars: 1000, chapterCount, createdAt: 1, updatedAt: 1,
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-ch-${i}`, novelId: id, index: i, title: `第${i + 1}章 标题`,
      content: `第${i + 1}章正文：令狐冲练剑。`, startOffset: 0, endOffset: 10,
    })),
  };
}

function graphJson(nodes: unknown[], edges?: unknown[]) {
  return JSON.stringify({ nodes, edges });
}

const N = (id: string, group = "主角", description = "其人") => ({ id, group, description });

function reply(content: string) {
  return { content, tokensUsed: { input: 11, output: 77, total: 88 } };
}

function promptOf(callIndex = 0): string {
  return chat.mock.calls[callIndex][0].messages[1].content as string;
}

async function run(overrides?: Record<string, unknown>) {
  return await characterGraphAgent.run({ novelId: "book-1", onStatus: vi.fn(), ...overrides } as never);
}

const PRE = "令狐冲与任盈盈在梅庄相聚，岳不群自导自演，左冷禅并购五岳剑派。".repeat(6); // > 100 字符

beforeEach(() => {
  repo.loadNovel.mockReset();
  chat.mockReset();
  store.config = SMALL_CONFIG;
  repo.loadNovel.mockResolvedValue(makeNovel(13));
  useUIStore.setState({ graphCharacterLimit: 50 });
});

describe("图谱的上下文选取（预检索 / 回退采样）", () => {
  it("预检索够长时用语义检索段落，并且不再整本加载正文", async () => {
    repo.loadNovel.mockResolvedValue(makeNovel(13));
    chat.mockResolvedValue(reply(graphJson([N("令狐冲"), N("岳不群")], [])));
    const r = await run({ preRetrieved: PRE });
    expect(r.success).toBe(true);
    expect(repo.loadNovel).toHaveBeenCalledWith("book-1", undefined, false);
    const p = promptOf();
    expect(p).toContain("**语义检索相关段落：**");
    expect(p).toContain("左冷禅并购五岳剑派");
    expect(p).not.toContain("**内容样本：**");
  });

  it("预检索太短（<100 字符）时回退采样，此时必须真把正文读出来", async () => {
    chat.mockResolvedValue(reply(graphJson([N("令狐冲"), N("岳不群")], [])));
    await run({ preRetrieved: "太短了" });
    expect(repo.loadNovel).toHaveBeenCalledWith("book-1", undefined, undefined);
    const p = promptOf();
    expect(p).toContain("**内容样本：**");
    expect(p).not.toContain("太短了");
    // 采样确实选中了开头 + 中段 + 末章，模型才看得见结局
    expect(p).toContain("【第1章 标题】");
    expect(p).toContain("【第7章 标题】");
    expect(p).toContain("【第13章 标题】");
    expect(p).toContain("第13章正文：令狐冲练剑。");
  });

  it("目录带真实章节序号，并且来自按 novelId 加载到的那本书", async () => {
    chat.mockResolvedValue(reply(graphJson([N("令狐冲")], [])));
    await run();
    const p = promptOf();
    expect(p).toContain("《笑傲测试》");
    expect(p).toContain("1. 第1章 标题");
    expect(p).toContain("13. 第13章 标题");
    expect(p).not.toContain("0. 第1章");
  });

  it("串号防护：preloadedNovel 是别的书时忽略它，用本书的目录与书名", async () => {
    repo.loadNovel.mockImplementation(async (id: string) =>
      id === "book-1" ? makeNovel(2, "book-1", "本书") : makeNovel(2, "other", "别书"));
    chat.mockResolvedValue(reply(graphJson([N("令狐冲")], [])));
    await run({ preloadedNovel: makeNovel(2, "stale", "上一本") });
    const p = promptOf();
    expect(p).toContain("《本书》");
    expect(p).not.toContain("上一本");
    expect(p).not.toContain("别书");
  });

  it("千章书的目录按预算抽样并标注，正文样本仍然照给", async () => {
    repo.loadNovel.mockResolvedValue(makeNovel(1000));
    chat.mockResolvedValue(reply(graphJson([N("令狐冲")], [])));
    await run({ preRetrieved: PRE });
    const p = promptOf();
    const lines = p.split("\n").filter((l) => /^\d+\. 第\d+章 标题$/.test(l));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThan(1000);
    expect(lines[0]).toBe("1. 第1章 标题");
    expect(lines[lines.length - 1]).toBe("1000. 第1000章 标题");
    expect(p).toContain("等距抽样");
  });

  it("人物上限取用户设置，不写死 50", async () => {
    useUIStore.setState({ graphCharacterLimit: 30 });
    chat.mockResolvedValue(reply(graphJson([N("令狐冲")], [])));
    await run();
    expect(promptOf()).toContain("识别10-30个重要角色");
    expect(promptOf()).not.toContain("识别10-50个重要角色");
  });

  it("prompt 超出可用输入时降级为目录精简版（否则服务商直接 400）", async () => {
    const huge = "令".repeat(9000);
    chat.mockResolvedValue(reply(graphJson([N("令狐冲")], [])));
    await run({ preRetrieved: huge });
    const p = promptOf();
    expect(p).toContain("请只输出JSON。");
    expect(p).toContain("1. 第1章 标题");
    expect(p).not.toContain("人物关系分析专家");
    expect(p).not.toContain(huge.slice(0, 500));
  });

  it("prompt 在预算内时不降级，完整指令与检索段落都要送出", async () => {
    chat.mockResolvedValue(reply(graphJson([N("令狐冲")], [])));
    await run({ preRetrieved: PRE });
    const p = promptOf();
    expect(p).toContain("你是一位专业的小说人物关系分析专家");
    expect(p).toContain("识别10-50个重要角色");
    expect(p).toContain("左冷禅并购五岳剑派");
    expect(p).not.toContain("请只输出JSON。");
  });
});

describe("图谱 JSON 的解析：必须失败的场景", () => {
  it("纯 JSON 正常解析，节点与边的原文一字不改", async () => {
    chat.mockResolvedValue(reply(graphJson(
      [N("令狐冲", "主角", "华山派大弟子"), N("任盈盈", "主角", "日月神教圣姑"), N("岳不群", "反派", "华山派掌门")],
      [{ source: "令狐冲", target: "任盈盈", label: "恋人" }, { source: "令狐冲", target: "岳不群", label: "师徒" }],
    )));
    const r = await run();
    expect(r.success).toBe(true);
    const g = (r.data as { graphData: { nodes: { id: string }[]; edges: { source: string; target: string; label: string }[] } }).graphData;
    expect(g.nodes.map((n) => n.id)).toEqual(["令狐冲", "任盈盈", "岳不群"]);
    expect(g.edges).toEqual([
      { source: "令狐冲", target: "任盈盈", label: "恋人" },
      { source: "令狐冲", target: "岳不群", label: "师徒" },
    ]);
    expect(r.tokensUsed).toBe(77);
  });

  it("Markdown 围栏 + 前后说明文字能解析", async () => {
    chat.mockResolvedValue(reply(`好的：\n\`\`\`json\n${graphJson([N("令狐冲"), N("岳不群")], [{ source: "令狐冲", target: "岳不群", label: "师徒" }])}\n\`\`\`\n以上。`));
    const r = await run();
    expect(r.success).toBe(true);
  });

  it("被截断的 JSON 必须整体失败（图谱侧不许自动补全成少几个人的关系网）", async () => {
    const full = graphJson(
      [N("令狐冲"), N("任盈盈"), N("岳不群")],
      [{ source: "令狐冲", target: "任盈盈", label: "恋人" }],
    );
    chat.mockResolvedValue(reply(full.slice(0, full.indexOf('"edges"'))));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toBe("未能从 AI 回复中提取到 JSON 图谱数据，请重试。");
    expect(r.data).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("返回空 nodes 时失败，不交出一张空白图谱", async () => {
    chat.mockResolvedValue(reply(graphJson([], [])));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toBe("图谱数据不完整（nodes 为空或不是数组），请重试。");
    expect(r.data).toBeUndefined();
  });

  it("返回的不是 JSON（纯文本致歉）时失败且只重试一次", async () => {
    chat.mockResolvedValue(reply("这部小说的人物关系太复杂了，我无法生成 JSON。"));
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.data).toBeUndefined();
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("空 content（choices 为 null 一类的空壳响应）不能当成功", async () => {
    chat.mockResolvedValue({ content: undefined, tokensUsed: { input: 0, output: 0, total: 0 } } as never);
    const r = await run();
    expect(r.success).toBe(false);
    expect(r.error).toContain("空响应，请检查 API 配置");
    expect(r.data).toBeUndefined();
  });

  it("第一次失败后第二次把错误与要求带回 prompt", async () => {
    chat
      .mockResolvedValueOnce(reply("没有 JSON"))
      .mockResolvedValueOnce(reply(graphJson([N("令狐冲"), N("岳不群")], [{ source: "令狐冲", target: "岳不群", label: "师徒" }])));
    const r = await run();
    expect(r.success).toBe(true);
    expect(promptOf(1)).toContain("【上次生成时出错】");
    expect(promptOf(1)).toContain("edges 数组不能为空");
    expect(promptOf(0)).not.toContain("【上次生成时出错】");
  });
});

describe("图谱的边兜底与引用过滤", () => {
  async function graphOf(json: string) {
    chat.mockResolvedValue(reply(json));
    const r = await run();
    expect(r.success).toBe(true);
    return (r.data as { graphData: { nodes: { id: string; group: string; description: string }[]; edges: { source: string; target: string; label: string }[] } }).graphData;
  }

  it("模型没给边时按节点顺序生成链式兜底边（不多不少，不产生 undefined 节点）", async () => {
    const g = await graphOf(graphJson([N("令狐冲"), N("任盈盈"), N("岳不群")], []));
    expect(g.edges).toEqual([
      { source: "令狐冲", target: "任盈盈", label: "关联" },
      { source: "任盈盈", target: "岳不群", label: "关联" },
    ]);
  });

  it("edges 字段整个缺失也兜底", async () => {
    const g = await graphOf(JSON.stringify({ nodes: [N("令狐冲"), N("岳不群")] }));
    expect(g.edges).toEqual([{ source: "令狐冲", target: "岳不群", label: "关联" }]);
  });

  it("所有边都引用不存在的人物时换成兜底链（否则界面一张空网）", async () => {
    const g = await graphOf(graphJson([N("令狐冲"), N("任盈盈"), N("岳不群")], [
      { source: "甲", target: "乙", label: "仇敌" },
      { source: "令狐冲", target: "丙", label: "利用" },
    ]));
    expect(g.edges).toEqual([
      { source: "令狐冲", target: "任盈盈", label: "关联" },
      { source: "任盈盈", target: "岳不群", label: "关联" },
    ]);
  });

  it("只有一条边无效时仅丢掉那条，真关系不能被兜底链整体覆盖", async () => {
    const g = await graphOf(graphJson([N("令狐冲"), N("任盈盈"), N("岳不群")], [
      { source: "令狐冲", target: "任盈盈", label: "恋人" },
      { source: "任盈盈", target: "岳不群", label: "仇敌" },
      { source: "令狐冲", target: "不存在的人", label: "师徒" },
    ]));
    expect(g.edges).toEqual([
      { source: "令狐冲", target: "任盈盈", label: "恋人" },
      { source: "任盈盈", target: "岳不群", label: "仇敌" },
    ]);
  });

  it("单节点且无边时不产生越界边", async () => {
    const g = await graphOf(graphJson([N("令狐冲")], []));
    expect(g.edges).toEqual([]);
  });

  it("缺失的 description / group 被补全，已有的不被改写", async () => {
    const g = await graphOf(JSON.stringify({
      nodes: [
        { id: "令狐冲", group: "主角", description: "" },
        { id: "岳不群", description: "华山派掌门" },
        { id: "任盈盈", group: "" },
      ],
      edges: [],
    }));
    expect(g.nodes[0].description).toBe("令狐冲（主角）");
    expect(g.nodes[1].group).toBe("其他");
    expect(g.nodes[1].description).toBe("华山派掌门");
    // 补 group 与补 description 的先后顺序不影响"不许留空"这条底线
    expect(g.nodes[2].group).toBe("其他");
    expect(g.nodes[2].description).toContain("任盈盈");
  });
});

describe("图谱的请求参数", () => {
  it("输出上限 8192：模型上限更高时也不能超发", async () => {
    chat.mockResolvedValue(reply(graphJson([N("令狐冲")], [])));
    await run();
    expect(chat.mock.calls[0][0].max_tokens).toBe(4096);
    store.config = BIG_CONFIG;
    await run();
    expect(chat.mock.calls[1][0].max_tokens).toBe(8192);
  });

  it("取消信号与温度随请求送出", async () => {
    chat.mockResolvedValue(reply(graphJson([N("令狐冲")], [])));
    const controller = new AbortController();
    await run({ signal: controller.signal });
    const req = chat.mock.calls[0][0];
    expect(req.signal).toBe(controller.signal);
    expect(req.temperature).toBe(0.3);
  });
});
