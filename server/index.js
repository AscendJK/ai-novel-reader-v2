/**
 * AI Novel Reader - Server Entry Point
 *
 * This file is the main entry point for the Express server.
 * Routes are organized in separate modules under server/routes/
 */

import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { checkpointWAL, createBackup, cleanupDeletedRecords, getBackupConfig, isRestoringBackup } from "./database.js";
import { novelsRouter, ragRouter, syncRouter, proxyRouter, versionRouter } from "./routes/index.js";

import { mountAdminRoutes } from "./admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isFullMode = process.argv.includes("--full");
const app = express();

// 兜底日志：未捕获的 promise 拒绝只记录不退出（Node ≥15 默认会 crash 整个进程，
// 对长驻的家庭服务器来说，带病坚持 + 留下日志好过无声消失）
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason);
});

// ── CORS: restrict to specific origins ──
const ALLOWED_ORIGINS = [
  // 开发环境
  "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:4173", "http://127.0.0.1:4173",
  "https://localhost", "https://127.0.0.1",
  // GitHub Pages
  "https://ascendjk.github.io",
  // 用户自定义前端域名（可通过环境变量配置）
  ...(process.env.CORS_ORIGINS || "").split(",").filter(Boolean),
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin (same-origin, curl, mobile apps) and localhost
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // Allow any LAN/private IP (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin)) return cb(null, true);
    cb(null, false);
  },
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "anthropic-version"],
  exposedHeaders: ["Content-Type"],
  credentials: true,
  maxAge: 86400,
}));
app.use(express.json({ limit: "50mb" }));

// ── Security headers ──────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// ── Reject requests during backup restore ───────────────────
app.use((req, res, next) => {
  if (isRestoringBackup()) {
    return res.status(503).json({ error: "服务器正在恢复备份，请稍后重试" });
  }
  next();
});

// ── Mount Admin Routes ──────────────────────────────────────
mountAdminRoutes(app, { onBackupConfigChanged: scheduleBackup });

// ── Mount API Routes ────────────────────────────────────────
versionRouter(app);
app.use("/api/novels", novelsRouter);
app.use("/api/rag", ragRouter);
app.use("/api/sync", syncRouter);
app.use("/api/proxy", proxyRouter);

// ── Admin page ──────────────────────────────────────────────

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// ── Static serving (full mode only) ────────────────────────
// --full 且 dist 存在时伺服前端构建产物。根路径 302 到 base 子路径，
// 保持与 GitHub Pages 相同的子路径结构（SW 作用域 / COI / manifest 依赖它）。
// dist 缺失（如后端精简包）时跳过，仅 API 模式运行。
if (isFullMode) {
  const distPath = path.join(__dirname, "..", "dist");
  if (fs.existsSync(distPath)) {
    const BASE = "/ai-novel-reader-v2";
    const baseRe = new RegExp("^" + BASE + "/.*$");
    app.get("/", (_req, res) => res.redirect(BASE + "/"));
    app.use(BASE, express.static(distPath));
    // base 路径下非静态文件的 GET 导航回退到 index.html（Express 5：用 RegExp 通配）
    app.get(baseRe, (req, res, next) => {
      if (req.method !== "GET" || path.extname(req.path)) return next();
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log("[static] serving " + distPath + " at " + BASE + "/ (full mode)");
  } else {
    console.warn("[static] --full 模式未找到 dist/，跳过前端伺服（仅 API 模式）");
  }
}

// ── Note: 前后端分离模式下，前端由 GitHub Pages 托管 ───────
// 后端只提供 API 服务；--full 且存在 dist 时上方静态块生效

// ── Global error handler ────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "服务器内部错误" });
});

// ── Start server ────────────────────────────────────────────

const PORT = process.env.PORT || 5173;
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
const dataDir = path.join(__dirname, "data");

// Check for SSL certificate
const certPath = path.join(dataDir, "cert.pem");
const keyPath = path.join(dataDir, "key.pem");

