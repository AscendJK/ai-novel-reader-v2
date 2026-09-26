/**
 * lib/quota-guard — 磁盘写满时那条自动降级链，首次有直接判据
 *
 * 它有四个真调用点（db/repositories.ts:26、rag/index.ts:230、rag/build-index.ts:223、
 * tts/tts-cache.ts:165），而每一处的用例都把整只模块 mock 掉了（`vi.mock("@/lib/quota-guard")`）。
 * 也就是说"写满之后会发生什么"到今天为止一次都没被判过——而这恰恰是它会做错的那件事：
 * 三个清理动作是有安全等级的（先淘汰可重建的 RAG 索引，再扫 TTS 孤儿，最后才删非激活的
 * 嵌入模型），链上任何一格短路掉了，用户看到的就不是"清出空间重试"而是"书架里的书少了点东西"。
 *
 * 判五件事：
 * 1. `isQuotaError` 只认 name，且两个名字都要在（Chromium 的 `QuotaExceededError` 与
 *    Firefox 的 `NS_ERROR_DOM_QUOTA_REACHED` 是两家不同的浏览器，少一个另一家永远不降级）；
 * 2. 非配额错误必须原样、立刻抛出（对象身份要留住：调用方靠它给用户看原因）；
 * 3. 降级链按安全等级从低到高跑，**第一步腾出空间就不许再动后面两格**；
 * 4. 重试预算：1 次原写 + 3 次重试，跑完抛的仍是最初那个错误；腾不出空间就一次都不重试；
 * 5. `navigator.storage.estimate()` 拿不到时的口径——**假定腾出了空间**，由预算兜死循环。
 *    这一格是产品注释里写明的设计（quota-guard.ts:60），不是漏判：真机上 estimate 经常没有，
 *    把它反过来钉成"测不到就不清理"会让所有 Android 用户永远得不到自动降级。
 *
 * 有意不判的：
 * - 三个清理目标各自清什么（`enforceIndexedDBQuota` / `cleanupOrphanFiles` /
 *   `deleteNonActiveEmbeddingModels` 各自的判据在 rag 与 tts 那几档里），这里只判调用顺序与次数；
 * - 日志文案的完整字面量：只判"每次重试留一条、带第几次"，整句改字不该红；
 * - `withQuotaRetry` 的泛型返回值：四个调用点全都丢弃返回值，且写回 `undefined` 会被 tsc 拦住，
 *   类型层已经管住。这里只用一条用例确认成功路径没被改成"跑完不返回"。
 * - **为什么用动态 import 而不是静态**：这一格判据够不着（G20 实测 0 红）——这一层只看行为，
 *   "避免与清理目标互相引用成环"不在行为面上。唯一的防线是 quota-guard.ts:10 那行注释。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** 降级链三个目标的替身：seq 记录"按什么顺序真跑了"，各自可单独改成抛错 */
const M = vi.hoisted(() => {
  const seq: string[] = [];
  return {
    seq,
    enforce: vi.fn(),
    cleanup: vi.fn(),
    dropModels: vi.fn(),
  };
});

vi.mock("@/rag/rag-cache-utils", () => ({ enforceIndexedDBQuota: M.enforce }));
vi.mock("@/tts/tts-cache", () => ({ cleanupOrphanFiles: M.cleanup }));
vi.mock("@/rag/model-loader", () => ({ deleteNonActiveEmbeddingModels: M.dropModels }));

import { isQuotaError, withQuotaRetry } from "../quota-guard";

const quotaErr = (name = "QuotaExceededError") => {
  const e = new Error("storage is full");
  e.name = name;
  return e;
};

/** 拿拒绝值本身：要判的是"同一个对象"，不是文案 */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("这一条期待它失败，结果成功了");
    },
    (e: unknown) => e,
  );
}

const originalStorage = navigator.storage;

/** 第一笔写抛 err、第二笔起返回 ok */
function flakyWrite(err: unknown, ok: string) {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    if (calls === 1) throw err;
    return ok;
  });
}

/** usage 读数依次发出；超出末尾就重复最后一个 */
function stubUsage(readings: number[]) {
  let i = 0;
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    writable: true,
    value: {
      estimate: async () => ({ usage: readings[Math.min(i++, readings.length - 1)], quota: 1e9 }),
    },
  });
}

