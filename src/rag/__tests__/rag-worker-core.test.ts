/**
 * 服务端向量索引 worker 的核心两件事（批次 E-3）
 *
 * `server/rag-worker.mjs` 此前既无单测也无探针可达。它能被跑起来的部分要下载模型，
 * 所以把两处纯逻辑挪进 server/lib/rag-worker-core.mjs 单独锁：
 *   1) 分批编码——最坏的失败模式不是报错，是"文本与向量错位"：索引形状完全合法、
 *      数量对得上、父进程自校验过得去，检索出来的段落却是别的章节。
 *   2) 模型下载源判定——坏配置不能把整次建库拖死。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error - 后端 JS 模块无类型声明
const core = await import("../../../server/lib/rag-worker-core.mjs");
const { resolveMirrorHost, runEmbeddingBatches } = core as {
  resolveMirrorHost: (o: { configPath?: string; envHost?: string }) => string;
  runEmbeddingBatches: (o: {
    chunks: unknown[];
    batchSize: number;
    embed: (texts: string[]) => Promise<number[][]>;
    onProgress?: (m: { type: string; current: number; total: number }) => void;
  }) => Promise<{ vectors: number[][]; dim: number }>;
};

function tempConfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-mirror-"));
  const file = path.join(dir, "rag-config.json");
  fs.writeFileSync(file, contents, "utf-8");
  return file;
}

describe("resolveMirrorHost", () => {
  it("配置文件里的 mirrorHost 优先，且保证以 / 结尾", () => {
    const f = tempConfig(JSON.stringify({ mirrorHost: "https://mirror.example.com" }));
    expect(resolveMirrorHost({ configPath: f, envHost: "https://env.example.com/" })).toBe(
      "https://mirror.example.com/"
    );
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });

  it("没有配置文件时用环境变量，都没有时用默认镜像", () => {
    expect(resolveMirrorHost({ configPath: path.join(os.tmpdir(), "不存在.json"), envHost: "https://env.example.com/" })).toBe(
      "https://env.example.com/"
    );
    expect(resolveMirrorHost({})).toBe("https://hf-mirror.com/");
  });

  it("配置文件是坏 JSON 时退回可用值而不是抛异常（坏配置不该把建库拖死）", () => {
    const f = tempConfig("{ 这不是 JSON");
    expect(resolveMirrorHost({ configPath: f, envHost: "https://env.example.com/" })).toBe("https://env.example.com/");
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });

  it("配置文件里没有 mirrorHost 字段时不算数", () => {
    const f = tempConfig(JSON.stringify({ other: 1 }));
    expect(resolveMirrorHost({ configPath: f })).toBe("https://hf-mirror.com/");
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });
});

/** 每条向量回填"我收到的是第几条文本"，这样错位一眼可见 */
function echoEmbed(batches: string[][]) {
  return async (texts: string[]) => {
    batches.push(texts);
    return texts.map((t, i) => [batches.length - 1, i, t.length]);
  };
}

describe("runEmbeddingBatches", () => {
  it("每批拿到的文本正是该批 chunk 的 content，顺序不打乱", async () => {
    const chunks = Array.from({ length: 7 }, (_, i) => ({ content: `第${i}章正文` }));
    const batches: string[][] = [];
    const { vectors } = await runEmbeddingBatches({ chunks, batchSize: 3, embed: echoEmbed(batches) });
    expect(batches).toEqual([
      ["第0章正文", "第1章正文", "第2章正文"],
      ["第3章正文", "第4章正文", "第5章正文"],
      ["第6章正文"],
    ]);
    expect(vectors).toHaveLength(7);
    expect(vectors.map((v) => v[2])).toEqual(chunks.map((c) => c.content.length));
  });

  it("字符串形态的 chunk 与对象形态混着传也能各取到自己", async () => {
    const chunks = ["纯字符串", { content: "对象内容" }, "纯字符串2", { content: "对象内容2" }];
    const batches: string[][] = [];
    await runEmbeddingBatches({ chunks, batchSize: 2, embed: echoEmbed(batches) });
    expect(batches).toEqual([["纯字符串", "对象内容"], ["纯字符串2", "对象内容2"]]);
  });

  it("进度单调不减、封顶在 chunk 总数（超过 total 会让界面进度条倒退或爆表）", async () => {
    const chunks = Array.from({ length: 7 }, (_, i) => `c${i}`);
    const seen: { current: number; total: number }[] = [];
    await runEmbeddingBatches({
      chunks,
      batchSize: 3,
      embed: async (t) => t.map(() => [1]),
      onProgress: (m) => seen.push({ current: m.current, total: m.total }),
    });
    expect(seen.map((s) => s.current)).toEqual([3, 6, 7]);
    expect(seen.every((s) => s.total === 7)).toBe(true);
    expect(seen.every((s) => s.current <= s.total)).toBe(true);
  });

  it("dim 取第一条向量的长度（父进程靠它判索引是否完整，取到最后一条会随批次数漂移）", async () => {
    let calls = 0;
    const { dim } = await runEmbeddingBatches({
      chunks: ["a", "b"],
      batchSize: 1,
      embed: async () => {
        calls++;
        return calls === 1 ? [[0, 1, 2, 3]] : [[7]]; // 第二批故意给一条更短的
      },
    });
    expect(dim).toBe(4);
  });

  it("没有 chunk 时一次都不调用 embed（不许白下载模型）", async () => {
    let calls = 0;
    const r = await runEmbeddingBatches({
      chunks: [],
      batchSize: 8,
      embed: async () => {
        calls++;
        return [];
      },
    });
    expect(calls).toBe(0);
    expect(r).toEqual({ vectors: [], dim: 0 });
  });

  it("某一批失败时错误原样抛出——worker 顶层会把它转成 error 消息，父进程据此标记失败", async () => {
    await expect(
      runEmbeddingBatches({
        chunks: ["a", "b", "c"],
        batchSize: 1,
        embed: async (t) => {
          if (t[0] === "b") throw new Error("模型炸了");
          return [[1]];
        },
      })
    ).rejects.toThrow("模型炸了");
  });
});
