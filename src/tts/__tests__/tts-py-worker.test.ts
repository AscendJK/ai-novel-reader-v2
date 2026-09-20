/**
 * 服务端推理的 Python 子进程队列（lib/tts-py-worker.mjs）
 *
 * 这个 worker 一个就吃 ~925MB，而且它是"用户点了停止之后还在跑"的那一类资源。
 * 它的每个失败模式都不体现在单次朗读成功与否上：并发重复 spawn 直到 OOM、启动超时
 * 后进程留着不杀、客户端断开后空闲关闭计划排不上、旧进程退出把新进程引用抹掉变成
 * 孤儿进程。这些只有拿假子进程驱动才看得见，所以 spawn / execFile / 模型下载 /
 * 时钟全部注入——测试里既不需要真 Python，也不会去碰 350MB 模型。
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

// @ts-expect-error - 后端 JS 模块无类型声明
const mod = await import("../../../server/lib/tts-py-worker.mjs");
const { createTtsPyWorker, idleTimeoutMsFromEnv } = mod as {
  createTtsPyWorker: (o: Record<string, unknown>) => {
    detectPythonCommand: () => Promise<string>;
    generate: (text: string, sid: number, speed: number, username?: string, idRef?: { id?: number } | null) => Promise<Record<string, unknown>>;
    cancelForUser: (username?: string) => number;
    abortQueued: (id?: number) => boolean;
    shutdown: (reason?: string) => void;
    isQueueFull: () => boolean;
    queueSize: () => number;
    isReady: () => boolean;
    lastError: () => string;
  };
  idleTimeoutMsFromEnv: (env?: Record<string, string | undefined>) => number;
};

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeProc() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
  const line = (msg: unknown) => proc.stdout.emit("data", JSON.stringify(msg) + "\n");
  const raw = (s: string) => proc.stdout.emit("data", s);
  const writes = () => proc.stdin.write.mock.calls.map((c: unknown[]) => String(c[0]));
  return { proc, line, raw, writes };
}

type FakeProc = ReturnType<typeof makeProc>;

/** 造一个可驱动的 worker。默认所有超时都很宽松，只有被测的那一条被调小，
 *  这样"进程被杀"只有一个来源，用例不会因为超时抢跑而假绿或假红。 */
