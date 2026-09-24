/**
 * B3：`server/rag-worker.mjs` 那 39 行接线（地板第 2 档）
 *
 * E-3 把两处纯逻辑挪进 `server/lib/rag-worker-core.mjs` 单独锁了，剩下的这一层当时是
 * 故意留白的——它"能被跑起来的部分要下载模型"。这里不下载模型：把 `@xenova/transformers`
 * 和 `node:worker_threads` 两个**边界**桩住，判的是我们究竟把什么交给 transformers、
 * 父进程（`rag-builder.js:253-265`）究竟能收到什么。core 用真的，所以分批与进度那条链
 * 是跟着一起被穿一遍的，不是拿桩自补。
 *
 * 三处判据各有真实故障，不是装饰：
 *   ① `normalize: true` 掉了 → 向量长度不为 1，父进程的数量/维度自校验照样过得去，
 *      检索出来的段落排序静默错（跟 E-3 那条"文本与向量错位"是同一族）。
 *   ② 失败路径不 postMessage → 父进程收不到 error，只能干等到 10~60 分钟的编码超时，
 *      用户看到的原因为什么是"超时"而不是"模型下载失败"。
 *   ③ 镜像源配置文件路径写错 → 静默退回默认镜像，坏在境内网络上是整次建库挂住。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  pipeTasks: [] as Array<{ task: string; model: string }>,
  pipeCalls: [] as Array<{ texts: string[]; opts: unknown }>,
  workerData: {} as Record<string, unknown>,
  env: {} as Record<string, unknown>,
  mirrorArgs: [] as Array<Record<string, unknown>>,
  mirrorReturn: "",
  pipelineError: null as unknown,
  finish: null as null | (() => void),
}));

// 两个桩都自带 default：worker 走的是 ESM→SSR 转换后的取法，只给具名导出时
// vitest 会在 import 那一行抛 `No "default" export is defined on the mock`
vi.mock("node:worker_threads", () => {
  const api = {
    parentPort: {
      postMessage: (m: Record<string, unknown>) => {
        h.messages.push(m);
        if (m.type === "done" || m.type === "error") h.finish?.();
      },
    },
    // 模块在 import 时解构 workerData，所以每个用例只改这个对象的内容、不换引用
    workerData: h.workerData,
  };
  return { ...api, default: api };
});

vi.mock("@xenova/transformers", () => {
  const api = {
    env: h.env,
    pipeline: async (task: string, model: string) => {
      h.pipeTasks.push({ task, model });
      if (h.pipelineError) throw h.pipelineError;
      return async (texts: string[], opts: unknown) => {
        h.pipeCalls.push({ texts, opts });
        // 行内容只跟文本本身有关，好让"顺序"这一项可判
        return { tolist: async () => texts.map((t) => [t.length, t.charCodeAt(0)]) };
      };
    },
  };
  return { ...api, default: api };
});

// core 走真实现，只在外面套一层记录入参的壳——判的是 worker 传了什么，不是 core 怎么算
vi.mock("../../../server/lib/rag-worker-core.mjs", async (importOriginal) => {
  const real = (await importOriginal()) as {
    resolveMirrorHost: (o: { configPath?: string; envHost?: string }) => string;
  };
  return {
    ...real,
    resolveMirrorHost: (o: { configPath?: string; envHost?: string }) => {
      h.mirrorArgs.push({ ...o });
      h.mirrorReturn = real.resolveMirrorHost(o);
      return h.mirrorReturn;
    },
  };
});

function setData(d: Record<string, unknown>): void {
  for (const k of Object.keys(h.workerData)) delete h.workerData[k];
  Object.assign(h.workerData, d);
}

/** 跑一遍 worker，返回父进程收到的消息序列（按时间顺序）。 */
async function runWorker(
  d: Record<string, unknown>,
  inject?: { pipelineError?: unknown },
): Promise<Array<Record<string, unknown>>> {
  h.messages.length = 0;
  h.pipeTasks.length = 0;
  h.pipeCalls.length = 0;
  h.mirrorArgs.length = 0;
  h.mirrorReturn = "";
  h.pipelineError = inject?.pipelineError ?? null;
  for (const k of Object.keys(h.env)) delete h.env[k];
  setData({ batchSize: 2, modelKey: "Xenova/test-model", ...d });
  vi.resetModules();
  const settled = new Promise<void>((res) => { h.finish = res; });
  // 说明符得写成字面量：地板靠正则抽 import 图（`audit-import-graph.mjs:88` 只认字面量的
  // 动态 import），用变量就是"判据在、账上查不到"，这只文件会被继续算成两层都没碰到。
  // @ts-expect-error - 后端 worker 无类型声明，且这只文件在 rootDir 之外
  const loading = import("../../../server/rag-worker.mjs");
  // 顶层那句 run() 是异步的：import 只保证同步段跑完，所以等终止消息。
  // 2 秒兜底——真出"永远不发终止消息"这种故障，要让断言红，而不是把用例挂住。
  await Promise.race([settled, new Promise((r) => setTimeout(r, 2_000))]);
  await loading;
  return h.messages;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("worker 与模型之间的那一句", () => {
  it("按 feature-extraction + workerData 里那个模型加载，两批文本各交一次", async () => {
    await runWorker({ chunks: ["甲甲", "乙乙", "丙"] });
    expect(h.pipeTasks).toEqual([{ task: "feature-extraction", model: "Xenova/test-model" }]);
    expect(h.pipeCalls.map((c) => c.texts)).toEqual([["甲甲", "乙乙"], ["丙"]]);
  });

  it("每一批都带 pooling=mean 与 normalize=true：少了 normalize 向量长度不为 1，检索排序静默错", async () => {
    await runWorker({ chunks: ["甲甲", "乙乙", "丙"] });
    expect(h.pipeCalls).toHaveLength(2);
    for (const call of h.pipeCalls) {
      expect(call.opts).toEqual({ pooling: "mean", normalize: true });
    }
  });

  it("workerData 没给 modelKey 时不许把 undefined 拿去加载模型", async () => {
    await runWorker({ chunks: ["甲"], batchSize: 1, modelKey: undefined });
    expect(h.pipeTasks[0].model).toBe("Xenova/bge-small-zh-v1.5");
  });
});

describe("父进程收到的那一串消息", () => {
  it("downloading 打头，逐批 progress，最后一条 done 带全向量与维度", async () => {
    const messages = await runWorker({ chunks: ["甲甲", "乙乙", "丙"] });
    expect(messages[0]).toEqual({ type: "downloading", model: "Xenova/test-model" });
    expect(messages.slice(1, 3)).toEqual([
      { type: "progress", current: 2, total: 3 },
      { type: "progress", current: 3, total: 3 },
    ]);
    expect(messages[3]).toEqual({
      type: "done",
      // 甲甲 U+7532=30002 / 乙乙 U+4E59=20057 / 丙 U+4E19=19993
      vectors: [[2, 30002], [2, 20057], [1, 19993]],
      dim: 2,
    });
    expect(messages).toHaveLength(4);
  });

  it("done 里的向量顺序就是文本顺序：错位会造出形状合法、内容全错的索引", async () => {
    const messages = await runWorker({ chunks: ["甲甲", "乙乙", "丙"], batchSize: 1 });
    const done = messages[messages.length - 1];
    expect((done.vectors as number[][]).map((v) => v[0])).toEqual([2, 2, 1]);
  });
});

describe("失败路径不许把父进程晾着", () => {
  it("模型加载抛错时只发一条 error，且带原因、不发 done", async () => {
    const messages = await runWorker({ chunks: ["甲"] }, { pipelineError: new Error("模型下载失败：连接被重置") });
    expect(messages.map((m) => m.type)).toEqual(["downloading", "error"]);
    expect(messages[1].error).toBe("模型下载失败：连接被重置");
  });

  it("抛出来的不是 Error（没有 message）时也要有可读文案，不许让父进程 new Error(undefined)", async () => {
    const messages = await runWorker({ chunks: ["甲"] }, { pipelineError: "网络断了" });
    expect(messages[1]).toEqual({ type: "error", error: "网络断了" });
  });
});

describe("下载源与缓存目录的接线", () => {
  it("镜像源读的是 server/data/rag-config.json，环境变量作退路，算出来的值真写进 env", async () => {
    process.env.HF_MIRROR = "https://env-mirror.example/";
    try {
      await runWorker({ chunks: ["甲"] });
      expect(h.mirrorArgs).toHaveLength(1);
      const args = h.mirrorArgs[0] as { configPath: string; envHost: string };
      expect(args.configPath.replace(/\\/g, "/")).toMatch(/server\/data\/rag-config\.json$/);
      expect(args.envHost).toBe("https://env-mirror.example/");
      expect(h.env.remoteHost).toBe(h.mirrorReturn);
    } finally {
      delete process.env.HF_MIRROR;
    }
  });

  it("模型缓存落在 server/data/models-cache，且允许远程模型（否则每次建库都重新下载）", async () => {
    await runWorker({ chunks: ["甲"] });
    const dir = (p: unknown) => String(p).replace(/\\/g, "/");
    expect(dir(h.env.cacheDir)).toMatch(/server\/data\/models-cache$/);
    expect(dir(h.env.localModelPath)).toMatch(/server\/data\/models-cache$/);
    expect(h.env.allowRemoteModels).toBe(true);
  });
});
