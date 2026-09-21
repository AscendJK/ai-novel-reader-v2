/**
 * TTS 拼卷/解压流水（server/lib/tts-assemble.mjs）
 *
 * 这段代码端到端要真下 322MB 才看得见，所以这里用**真临时目录 + 假下载器 + 假 7z**：
 * fs 是真的（cpSync/readdirSync/statSync 的语义不该由桩来猜），只有"网络"和"外部命令"
 * 两个边界是演的。锁的是四类后果：
 * - 顺序/结构错了：拼出来的包解不开，或者多套一层目录，模型加载找不到 config.json；
 * - 失败之后盘上留几百 MB 临时卷（本机就实测留过一个上次的 -extract 目录）；
 * - 取消之后还继续下剩下的分卷；
 * - 真实错误被 finally 里的清理异常顶掉，用户看到的是 ReferenceError/EBUSY。
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error - 后端 JS 模块无类型声明
const mod = await import("../../../server/lib/tts-assemble.mjs");
const { createGiteeAssembler, createGitHubTarExtractor } = mod as {
  createGiteeAssembler: (deps: Record<string, unknown>) => (o: Record<string, unknown>) => Promise<void>;
  createGitHubTarExtractor: (deps: Record<string, unknown>) => (o: Record<string, unknown>) => Promise<void>;
};

const PARTS = ["book.7z.001", "book.7z.002", "book.7z.003", "book.7z.004"];
const REQUIRED = ["config.json", "model.onnx"];

interface Env {
  tempDir: string;
  targetDir: string;
  /** 每个分卷/压缩包的真实字节，用来验拼接顺序 */
  blobs: Record<string, Buffer>;
  downloads: string[];
  execs: string[][];
  steps: string[];
  /** 内核每次"验文件头"要读多少字节——超过几十字节就是拿 readFileSync 读整包 */
  heads: number[];
  /** 内核"验文件头"那一刻整包的内容——那是 finally 删掉它之前唯一能读到它的时机 */
  captured: Map<string, string>;
  assemble: (o?: Record<string, unknown>) => Promise<void>;
  tarExtract: (o?: Record<string, unknown>) => Promise<void>;
}

function mkEnv(opts: {
  headOk?: boolean;
  /** 假 7z/tar 解压出来的目录结构：键是相对解压根的路径 */
  extracted?: Record<string, string>;
  execError?: Error & { code?: string };
} = {}): Env {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-assemble-"));
  const targetDir = path.join(tempDir, "cache-target");
  const blobs: Record<string, Buffer> = {};
  PARTS.forEach((p, i) => { blobs[p] = Buffer.from(`卷${i}|`, "utf8"); });
  const downloads: string[] = [];
  const execs: string[][] = [];
  const steps: string[] = [];
  const captured = new Map<string, string>();
  const heads: number[] = [];

  // 7z 的 `-o<dir>` 参数指哪儿就解到哪儿；tar 用 -C tempDir，解出 archiveName/ 那一层
  const exec = async (cmd: string, args: string[]) => {
    execs.push([cmd, ...args]);
    if (opts.execError) throw opts.execError;
    const outIdx = args.findIndex((a) => a.startsWith("-o"));
    const root = outIdx >= 0 ? args[outIdx].slice(2) : path.join(tempDir, "book");
    for (const [rel, body] of Object.entries(opts.extracted ?? { "config.json": "{}", "model.onnx": "M" })) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body, "utf8");
    }
  };

  const download = async (url: string, dest: string) => {
    const name = path.basename(url);
    downloads.push(name);
    // 兜底内容要有几百字节：tar 那条路读的就是它，"文件头只读几个字节"才量得出来
    fs.writeFileSync(dest, blobs[name] ?? Buffer.from("junk".repeat(50)));
  };

  const common = {
    fs,
    path,
    tempDir,
    download,
    exec,
    readHead: (p: string, n: number) => {
      heads.push(n);
      const all = fs.readFileSync(p);
      captured.set(p, all.toString("utf8"));
      return all.subarray(0, n);
    },
    isValidArchiveHead: () => opts.headOk ?? true,
    validateExtracted: (dir: string, required: string[]) => {
      for (const f of required) {
        if (!fs.existsSync(path.join(dir, f))) throw new Error(`缺少文件: ${f}`);
      }
    },
    assertPartsInOrder: (names: string[]) => {
      const nums = names.map((n) => Number(n.slice(n.lastIndexOf(".") + 1)));
      for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) throw new Error("分卷顺序不对");
    },
    log: vi.fn(),
  };

  const assemble = (o: Record<string, unknown> = {}) =>
    createGiteeAssembler(common)({
      baseUrl: "https://example.test/repo",
      partNames: PARTS,
      archiveName: "book",
      targetDir,
      requiredFiles: REQUIRED,
      onProgress: (step: string) => steps.push(step),
      ...o,
    });

  const tarExtract = (o: Record<string, unknown> = {}) =>
    createGitHubTarExtractor(common)({
      url: "https://github.com/x/book.tar.bz2",
      mirrors: ["https://mirror1.test/"],
      archiveName: "book",
      targetDir,
      requiredFiles: REQUIRED,
      onProgress: (step: string) => steps.push(step),
      ...o,
    });

  return { tempDir, targetDir, blobs, downloads, execs, steps, heads, captured, assemble, tarExtract };
}

