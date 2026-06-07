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

    // Only allow HTTP/HTTPS URLs
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      return res.status(400).json({ error: "only HTTP/HTTPS URLs allowed" });
    }

    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const isPrivateIP =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("169.254.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^100\.(6[4-9]|[7-9]\d|1[0-2][0-7])\./.test(hostname) || // CGNAT
      hostname.startsWith("fd") || // IPv6 ULA
      hostname.startsWith("fc");

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
