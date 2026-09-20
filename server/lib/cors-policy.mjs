/**
 * CORS 源判定（从 server/index.js 抽出）
 *
 * 这个判定错一次的代价是"前端在某个访问方式下突然全线失败"：GitHub Pages 前端 +
 * 局域网后端本来就是跨源的，判定放不过就没有 AI、没有同步、没有朗读，而浏览器给出的
 * 报错永远只在客户端。项目既定的访问模型是"局域网内无密码"，所以局域网地址必须放过；
 * 反过来，公网来源不能放过——后端会替前端去访问用户配置的厂商地址。
 */

// 固定放行的来源：开发端口、本机、GitHub Pages 托管地址
export const STATIC_ALLOWED_ORIGINS = [
  "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:4173", "http://127.0.0.1:4173",
  "https://localhost", "https://127.0.0.1",
  "https://ascendjk.github.io",
];

// 局域网/私有网段：192.168.x.x、10.x.x.x、172.16-31.x.x，可带任意端口
const LAN_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

/**
 * 把 CORS_ORIGINS 环境变量（逗号分隔）解析成来源列表。
 * 少一条用户自己配的域名，就会变成"他在设置页里配好了前端地址，后端却不认"。
 */
export function extraAllowedOrigins(envValue) {
  return String(envValue || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * @param {string|undefined} origin 请求头里的 Origin；无 Origin（同源、curl、原生 App）一律放过
 * @param {string[]} envOrigins CORS_ORIGINS 解析结果
 */
export function isOriginAllowed(origin, envOrigins = []) {
  if (!origin) return true;
  if (STATIC_ALLOWED_ORIGINS.includes(origin)) return true;
  if (envOrigins.includes(origin)) return true;
  return LAN_ORIGIN.test(origin);
}
