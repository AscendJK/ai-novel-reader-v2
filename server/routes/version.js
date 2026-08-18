/**
 * GET /api/version — 返回后端版本号
 * 供前端登录时检测前后端版本是否一致
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 尝试多个路径查找 package.json，兼容开发模式和打包后结构
const possiblePaths = [
  path.join(__dirname, "..", "..", "package.json"), // 开发模式: server/routes/ → ../../
  path.join(__dirname, "..", "package.json"),        // 打包后可能的结构
  path.join(process.cwd(), "package.json"),           // 以工作目录为基准
];

let version = "0.0.0";
for (const p of possiblePaths) {
  try {
    const pkg = JSON.parse(readFileSync(p, "utf-8"));
    if (pkg.version) {
      version = pkg.version;
      break;
    }
  } catch {
    // 继续尝试下一个路径
  }
}

export default function versionRouter(app) {
  app.get("/api/version", (_req, res) => {
    res.json({ version });
  });
}