/** 临时目录里剩下的东西（清理判据看它）——只点名我们关心的那几个，别的目录不参与 */
function leftovers(env: Env): string[] {
  const names = [...PARTS, "book.7z", "book", "book-extract", "book.tar.bz2"];
  return names.filter((n) => fs.existsSync(path.join(env.tempDir, n)));
}

describe("Gitee：7z 分卷拼装", () => {
  it("分卷顺序不对时一个字节都不下载", async () => {
    const env = mkEnv();
    await expect(
      env.assemble({ partNames: [PARTS[0], PARTS[2], PARTS[1], PARTS[3]] }),
    ).rejects.toThrow("分卷顺序不对");
    expect(env.downloads, "先验顺序再花钱：不该已经开始下几百 MB").toEqual([]);
  });

  it("拼接严格按数组顺序写入，卷内容首尾相接", async () => {
    const env = mkEnv();
    await env.assemble();
    // 拼接产物在 finally 里就被删了，所以验"验文件头那一刻读到的整包内容"
    expect([...env.captured.values()], "拼接结果不是按数组顺序串起来的").toEqual(["卷0|卷1|卷2|卷3|"]);
  });

  it("压缩包文件头不对：报文件头校验失败，且临时卷不留在盘上", async () => {
    const env = mkEnv({ headOk: false });
    await expect(env.assemble()).rejects.toThrow("不是有效的 7z 格式");
    expect(env.execs, "文件头都不对还去跑 7z：用户看到的是 tar/7z 的退出码，不是「包坏了」").toEqual([]);
    expect(leftovers(env), "失败之后分卷/拼接产物还在，等于每次失败都往盘上堆几百 MB").toEqual([]);
    // 只读开头几个字节：拿 readFileSync 读整包会把 322MB 全塞进内存（批次 H-1 修的就是这个）
    expect(env.heads, "验文件头却读了整包：内存尖峰回来了").toEqual([6]);
  });

  it("7z 没装：给的是可行动的文案，并且照样清理干净", async () => {
    const err = Object.assign(new Error("spawn 7z ENOENT"), { code: "ENOENT" });
    const env = mkEnv({ execError: err });
    await expect(env.assemble()).rejects.toThrow(/7z 未安装/);
    expect(leftovers(env)).toEqual([]);
  });

  it("7z 非零退出：错误里带上它自己的原因，不许糊成一句\"解压失败\"", async () => {
    const env = mkEnv({ execError: new Error("Data Error") });
    await expect(env.assemble()).rejects.toThrow(/7z 解压失败: Data Error/);
  });

  it("归档里带一层同名目录时，复制的是那一层的内容（不多套一层）", async () => {
    const env = mkEnv({ extracted: { "book/config.json": "{}", "book/model.onnx": "M" } });
    await env.assemble();
    expect(fs.existsSync(path.join(env.targetDir, "config.json")), "targetDir 里多套了一层 book/").toBe(true);
    expect(fs.existsSync(path.join(env.targetDir, "book"))).toBe(false);
  });

  it("归档摊平时同样能复制", async () => {
    const env = mkEnv();
    await env.assemble();
    expect(fs.existsSync(path.join(env.targetDir, "model.onnx"))).toBe(true);
  });

  it("解压前先清空上次的解压目录：半套文件不许混进这次的复制", async () => {
    // 上次进程被强杀时会留下一个填了一半的 -extract 目录；不清空就直接解压+复制，
    // 里面残留的半个 model.onnx 会跟着搬进缓存，症状是"校验明明过了，模型却打不开"。
    const env = mkEnv({ extracted: { "config.json": "fresh" } });
    fs.mkdirSync(path.join(env.tempDir, "book-extract"), { recursive: true });
    fs.writeFileSync(path.join(env.tempDir, "book-extract", "model.onnx"), "STALE");
    await env.assemble({ requiredFiles: ["config.json"] });
    expect(fs.existsSync(path.join(env.targetDir, "model.onnx")), "缓存里躺着一个上次残留的半截模型").toBe(false);
  });

  it("解压结果不齐：把缺哪个文件说清楚，并清掉临时目录", async () => {
    const env = mkEnv({ extracted: { "config.json": "{}" } });
    await expect(env.assemble()).rejects.toThrow("缺少文件: model.onnx");
    expect(leftovers(env)).toEqual([]);
  });

  it("某一分卷下到一半失败：那一卷的半截文件也要被带走", async () => {
    // 清理清单是"按分卷名算出来的"，不是"成功下载了几卷就记几个"——坏在中间那一卷时，
    // 它的半截文件已经在盘上了。少了这一条，每次网络抖动都在 tts-temp 里留几十 MB。
    const env = mkEnv();
    const flaky = createGiteeAssembler({
      fs,
      path,
      tempDir: env.tempDir,
      download: async (url: string, dest: string) => {
        fs.writeFileSync(dest, "写了一半的分卷");
        if (url.endsWith(".003")) throw new Error("socket hang up");
      },
      exec: async () => {},
      readHead: (p: string, n: number) => fs.readFileSync(p).subarray(0, n),
      isValidArchiveHead: () => true,
      validateExtracted: () => {},
      assertPartsInOrder: () => {},
    });
    await expect(
      flaky({
        baseUrl: "https://example.test/repo",
        partNames: PARTS,
        archiveName: "book",
        targetDir: env.targetDir,
        requiredFiles: REQUIRED,
      }),
    ).rejects.toThrow("socket hang up");
    expect(leftovers(env), "第 3 卷的半截文件留在了 tts-temp").toEqual([]);
  });

  it("中途取消：剩下的分卷不再下，已下的清掉", async () => {
    const env = mkEnv();
    const controller = new AbortController();
    const wrapped = createGiteeAssembler({
      fs,
      path,
      tempDir: env.tempDir,
      download: async (_url: string, dest: string) => {
        controller.abort();
        fs.writeFileSync(dest, "半个包");
      },
      exec: async () => {},
      readHead: (p: string, n: number) => fs.readFileSync(p).subarray(0, n),
      isValidArchiveHead: () => true,
      validateExtracted: () => {},
      assertPartsInOrder: () => {},
    });
    await expect(
      wrapped({
        baseUrl: "https://example.test",
        partNames: PARTS,
        archiveName: "book",
        targetDir: env.targetDir,
        requiredFiles: REQUIRED,
        signal: controller.signal,
      }),
    ).rejects.toThrow("下载已取消");
    expect(leftovers(env), "取消之后第一卷的半个包不该留在盘上").toEqual([]);
  });

  it("成功路径按用户看得懂的顺序报进度", async () => {
    const env = mkEnv();
    await env.assemble();
    expect(env.steps).toEqual([
      "下载分卷 1/4", "下载分卷 2/4", "下载分卷 3/4", "下载分卷 4/4",
      "拼接分卷", "校验压缩包", "解压中", "复制文件", "校验文件", "清理",
    ]);
  });

  it("上一次残留的旧中间目录也一起清掉", async () => {
    const env = mkEnv();
    fs.mkdirSync(path.join(env.tempDir, "book"), { recursive: true });
    fs.writeFileSync(path.join(env.tempDir, "book", "stale"), "x");
    await env.assemble();
    expect(leftovers(env)).toEqual([]);
  });

  it("清理时 rmSync 抛错（Windows 上文件被占用），也不许顶掉真正的错误", async () => {
    // 用户该看到"包坏了"，而不是 `EBUSY: resource busy or locked`——后者是本机
    // 偶发的清理失败，跟下载结果没关系。
    const env = mkEnv({ headOk: false });
    const busyFs = {
      ...fs,
      rmSync: () => { throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); },
    };
    const assemble = createGiteeAssembler({
      fs: busyFs,
      path,
      tempDir: env.tempDir,
      download: async (url: string, dest: string) => {
        fs.writeFileSync(dest, env.blobs[path.basename(url)]);
      },
      exec: async () => {},
      readHead: (p: string, n: number) => fs.readFileSync(p).subarray(0, n),
      isValidArchiveHead: () => false,
      validateExtracted: () => {},
      assertPartsInOrder: () => {},
    });
    await expect(
      assemble({
        baseUrl: "https://example.test/repo",
        partNames: PARTS,
        archiveName: "book",
        targetDir: env.targetDir,
        requiredFiles: REQUIRED,
      }),
    ).rejects.toThrow("不是有效的 7z 格式");
  });
});

