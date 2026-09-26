/**
 * TTS 资源的「拼卷 → 校验 → 解压 → 复制 → 校验 → 清理」流水（Gitee 的 7z 分卷、
 * GitHub 的 tar.bz2 两条路）。
 *
 * 为什么单独抽出来：这是 `/tts/prepare` 背后最容易错、又最难验的一段——分卷顺序写错、
 * 归档里多套一层目录导致模型加载找不到 `config.json`、解压失败后几百 MB 临时卷留在盘上，
 * 每一条都要真下 322MB 才看得见。抽成依赖注入的内核之后，生产路径和用例跑的是同一份代码，
 * 假 fs + 假下载器 + 假 7z 就能把每条分支走一遍。
 *
 * `download` 的调用形状与 `server/lib/tts-download.mjs` 一致：
 * `download(url, dest, chunkSize, onPercent, { signal })`。
 */
import nodePath from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * 等 write stream 落地。
 *
 * `'error'` 走 resolve 而不是 reject：拼卷那段是"pipe 可能先抛、而写盘的错之后才到"的
 * 形状，reject 出去没人接就是一次未处理拒绝（Node 默认会掀掉进程）。错误留在 `.error` 上，
 * 由调用方决定哪一条才是用户该看到的原因。
 */
function settleStream(ws) {
  const box = { error: null };
  const done = new Promise((resolve) => {
    ws.on("finish", resolve);
    ws.on("error", (e) => {
      box.error = e;
      resolve();
    });
  });
  return { done, box };
}

/** 清理永远在 finally 里做，且单项失败不许顶掉真正的错误——所以每个都各自吞。 */
function cleanup(fs, paths) {
  for (const p of paths) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* 残留的临时文件不该盖住用户的错误 */ }
  }
}

/**
 * Gitee：下分卷 → 按顺序拼成完整 7z → 验文件头 → 解压到独立子目录 →
 * 复制进缓存目录 → 校验齐套。
 *
 * 归档结构有两种（`kokoro-*.7z.00N` 里带一层同名目录，wasm 那种直接摊平），
 * 所以复制前先判断"只有一个个顶层目录"这件事——不判就会把 `archiveName/` 这层
 * 一起搬进 targetDir，症状是模型目录里多套一层、加载时找不到文件。
 */
export function createGiteeAssembler(deps) {
  const {
    fs,
    path = nodePath,
    tempDir,
    download,
    exec,
    assertPartsInOrder,
    readHead,
    isValidArchiveHead,
    validateExtracted,
  } = deps;

  return async function assembleFromGitee({
    baseUrl, partNames, archiveName, targetDir, requiredFiles, onProgress, signal,
  }) {
    // 先验顺序再花钱：拼接是按数组顺序流式写入的，顺序错要等几百 MB 下完、7z 解压时才炸
    assertPartsInOrder(partNames);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const partPaths = partNames.map((n) => path.join(tempDir, n));
    const archivePath = path.join(tempDir, `${archiveName}.7z`);
    // 下面这几个必须在 try 之外声明：finally 要清它们，而 try 块内的 const 在 finally
    // 作用域不可见——引用它会抛 ReferenceError 并顶掉 try 里真正的错误
    const extractRoot = path.join(tempDir, `${archiveName}-extract`);
    // 老版本留下的中间目录名，一并清掉（判据里有它：清不干净就是磁盘上只增不减）
    const legacyDir = path.join(tempDir, archiveName);

    try {
      for (let i = 0; i < partNames.length; i++) {
        if (signal?.aborted) throw new Error("下载已取消");
        onProgress?.(`下载分卷 ${i + 1}/${partNames.length}`, partNames[i]);
        await download(
          `${baseUrl}/${partNames[i]}`,
          partPaths[i],
          1024 * 1024,
          (pct) => onProgress?.(`下载分卷 ${i + 1}/${partNames.length} ${pct}%`, partNames[i]),
          { signal },
        );
      }

      onProgress?.("拼接分卷", "合并为完整压缩包");
      const ws = fs.createWriteStream(archivePath);
      const landed = settleStream(ws);
      let pipeErr = null;
      try {
        // 逐卷交给 stream 串起来：任意时刻内存里只有一卷的块，写满了由 pipeline 等 drain。
        // 原来那两行是 `ws.write(fs.readFileSync(p))`——一整卷 ~50MB 一次进内存、四卷 322MB
        // 逐卷累加，而且不看 write() 返回 false，等于把背压整格关掉。
        for (const p of partPaths) await pipeline(fs.createReadStream(p), ws, { end: false });
      } catch (e) {
        pipeErr = e;
      }
      ws.end();
      await landed.done;
      // 两条错可能同时到（pipe 抛了之后 ws 也会报错），以"为什么没拼上"那一条为准
      if (pipeErr) throw pipeErr;
      if (landed.box.error) throw landed.box.error;

      // 只读开头 6 字节：整包 readFileSync 会把 322MB 全塞进内存
      onProgress?.("校验压缩包", "检查文件格式");
      if (!isValidArchiveHead(readHead(archivePath, 6))) {
        throw new Error("拼接后的文件不是有效的 7z 格式（文件头校验失败）");
      }

      onProgress?.("解压中", "7z 解压...");
      try {
        fs.rmSync(extractRoot, { recursive: true });
      } catch { /* 还没解压过，目录本就不在 */ }
      fs.mkdirSync(extractRoot, { recursive: true });
      try {
        await exec("7z", ["x", archivePath, `-o${extractRoot}`, "-y"], { timeout: 120000 });
      } catch (e) {
        if (e.code === "ENOENT") {
          throw new Error("7z 未安装。请安装 7-Zip (Windows) 或 p7zip-full (Linux/macOS) 后重试。", { cause: e });
        }
        throw new Error(`7z 解压失败: ${e.message}`, { cause: e });
      }

      onProgress?.("复制文件", "写入缓存目录");
      let copySrc = extractRoot;
      const entries = fs.readdirSync(extractRoot);
      if (entries.length === 1) {
        const only = path.join(extractRoot, entries[0]);
        try {
          if (fs.statSync(only).isDirectory()) copySrc = only;
        } catch { /* 读不到就按"摊平"处理 */ }
      }
      fs.cpSync(copySrc, targetDir, { recursive: true });

      onProgress?.("校验文件", "检查完整性");
      validateExtracted(targetDir, requiredFiles);
      onProgress?.("清理", "删除临时文件");
    } finally {
      cleanup(fs, [...partPaths, archivePath, legacyDir, extractRoot]);
    }
  };
}

