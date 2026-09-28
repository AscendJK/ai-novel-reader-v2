#!/usr/bin/env node
/**
 * 生成后端包的锁：`package-server-lock.json`（进仓库，出包时作为 `package-lock.json` 复制进去）。
 *
 * 为什么单独来一份：后端包只有五只依赖，而仓库根那份 `package-lock.json` 钉的是**前端 + 开发工具**
 * 的整棵树，塞进后端包既装不出来也没意义。更要紧的是 `package-server.json` 写的是 `^` 浮动范围，
 * 而包内 start 脚本跑 `npm install`——用户装到的版本从来不受我们控制：
 * 开发机与 CI 走 `npm ci`（根锁：better-sqlite3 12.10.0），真后端台架按用户方式装出来的是 12.11.1。
 * 这一份锁把"用户装到哪一版"钉成"我们在台架上验过的那一版"。
 *
 * 用法：`npm run pack:lock`（改完 `package-server.json` 就要重跑一次；
 * 出包闸门会核它是否过期，见 pack-gate 的 `lockSyncProblems`）。
 * 需要联网：只解析元数据，不下载包、不跑 install 脚本。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT = "package-server-lock.json";
const main = JSON.parse(fs.readFileSync("package.json", "utf8"));
const server = JSON.parse(fs.readFileSync("package-server.json", "utf8"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anr-backend-lock-"));
try {
  // 版本号与包内那份 package.json 同源（pack-backend.ps1 也是这么覆盖的），
  // 免得 lock 里记录的 version 与包里声明的对不上，看起来像被改过
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ ...server, version: main.version }, null, 2) + "\n");
  // Windows 上 npm 是 npm.cmd，`shell: false` 直接 spawn 它会 EINVAL（退出码 null）
  const r = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
    cwd: tmp,
    stdio: "inherit",
    shell: true,
  });
  if (r.status !== 0) {
    console.error(`[gen-lock] npm 解析失败（退出码 ${r.status}），没有写出 ${OUT}`);
    process.exit(r.status ?? 1);
  }
  const lock = fs.readFileSync(path.join(tmp, "package-lock.json"), "utf8");
  fs.writeFileSync(OUT, lock);
  const parsed = JSON.parse(lock);
  const resolved = Object.entries(parsed.packages ?? {})
    .filter(([k]) => k.startsWith("node_modules/") && !k.slice("node_modules/".length).includes("/"))
    .map(([k, v]) => `${k.slice("node_modules/".length)}@${v.version}`);
  console.log(`[gen-lock] 写出 ${OUT}（lockfileVersion ${parsed.lockfileVersion}）`);
  console.log(`[gen-lock] 直接依赖钉在：${resolved.join("  ")}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
