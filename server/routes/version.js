/**
 * GET /api/version — 返回后端版本号
 * 供前端登录时检测前后端版本是否一致
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let version = "0.0.0";
try {
  const pkg = JSON.parse(
    readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8")
  );
  version = pkg.version || "0.0.0";
} catch (e) {
  console.error("[version] Failed to read package.json:", e.message);
}

export default function versionRouter(app) {
  app.get("/api/version", (_req, res) => {
    res.json({ version });
  });
}