/**
 * GitHub：下 tar.bz2（官方直连 + 加速镜像依次试）→ 验文件头 → tar 解压 →
 * 复制到缓存目录 → 校验齐套。
 *
 * 镜像列表是"失败就换下一个"，不是并发：一个包几百 MB，同时下两份会当场把带宽占满。
 */
export function createGitHubTarExtractor(deps) {
  const {
    fs,
    path = nodePath,
    tempDir,
    download,
    exec,
    readHead,
    isValidArchiveHead,
    validateExtracted,
    log = () => {},
  } = deps;

  return async function extractFromGitHubTar({
    url, mirrors = [], archiveName, targetDir, requiredFiles, onProgress, signal,
  }) {
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const archivePath = path.join(tempDir, `${archiveName}.tar.bz2`);
    const extractedDir = path.join(tempDir, archiveName);

    try {
      onProgress?.("下载中 (GitHub)", "tar.bz2 格式");
      // 依次尝试官方直连 + 加速镜像（download 失败会自己删掉残缺文件，重试安全）
      let lastErr = null;
      for (const u of [url, ...mirrors.map((m) => m + url)]) {
        if (signal?.aborted) throw new Error("下载已取消");
        try {
          await download(u, archivePath, 1024 * 1024, (pct) => {
            onProgress?.(`下载中 ${pct}% (GitHub)`, "tar.bz2 格式");
          }, { signal });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          log(`GitHub 下载失败 (${u}): ${e.message}，尝试下一个源`);
        }
      }
      if (lastErr) throw lastErr;

      onProgress?.("校验压缩包", "检查文件格式");
      if (!isValidArchiveHead(readHead(archivePath, 4))) {
        throw new Error("下载的文件不是有效的 bzip2 格式（文件头校验失败）");
      }

      onProgress?.("解压中", "tar.bz2 解压...");
      try {
        await exec("tar", ["xjf", archivePath, "-C", tempDir], { timeout: 120000 });
      } catch (e) {
        if (e.code === "ENOENT") {
          throw new Error("tar 未安装。请安装 tar (Linux/macOS) 或 7-Zip (Windows) 后重试。", { cause: e });
        }
        throw new Error(`tar 解压失败: ${e.message}`, { cause: e });
      }

      onProgress?.("复制文件", "写入缓存目录");
      if (!fs.existsSync(extractedDir)) {
        throw new Error(`解压后找不到目录: ${archiveName}`);
      }
      fs.cpSync(extractedDir, targetDir, { recursive: true });

      onProgress?.("校验文件", "检查完整性");
      validateExtracted(targetDir, requiredFiles);
    } finally {
      cleanup(fs, [archivePath, extractedDir]);
    }
  };
}