/** 测不到的三种真形：整个没有 storage / estimate 自己炸 / 回来了但没带 usage */function stubUnmeasurable(kind: "no-storage" | "estimate-throws" | "no-usage-field") {
  const value =
    kind === "no-storage"
      ? undefined
      : kind === "estimate-throws"
        ? { estimate: async () => { throw new Error("SecurityError"); } }
        : { estimate: async () => ({ quota: 1e9 }) };
  Object.defineProperty(navigator, "storage", { configurable: true, writable: true, value });
}

/** 每问一次就降一档：用来演"每次清理都真腾出空间"的那几笔 */
function stubShrinking() {
  let usage = 1000;
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    writable: true,
    value: {
      estimate: async () => ({ usage: (usage -= 100), quota: 1e9 }),
    },
  });
}

/** 产品里那条 console.warn 是唯一现场留痕，收下来判次数与"第几次" */
let warns: string[];
const originalWarn = console.warn;

beforeEach(() => {
  M.seq.length = 0;
  M.enforce.mockClear();
  M.cleanup.mockClear();
  M.dropModels.mockClear();
  M.enforce.mockImplementation(async () => { M.seq.push("rag"); });
  M.cleanup.mockImplementation(async () => { M.seq.push("tts"); return 1; });
  M.dropModels.mockImplementation(async () => { M.seq.push("model"); return 1; });
  stubUsage([100, 50]);
  warns = [];
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
});

afterEach(() => {
  console.warn = originalWarn;
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    writable: true,
    value: originalStorage,
  });
  vi.restoreAllMocks();
});

describe("isQuotaError 只认 name", () => {
  it("Chromium 与 Firefox 两个名字都算（少一个另一家永远不降级）", () => {
    expect(isQuotaError(quotaErr("QuotaExceededError"))).toBe(true);
    expect(isQuotaError(quotaErr("NS_ERROR_DOM_QUOTA_REACHED"))).toBe(true);
  });

  it("真的 DOMException 形状也算（IndexedDB 炸出来的是它，不是 Error）", () => {
    expect(isQuotaError(new DOMException("the task has been aborted", "QuotaExceededError"))).toBe(true);
  });

  it("其他 name 一律不算：DataError / NetworkError / 默认 Error 都不该触发清库", () => {
    for (const name of ["DataError", "AbortError", "NetworkError", "TransactionInactiveError", "TypeError"]) {
      expect(isQuotaError(quotaErr(name)), name).toBe(false);
    }
    expect(isQuotaError(new Error("boom"))).toBe(false);
  });

  it("message 里写着 quota 也不算（不许退化成按文案猜）", () => {
    const e = new Error("QuotaExceededError: exceeded the quota");
    expect(e.message).toContain("QuotaExceeded");
    expect(isQuotaError(e)).toBe(false);
  });

  it("非对象与空值都返回 false 且不抛：字符串哪怕内容就是那个名字也不算", () => {
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError("QuotaExceededError")).toBe(false);
    expect(isQuotaError(0)).toBe(false);
    expect(isQuotaError("")).toBe(false);
  });

  it("对象没有 name、name 是空串或不是字符串，都算不出来", () => {
    expect(isQuotaError({})).toBe(false);
    expect(isQuotaError({ name: "" })).toBe(false);
    expect(isQuotaError({ name: 7 })).toBe(false);
    expect(isQuotaError({ message: "quota" })).toBe(false);
  });
});

