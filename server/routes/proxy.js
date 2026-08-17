/**
 * 代理相关路由
 * 用于绕过浏览器 CORS 限制访问外部 API
 */

import { Router } from "express";
import { authNovel } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = Router();

// POST /api/proxy/chat — proxy LLM API requests
router.post("/chat", rateLimit(60), async (req, res) => {
  if (!authNovel(req, res)) return;
  try {
    const { url, headers, body } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });
    if (body && JSON.stringify(body).length > 1_000_000) {
      return res.status(413).json({ error: "请求体过大" });
    }

    // Only allow HTTP/HTTPS URLs
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      return res.status(400).json({ error: "only HTTP/HTTPS URLs allowed" });
    }

    const urlObj = new URL(url);
    // 去除 IPv6 方括号，统一处理
    let hostname = urlObj.hostname.replace(/^\[|\]$/g, "");
    // 将 IPv4-mapped IPv6（::ffff:x.x.x.x）还原为纯 IPv4，避免被宽泛的前缀匹配绕过
    const ipv4Mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (ipv4Mapped) hostname = ipv4Mapped[1];

    // 将点分 IPv4 转为 32 位整数；非法格式返回 null
    function ipv4ToInt(ip) {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
      const parts = ip.split(".").map(Number);
      if (parts.some((p) => p > 255)) return null;
      return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    }
    function isIPv4Private(ip) {
      const int = ipv4ToInt(ip);
      if (int === null) return false;
      // 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10 (CGNAT), 127.0.0.0/8,
      // 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16
      const ranges = [
        [0x00000000, 0x00ffffff], [0x0a000000, 0x0affffff],
        [0x64400000, 0x647fffff], [0x7f000000, 0x7fffffff],
        [0xa9fe0000, 0xa9feffff], [0xac100000, 0xac1fffff],
        [0xc0a80000, 0xc0a8ffff],
      ];
      return ranges.some(([lo, hi]) => int >= lo && int <= hi);
    }

    const isPrivateIP =
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "::" ||
      isIPv4Private(hostname) ||
      hostname.startsWith("fd") || // IPv6 ULA
      hostname.startsWith("fc") ||
      hostname.startsWith("fe80"); // IPv6 link-local

    // HTTP only allowed for LAN/private IPs; external must use HTTPS
    if (url.startsWith("http://") && !isPrivateIP) {
      return res.status(400).json({ error: "外部地址必须使用 HTTPS" });
    }

    // Only forward specific headers
    const safeHeaders = {};
    const allowedHeaders = ["authorization", "x-api-key", "anthropic-version", "content-type"];
    for (const key of allowedHeaders) {
      if (headers?.[key]) {
        safeHeaders[key] = headers[key];
      }
    }

    console.log(`[proxy] 请求: ${url}`);
    const startTime = Date.now();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...safeHeaders,
      },
      body: JSON.stringify(body),
      redirect: "error", // 禁止跟随重定向，防止 SSRF 绕过
      signal: AbortSignal.timeout(180000), // 3 分钟超时
    });

    const elapsed = Date.now() - startTime;
    console.log(`[proxy] 响应: ${response.status} (${elapsed}ms)`);

    // 检查响应是否成功
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[proxy] API 错误: ${response.status} ${response.statusText}`, errorText);
      return res.status(response.status).json({
        error: `API 返回错误: ${response.status} ${response.statusText}`,
        details: errorText
      });
    }

    const responseText = await response.text();
    console.log(`[proxy] 响应内容长度: ${responseText.length} 字符`);

    try {
      const data = JSON.parse(responseText);
      res.json(data);
    } catch (e) {
      console.error(`[proxy] JSON 解析失败:`, e);
      console.error(`[proxy] 原始响应:`, responseText.slice(0, 500));
      res.status(500).json({ error: "API 返回了无效的 JSON", raw: responseText.slice(0, 1000) });
    }
  } catch (e) {
    console.error("[proxy] error:", e);
    if (e.name === "TimeoutError") {
      res.status(504).json({ error: "代理请求超时（3分钟），API 服务器响应过慢" });
    } else if (e.message?.includes("redirect")) {
      res.status(400).json({ error: "目标 URL 尝试重定向，出于安全考虑已拒绝" });
    } else {
      res.status(500).json({ error: "代理请求失败" });
    }
  }
});

export default router;
