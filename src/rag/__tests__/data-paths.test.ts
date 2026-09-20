/**
 * 服务端数据目录的唯一解析口：`NOVEL_READER_DATA_DIR`。
 *
 * 为什么要有这只 env：`npm run verify` 每次都起真 `server/index.js` 七次，而原先只有
 * DB 能退（`NOVEL_READER_DB_PATH`）。证书（`index.js`）、`.admin_token`（`admin.js`）、
 * `models-cache` / `tts-temp` / `rag-config.json`（`routes/rag.js`）全是
 * `path.join(__dirname, "data", …)`，探针一点退路都没有——其中 `generateCert()` 执行的
 * 还是 `mkcert -install`，触发时动的不只是那两个文件，是整台机器的系统信任根。
 */
import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";

// @ts-expect-error - 后端 JS 模块无类型声明
const mod = await import("../../../server/lib/data-paths.mjs");
const { resolveDataDir, dataPath, DEFAULT_DATA_DIR, SERVER_DIR } = mod as {
  resolveDataDir: (env?: NodeJS.ProcessEnv) => string;
  dataPath: (...parts: string[]) => string;
  DEFAULT_DATA_DIR: string;
  SERVER_DIR: string;
};

const ORIGINAL = process.env.NOVEL_READER_DATA_DIR;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NOVEL_READER_DATA_DIR;
  else process.env.NOVEL_READER_DATA_DIR = ORIGINAL;
});

describe("resolveDataDir：一只 env 管住服务端全部落盘位置", () => {
  it("默认落在 server/data（不设 env 时行为与改动前逐字一致）", () => {
    delete process.env.NOVEL_READER_DATA_DIR;
    expect(resolveDataDir()).toBe(path.join(SERVER_DIR, "data"));
    expect(DEFAULT_DATA_DIR).toBe(resolveDataDir());
  });

  it("设了 env 就用它，并且一律给绝对路径", () => {
    process.env.NOVEL_READER_DATA_DIR = path.resolve("tmp-anr-data");
    expect(resolveDataDir()).toBe(path.resolve("tmp-anr-data"));
    expect(path.isAbsolute(resolveDataDir())).toBe(true);
  });

  it("相对路径按 cwd 展开，不留下一个\"看起来能用\"的相对目录", () => {
    process.env.NOVEL_READER_DATA_DIR = "relative/anr";
    expect(path.isAbsolute(resolveDataDir())).toBe(true);
    expect(resolveDataDir()).toBe(path.join(process.cwd(), "relative/anr"));
  });

  it("空串与纯空格按\"没配\"处理（配错方向不能把证书写到 cwd）", () => {
    for (const value of ["", "   ", "\t"]) {
      process.env.NOVEL_READER_DATA_DIR = value;
      expect(resolveDataDir()).toBe(DEFAULT_DATA_DIR);
    }
  });

  it("dataPath 拼出的每一条路径都落在同一个目录下", () => {
    const dir = path.resolve("tmp-anr-data-2");
    process.env.NOVEL_READER_DATA_DIR = dir;
    // 这几只键名是刻意挑的：它们原先分散在三只文件里各自硬编码
    for (const rel of [["cert.pem"], ["key.pem"], [".admin_token"], ["novels.db"], ["tts-temp"], ["models-cache"], ["rag-config.json"], ["backups"]]) {
      expect(dataPath(...rel)).toBe(path.join(dir, ...rel));
    }
  });
});