describe("不降级、也不重试的那些情形", () => {
  it("写成功了就原样返回，且一个清理动作都不许跑", async () => {
    const fn = vi.fn(async () => "written");
    await expect(withQuotaRetry(fn)).resolves.toBe("written");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(M.seq).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("非配额错误：原样、立刻抛出，不清理也不留日志", async () => {
    const boom = quotaErr("DataError");
    const fn = vi.fn(async () => { throw boom; });
    expect(await rejection(withQuotaRetry(fn))).toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(M.seq).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("以字符串拒绝的错误也原样抛出（不许把内容当配额信号）", async () => {
    const fn = vi.fn(async () => { throw "QuotaExceededError"; });
    expect(await rejection(withQuotaRetry(fn))).toBe("QuotaExceededError");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(M.seq).toEqual([]);
  });

  it("降级链三步都测不出释放 → 一次都不重试，抛的还是最初那个错误", async () => {
    stubUsage([100]);
    const boom = quotaErr();
    const fn = vi.fn(async () => { throw boom; });
    expect(await rejection(withQuotaRetry(fn))).toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(M.seq).toEqual(["rag", "tts", "model"]);
    expect(warns).toEqual([]);
  });
});

describe("降级链按安全等级从低到高", () => {
  it("第一步就腾出空间：后面两格一步都不许跑（能少删就少删）", async () => {
    stubUsage([100, 60]);
    const fn = flakyWrite(quotaErr(), "ok");
    await expect(withQuotaRetry(fn)).resolves.toBe("ok");
    expect(M.seq).toEqual(["rag"]);
    expect(M.cleanup).not.toHaveBeenCalled();
    expect(M.dropModels).not.toHaveBeenCalled();
  });

  it("前两步测不出变化才依次往下跑，顺序就是 rag → tts → model", async () => {
    stubUsage([100, 100, 100, 100, 100, 40]);
    const fn = flakyWrite(quotaErr(), "ok");
    await expect(withQuotaRetry(fn)).resolves.toBe("ok");
    expect(M.seq).toEqual(["rag", "tts", "model"]);
  });

  it("某一步自己炸了不带走整条链：后面两格照跑", async () => {
    M.enforce.mockImplementation(async () => {
      M.seq.push("rag");
      throw new Error("RAG 库打不开");
    });
    stubUsage([100, 100, 100, 70]);
    const fn = flakyWrite(quotaErr(), "ok");
    await expect(withQuotaRetry(fn)).resolves.toBe("ok");
    expect(M.seq).toEqual(["rag", "tts"]);
  });

  it("每一步都是严格「变小」才算释放：usage 一点没动不算清出空间", async () => {
    stubUsage([100, 100]);
    const boom = quotaErr();
    const fn = vi.fn(async () => { throw boom; });
    expect(await rejection(withQuotaRetry(fn))).toBe(boom);
    expect(M.dropModels).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("重试预算：1 次原写 + 3 次重试", () => {
  it("清出空间后重试成功：写操作跑两次，留一条日志", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw quotaErr();
    });
    await expect(withQuotaRetry(fn)).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(warns).toHaveLength(1);
  });

  it("一直写满：fn 最多跑 4 次，最后抛的仍是最初那个错误对象", async () => {
    stubShrinking();
    const boom = quotaErr();
    const fn = vi.fn(async () => { throw boom; });
    expect(await rejection(withQuotaRetry(fn))).toBe(boom);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(M.enforce).toHaveBeenCalledTimes(3);
  });

  it("每次重试各留一条，且带的是第几次（1/3、2/3、3/3）", async () => {
    stubShrinking();
    const fn = vi.fn(async () => { throw quotaErr(); });
    await rejection(withQuotaRetry(fn));
    const lines = warns.slice();
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.match(/\((\d)\/3\)/)?.[1])).toEqual(["1", "2", "3"]);
  });

  it("重试途中换成非配额错误：立刻抛出，不再烧剩下的预算", async () => {
    stubUsage([100, 60]);
    const boom = quotaErr();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      throw quotaErr(calls === 1 ? "QuotaExceededError" : "DataError");
    });
    expect(await rejection(withQuotaRetry(fn))).not.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(M.enforce).toHaveBeenCalledTimes(1);
  });
});

describe("estimate 拿不到时的口径：假定清出了空间", () => {
  it.each(["no-storage", "estimate-throws", "no-usage-field"] as const)(
    "%s：仍然重试（由预算兜住，不是死循环）",
    async (kind) => {
      stubUnmeasurable(kind);
      const fn = flakyWrite(quotaErr(), "ok");
      await expect(withQuotaRetry(fn)).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
      // 拿不到读数时第一步就判定「有效」，所以只有最安全那一格被动过
      expect(M.seq).toEqual(["rag"]);
    },
  );

  it("测不到也不许无限重试：预算跑完照样抛原错误", async () => {
    stubUnmeasurable("no-storage");
    const boom = quotaErr();
    const fn = vi.fn(async () => { throw boom; });
    expect(await rejection(withQuotaRetry(fn))).toBe(boom);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

// ── 变异台账（字节基线 sha256=480d1160… / 3227 B / 87 行；一刀一跑一还原。每轮核
//    markers=1 与 transform_failed=0，收局 D0b 才拿字节比——正是它抓到一行残留）──────────
//
// 24 刀（G1..G23 再加一记 G3b）：22 刀咬红，2 刀 0 红且**两条原因都写在明处**（G4、G20）。
// 22 条用例每一条都被至少一刀指名打红过。D0 = D0b = 22 条全绿（开局与收局各一次）。
// 跑法 %TEMP%\knife-qg.sh（FORCE_COLOR=0 + 剥 ANSI，否则 sum 那行读不出来）。
//
// G1  摘掉 Firefox 那个名字                    1 红：两个名字都算
// G2  摘掉「非对象直接 false」的守卫            1 红：非对象与空值（只有 null/undefined 那两格真抛出去；
//     字符串那格不抛——取 .name 得 undefined，兜成空串还是 false）
// G3  只把 return 换成按文案猜                  2 红：两个名字 ／ message 那条。**咬不到「以字符串拒绝」**：
//     typeof 守卫在它前面就拦下了 → 同一族判据分两层取样（直接调 isQuotaError 一层、走重试一趟一层）
// G3b 整只换成按文案猜（连守卫一起摘）          4 红：G3 那两条 ＋ 非对象与空值 ＋ 以字符串拒绝。
//     与 sanitize-svg／badge 那条「配置层要下整段删掉的刀」同族：**只有把守卫一起摘，才看得到这条的牙**
// G4  摘掉 name 的 `|| ""` 兜底                 **0 红，真装饰**：undefined 与 "" 在两处 === 比较里同侧；
//     这一格是给 tsc 收窄类型用的，不是给行为的。不补断言（补了只能断言一个不存在的差异＝假绿）
// G5  三步顺序整个倒过来                        9 红（本只最宽的"设计面"一刀：安全等级从低到高就是它全部的意义）
// G6  摘掉「腾出空间就收手」的短让              5 红：能少删就少删那条 ＋ 三条「测不到」
// G7  `<` 放宽成 `<=`（没变大就算释放）         4 红：严格变小 ／ 顺序 ／ 单步炸了 ／ 三步都不释放
// G8  摘掉单步 try/catch                        1 红：某一步炸了不带走整条链
// G9  测不到时兜成 0（不是 null）               3 红：no-storage ／ estimate-throws ／ 测不到也不许无限重试
// G10 丢掉 `est.usage ?? null`                  1 红：no-usage-field 单独那一行
// G11 MAX_RETRIES 3 抬成 2                      3 红：含「1/3、2/3、3/3」那条（只剩两行）
// G12 循环边界 `<=` 改成 `<`                    2 红：**「每次各留一条」这一条不红**——(1/3)(2/3)(3/3)
//     三行照样齐，被挪走的是"最后一次清理"，不是计数
// G13 摘掉「非配额错误直接抛」                  3 红
// G14 摘掉「没腾出空间就不再试」                2 红
// G15 摘掉重试留痕                              2 红
// G16 留痕计数少 1（attempt 不 +1）             1 红
// G17 摘掉 `attempt >= MAX_RETRIES` 那道闸      2 红：**fn 次数那条不红**——4 次由 for 的条件守住；
//     这一格管的是"多清一次库 ＋ 多留一条痕"。与 G11／G12 三刀红名互不相同，
//     正好把"跑几次写""清几次库""留几条痕"三格分开——**计数型判据要给"少一次"和"多一次"两把不同的刀**
// G18 抛新造的错误、丢掉最初那个对象            4 红（用户看到的"为什么没写进去"就靠这个身份）
// G19 `return await fn()` 丢掉 await            13 红。原以为是等价变异，实测它是**整条重试腿的总开关**：
//     在 try 里 `return promise` 不 await，catch 永远进不去，降级链一次都不跑
// G20 动态 import 换成静态                      **0 红，而且判据够不着**：这一层只看行为，
//     "避免与清理目标成环"不在行为面上 → 唯一的防线是文件头那行注释（记下来，不硬造断言）
// G21 只认 `instanceof Error`                   1 红：真的 DOMException 形状那条（IndexedDB 炸出来的是它）
// G22 是对象就返回 true                         5 红：第一次咬到「其他 name 一律不算」与「没有 name／空串／非字符串」
// G23 写入前先清一遍（"预防性清理"）            14 红（本只最宽的一刀），也是
//     「写成功了就原样返回、一个清理动作都不许跑」唯一的一条牙
//
// 一记账面事故（必须记）：G21→G22 那段还原多留了一行同字面量、且**不可达**的 return。
// 行为面它永不执行，所以 G22/G23 的读数不受影响；但 D0b 的 sha 打印先报出 1b8c99f3 不等于基线，
// `git diff` 再定位到那一行，删掉后回到 480d1160。**markers=1 且红名对得上不等于盘是干净的**——
// 收局要拿字节比，不能只看计数。

