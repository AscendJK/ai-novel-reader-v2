/**
 * TTS 资源下载链路里"只做判断"的那几块（从 routes/rag.js 抽出）
 *
 * 搬模型（322MB 分 4 卷 + WASM）这条链要真跑就得真下几百 MB，CI 里做不起；
 * 但把它判定的部分抽出来就不需要下载：磁盘余量、压缩包文件头、只读文件头的
 * 字节数、解压后的齐套与最小尺寸、分卷的拼接顺序。这五块恰恰是"改坏了最贵"的：
 * 判据被改松 → 半个模型进缓存，症状推迟到用户点朗读才炸；顺序改错 → 拼出的包
 * 坏掉，而那时已经白下几百 MB。所以把它们做成注入 fs 的纯判定，用几 KB 的假样本锁住。
 */
import defaultFs from "node:fs";
import defaultPath from "node:path";

/** 校验 7z 文件头（37 7A BC AF 27 1C，只比对前 4 字节） */
export function isValid7z(buffer) {
  return buffer.length > 4 && buffer[0] === 0x37 && buffer[1] === 0x7A && buffer[2] === 0xBC && buffer[3] === 0xAF;
}

/** 校验 bzip2 文件头（BZ） */
export function isValidBz2(buffer) {
  return buffer.length > 2 && buffer[0] === 0x42 && buffer[1] === 0x5A;
}

/**
 * 只读文件开头若干字节。
 * 原先 7z 那条走的是 `fs.readFileSync(archivePath)`——为了比对 4 个字节把整包
 * 322MB 读进内存，在小内存的部署机上是一次实打实的尖峰（tar 那条早就只读 4 字节了）。
 */
export function readHeadSync(filePath, maxBytes, fsImpl = defaultFs) {
  const buf = Buffer.alloc(maxBytes);
  const fd = fsImpl.openSync(filePath, "r");
  try {
    return buf.subarray(0, fsImpl.readSync(fd, buf, 0, maxBytes, 0));
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * 解压后的齐套 + 最小尺寸判定。IO 留在调用方：`readSize(name)` 返回字节数，文件不存在返回 null。
 * 报错文案与抽出前保持一致（这些字符串会直接出现在设置页的失败提示里）。
 */
export function checkExtractedFiles(requiredFiles, readSize) {
  const missing = [];
  const tooSmall = [];

  for (const [filename, minSize] of Object.entries(requiredFiles)) {
    const size = readSize(filename);
    if (size === null || size === undefined) {
      missing.push(filename);
    } else if (size < minSize) {
      tooSmall.push(`${filename} (${(size / 1024).toFixed(0)}KB < ${(minSize / 1024).toFixed(0)}KB)`);
    }
  }

  if (missing.length > 0) {
    throw new Error(`解压后缺少文件: ${missing.join(", ")}`);
  }
  if (tooSmall.length > 0) {
    throw new Error(`解压后文件异常（可能损坏）: ${tooSmall.join(", ")}`);
  }
  return { missing, tooSmall };
}

/**
 * 下载前的磁盘余量守卫。
 * fs.statfsSync 返回的是 bsize/bavail/blocks——没有 available 与 size 字段，
 * 拿它们相乘得到 NaN，`NaN < 阈值` 恒为 false，等于这道守卫从未生效过。
 * 读数拿不到/异常时跳过检查（宁可少挡一次，也不要因为平台差异挡死所有人下载）。
 * 返回可用字节数，跳过时返回 null。
 */
export function checkDiskSpace({ dir, minBytes, fsImpl = defaultFs, pathImpl = defaultPath }) {
  // 目标目录可能还不存在，statfsSync 要求已存在的路径：逐级上溯到存在的祖先
  let probeDir = dir;
  for (let i = 0; i < 6 && !fsImpl.existsSync(probeDir); i++) probeDir = pathImpl.dirname(probeDir);
  let freeBytes;
  try {
    const s = fsImpl.statfsSync(probeDir);
    freeBytes = Number(s.bsize) * Number(s.bavail);
  } catch (e) {
    console.warn(`[tts-proxy] 无法检查磁盘余量（${e.message}），跳过检查`);
    return null;
  }
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) {
    console.warn(`[tts-proxy] 磁盘余量读数异常（${freeBytes}），跳过检查`);
    return null;
  }
  if (freeBytes < minBytes) {
    throw new Error(
      `磁盘空间不足：需要至少 ${Math.round(minBytes / 1024 / 1024)}MB，` +
      `${probeDir} 当前可用 ${Math.round(freeBytes / 1024 / 1024)}MB`
    );
  }
  return freeBytes;
}

/**
 * 分卷顺序守卫：拼接是按数组顺序流式写入的，顺序错了拼出的包就是坏的，
 * 而那要等几百 MB 下完、7z 解压时才暴露。命名约定是 `xxx.7z.001..00N`，
 * 单卷（无数字后缀）只允许一条。
 */
export function assertPartsInOrder(partNames) {
  if (!Array.isArray(partNames) || partNames.length === 0) {
    throw new Error("分卷清单为空，无法下载");
  }
  const suffixOf = (name) => {
    const m = /\.(\d{3})$/.exec(name);
    return m ? Number(m[1]) : null;
  };
  if (partNames.length === 1) {
    if (suffixOf(partNames[0]) !== null) throw new Error(`单卷分卷号异常: ${partNames[0]}`);
    return partNames;
  }
  const nums = partNames.map(suffixOf);
  if (nums.some((n) => n === null)) {
    throw new Error(`分卷清单混有无编号项: ${partNames.join(", ")}`);
  }
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) {
      throw new Error(`分卷顺序不对（第 ${i + 1} 项应为 .${String(i + 1).padStart(3, "0")}，实际 ${partNames[i]}）`);
    }
  }
  return partNames;
}
