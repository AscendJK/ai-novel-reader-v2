/**
 * 下载链路里"只做判断"的五块（lib/tts-archive-checks.mjs）
 *
 * 整条 322MB 下载在 CI 里做不起，但做不起的是"真下载"，不是"判定"：磁盘余量、
 * 压缩包文件头、只读头部的字节数、解压后的齐套与最小尺寸、分卷拼接顺序——这五块
 * 改坏了都不会立刻出事，而是等几百 MB 下完、甚至等用户点朗读时才炸。
 * 所以把它们用几 KB 的假样本钉住。
 */
import { describe, it, expect, vi } from "vitest";

// @ts-expect-error - 后端 JS 模块无类型声明
const mod = await import("../../../server/lib/tts-archive-checks.mjs");
const {
  isValid7z, isValidBz2, readHeadSync, checkExtractedFiles, checkDiskSpace, assertPartsInOrder,
} = mod as {
  isValid7z: (b: Buffer) => boolean;
  isValidBz2: (b: Buffer) => boolean;
  readHeadSync: (p: string, n: number, fsImpl?: Record<string, (...a: never[]) => unknown>) => Buffer;
  checkExtractedFiles: (req: Record<string, number>, readSize: (n: string) => number | null) => unknown;
  checkDiskSpace: (o: {
    dir: string; minBytes: number;
    fsImpl: { existsSync: (p: string) => boolean; statfsSync: (p: string) => unknown };
    pathImpl?: { dirname: (p: string) => string };
  }) => number | null;
  assertPartsInOrder: (names: string[]) => string[];
};

const SEVEN_Z_HEAD = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const BZ2_HEAD = Buffer.from([0x42, 0x5a, 0x68, 0x39]);

describe("压缩包文件头", () => {
  it("7z 头认得，且至少要读到第 5 字节才算数", () => {
    expect(isValid7z(SEVEN_Z_HEAD)).toBe(true);
    expect(isValid7z(SEVEN_Z_HEAD.subarray(0, 4))).toBe(false); // 读太短会被判成"不是 7z"
    expect(isValid7z(Buffer.alloc(0))).toBe(false);
    expect(isValid7z(BZ2_HEAD)).toBe(false);
  });

  it("bzip2 头认得，且与 7z 互斥", () => {
    expect(isValidBz2(BZ2_HEAD)).toBe(true);
    expect(isValidBz2(BZ2_HEAD.subarray(0, 2))).toBe(false);
    expect(isValidBz2(SEVEN_Z_HEAD)).toBe(false);
  });
});

describe("只读文件头", () => {
  const fakeFs = (size: number, read: number) => {
    const calls: unknown[][] = [];
    return {
      calls,
      fsImpl: {
        openSync: (...a: unknown[]) => { calls.push(["open", ...a]); return 7; },
        readSync: (...a: unknown[]) => { calls.push(["read", ...a]); return read; },
        closeSync: (...a: unknown[]) => { calls.push(["close", ...a]); return undefined; },
      },
      size,
    };
  };

  it("绝不整包读入：只 openSync + readSync(maxBytes) + closeSync", () => {
    const f = fakeFs(322 * 1024 * 1024, 6);
    const head = readHeadSync("/tmp/kokoro.7z", 6, f.fsImpl as never);
    expect(f.calls).toEqual([
      ["open", "/tmp/kokoro.7z", "r"],
      ["read", 7, head, 0, 6, 0],
      ["close", 7],
    ]);
    expect(head.length).toBe(6);
  });

  it("读到的字节数就是返回长度（文件比 maxBytes 还短不能补零）", () => {
    const f = fakeFs(3, 3);
    const head = readHeadSync("/tmp/tiny", 6, f.fsImpl as never);
    expect(head.length).toBe(3);
    expect(isValid7z(head)).toBe(false);
  });

  it("读抛出异常也必须关掉 fd（否则下载重试几次就把进程 fd 耗光）", () => {
    const closed: number[] = [];
    const fsImpl = {
      openSync: () => 9,
      readSync: () => { throw new Error("EIO"); },
      closeSync: (fd: number) => { closed.push(fd); },
    };
    expect(() => readHeadSync("/tmp/bad", 6, fsImpl as never)).toThrow("EIO");
    expect(closed).toEqual([9]);
  });
});

describe("解压后的齐套与最小尺寸", () => {
  const REQ = {
    "model.onnx": 1024 * 1024,
    "tokens.txt": 100,
    "dict/jieba.dict.utf8": 1024 * 1024,
  };

  it("全部就位时不报错", () => {
    const readSize = (n: string) => (n === "tokens.txt" ? 100 : 40 * 1024 * 1024);
    expect(() => checkExtractedFiles(REQ, readSize)).not.toThrow();
  });

  it("缺文件时把缺的全部列出来，而不是只报第一个", () => {
    const readSize = (n: string) => (n === "tokens.txt" ? 500 : null);
    expect(() => checkExtractedFiles(REQ, readSize)).toThrow(
      "解压后缺少文件: model.onnx, dict/jieba.dict.utf8"
    );
  });

  it("尺寸不够时报出实际与要求（KB 取整，这串文案直接进设置页提示）", () => {
    const readSize = (n: string) => (n === "model.onnx" ? 600 * 1024 : 2 * 1024 * 1024);
    expect(() => checkExtractedFiles(REQ, readSize)).toThrow(
      "解压后文件异常（可能损坏）: model.onnx (600KB < 1024KB)"
    );
  });

  it("恰好等于最小尺寸算通过（判定是 <，不是 <=）", () => {
    const readSize = (n: string) => REQ[n as keyof typeof REQ];
    expect(() => checkExtractedFiles(REQ, readSize)).not.toThrow();
  });

  it("要求表里 0 字节门槛也不放过缺失项", () => {
    expect(() => checkExtractedFiles({ "a.txt": 0 }, () => null)).toThrow("解压后缺少文件: a.txt");
  });
});

