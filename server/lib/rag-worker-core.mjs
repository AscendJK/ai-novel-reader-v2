import fs from "node:fs";

const DEFAULT_MIRROR_HOST = "https://hf-mirror.com/";

/**
 * 模型下载源：配置文件 > 环境变量 > 默认镜像。
 * 配置坏了不能拖死整次索引，所以解析失败一律退回默认值。
 */
export function resolveMirrorHost({ configPath, envHost }) {
  let host = envHost || DEFAULT_MIRROR_HOST;
  try {
    if (configPath && fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.mirrorHost) host = config.mirrorHost;
    }
  } catch { /* 忽略：坏配置按无配置处理 */ }
  return host.endsWith("/") ? host : `${host}/`;
}

/**
 * 分批编码。embed(texts) 必须返回与 texts 一一对应的向量——第 i 章的向量只能来自
 * 第 i 章的文本，错位会造出一个"形状完全正确、检索结果全错"的索引，父进程那关
 * （数量/维度自校验）拦不住，界面上也看不出来。
 */
export async function runEmbeddingBatches({ chunks, batchSize, embed, onProgress }) {
  const totalBatches = Math.ceil(chunks.length / batchSize);
  const vectors = [];
  let dim = 0;

  for (let b = 0; b < totalBatches; b++) {
    const batch = chunks.slice(b * batchSize, Math.min((b + 1) * batchSize, chunks.length));
    // 提取 content 字段（chunks 可能是字符串或对象）
    const texts = batch.map((c) => (typeof c === "string" ? c : c.content));
    const rows = await embed(texts);
    for (const row of rows) vectors.push(row);
    dim = vectors[0]?.length || dim;
    onProgress?.({
      type: "progress",
      current: Math.min((b + 1) * batchSize, chunks.length),
      total: chunks.length,
    });
    await new Promise((resolve) => { setImmediate(resolve); });
  }

  return { vectors, dim };
}
