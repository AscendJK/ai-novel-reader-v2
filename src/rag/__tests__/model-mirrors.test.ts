/**
 * 模型镜像优先级（批次 G：routes/rag.js 里那份没人看着的判据抽出来）
 *
 * 顺序是用户能感知的行为：管理界面配的镜像必须压过环境变量，环境变量压过默认列表。
 * rag.js 拿整张列表做"依次回源"，rag-worker 拿第一项——两边共用这一份之后，
 * server/lib/rag-worker-core.mjs 原有的 10 条用例就是它对 worker 侧的等价性证明。
 */
import { describe, it, expect } from "vitest";

// @ts-expect-error - 后端 JS 模块无类型声明
const mirrors = await import("../../../server/lib/model-mirrors.mjs");
const { resolveMirrorHosts, DEFAULT_MODEL_MIRRORS } = mirrors as {
  resolveMirrorHosts: (o: {
    configPath?: string;
    envHost?: string;
    defaults?: string[];
    exists?: (p: string) => boolean;
    read?: (p: string) => string;
  }) => string[];
  DEFAULT_MODEL_MIRRORS: string[];
};

const fakeFs = (json: string | null) => ({
  exists: () => json !== null,
  read: () => {
    if (json === null) throw new Error("ENOENT");
    return json;
  },
});

describe("resolveMirrorHosts 的顺序", () => {
  it("配置文件 > 环境变量 > 默认镜像，并且顺序不能反", () => {
    const hosts = resolveMirrorHosts({
      configPath: "/tmp/rag-config.json",
      envHost: "https://env.example.com",
      ...fakeFs(JSON.stringify({ mirrorHost: "https://ui.example.com" })),
    });
    expect(hosts).toEqual([
      "https://ui.example.com/",
      "https://env.example.com/",
      ...DEFAULT_MODEL_MIRRORS,
    ]);
  });

  it("没配镜像时用环境变量，环境变量也没有时用默认列表", () => {
    expect(resolveMirrorHosts({ configPath: undefined, envHost: "https://env.example.com/", ...fakeFs(null) }))
      .toEqual(["https://env.example.com/", ...DEFAULT_MODEL_MIRRORS]);
    expect(resolveMirrorHosts({ ...fakeFs(null) })).toEqual(DEFAULT_MODEL_MIRRORS);
  });

  it("rag-config.json 是坏 JSON 时只丢掉配置那一条，不许抛出去拖死建库", () => {
    const hosts = resolveMirrorHosts({
      configPath: "/tmp/rag-config.json",
      envHost: "https://env.example.com",
      ...fakeFs("{ 这不是 JSON"),
    });
    expect(hosts[0]).toBe("https://env.example.com/");
    expect(hosts).toContain("https://hf-mirror.com/");
  });

  it("配置里没有 mirrorHost 字段时等同于没配", () => {
    const hosts = resolveMirrorHosts({
      configPath: "/tmp/rag-config.json",
      ...fakeFs(JSON.stringify({ other: 1 })),
    });
    expect(hosts).toEqual(DEFAULT_MODEL_MIRRORS);
  });

  it("配置与环境变量指向同一个地址时不重复回源（重复会白等一次超时）", () => {
    const hosts = resolveMirrorHosts({
      configPath: "/tmp/rag-config.json",
      envHost: "https://hf-mirror.com/",
      ...fakeFs(JSON.stringify({ mirrorHost: "https://hf-mirror.com" })),
    });
    expect(hosts).toEqual(["https://hf-mirror.com/", "https://huggingface.co/"]);
  });

  it("配置与环境变量少写尾斜杠会被补上——拼接时少一个斜杠就是 404", () => {
    const hosts = resolveMirrorHosts({
      configPath: "/tmp/rag-config.json",
      envHost: "https://env.example.com",
      defaults: ["https://d.example.com/"],
      ...fakeFs(JSON.stringify({ mirrorHost: "https://ui.example.com" })),
    });
    expect(hosts).toEqual([
      "https://ui.example.com/",
      "https://env.example.com/",
      "https://d.example.com/",
    ]);
  });

  it("默认列表原样兜在最后（它本来就是带斜杠的字面量）", () => {
    expect(DEFAULT_MODEL_MIRRORS.every((h) => h.endsWith("/"))).toBe(true);
    expect(resolveMirrorHosts({ ...fakeFs(null) })).toEqual(DEFAULT_MODEL_MIRRORS);
  });
});
