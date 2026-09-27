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
import { Writable, Readable } from "node:stream";

// @ts-expect-error - 后端 JS 模块无类型声明
const mod = await import("../../../server/lib/tts-assemble.mjs");
const { createGiteeAssembler, createGitHubTarExtractor } = mod as {
  createGiteeAssembler: (deps: Record<string, unknown>) => (o: Record<string, unknown>) => Promise<void>;
  createGitHubTarExtractor: (deps: Record<string, unknown>) => (o: Record<string, unknown>) => Promise<void>;
};

const PARTS = ["book.7z.001", "book.7z.002", "book.7z.003", "book.7z.004"];
/** 拼接产物在临时目录里的名字。假落地口拿它当 append 目标，产品改名字时只改这一处。 */
const ARCHIVE_FILE = "book.combined.7z";
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
  /** 传给内核的那一份依赖（换 fs 时整份复用，只替掉要看的那一格） */
  common: Record<string, unknown>;
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

  return { tempDir, targetDir, blobs, downloads, execs, steps, heads, captured, common, assemble, tarExtract };
}

/** 临时目录里剩下的东西（清理判据看它）——只点名我们关心的那几个，别的目录不参与 */
function leftovers(env: Env): string[] {
  const names = [...PARTS, "book.7z", ARCHIVE_FILE, "book", "book-extract", "book.tar.bz2"];
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

  it("只有一卷、卷名又与拼接产物同名：这一卷不许在被抄进产物之前先被清空", async () => {
    // 生产里真有这一格：WASM 运行时的 `GITEE_WASM_PARTS` 就是单卷 `<archiveName>.7z`，
    // 而拼接产物过去也叫同一个名字。`createWriteStream` 打开即截零，于是"同一个文件
    // 边读边被自己掏空"——7z 拿到的是半截包。真后端 R-D1 实测到的正是它：
    // 下载完整（已下载 8.6 MB）、文件头校验过、`7z x` 报 Unexpected end of archive。
    const env = mkEnv();
    // 跨过 createReadStream 的 64KB 分块：半截才量得出来
    const body = Buffer.from("卷体内容|".repeat(30000));
    env.blobs["book.7z"] = body;
    await env.assemble({ partNames: ["book.7z"] });
    expect([...env.captured.values()], "送进 7z 的那一包不是完整的这一卷").toEqual([body.toString("utf8")]);
    expect(leftovers(env), "单卷这一路失败了还要在 tts-temp 里留东西").toEqual([]);
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

/**
 * 拼卷这一格的**内存账**。
 *
 * 为什么要单独一档：这条链路上"下完 322MB"和"拼完 322MB"是两次内存尖峰，
 * 前者在批次 H-1 已经判住（验文件头只许读 6 字节），后者当时漏了——
 * `ws.write(fs.readFileSync(p))` 会把一整卷（实测一卷 ~50MB）一次性读进内存，
 * 而且不看 `write()` 返回 false，低配设备上是真会当场趴下的。
 * 这三条判据钉的就是这两格，跑的是同一份生产代码（依赖注入的 fs）。
 */
describe("拼卷：一次只许有一卷在内存里", () => {
  /**
   * 一个"会喊累"的落地口：水位 1 字节 + 异步 cb，所以任何一次 write 都会返回 false，
   * 于是"没等到 drain 就又写"变成一件**量得出来**的事。
   */
  function slowSink(dest: string, failAt = 0, finalError: string | null = null) {
    const stat = { writes: 0, bytes: 0, wroteWhileFull: 0 };
    const ws = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _enc, cb) {
        stat.writes++;
        stat.bytes += chunk.length;
        if (failAt && stat.writes === failAt) {
          cb(new Error("ENOSPC: no space left on device"));
          return;
        }
        fs.appendFileSync(dest, chunk);
        setTimeout(cb, 0);
      },
      // 全部 write 都成功了、最后 flush 那一下才炸——pipe 那一格量不到它
      ...(finalError ? { final: (cb: (e?: Error) => void) => cb(new Error(finalError)) } : {}),
    });
    let full = false;
    ws.on("drain", () => { full = false; });
    const orig = ws.write.bind(ws) as (chunk: unknown) => boolean;
    ws.write = ((chunk: unknown) => {
      if (full) stat.wroteWhileFull++;
      const ok = orig(chunk);
      if (!ok) full = true;
      return ok;
    }) as typeof ws.write;
    return { ws, stat };
  }

  const run = (env: Env, fsOverrides: Record<string, unknown>) =>
    createGiteeAssembler({ ...env.common, fs: { ...fs, ...fsOverrides } })({
      baseUrl: "https://example.test/repo",
      partNames: PARTS,
      archiveName: "book",
      targetDir: env.targetDir,
      requiredFiles: REQUIRED,
      onProgress: (step: string) => env.steps.push(step),
    });

  it("拼接不许再为『把整卷读进内存』调用 readFileSync", async () => {
    const env = mkEnv();
    const reads: string[] = [];
    const readFileSync = (p: unknown, ...rest: unknown[]) => {
      reads.push(String(p));
      return (fs.readFileSync as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    };
    await run(env, { readFileSync });
    expect(
      reads.filter((p) => PARTS.some((n) => p.endsWith(n))),
      "拼接又回到 ws.write(fs.readFileSync(卷))：一卷 ~50MB 整个进内存",
    ).toEqual([]);
  });

  it("写满了要等 drain：一次 write 返回 false 之后，没 drain 就不许再写", async () => {
    const env = mkEnv();
    const sink = slowSink(path.join(env.tempDir, ARCHIVE_FILE));
    await run(env, { createWriteStream: () => sink.ws });
    expect(sink.stat.wroteWhileFull, "无视背压：write() 已经返回 false 还接着往下写").toBe(0);
    expect([...env.captured.values()], "流式串接之后拼接结果变了序/少了字节").toEqual(["卷0|卷1|卷2|卷3|"]);
  });

  it("写到一半落地失败：这个错要冒出来，临时卷照样清干净", async () => {
    const env = mkEnv();
    const sink = slowSink(path.join(env.tempDir, ARCHIVE_FILE), 3);
    await expect(run(env, { createWriteStream: () => sink.ws })).rejects.toThrow(/ENOSPC/);
    expect(leftovers(env), "拼卷失败还留着分卷与半截包：每次失败往盘上堆几百 MB").toEqual([]);
  });

  it("全部 write 都成了、最后 flush 那一下才失败：同样不许当成拼好了，也不许去跑 7z", async () => {
    const env = mkEnv();
    const sink = slowSink(path.join(env.tempDir, ARCHIVE_FILE), 0, "flush 失败: EIO");
    await expect(run(env, { createWriteStream: () => sink.ws })).rejects.toThrow(/flush 失败/);
    expect(env.execs, "包都没落地就去解压：用户看到的是 7z 的退出码，不是「写不进去」").toEqual([]);
    expect(leftovers(env)).toEqual([]);
  });

  it("分卷读不出来：抛的是读的那条错，不是写盘那一侧的连带错", async () => {
    // 两条错同时在（源读不到 + ws 最后 flush 也报错）时，用户该看到的是"哪一步没成"，
    // 而不是被 flush 那条盖住。摘掉 `if (pipeErr) throw pipeErr` 这条会红。
    const env = mkEnv();
    const sink = slowSink(path.join(env.tempDir, ARCHIVE_FILE), 0, "flush 失败: EIO");
    const broken = () => {
      const rs = new Readable({ read() {} });
      rs.destroy(new Error("读不到分卷: ENOENT"));
      return rs;
    };
    await expect(
      run(env, { createWriteStream: () => sink.ws, createReadStream: broken }),
    ).rejects.toThrow(/读不到分卷/);
    expect(leftovers(env), "读失败之后分卷留在盘上").toEqual([]);
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

/**
 * 判别力台账（2026-09-27 本机，`npx vitest run src/tts/__tests__/tts-assemble.test.ts`）。
 * 基线：server/lib/tts-assemble.mjs = sha256 02a34924…，每刀 sed 改一行、跑完 `cp` 回基线并 `cmp` 核过。
 * 立红阶段：改产品之前 J1/J2 就是红的（readFileSync 4 次 / wroteWhileFull=3），J3~J5 是要保住的格子。
 *
 *  A1 把 `for (…) await pipeline(createReadStream(p), ws, {end:false})` 换回原来的
 *     `for (…) ws.write(fs.readFileSync(p))` → 3 红：J1 整卷读内存、J2 无视背压、
 *     J5「读的那条错优先」（源换成坏流之后没人读它了）
 *  A2 只摘掉 `{ end: false }` → 14 红（第一卷就把 ws 关掉了，后面整条流水挂到超时）
 *  A3 摘掉 `if (landed.box.error) throw landed.box.error` → 1 红：J4（flush 才失败那一格）
 *  A4 把 `throw pipeErr` 换成 `throw new Error("拼接失败")` → 2 红：J3 + J5（原错必须原样出去）
 *  A5 删掉整段 pipe 循环 → 4 红
 *
 * 没有一刀 0 红。另外记一笔**主动删掉的格子**：原本写过 `if (!pipeErr) await landed.done`
 * （怕 pipeline 把 ws destroy 掉之后再等落地会挂死），摘掉它做对照时**0 红**——判不到，
 * 所以那三行不写了，不是漏了。真要挂死的情形（写回调永不返回）发生在 pipeline 内部，
 * 这一格管不着；A2 就是那种挂死，14 条一起红。
 */

/**
 * 判别力台账·补一笔（同一天晚些，真后端 R-D1 复跑抓出来的那一格）
 *
 * 基线：server/lib/tts-assemble.mjs = sha256 9987cf1f…（拼接产物改名成 `.combined.7z` 之后
 * 的那一版），每刀改一行、跑完 `cp` 回基线并 `cmp` + sha256 核过。
 *
 * 立红：改产品之前新那条「单卷与拼接产物同名」就是红的——
 * `送进 7z 的那一包不是完整的这一卷: expected [''] to deeply equal [Array(1)]`，
 * 也就是 7z 拿到的是 0 字节的包。**这一格不是编出来的**：真后端 R-D1 今天就红在这里
 * （下载完整 8.6 MB、文件头校验过、`7z x` 报 Unexpected end of archive）。成因是两次改动
 * 撞出来的：`GITEE_WASM_PARTS` 是单卷、卷名恰好等于拼接产物名，而拼卷从
 * `ws.write(fs.readFileSync(卷))` 换成流式串接之后，"读这一卷"与"写同一个文件"第一次
 * 真的同时发生——`createWriteStream` 打开即截零。旧的整卷读法把数据先捞进内存，同名反而无害。
 *
 *  T1 把 archivePath 换回 `archiveName + ".7z"`（等于还原这次修复）→ 4 红：
 *     新判据（0 字节包）+ 借同名当 append 目标的三条内存/清理判据
 *  T2 把 archivePath 从 finally 的清理清单里摘掉 → 7 红（新判据里那半条 leftovers 在内）
 *
 * 没有一刀 0 红。假落地口那四条原先把文件名抄了一遍遍，这次收成常量 ARCHIVE_FILE，
 * 免得下次产品改名时要跟着改四处判据。
 */
