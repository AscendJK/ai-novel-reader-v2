/**
 * 服务端推理的 Python 子进程队列（从 routes/rag.js 抽出，逻辑保持等价）
 *
 * 这一段管的是"起一个约 925MB 的常驻进程"的全部失败模式：并发重复 spawn、
 * 启动超时后不杀进程、客户端断开后队列不清空导致进程无限常驻、旧进程退出时
 * 把新进程的引用抹掉。这些只能在观察到子进程行为的层面上被锁住，所以
 * spawn / execFile / 模型下载 / 时间全部注入——测试用假 worker 驱动，
 * 既不需要真 Python，也不碰 350MB 模型。
 */
import { spawn as nodeSpawn, execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const defaultExecFileAsync = promisify(nodeExecFile);

/** 空闲关闭时长：默认 10 分钟，可用 TTS_PY_IDLE_SECONDS 覆盖（测试/部署调优用） */
export function idleTimeoutMsFromEnv(env = process.env) {
  return (Number(env.TTS_PY_IDLE_SECONDS) || 600) * 1000;
}

export function createTtsPyWorker(options = {}) {
  const {
    spawn = nodeSpawn,
    execFileAsync = defaultExecFileAsync,
    ensureModelReady = async () => {},
    workerPy,
    modelCache,
    env = process.env,
    pythonCandidates = ["python", "python3", "py"],
    threads = 8,
    detectTimeoutMs = 15000,
    detectCacheMs = 60000,
    startTimeoutMs = 30000,
    genTimeoutMs = 180000,
    queueLimit = 30,
    startCooldownMs = 30000,
    pollMs = 200,
    idleTimeoutMs = idleTimeoutMsFromEnv(env),
    now = () => Date.now(),
    logger = console,
  } = options;

  let pyProc = null;            // Python 子进程
  let pyReady = false;          // 是否收到 ready 消息
  let pyStartPromise = null;    // 启动去重
  let pyBuffer = "";            // stdout 行缓冲
  const pyQueue = new Map();    // id → { resolve, reject, timer, username, started }
  let pyNextId = 1;
  let pyLastError = "";         // 上次失败原因（status 接口展示）
  let pyStartFailedAt = 0;      // 上次启动失败时刻：冷却期内不再反复 spawn
  let pyIdleTimer = null;

  // ── python 命令探测 ────────────────────────────────

  /** 探测可用的 python 命令（缓存 60s：部署后装好 Python 无需重启即可生效） */
  let _pyCmdCache = null;
  let _pyCmdCacheAt = 0;
  async function detectPythonCommand() {
    if (_pyCmdCache !== null && now() - _pyCmdCacheAt < detectCacheMs) return _pyCmdCache;
    for (const cmd of pythonCandidates) {
      try {
        const { stdout } = await execFileAsync(cmd, ["-c", "import sherpa_onnx; print('ok')"], {
          timeout: detectTimeoutMs, windowsHide: true,
        });
        if (String(stdout).trim() === "ok") {
          _pyCmdCache = cmd;
          _pyCmdCacheAt = now();
          return cmd;
        }
      } catch { /* 尝试下一个 */ }
    }
    _pyCmdCache = "";
    _pyCmdCacheAt = now();
    return _pyCmdCache;
  }

  // ── 队列与空闲关闭 ────────────────────────────────

  /** 计划空闲关闭（仅当队列为空时调用） */
  function schedulePyIdleShutdown() {
    clearTimeout(pyIdleTimer);
    pyIdleTimer = setTimeout(() => {
      logger.log(`[tts-py] 空闲 ${idleTimeoutMs / 1000}s 无请求，关闭推理进程（释放内存）`);
      shutdownPyProcess("idle");
    }, idleTimeoutMs);
  }

  /** 取消空闲关闭计划（新请求到来时调用） */
  function cancelPyIdleShutdown() {
    if (pyIdleTimer) {
      clearTimeout(pyIdleTimer);
      pyIdleTimer = null;
    }
  }

  /**
   * 从队列移除一条请求。超时/cancel/启动失败/客户端断开都必须走这里——空闲关闭
   * 计划原先只挂在 stdout 的 result/error 分支上，客户端停止朗读后队列被清空却
   * 排不上关闭计划，~925MB 的进程就无限常驻了。
   */
  function dropPyRequest(id) {
    const p = pyQueue.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    pyQueue.delete(id);
    if (pyQueue.size === 0) schedulePyIdleShutdown();
    return true;
  }

  /** 关闭 Python 推理进程（空闲超时 / 后端退出时调用） */
  function shutdownPyProcess(reason = "shutdown") {
    cancelPyIdleShutdown();
    if (!pyProc) return;
    logger.log(`[tts-py] 关闭推理进程 (${reason})`);
    try { pyProc.kill(); } catch { /* 已退出 */ }
    // pyProc.on("exit") 会重置 pyProc/pyReady/pyStartPromise；队列为空时无 pending 可 reject
  }

  // ── 进程启停 ──────────────────────────────────────

  /** 确保 Python 推理进程已启动（模型就绪 + 进程 ready） */
  async function ensurePyProcess() {
    const pyCmd = await detectPythonCommand();
    if (!pyCmd) throw new Error("服务器未安装 Python 或 sherpa-onnx，无法使用服务端推理。请运行: pip install sherpa-onnx");
    if (pyProc && pyReady) return pyProc;
    if (pyStartPromise) return pyStartPromise;
    // 启动失败冷却：前端会自动重试多次，没有冷却就会反复 spawn 每个约 925MB 的进程
    if (now() - pyStartFailedAt < startCooldownMs) {
      throw new Error(pyLastError || `服务端推理启动失败，请 ${startCooldownMs / 1000} 秒后重试`);
    }

    pyStartPromise = (async () => {
      // 先确保模型文件在服务器上就绪（懒下载：仅在启用服务端推理时触发）
      await ensureModelReady();
      if (pyProc && pyReady) return pyProc;

      pyReady = false;
      pyBuffer = "";
      // 显式强制 UTF-8：中文 Windows 默认 ANSI 代码页 936(GBK)，若不注入
      // PYTHONUTF8，Node 写入的 UTF-8 字节会被 Python 按 GBK 解码成乱码，
      // Kokoro 对乱码汉字硬拼音素 → 音色/语速正常但内容胡话（乱读）。
      // 不依赖部署机全局环境变量，一处改动根治。
      const proc = spawn(pyCmd, [workerPy, modelCache, String(threads)], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      });
      pyProc = proc;

      // stdin 必须挂 error 监听：进程死亡瞬间，exit 事件置空 pyProc 与 socket
      // 真正关闭之间存在异步窗口，此刻 pyGenerate 的 stdin.write 会触发 EPIPE——
      // Stream 无 error 监听时按 uncaughtException 处理，整个 Node 后端崩溃退出。
      // 挂上监听后 EPIPE 被吞掉，未完成请求由下方 exit 处理器统一 reject。
      proc.stdin.on("error", () => {});

      proc.stdout.on("data", (chunk) => {
        pyBuffer += chunk.toString("utf8");
        let idx;
        while ((idx = pyBuffer.indexOf("\n")) >= 0) {
          const line = pyBuffer.slice(0, idx).trim();
          pyBuffer = pyBuffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "ready") {
              pyReady = true;
              pyLastError = "";
              pyStartFailedAt = 0;
              logger.log(`[tts-py] 服务端推理就绪 (numSpeakers=${msg.numSpeakers})`);
            } else if (msg.type === "result") {
              const pending = pyQueue.get(msg.id);
              if (pending) {
                clearTimeout(pending.timer);
                pyQueue.delete(msg.id);
                pending.resolve(msg);
              }
              if (pyQueue.size === 0) schedulePyIdleShutdown(); // 队列清空：开始计空闲
            } else if (msg.type === "error") {
              const pending = pyQueue.get(msg.id);
              if (pending) {
                clearTimeout(pending.timer);
                pyQueue.delete(msg.id);
                pending.reject(new Error(msg.message));
              }
              if (pyQueue.size === 0) schedulePyIdleShutdown(); // 队列清空：开始计空闲
            }
          } catch { /* 非 JSON 行忽略 */ }
        }
      });
      proc.stderr.on("data", (chunk) => {
        const s = String(chunk).trim();
        if (s) logger.warn("[tts-py] stderr:", s.slice(0, 500));
      });
      // 所有状态回写都要认进程身份：超时/停止会让 pyProc 指向**新**进程，
      // 旧进程稍后才 exit，无条件清空就会把新进程的引用抹掉 → 新进程成孤儿
      proc.on("exit", (code) => {
        logger.warn(`[tts-py] 进程退出 code=${code}`);
        // 状态回写和"判死排队请求"都要认进程身份：超时/停止会让 pyProc 指向**新**
        // 进程，旧进程稍后才 exit。无条件执行就会把新进程引用抹掉（新进程成孤儿），
        // 并把新进程正在排队的请求一起 reject 成"进程已退出"——用户看到的症状是
        // 朗读突然失败，而机器上其实有一个健康进程在跑。
        if (pyProc !== proc) return;
        pyProc = null;
        pyReady = false;
        pyStartPromise = null;
        // 未完成请求全部失败
        for (const [id, p] of pyQueue) {
          clearTimeout(p.timer);
          pyQueue.delete(id);
          p.reject(new Error("服务端推理进程已退出"));
        }
      });
      proc.on("error", (err) => {
        pyLastError = err.message;
        logger.error("[tts-py] 进程错误:", err.message);
        if (pyProc === proc) {
          pyProc = null;
          pyReady = false;
          pyStartPromise = null;
        }
      });

      // 等待 ready（含模型加载，约 3s）
      await new Promise((resolve, reject) => {
        const t0 = now();
        const timer = setInterval(() => {
          if (pyReady) { clearInterval(timer); resolve(); }
          else if (now() - t0 > startTimeoutMs) {
            clearInterval(timer);
            // 超时必须杀掉刚起的进程：只 reject 会让它带着 ~925MB 常驻，
            // 下次 ensurePyProcess 又起一个，反复触发直到 OOM
            try { proc.kill(); } catch { /* 已退出 */ }
            reject(new Error(pyLastError || `服务端推理启动超时（${startTimeoutMs / 1000}s）`));
          }
        }, pollMs);
      });
      return pyProc;
    })().catch((e) => {
      pyStartFailedAt = now();
      pyLastError = e?.message ?? String(e);
      pyStartPromise = null;
      throw e;
    });

    return pyStartPromise;
  }

  /** 提交一次生成请求，返回 { sampleRate, wavBase64 }。
   *  username 用于取消协议：前端停止时按用户清掉排队中的请求。
   *  先入队（等待 Python 就绪期间也可被 cancel 取消），进程就绪后再写入 stdin。 */
  async function generate(text, sid, speed, username = "", idRef = null) {
    cancelPyIdleShutdown(); // 有新请求：取消空闲关闭计划
    const id = pyNextId++;
    if (idRef) idRef.id = id; // 同步回填：调用方要在 await 之前就能拿到 id 做出队
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (dropPyRequest(id)) {
          reject(new Error(`服务端推理超时（${genTimeoutMs / 1000}s）`));
        }
      }, genTimeoutMs);
      pyQueue.set(id, { resolve, reject, timer, username, started: false });
      // 异步等进程就绪后写入；期间被 cancel 移除则静默放弃（reject 已由 cancel 触发）
      (async () => {
        try {
          await ensurePyProcess();
          if (!pyQueue.has(id)) return; // 已被 cancel 取消
          pyQueue.get(id).started = true;
          pyProc.stdin.write(JSON.stringify({ id, text, sid, speed }) + "\n");
        } catch (e) {
          if (dropPyRequest(id)) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }
      })();
    });
  }

  /** 取消某用户所有排队中的请求（前端停止朗读时调用）。
   *  - 未开始的请求：直接从队列移除，Python 不再生成（释放队列位置给其他用户）
   *  - 正在生成的请求：无法中断 Python，但结果返回时队列中已无该 id，自动丢弃
   *  ⚠️ 不依赖 pyReady：Python 启动窗口内（pyReady=false）也有排队中的请求需要取消。
   * 返回被取消的请求数。 */
  function cancelForUser(username) {
    if (!username) return 0;
    let cancelled = 0;
    for (const [id, p] of pyQueue) {
      if (p.username === username) {
        dropPyRequest(id);
        p.reject(new Error("服务端推理已取消"));
        cancelled++;
      }
    }
    if (cancelled > 0) logger.log(`[tts-py] 用户 ${username} 取消 ${cancelled} 个排队请求`);
    return cancelled;
  }

  /** 客户端断开时出队并让调用方拿到错误；已出队/已完成则什么都不做 */
  function abortQueued(id) {
    const p = id == null ? null : pyQueue.get(id);
    if (!p) return false;
    dropPyRequest(id);
    p.reject(new Error("客户端已断开"));
    return true;
  }

  return {
    detectPythonCommand,
    generate,
    cancelForUser,
    abortQueued,
    shutdown: shutdownPyProcess,
    isQueueFull: () => pyQueue.size >= queueLimit,
    queueSize: () => pyQueue.size,
    isReady: () => pyReady,
    lastError: () => pyLastError,
  };
}