describe("GitHub：tar.bz2 直连 + 镜像", () => {
  it("官方直连失败时换镜像，成功就不再试第三个源", async () => {
    const tried: string[] = [];
    const env = mkEnv();
    const extract = createGitHubTarExtractor({
      fs,
      path,
      tempDir: env.tempDir,
      download: async (url: string, dest: string) => {
        tried.push(url);
        if (tried.length === 1) throw new Error("connect ECONN");
        fs.writeFileSync(dest, "BZh9");
        fs.mkdirSync(path.join(env.tempDir, "book"), { recursive: true });
        fs.writeFileSync(path.join(env.tempDir, "book", "config.json"), "{}");
        fs.writeFileSync(path.join(env.tempDir, "book", "model.onnx"), "M");
      },
      exec: async () => {},
      readHead: (p: string, n: number) => fs.readFileSync(p).subarray(0, n),
      isValidArchiveHead: () => true,
      validateExtracted: () => {},
    });
    await extract({
      url: "https://github.com/x/book.tar.bz2",
      mirrors: ["https://mirror1.test/", "https://mirror2.test/"],
      archiveName: "book",
      targetDir: env.targetDir,
      requiredFiles: REQUIRED,
    });
    expect(tried).toEqual(["https://github.com/x/book.tar.bz2", "https://mirror1.test/https://github.com/x/book.tar.bz2"]);
    expect(leftovers(env), "成功也要把 tar 包和解压目录带走：一次几百 MB").toEqual([]);
  });

  it("所有源都失败：抛最后那个错，且不留半截包", async () => {
    const env = mkEnv();
    const extract = createGitHubTarExtractor({
      fs,
      path,
      tempDir: env.tempDir,
      download: async (url: string) => {
        fs.writeFileSync(path.join(env.tempDir, "book.tar.bz2"), "半个包");
        throw new Error(`源挂了 ${url}`);
      },
      exec: async () => {},
      readHead: (p: string, n: number) => fs.readFileSync(p).subarray(0, n),
      isValidArchiveHead: () => true,
      validateExtracted: () => {},
    });
    await expect(
      extract({
        url: "https://github.com/x/book.tar.bz2",
        mirrors: ["https://mirror1.test/"],
        archiveName: "book",
        targetDir: env.targetDir,
        requiredFiles: REQUIRED,
      }),
    ).rejects.toThrow("源挂了 https://mirror1.test/https://github.com/x/book.tar.bz2");
    expect(leftovers(env)).toEqual([]);
  });

  it("取消之后不再换下一个镜像硬试", async () => {
    const env = mkEnv();
    const controller = new AbortController();
    const tried: string[] = [];
    const extract = createGitHubTarExtractor({
      fs,
      path,
      tempDir: env.tempDir,
      download: async (url: string) => {
        tried.push(url);
        controller.abort();
        throw new Error("网络断了");
      },
      exec: async () => {},
      readHead: (p: string, n: number) => fs.readFileSync(p).subarray(0, n),
      isValidArchiveHead: () => true,
      validateExtracted: () => {},
    });
    await expect(
      extract({
        url: "https://github.com/x/book.tar.bz2",
        mirrors: ["https://mirror1.test/", "https://mirror2.test/"],
        archiveName: "book",
        targetDir: env.targetDir,
        requiredFiles: REQUIRED,
        signal: controller.signal,
      }),
    ).rejects.toThrow("下载已取消");
    expect(tried, "已经取消了还接着换源下几百 MB").toEqual(["https://github.com/x/book.tar.bz2"]);
  });

  it("下载下来的不是 bzip2：当场报格式不对，不去跑 tar", async () => {
    const env = mkEnv({ headOk: false });
    await expect(env.tarExtract()).rejects.toThrow("不是有效的 bzip2 格式");
    expect(env.execs, "文件头都不对还去跑 tar：错误会变成一个看不懂的 tar 退出码").toEqual([]);
    expect(leftovers(env)).toEqual([]);
    expect(env.heads, "验 tar 文件头却读了整包").toEqual([4]);
  });

  it("解压完却找不到预期目录：说清楚是哪一个", async () => {
    const env = mkEnv({ extracted: {} });
    await expect(env.tarExtract()).rejects.toThrow("解压后找不到目录: book");
    expect(leftovers(env)).toEqual([]);
  });

  it("tar 没装时给可行动文案", async () => {
    const env = mkEnv({ execError: Object.assign(new Error("spawn tar ENOENT"), { code: "ENOENT" }) });
    await expect(env.tarExtract()).rejects.toThrow(/tar 未安装/);
  });
});
