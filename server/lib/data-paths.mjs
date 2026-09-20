/**
 * 服务端落盘位置的唯一出口。
 *
 * 为什么必须有：`npm run verify` 每次都会起真 `server/index.js` 七次（七只探针各自 spawn），
 * 而原先只有 DB 能退到临时目录（`NOVEL_READER_DB_PATH`）。证书、`.admin_token`、
 * `models-cache` / `tts-temp` / `rag-config.json` 各自在三个文件里硬编码
 * `path.join(__dirname, "data", …)`，探针一点退路都没有——其中启动路径上的
 * `generateCert()` 执行的是 `mkcert -install`，一旦触发（当前 LAN IP 与证书 SAN 不吻合时），
 * 改动的不只是那两个文件，而是这台机器的系统信任根。
 *
 * 不设 env 时默认值与改动前逐字一致，所以生产启动行为不变；探针一律显式指向自己的工作目录。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** server/ 目录本身（本文件在 server/lib 下） */
export const SERVER_DIR = path.resolve(here, "..");
export const DEFAULT_DATA_DIR = path.join(SERVER_DIR, "data");

export function resolveDataDir(env = process.env) {
  const override = env.NOVEL_READER_DATA_DIR;
  if (typeof override !== "string") return DEFAULT_DATA_DIR;
  const trimmed = override.trim();
  // 空值按"没配"处理：配错一只环境变量就把证书写到 cwd 是更糟的结果
  if (!trimmed) return DEFAULT_DATA_DIR;
  return path.resolve(trimmed);
}

export function dataPath(...parts) {
  return path.join(resolveDataDir(), ...parts);
}
