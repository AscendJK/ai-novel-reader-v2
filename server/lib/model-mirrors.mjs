/**
 * 模型下载镜像的优先级判定（唯一来源）
 *
 * 顺序是用户能感知的行为：管理界面配的 mirrorHost 必须压过环境变量，环境变量压过默认
 * 镜像；配错一个字符的配置文件不该把整次建库拖死，所以解析失败一律按"没配"处理。
 * rag.js（回源下载列表）与 rag-worker-core.mjs（worker 里取第一个）共用这一份。
 */
import fs from "node:fs";

export const DEFAULT_MODEL_MIRRORS = ["https://hf-mirror.com/", "https://huggingface.co/"];

/**
 * @param {object} o
 * @param {string} [o.configPath] rag-config.json 的路径
 * @param {string} [o.envHost] 环境变量 HF_MIRROR 的值
 * @param {string[]} [o.defaults] 兜底镜像列表，测试可注入
 * @param {(p: string) => boolean} [o.exists]
 * @param {(p: string) => string} [o.read]
 * @returns {string[]} 去重、补过尾斜杠的镜像列表；配置文件坏的只丢掉了配置那一条
 */
export function resolveMirrorHosts({
  configPath,
  envHost,
  defaults = DEFAULT_MODEL_MIRRORS,
  exists = fs.existsSync,
  read = (p) => fs.readFileSync(p, "utf-8"),
} = {}) {
  const norm = (h) => (h.endsWith("/") ? h : `${h}/`);
  const hosts = [];
  try {
    if (configPath && exists(configPath)) {
      const config = JSON.parse(read(configPath));
      if (config.mirrorHost) hosts.push(norm(config.mirrorHost));
    }
  } catch { /* 忽略：坏配置按无配置处理 */ }
  if (envHost) hosts.push(norm(envHost));
  hosts.push(...defaults.map(norm));
  return [...new Set(hosts)];
}
