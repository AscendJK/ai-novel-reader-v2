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
import { checkpointWAL, createBackup, cleanupDeletedRecords } from "./database.js";
import { novelsRouter, ragRouter, syncRouter, proxyRouter } from "./routes/index.js";

import { mountAdminRoutes } from "./admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ── CORS: restrict to localhost origins ──
const ALLOWED_ORIGINS = [
  "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:3001", "http://127.0.0.1:3001",
  "http://localhost:4173", "http://127.0.0.1:4173",
  "https://localhost", "https://127.0.0.1",
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin (same-origin, curl, mobile apps) and localhost
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // Allow any LAN/private IP (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?/.test(origin)) return cb(null, true);
    cb(new Error("CORS not allowed"));
  },
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "anthropic-version"],
  exposedHeaders: ["Content-Type"],
  credentials: true,
  maxAge: 86400,
}));
app.use(express.json({ limit: "50mb" }));

// ── Mount Admin Routes ──────────────────────────────────────
mountAdminRoutes(app);

// ── Mount API Routes ────────────────────────────────────────
app.use("/api/novels", novelsRouter);
app.use("/api/rag", ragRouter);
app.use("/api/sync", syncRouter);
app.use("/api/proxy", proxyRouter);

// ── Admin page ──────────────────────────────────────────────

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// ── Production static serving ───────────────────────────────

const isFullMode = process.argv.includes("--full");
if (isFullMode) {
  const distPath = path.join(__dirname, "..", "dist");
  app.use(express.static(distPath));
  // SPA fallback: serve index.html for any non-API, non-admin route
  // Note: Express 5 requires named parameters, so we use a middleware instead of "*"
  app.use((req, res, next) => {
    // Skip API and admin routes
    if (req.path.startsWith("/api/") || req.path.startsWith("/admin")) {
      return next();
    }
    // Skip non-GET requests
    if (req.method !== "GET") {
      return next();
    }
    res.sendFile(path.join(distPath, "index.html"));
  });
}

// ── Global error handler ────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "服务器内部错误" });
});

// ── Start server ────────────────────────────────────────────

const PORT = process.env.PORT || (isFullMode ? 5173 : 3001);
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
const dataDir = path.join(__dirname, "data");

// Check for SSL certificate
const certPath = path.join(dataDir, "cert.pem");
const keyPath = path.join(dataDir, "key.pem");

function isCertValid(certFile) {
  try {
    const cert = fs.readFileSync(certFile, "utf-8");
    // Extract expiry date from PEM certificate
    const match = cert.match(/Not After\s*:\s*(.+)/);
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
  if (hasSSL && !isCertValid(certPath)) {
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

// ── Maintenance tasks ───────────────────────────────────────

// 启动时立即执行一次备份
try { createBackup(); } catch { /* ignore */ }

// WAL checkpoint every 30 minutes
setInterval(() => {
  try { checkpointWAL(); } catch { /* ignore */ }
}, 30 * 60 * 1000);

// Backup every 24 hours
setInterval(() => {
  try { createBackup(); } catch { /* ignore */ }
}, 24 * 60 * 60 * 1000);

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