function setup(overrides: Record<string, unknown> = {}) {
  const created: FakeProc[] = [];
  const spawn = vi.fn((...args: unknown[]) => {
    void args;
    const f = makeProc();
    created.push(f);
    return f.proc;
  });
  const defaultExecFile = vi.fn(async () => ({ stdout: "ok\n" }));
  const worker = createTtsPyWorker({
    spawn,
    execFileAsync: defaultExecFile,
    ensureModelReady: vi.fn(async () => {}),
    workerPy: "/app/server/tts-worker.py",
    modelCache: "/app/cache/model",
    env: {},
    pollMs: 2,
    startTimeoutMs: 1000,
    genTimeoutMs: 1000,
    queueLimit: 3,
    idleTimeoutMs: 60,
    detectCacheMs: 60000,
    startCooldownMs: 30000,
    logger: silentLogger,
    ...overrides,
  });
  // 覆盖 mock 时让断言拿到的是同一个函数对象
  const execFileAsync = (overrides.execFileAsync as ReturnType<typeof vi.fn>) ?? defaultExecFile;
  /** 轮询到条件成立：CI 上慢机器不会假失败，快机器也不白等 */
  const until = async (cond: () => boolean, what: string, ms = 2000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("等待超时: " + what);
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  /** 入队是同步的、spawn 是异步的（要先过探测），碰 procs[0] 之前必须等它 */
  const awaitSpawn = async () => { await until(() => created.length > 0, "spawn"); };
  /** 起进程并等到 ready，返回该进程的驱动器 */
  const started = async (username = "alice") => {
    const ref: { id?: number } = {};
    const p = worker.generate("你好", 45, 1, username, ref);
    await awaitSpawn();
    const f = created[created.length - 1];
    f.line({ type: "ready", numSpeakers: 103 });
    await until(() => f.writes().length > 0, "stdin 写入");
    return { p, f, ref, id: ref.id as number };
  };
  return { worker, spawn, execFileAsync, procs: () => created, until, awaitSpawn, started };
}

describe("python 命令探测", () => {
  it("探测结果缓存 60s：反复查询只探测一次", async () => {
    const s = setup();
    await s.worker.detectPythonCommand();
    await s.worker.detectPythonCommand();
    await s.worker.detectPythonCommand();
    expect(s.execFileAsync).toHaveBeenCalledTimes(1);
  });

  it("探测失败同样缓存：不会每个请求都从头把候选再试一遍", async () => {
    const s = setup({ execFileAsync: vi.fn(async () => { throw new Error("not found"); }) });
    expect(await s.worker.detectPythonCommand()).toBe("");
    expect(await s.worker.detectPythonCommand()).toBe("");
    expect(s.execFileAsync).toHaveBeenCalledTimes(3); // 一轮 python/python3/py，不是两轮
  });

  it("输出里夹警告行的 python 不算可用，继续回落到下一个候选", async () => {
    const seen: string[] = [];
    const s = setup({
      execFileAsync: vi.fn(async (cmd: string) => {
        seen.push(cmd);
        return { stdout: cmd === "python" ? "UserWarning: onnx 版本不匹配\nok\n" : "ok\n" };
      }),
    });
    expect(await s.worker.detectPythonCommand()).toBe("python3");
    expect(seen).toEqual(["python", "python3"]);
  });

  it("没有可用 Python 时直接报错，绝不 spawn 进程", async () => {
    const s = setup({ execFileAsync: vi.fn(async () => { throw new Error("no python"); }) });
    await expect(s.worker.generate("你好", 45, 1, "alice")).rejects.toThrow(/未安装 Python/);
    expect(s.spawn).not.toHaveBeenCalled();
  });
});

describe("启动与去重", () => {
  it("并发请求只 spawn 一个进程（每个约 925MB）", async () => {
    const s = setup();
    const promises = ["一", "二", "三"].map((t) => s.worker.generate(t, 45, 1, "alice"));
    await s.until(() => s.procs().length === 1, "spawn");
    const f = s.procs()[0];
    f.line({ type: "ready", numSpeakers: 103 });
    f.line({ type: "result", id: 1, wavBase64: "AAAA" });
    f.line({ type: "result", id: 2, wavBase64: "AAAA" });
    f.line({ type: "result", id: 3, wavBase64: "AAAA" });
    await Promise.all(promises);
    expect(s.spawn).toHaveBeenCalledTimes(1);
  });

  it("进程没 ready 之前不写 stdin，ready 之后才写完整一行 JSON", async () => {
    const s = setup();
    const ref: { id?: number } = {};
    const p = s.worker.generate("你好世界", 7, 1.5, "alice", ref);
    await s.until(() => s.procs().length === 1, "spawn");
    const f = s.procs()[0];
    expect(f.writes()).toEqual([]);         // 未 ready 不许投喂
    expect(ref.id).toBeTypeOf("number");    // id 同步回填：调用方要在 await 之前就能做出队
    f.line({ type: "ready", numSpeakers: 103 });
    await s.until(() => f.writes().length === 1, "stdin 写入");
    expect(JSON.parse(f.writes()[0])).toEqual({ id: ref.id, text: "你好世界", sid: 7, speed: 1.5 });
    expect(f.writes()[0].endsWith("\n")).toBe(true);
    f.line({ type: "result", id: ref.id, wavBase64: "AAAA" });
    await expect(p).resolves.toMatchObject({ wavBase64: "AAAA" });
  });

  it("spawn 必须显式带上 UTF-8 环境（中文 Windows 上少一个就乱读）", async () => {
    const s = setup();
    const { p, f, id } = await s.started();
    const opts = s.spawn.mock.calls[0][2] as { env: Record<string, string>; windowsHide: boolean };
    expect(opts.env.PYTHONUTF8).toBe("1");
    expect(opts.env.PYTHONIOENCODING).toBe("utf-8");
    expect(opts.windowsHide).toBe(true);
    f.line({ type: "error", id, message: "结束用例" });
    await expect(p).rejects.toThrow("结束用例");
  });

  it("命令行参数是 worker 脚本 + 模型目录 + 线程数", async () => {
    const s = setup();
    const { p, f, id } = await s.started();
    const argv = s.spawn.mock.calls[0][1] as string[];
    expect(argv).toEqual(["/app/server/tts-worker.py", "/app/cache/model", "8"]);
    f.line({ type: "error", id, message: "结束用例" });
    await expect(p).rejects.toThrow("结束用例");
  });

  it("stdin 必须挂 error 监听：进程死亡瞬间写入的 EPIPE 不能变成整个后端崩溃", async () => {
    const s = setup();
    const started = s.worker.generate("你好", 45, 1, "alice");
    await s.until(() => s.procs().length === 1, "spawn");
    const f = s.procs()[0];
    expect(f.proc.stdin.listenerCount("error")).toBe(1);
    f.line({ type: "ready", numSpeakers: 103 });
    await s.until(() => f.writes().length === 1, "写入");
    f.proc.stdin.emit("error", new Error("EPIPE"));  // 无监听时这里是 uncaughtException
    f.line({ type: "result", id: 1, wavBase64: "AAAA" });
    await expect(started).resolves.toMatchObject({ wavBase64: "AAAA" });
  });

  it("启动超时不仅要失败，还要把刚起的进程杀掉", async () => {
    const s = setup({ startTimeoutMs: 20 });
    const p = s.worker.generate("你好", 45, 1, "alice");
    await s.until(() => s.procs().length === 1, "spawn");
    const f = s.procs()[0];
    await expect(p).rejects.toThrow(/启动超时/);
    expect(f.proc.kill).toHaveBeenCalled();          // 不杀就是带着 925MB 常驻
    expect(s.worker.isReady()).toBe(false);
  });

  it("启动失败后进入冷却：冷却期内不再反复 spawn，过了冷却才放行", async () => {
    let offset = 0;   // 时钟跟着真实时间走，只把"过了多久"往前推，否则启动超时永远等不到
    const s = setup({ startTimeoutMs: 20, startCooldownMs: 30000, now: () => Date.now() + offset });
    await expect(s.worker.generate("你好", 45, 1, "alice")).rejects.toThrow(/启动超时/);
    expect(s.spawn).toHaveBeenCalledTimes(1);

    await expect(s.worker.generate("你好", 45, 1, "alice")).rejects.toThrow(/启动超时/);
    expect(s.spawn).toHaveBeenCalledTimes(1);
    expect(s.worker.lastError()).toContain("启动超时"); // 报的是上次真实原因，不是"稍后重试"

    offset = 31000; // 冷却已过
    await expect(s.worker.generate("你好", 45, 1, "alice")).rejects.toThrow(/启动超时/);
    expect(s.spawn).toHaveBeenCalledTimes(2);
  });

  it("启动时模型下载只发生一次，且下载失败不把进程当成已启动", async () => {
    const ensureModelReady = vi.fn(async () => { throw new Error("模型下载失败"); });
    const s = setup({ ensureModelReady });
    await expect(s.worker.generate("你好", 45, 1, "alice")).rejects.toThrow("模型下载失败");
    expect(ensureModelReady).toHaveBeenCalledTimes(1);
    expect(s.spawn).not.toHaveBeenCalled();          // 模型都没下来就不该起进程
  });
});

describe("排队、取消与断开", () => {
  it("排队到达上限时 isQueueFull 为真（路由据此回 503）", async () => {
    const s = setup({ queueLimit: 2 });
    const p1 = s.worker.generate("一", 45, 1, "alice");
    const p2 = s.worker.generate("二", 45, 1, "alice");
    await s.awaitSpawn();
    await s.until(() => s.worker.queueSize() === 2, "两条入队");
    expect(s.worker.isQueueFull()).toBe(true);
    s.procs()[0].line({ type: "error", id: 1, message: "结束用例" });
    await expect(p1).rejects.toThrow("结束用例");
    await s.until(() => !s.worker.isQueueFull(), "出队后不满");
    s.procs()[0].line({ type: "error", id: 2, message: "结束用例" });
    await expect(p2).rejects.toThrow("结束用例");
  });

  it("cancelForUser 只清掉该用户的排队请求并返回条数", async () => {
    const s = setup();
    const pa = s.worker.generate("a1", 45, 1, "alice");
    const pb = s.worker.generate("a2", 45, 1, "alice");
    const pc = s.worker.generate("b1", 45, 1, "bob");
    await s.awaitSpawn();
    await s.until(() => s.worker.queueSize() === 3, "三条入队");
    expect(s.worker.cancelForUser("alice")).toBe(2);
    expect(s.worker.queueSize()).toBe(1);
    await expect(pa).rejects.toThrow(/已取消/);
    await expect(pb).rejects.toThrow(/已取消/);
    s.procs()[0].line({ type: "ready", numSpeakers: 103 });
    await s.until(() => s.procs()[0].writes().length === 1, "bob 那条写入");
    expect(JSON.parse(s.procs()[0].writes()[0]).text).toBe("b1");
    s.procs()[0].line({ type: "result", id: 3, wavBase64: "ZZZZ" });
    await expect(pc).resolves.toMatchObject({ wavBase64: "ZZZZ" });
  });

  it("没带用户名时不取消任何人的请求", async () => {
    const s = setup();
    const { p, f, id } = await s.started();
    expect(s.worker.cancelForUser()).toBe(0);
    expect(s.worker.queueSize()).toBe(1);
    f.line({ type: "result", id, wavBase64: "AAAA" });
    await expect(p).resolves.toMatchObject({ wavBase64: "AAAA" });
  });

  it("启动窗口内被取消的请求，进程就绪后也不能再写进 stdin", async () => {
    const s = setup();
    const doomed = s.worker.generate("作废", 45, 1, "alice");
    const kept = s.worker.generate("留着", 45, 1, "bob");
    await s.awaitSpawn();
    await s.until(() => s.worker.queueSize() === 2, "两条入队");
    expect(s.worker.cancelForUser("alice")).toBe(1);
    await expect(doomed).rejects.toThrow(/已取消/);
    s.procs()[0].line({ type: "ready", numSpeakers: 103 });
    await s.until(() => s.procs()[0].writes().length === 1, "bob 那条写入");
    expect(JSON.parse(s.procs()[0].writes()[0]).text).toBe("留着");
    s.procs()[0].line({ type: "result", id: 2, wavBase64: "AAAA" });
    await expect(kept).resolves.toMatchObject({ wavBase64: "AAAA" });
  });

  it("客户端断开：出队 + reject，并且把空闲关闭计划补上", async () => {
    const s = setup({ idleTimeoutMs: 40, startTimeoutMs: 60000 });
    const ref: { id?: number } = {};
    const p = s.worker.generate("你好", 45, 1, "alice", ref);
    await s.until(() => s.worker.queueSize() === 1, "入队");
    expect(s.worker.abortQueued(ref.id)).toBe(true);
    await expect(p).rejects.toThrow(/客户端已断开/);
    expect(s.worker.queueSize()).toBe(0);
    expect(s.worker.abortQueued(ref.id)).toBe(false);  // 重复断开不炸
    // 队列已空却再没有 result 可等：不补这一步，925MB 的进程就无限常驻
    await s.until(() => s.procs()[0].proc.kill.mock.calls.length > 0, "空闲到期关闭");
  });

  it("单条请求超时后自己出队，不会占着队列位", async () => {
    const s = setup({ genTimeoutMs: 30, idleTimeoutMs: 60000 });
    const p = s.worker.generate("你好", 45, 1, "alice");
    await s.until(() => s.procs().length === 1, "spawn");
    await expect(p).rejects.toThrow(/超时/);
    expect(s.worker.queueSize()).toBe(0);
  });

  it("Python 回报错误时把原始 message 交给调用方（否则前端只看到'推理失败'）", async () => {
    const s = setup();
    const { p, f, id } = await s.started();
    f.line({ type: "error", id, message: "音素转换失败" });
    await expect(p).rejects.toThrow("音素转换失败");
  });

  it("非 JSON 的进度噪音不许把请求误判成完成，也不许抛出来", async () => {
    const s = setup();
    const { p, f, id } = await s.started();
    f.raw("loading model... 42%\n");
    f.raw("{ 半截的 JSON\n");
    expect(s.worker.queueSize()).toBe(1);
    f.line({ type: "result", id, wavBase64: "AAAA", sampleRate: 24000 });
    await expect(p).resolves.toMatchObject({ sampleRate: 24000 });
  });

  it("跨 chunk 的半行 JSON 必须拼回来（否则结果永远等不到）", async () => {
    const s = setup();
    const { p, f, id } = await s.started();
    const line = JSON.stringify({ type: "result", id, wavBase64: "AAAA" }) + "\n";
    f.raw(line.slice(0, 18));
    expect(s.worker.queueSize()).toBe(1);            // 半行不能被当成一条消息
    f.raw(line.slice(18));
    await expect(p).resolves.toMatchObject({ wavBase64: "AAAA" });
  });
});

describe("常驻与退出", () => {
  it("进程退出时所有排队请求一起失败，没有人被吊住", async () => {
    const s = setup();
    const all = [s.worker.generate("一", 45, 1, "a"), s.worker.generate("二", 45, 1, "b")];
    await s.awaitSpawn();
    await s.until(() => s.worker.queueSize() === 2, "两条入队");
    s.procs()[0].proc.emit("exit", 137);
    const settled = await Promise.allSettled(all);
    expect(settled.map((r) => (r.status === "rejected" ? r.reason.message : "resolved")))
      .toEqual(["服务端推理进程已退出", "服务端推理进程已退出"]);
    expect(s.worker.queueSize()).toBe(0);
  });

  it("旧进程迟到的 exit 不能牵连新进程：排队中的请求照常完成", async () => {
    const s = setup({ startTimeoutMs: 200, startCooldownMs: 0 });
    const first = s.worker.generate("一", 45, 1, "alice");
    await s.until(() => s.procs().length === 1, "第一次 spawn");
    await expect(first).rejects.toThrow(/启动超时/);   // 超时把旧进程 kill 掉

    const second = s.worker.generate("二", 45, 1, "alice");
    await s.until(() => s.procs().length === 2, "第二次 spawn");
    const [old, cur] = s.procs();
    cur.line({ type: "ready", numSpeakers: 103 });
    await s.until(() => cur.writes().length === 1, "新进程收到请求");
    old.proc.emit("exit", 1);                          // 旧进程这会儿才退
    cur.line({ type: "result", id: 2, wavBase64: "BBBB" });
    await expect(second).resolves.toMatchObject({ wavBase64: "BBBB" });
    expect(s.spawn).toHaveBeenCalledTimes(2);          // 也没顺手起第三个
  });

  it("旧进程迟到的 exit 不能把新进程引用抹掉（否则新进程成孤儿，还会再 spawn）", async () => {
    const s = setup({ startTimeoutMs: 200, startCooldownMs: 0, idleTimeoutMs: 60000 });
    const first = s.worker.generate("一", 45, 1, "alice");
    await s.until(() => s.procs().length === 1, "第一次 spawn");
    await expect(first).rejects.toThrow(/启动超时/);

    const second = s.worker.generate("二", 45, 1, "alice");
    second.catch(() => { /* 由下面的 exit 事件 reject */ });
    await s.until(() => s.procs().length === 2, "第二次 spawn");
    const [old, cur] = s.procs();
    old.proc.emit("exit", 1);                          // 迟到的退出
    s.worker.shutdown("test");                         // 关的必须是新进程
    expect(cur.proc.kill).toHaveBeenCalledTimes(1);
    cur.proc.emit("exit", 143);
    await expect(second).rejects.toThrow(/进程已退出/);
    expect(s.spawn).toHaveBeenCalledTimes(2);
  });

  it("队列清空后空闲到期自动关闭；关闭计划排上前又来了新请求就取消", async () => {
    const s = setup({ idleTimeoutMs: 80 });
    const { p: p1, f, id } = await s.started();
    const p2 = s.worker.generate("二", 45, 1, "alice");
    f.line({ type: "result", id, wavBase64: "AAAA" });   // 队列清空 → 开始计空闲
    await expect(p1).resolves.toMatchObject({ wavBase64: "AAAA" });
    f.line({ type: "result", id: 2, wavBase64: "BBBB" }); // 新请求把关闭计划取消掉
    await expect(p2).resolves.toMatchObject({ wavBase64: "BBBB" });
    expect(f.proc.kill).not.toHaveBeenCalled();
    await s.until(() => f.proc.kill.mock.calls.length > 0, "空闲到期关闭");
    expect(s.spawn).toHaveBeenCalledTimes(1);
  });

  it("后端退出路径（shutdown）立即 kill 当前进程，不等生成完成", async () => {
    const s = setup({ idleTimeoutMs: 60000 });
    const { p, f } = await s.started();
    s.worker.shutdown("server-exit");
    expect(f.proc.kill).toHaveBeenCalledTimes(1);
    f.proc.emit("exit", 0);
    await expect(p).rejects.toThrow(/进程已退出/);
  });
});

describe("空闲时长来自环境", () => {
  it("默认 10 分钟，TTS_PY_IDLE_SECONDS 可覆盖，乱值回落到默认", () => {
    expect(idleTimeoutMsFromEnv({})).toBe(600000);
    expect(idleTimeoutMsFromEnv({ TTS_PY_IDLE_SECONDS: "5" })).toBe(5000);
    expect(idleTimeoutMsFromEnv({ TTS_PY_IDLE_SECONDS: "乱七八糟" })).toBe(600000);
  });
});