async function isCertValid(certFile) {
  try {
    // 用 Node 内置 X509 而不是 PATH 里的 openssl：Windows 上通常没有 openssl，
    // execSync 抛错会被判为"证书过期"，于是每次启动都白重签一遍
    const { X509Certificate } = await import("node:crypto");
    const cert = new X509Certificate(fs.readFileSync(certFile));
    return new Date(cert.validTo) > new Date();
  } catch {
    return false;
  }
}

// Collect all non-internal IPv4 addresses of this machine
async function getLanIPv4s() {
  const os = await import("node:os");
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

async function generateCert() {
  const { execSync } = await import("node:child_process");

  // Certificate covers localhost + all current LAN IPv4 addresses;
  // if these change later (Wi-Fi/router/DHCP), the startup IP-coverage check re-issues
  const ips = ["localhost", ...(await getLanIPv4s())];

  // Use mkcert to generate trusted certificate
  try {
    execSync("mkcert --version", { stdio: "pipe" });
    console.log("[ssl] Using mkcert to generate trusted certificate...");
    execSync(`mkcert -install -cert-file "${certPath}" -key-file "${keyPath}" ${ips.join(" ")}`, {
      cwd: dataDir,
      stdio: "pipe",
    });
    console.log(`[ssl] Trusted certificate generated for: ${ips.join(", ")}`);
    return true;
  } catch (e) {
    console.error("[ssl] mkcert not found. Please install mkcert:");
    console.error("[ssl]   Windows: winget install mkcert");
    console.error("[ssl]   macOS:   brew install mkcert");
    console.error("[ssl]   Linux:   sudo apt install mkcert");
    console.error("[ssl] After installing, run: mkcert -install");
    return false;
  }
}

// Compare the certificate's SANs against the current LAN IPv4 addresses,
// returning the IPs the certificate does NOT cover.
// On any parse failure returns [] so the existing certificate keeps being used.
async function getIpsMissingFromCert(certFile) {
  try {
    const { X509Certificate } = await import("node:crypto");
    const cert = new X509Certificate(fs.readFileSync(certFile));
    const covered = new Set(
      [...(cert.subjectAltName ?? "").matchAll(/IP Address:([^,\s]+)/g)].map((m) => m[1])
    );
    const current = await getLanIPv4s();
    return current.filter((ip) => !covered.has(ip));
  } catch {
    return [];
  }
}

// Start servers
async function startServers() {
  // Check if certificate exists and is valid
  let hasSSL = fs.existsSync(certPath) && fs.existsSync(keyPath);
  if (hasSSL && !(await isCertValid(certPath))) {
    console.log("[ssl] Certificate expired, regenerating...");
    hasSSL = await generateCert();
  }
  // IP 变化自动重签：换了 Wi-Fi / 路由器重启后当前 IP 不在旧证书覆盖范围内时直接重签，
  // 免去手动删证书（rootCA 与手机端已装信任不受重签影响）
  if (hasSSL) {
    const missingIps = await getIpsMissingFromCert(certPath);
    if (missingIps.length > 0) {
      console.log(`[ssl] 检测到 IP 变化：${missingIps.join(", ")} 不在证书覆盖范围内，自动重新签发...`);
      if (!(await generateCert())) {
        console.warn("[ssl] 自动重签失败（mkcert 不可用？），沿用现有证书继续运行");
      }
    }
  }
  if (!hasSSL) {
    console.log("[ssl] No certificate found, generating...");
    hasSSL = await generateCert();
  }

  if (hasSSL) {
    // Start HTTPS server
    const httpsServer = https.createServer({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    }, app);
    httpsServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[ssl] HTTPS port ${HTTPS_PORT} is already in use. Another instance may be running.`);
        console.error(`[ssl] Stop the other instance first, or set HTTPS_PORT env to use a different port.`);
      } else {
        console.error("[ssl] HTTPS server error:", err.message);
      }
      process.exit(1); // 端口冲突/监听失败必须退出，避免半启动状态让客户端连上旧实例
    });
    httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
      console.log(`[sync] https://0.0.0.0:${HTTPS_PORT} (${isFullMode ? "full" : "api-only"})`);
    });
    // Also start HTTP server for backward compatibility
    const httpServer = app.listen(PORT, "0.0.0.0", () => {
      console.log(`[sync] http://0.0.0.0:${PORT} (${isFullMode ? "full" : "api-only"})`);
    });
    httpServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[server] ⚠️ 端口 ${PORT} 已被占用：可能有旧的服务端进程仍在运行（node.exe / python.exe）。`);
        console.error(`[server] 请先彻底关闭旧进程再启动本服务：`);
        console.error(`[server]   任务管理器结束 node.exe 和 python.exe，或执行:`);
        console.error(`[server]     taskkill /F /IM node.exe /T`);
        console.error(`[server]     taskkill /F /IM python.exe`);
        console.error(`[server]   或改用其他端口: set PORT=5175 && npm run server`);
      } else {
        console.error("[server] HTTP server error:", err.message);
      }
      process.exit(1);
    });
  } else {
    // Start HTTP server only
    const httpServer = app.listen(PORT, "0.0.0.0", () => {
      console.log(`[sync] http://0.0.0.0:${PORT} (${isFullMode ? "full" : "api-only"})`);
    });
    httpServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[server] ⚠️ 端口 ${PORT} 已被占用：可能有旧的服务端进程仍在运行（node.exe / python.exe）。`);
        console.error(`[server] 请先彻底关闭旧进程再启动本服务：`);
        console.error(`[server]   任务管理器结束 node.exe 和 python.exe，或执行:`);
        console.error(`[server]     taskkill /F /IM node.exe /T`);
        console.error(`[server]     taskkill /F /IM python.exe`);
        console.error(`[server]   或改用其他端口: set PORT=5175 && npm run server`);
      } else {
        console.error("[server] HTTP server error:", err.message);
      }
      process.exit(1);
    });
  }
}

startServers();

// ── TTS 资源：按需下载（不再启动时自动下载）──────────────────
// 模型（约 350MB）只在用户于设置页启用「服务端推理」或「浏览器推理」时
// 才触发下载（/api/rag/tts/prepare 或首次 synthesize），避免一打开后端
// 就占用带宽/磁盘。启动时仅记录一个状态提示，失败不阻塞启动。
// 由设置页的「启用」按钮调用 ensureTTSResources（经 /tts/prepare SSE 端点）。

// ── Maintenance tasks ───────────────────────────────────────

// 启动时立即执行一次备份
createBackup().catch((e) => console.error("[backup] 启动备份失败:", e?.message ?? e));

// WAL checkpoint every 30 minutes
setInterval(() => {
  try { checkpointWAL(); } catch { /* ignore */ }
}, 30 * 60 * 1000);

// Backup at configured interval（管理后台修改配置时经 onBackupConfigChanged 触发重建定时器，立即生效）
let backupTimer = null;
function scheduleBackup() {
  if (backupTimer) clearInterval(backupTimer);
  const config = getBackupConfig();
  const intervalMs = config.intervalHours * 60 * 60 * 1000;
  backupTimer = setInterval(() => {
    createBackup().catch((e) => console.error("[backup] 定时备份失败:", e?.message ?? e));
  }, intervalMs);
  console.log(`[backup] interval: ${config.intervalHours}h, max: ${config.maxCount} files, retain: ${config.retainDays} days`);
}
scheduleBackup();

// Cleanup deleted records every 24 hours
setInterval(() => {
  try { cleanupDeletedRecords(); } catch { /* ignore */ }
}, 24 * 60 * 60 * 1000);

// Graceful shutdown
process.on("SIGINT", () => {
  try { checkpointWAL(); } catch { /* ignore */ }
  process.exit(0);
});

process.on("SIGTERM", () => {
  try { checkpointWAL(); } catch { /* ignore */ }
  process.exit(0);
});

// Windows 终端 Ctrl+Break / 终端窗口关闭时也走优雅退出，
// 确保 rag.js 的 process.on("exit") 能同步杀掉 Python TTS 推理进程（tts-worker.py），
// 避免关闭后端后残留 python 进程占用内存/锁模型文件。
process.on("SIGBREAK", () => {
  try { checkpointWAL(); } catch { /* ignore */ }
  process.exit(0);
});

process.on("SIGHUP", () => {
  try { checkpointWAL(); } catch { /* ignore */ }
  process.exit(0);
});