describe("下载前的磁盘余量", () => {
  const GB = 1024 * 1024 * 1024;
  const MIN = 500 * 1024 * 1024;
  const mk = (free: number, exists: (p: string) => boolean = () => true, statfsThrows = false) => ({
    existsSync: exists,
    statfsSync: vi.fn(() => {
      if (statfsThrows) throw new Error("EPERM");
      return { bsize: 4096, bavail: Math.floor(free / 4096), blocks: Math.floor(80 * GB / 4096) };
    }),
  });

  it("余量够就放行，并把可用字节数报回去", () => {
    const fsImpl = mk(2 * GB) as never;
    expect(checkDiskSpace({ dir: "/srv/models", minBytes: MIN, fsImpl })).toBe(2 * GB);
  });

  it("余量不够时挡住，文案含要求量与实际量", () => {
    const fsImpl = mk(120 * 1024 * 1024) as never;
    expect(() => checkDiskSpace({ dir: "/srv/models", minBytes: MIN, fsImpl })).toThrow(
      /磁盘空间不足：需要至少 500MB，\/srv\/models 当前可用 120MB/
    );
  });

  it("只用 statfsSync 真正有的字段（历史上拿 available/size 相乘得 NaN，守卫从未生效）", () => {
    // 只给 available/size 时读数必然是 NaN → 必须走"跳过并 warn"，绝不能当成"够"或"不够"
    const fsImpl = { existsSync: () => true, statfsSync: () => ({ available: 10, size: 1 }) } as never;
    expect(checkDiskSpace({ dir: "/srv", minBytes: MIN, fsImpl })).toBeNull();
  });

  it("目标目录还不存在时逐级上溯到存在的祖先，报错文案用那个祖先", () => {
    const fsImpl = {
      existsSync: (p: string) => p === "/srv",
      statfsSync: vi.fn(() => ({ bsize: 4096, bavail: Math.floor((120 * 1024 * 1024) / 4096) })),
    } as never;
    expect(() => checkDiskSpace({ dir: "/srv/app/server/data/models-cache", minBytes: MIN, fsImpl }))
      .toThrow(/\/srv 当前可用 120MB/);
  });

  it("statfsSync 抛错时跳过检查：平台差异不该挡死所有人的下载", () => {
    const fsImpl = mk(0, () => true, true) as never;
    expect(checkDiskSpace({ dir: "/srv", minBytes: MIN, fsImpl })).toBeNull();
  });
});

describe("分卷顺序", () => {
  it("单卷清单原样放行", () => {
    expect(assertPartsInOrder(["kokoro-multi-lang-v1_0.tar.bz2.7z"])).toEqual(["kokoro-multi-lang-v1_0.tar.bz2.7z"]);
  });

  it("四卷按 .001..004 放行", () => {
    const parts = ["m.7z.001", "m.7z.002", "m.7z.003", "m.7z.004"];
    expect(assertPartsInOrder(parts)).toEqual(parts);
  });

  it("顺序颠倒要在下第一卷之前就被挡住，并说清第几项不对", () => {
    expect(() => assertPartsInOrder(["m.7z.001", "m.7z.003", "m.7z.002", "m.7z.004"]))
      .toThrow(/第 2 项应为 \.002，实际 m\.7z\.003/);
  });

  it("断号同样挡住（漏下 .002 拼出来的包一定是坏的）", () => {
    expect(() => assertPartsInOrder(["m.7z.001", "m.7z.003"])).toThrow(/分卷顺序不对/);
  });

  it("分卷清单里混进无编号项挡住", () => {
    expect(() => assertPartsInOrder(["m.7z", "m.7z.002"])).toThrow(/混有无编号项/);
  });

  it("空清单挡住", () => {
    expect(() => assertPartsInOrder([])).toThrow(/分卷清单为空/);
  });

  // 改了 routes/rag.js 的两份清单常量，这里必须一起改：它是 CI 唯一能看到清单顺序的地方
  it("当前真实清单的顺序合法（抄自 routes/rag.js 的 GITEE_WASM_PARTS / GITEE_MODEL_PARTS）", () => {
    assertPartsInOrder(["sherpa-onnx-wasm-simd-1.13.6-kokoro-slim.7z"]);
    assertPartsInOrder([
      "kokoro-multi-lang-v1_0.7z.001",
      "kokoro-multi-lang-v1_0.7z.002",
      "kokoro-multi-lang-v1_0.7z.003",
      "kokoro-multi-lang-v1_0.7z.004",
    ]);
  });
});
