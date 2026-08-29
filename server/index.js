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
import { ensureTTSResources } from "./routes/rag.js";

import { mountAdminRoutes } from "./admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isFullMode = process.argv.includes("--full");
const app = express();

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
mountAdminRoutes(app);

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

// ── Note: 前后端分离模式下，前端由 GitHub Pages 托管 ───────
// 后端只提供 API 服务，不再需要静态文件服务

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
    const { execSync } = await import("node:child_process");
    // Use openssl to check certificate expiry
    const result = execSync(`openssl x509 -enddate -noout -in "${certFile}"`, { encoding: "utf-8" });
    // Output format: "notAfter=Jun 14 12:00:00 2026 GMT"
    const match = result.match(/notAfter=(.+)/);
    if (!match) return false;
    return new Date(match[1]) > new Date();
  } catch {
    return false;
  }
}

async function generateCert() {
  const { execSync } = await import("node:child_process");
  const os = await import("node:os");

  // Get local IP addresses
  const interfaces = os.networkInterfaces();
  const ips = ["localhost"];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }

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

// Start servers
async function startServers() {
  // Check if certificate exists and is valid
  let hasSSL = fs.existsSync(certPath) && fs.existsSync(keyPath);
  if (hasSSL && !(await isCertValid(certPath))) {
    console.log("[ssl] Certificate expired, regenerating...");
    hasSSL = await generateCert();
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
    });
    httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
      console.log(`[sync] https://0.0.0.0:${HTTPS_PORT} (${isFullMode ? "full" : "api-only"})`);
    });
    // Also start HTTP server for backward compatibility
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[sync] http://0.0.0.0:${PORT} (${isFullMode ? "full" : "api-only"})`);
    });
  } else {
    // Start HTTP server only
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[sync] http://0.0.0.0:${PORT} (${isFullMode ? "full" : "api-only"})`);
    });
  }
}

startServers();

// ── TTS 资源预加载 ───────────────────────────────────────────
// 启动后延迟 5 秒（避开启动高峰：备份/证书/WAL），后台自动检查并下载
// Kokoro 所需资源（WASM + 模型，约 190MB）。
// 失败不阻塞启动、不崩溃：日志记录后，由 /api/rag/tts/prepare 触发重试
//（ensure* 内部有 30 秒失败冷却，可安全重复调用）。
setTimeout(() => {
  // 进度回调节流：只打印阶段变化和整 10% 进度，避免 400MB 下载刷屏日志。
  // 兼容两种回调形态：
  //   1. (step, detail) 双参：step 含百分比（如 "下载分卷 1/3 45%"），detail 为文件名
  //   2. 单数字参（downloadFile 直接透传）：step 为纯数字（如 45），detail 为 undefined
  let lastPct = -1;
  const progressLogger = (step, detail) => {
    // 纯数字进度先转成 "45%"，与字符串形态统一处理
    const stepStr = typeof step === "number" ? `${step}%` : String(step);
    // 从 step + detail 拼接串中提取百分比（两种形态都能覆盖）
    const pctMatch = /(\d+)%/.exec(`${stepStr} ${detail || ""}`);
    if (pctMatch) {
      const pct = parseInt(pctMatch[1], 10);
      if (pct === lastPct || (pct % 10 !== 0 && pct !== 100)) return;
      lastPct = pct;
    }
    // 纯数字进度（如 45）格式化为 "下载中 45%"，避免打印 "45: undefined"
    if (typeof step === "number" && !detail) {
      console.log(`[tts-preload] 下载中 ${step}%`);
      return;
    }
    console.log(`[tts-preload] ${step}${detail ? `: ${detail}` : ""}`);
  };
  ensureTTSResources(progressLogger).then(() => {
    console.log("[tts-preload] Kokoro 资源就绪（WASM + 模型）");
  }).catch((e) => {
    console.warn(`[tts-preload] Kokoro 资源预加载失败（可稍后通过 /tts/prepare 重试）: ${e.message}`);
  });
}, 5000);

// ── Maintenance tasks ───────────────────────────────────────

// 启动时立即执行一次备份
try { createBackup(); } catch { /* ignore */ }

// WAL checkpoint every 30 minutes
setInterval(() => {
  try { checkpointWAL(); } catch { /* ignore */ }
}, 30 * 60 * 1000);

// Backup at configured interval
function scheduleBackup() {
  const config = getBackupConfig();
  const intervalMs = config.intervalHours * 60 * 60 * 1000;
  setInterval(() => {
    try { createBackup(); } catch { /* ignore */ }
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
