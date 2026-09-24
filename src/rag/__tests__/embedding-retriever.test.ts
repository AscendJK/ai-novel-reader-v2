/**
 * `src/rag/embedding-retriever.ts`：向量索引那一层的**内存账**与**编码回退链**。
 *
 * 为什么要单独钉：这只 334 行的文件 2026-06 以来被改 17 笔（第 1 档榜首），而全仓没有一条
 * 判据直接指着它——`src/rag/__tests__/index.test.ts` 判的是 `normalizeChunks`（住在另一只
 * 文件里），浏览器层 F13 判的是"命中按点积排序、换书不残留"那一眼看得见的结果。剩下的三件
 * 事谁都还没答过"改坏了会不会红"：
 *   ① 100MB 那道内存闸的**记账**（尺寸公式、同键覆盖、删除清账、淘汰顺序与通知）；
 *   ② `init` 那条"内存 → IndexedDB → 服务器状态 → 触发构建"的降级链（R-25 要求 buildStore
 *      必须收到收尾，否则书架那个状态窗口永远"构建中"）；
 *   ③ `search` 的编码回退（服务端 → Worker → 放弃）与看门狗（R-30）。
 *
 * 夹具：真 `useRAGStore` / `useBuildStore`（这两件事的"有没有收到"本身就是判据对象），
 * 桩掉的是 `@/db/database`、`@/lib/api-client`、`../worker-client`、`../build-index`、
 * `../rag-cache-utils`、`@/lib/logger`——它们各有自己的判据文件，桩掉才不双算。
 *
 * 100MB 这道闸不能靠真分配来量（要 25 百万个 float），所以尺寸一律走 `extraBytes` 这条
 * 官方入口凑到门槛边上，再用真实的小向量去踩线——`vectors.length × dim × 4` 那一项**参与
 * 计算**这件事，正是靠"恰好 100MB 不淘汰、多 32 字节就淘汰"这两格夹出来的。
 *
 * 读到、没判也没改的两处形状（不是缺陷，写下来免得下次当成漏网）：
 *  - `lruAdd` 里那句 `try { addLruKey } catch { /* ignore *\/ }`：store 就在同一模块图里，
 *    拿得到就不会抛，抛了也没有可观察后果——不可达防御支，判它等于判桩。
 *  - `encodeWithWatchdog` 的 `throw e` 那一支：两个调用点传进来的 `run` 都自带
 *    `.catch(() => null)`，非 abort 的错误到不了这里。要判"真错误不许被吞"得先改调用方。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EmbeddingProgress } from "../embedding-retriever";
import type { Chunk } from "../retriever";

const MB = 1024 * 1024;
const ENGINE = "Xenova/bge-small-zh-v1.5";

const s = vi.hoisted(() => ({
  dbGet: vi.fn(),
  dbDelete: vi.fn(),
  apiFetch: vi.fn(),
  buildAndPoll: vi.fn(),
  downloadIndex: vi.fn(),
  encodeWorker: vi.fn(),
  access: vi.fn(),
  logs: [] as string[],
}));

vi.mock("@/db/database", () => ({
  sharedDB: { ragCache: { get: (k: string) => s.dbGet(k), delete: (k: string) => s.dbDelete(k) } },
}));
vi.mock("@/lib/api-client", () => ({ apiFetch: (...a: unknown[]) => s.apiFetch(...a) }));
vi.mock("../worker-client", () => ({
  encodeQueryWithWorker: (text: string, engine: string, opts?: { signal?: AbortSignal }) =>
    s.encodeWorker(text, engine, opts),
}));
vi.mock("../build-index", () => ({
  buildAndPollRAGIndex: (o: unknown) => s.buildAndPoll(o),
  downloadAndCacheIndex: (o: unknown) => s.downloadIndex(o),
}));
vi.mock("../rag-cache-utils", () => ({ updateAccessTime: (...a: unknown[]) => s.access(...a) }));
vi.mock("@/lib/logger", () => ({ ragLog: (m: string) => { s.logs.push(String(m)); } }));

/**
 * `LRU_CACHE` 与 `cacheTotalSize` 是模块级的，跨用例存活——一个用例留下的余温会把下一个
 * 的"越线/没越线"顶反（第一版就是这么误判了两格判据的归属）。所以每个用例重新导入一次模块，
 * 各拿一份干净的账。
 */
let m: typeof import("../embedding-retriever");
// 两只 store 也必须从同一份新模块图里取：resetModules 之后被测代码拿到的是新实例，
// 断言若指着旧实例就永远对不上（第一版就红在这四处）。
let useRAGStore: typeof import("@/stores/rag-store")["useRAGStore"];
let useBuildStore: typeof import("@/stores/build-store")["useBuildStore"];
/** 本文件里加进 LRU 的键（重新导入后其实会自动归零，留着只是为了让"加了什么"可读） */
const addedKeys: string[] = [];
/** 造一条内存条目：`vecCount × dim` 是真 float（小得可以忽略），其余尺寸用 extraBytes 凑 */
function put(key: string, vecCount = 0, dim = 4, extraBytes = 0) {
  const vectors = Array.from({ length: vecCount }, (_, i) => new Float32Array(dim).fill(i));
  const chunks: Chunk[] = Array.from({ length: vecCount }, (_, i) => ({ id: `c${i}`, content: `第${i}段` }));
  m.lruAdd(key, vectors, chunks, dim, extraBytes);
  addedKeys.push(key);
}
const jsonOk = (obj: unknown) => ({ ok: true, status: 200, json: async () => obj });
const jsonFail = (status = 500) => ({ ok: false, status, json: async () => ({}) });

/** IDB 里那份缓存记录：字节数按 chunkCount×dim×4 摆（损坏用例故意打乱它） */
function idbRecord(chunkCount: number, dim: number, bytesOverride?: number) {
  const bytes = bytesOverride ?? chunkCount * dim * 4;
  return {
    chunkCount, dim,
    vectorsBuffer: new ArrayBuffer(bytes),
    chunks: Array.from({ length: chunkCount }, (_, i) => ({ id: `k${i}`, content: `正文${i}`, chapterIndex: i })),
  };
}
/** 从内存命中那一格读回向量坐标：init 之后实例上的 dim 就是缓存里那份 */
async function initOnce(novelId: string, onProgress?: (p: EmbeddingProgress) => void) {
  const r = new m.EmbeddingRetriever(ENGINE);
  await r.init(novelId, [], onProgress);
  return r;
}

beforeEach(async () => {
  vi.resetModules();
  m = await import("../embedding-retriever");
  ({ useRAGStore } = await import("@/stores/rag-store"));
  ({ useBuildStore } = await import("@/stores/build-store"));
  s.dbGet.mockResolvedValue(undefined);
  s.dbDelete.mockResolvedValue(undefined);
  s.apiFetch.mockReset();
  s.buildAndPoll.mockReset();
  s.downloadIndex.mockReset();
  s.encodeWorker.mockReset();
  s.access.mockReset();
  s.logs.length = 0;
  useBuildStore.setState({ builds: new Map() });
});

afterEach(() => {
  addedKeys.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("内存 LRU 的账", () => {
  it("尺寸按「条数 × dim × 4 字节」算：多算一字节就误踢，少算一字节就漏踢", () => {
    // 门槛 = 100MB。先垫到差 16 字节，再放一条 2×dim4（= 32 字节）的真向量条目 → 越过门槛
    put("垫场", 0, 4, 100 * MB - 16);
    expect(m.lruHas("垫场"), "垫场本身没越线，不该被踢").toBe(true);
    put("真向量条目", 2, 4);
    expect(m.lruHas("垫场"), "越过 100MB 之后最老那档必须被踢掉").toBe(false);
    expect(m.lruHas("真向量条目"), "刚放的这条不该马上被踢").toBe(true);
  });

  it("恰好等于 100MB 不算越线（是 > 不是 ≥）", () => {
    put("垫场", 0, 4, 100 * MB - 32);
    put("补满", 2, 4);
    expect(m.lruHas("垫场"), "总量正好 100MB 时一格都不该掉").toBe(true);
    expect(m.lruHas("补满")).toBe(true);
  });

  it("同一个键重复登记不许把旧尺寸留着——留着会凭空挤出 60MB 的淘汰", () => {
    const seen: string[] = [];
    const off = m.onLRUEvict((k) => seen.push(k));
    put("同一本书", 0, 4, 60 * MB);
    put("同一本书", 0, 4, 60 * MB);
    expect(m.lruHas("同一本书"), "覆盖登记不该把自己挤出去").toBe(true);
    expect(seen, "没有新增条目，就不该有任何淘汰通知").toEqual([]);
    off();
  });

  it("向量之外的驻留内存要算进账：TF-IDF 那类（vectors 为空）不记账的话 100MB 上限形同虚设", () => {
    put("垫场", 0, 4, 100 * MB - 63);
    // index.ts 就是这么调的：lruAdd(key, [], chunks, dim, chunks.length * dim * 8)
    put("TF-IDF", 0, 4, 2 * 4 * 8);
    expect(m.lruHas("垫场"), "TF-IDF 条目按 Float64 真实占额，越线就该挤出最老那档").toBe(false);
  });

  it("删除要把尺寸一并减掉：只删不清账，下一格会被凭空挤出去", () => {
    put("垫场", 0, 4, 100 * MB - 32);
    put("小条目", 2, 4);
    m.lruDelete("垫场");
    addedKeys.splice(addedKeys.indexOf("垫场"), 1);
    put("再来一格", 2, 4);
    expect(m.lruHas("小条目"), "垫场已经删掉了，账就该是空的，这条不该被挤").toBe(true);
  });

  it("淘汰按到达顺序踢最老的，且每踢一只都要把键报给监听者", () => {
    const seen: string[] = [];
    const off = m.onLRUEvict((k) => seen.push(k));
    put("甲", 0, 4, 50 * MB - 8);
    put("乙", 0, 4, 50 * MB - 8);
    put("丙", 0, 4, 16);
    expect(seen, "甲+乙 还差 16 字节到门槛，丙补上正好不满").toEqual([]);
    put("丁", 0, 4, 8);
    expect(seen, "越过门槛要报键，门面（index.ts）靠这一发清掉自己那份引用").toEqual(["甲"]);
    off();
    put("戊", 0, 4, 100 * MB);
    expect(seen.length, "退订之后不该再收到通知").toBe(1);
  });
});

describe("init：内存 → IndexedDB → 服务器状态 → 触发构建", () => {
  it("内存里已经有就直接用：不读 IDB、不发请求，但要说一声 done", async () => {
    put(`书A-${ENGINE}`, 2, 4);
    const seen: EmbeddingProgress[] = [];
    const r = await initOnce("书A", (p) => seen.push(p));
    expect(s.dbGet).not.toHaveBeenCalled();
    expect(s.apiFetch).not.toHaveBeenCalled();
    expect(r.vectorDim, "向量要用缓存里那份，不是空实例").toBe(4);
    expect(r.chunkCount).toBe(2);
    expect(seen.map((p) => p.phase)).toEqual(["done"]);
  });

  it("内存命中要把这一档挪回队尾：热数据不许最先被踢", async () => {
    // 顺序摆成 乙→甲，再走一次真·内存命中（init 里那段 delete + set）。之后垫一条大的把
    // 最老的顶出去：刷了新鲜度先踢甲，没刷就先踢乙。
    put(`乙-${ENGINE}`, 2, 4);
    put("甲", 0, 4, 8);
    const evicted: string[] = [];
    const off = m.onLRUEvict((k) => { evicted.push(k); });
    await initOnce("乙");
    expect(s.dbGet, "这一格判的是内存命中那条路，别掉进 IDB").not.toHaveBeenCalled();
    put("垫场", 0, 4, 100 * MB);
    expect(evicted[0], "命中过的乙比甲年轻，先被踢的应该是甲").toBe("甲");
    off();
  });

  it("IDB 里有完整索引：零拷贝装上、认成已缓存、并进内存账、记一次访问时间", async () => {
    s.dbGet.mockResolvedValue(idbRecord(3, 8));
    const seen: EmbeddingProgress[] = [];
    const r = await initOnce("书B", (p) => seen.push(p));
    expect(r.chunkCount).toBe(3);
    expect(r.vectorDim).toBe(8);
    expect(s.access, "访问记录要更新，智能淘汰策略靠它").toHaveBeenCalledWith("书B", ENGINE);
    expect(useRAGStore.getState().cachedKeys.has("书B-" + ENGINE), "界面那格「已缓存」要看这个集合").toBe(true);
    expect(m.lruHas("书B-" + ENGINE), "读出来的那份要并进内存账，否则下次还得再读一遍 IDB").toBe(true);
    addedKeys.push("书B-" + ENGINE);
    expect(seen.map((p) => p.phase), "读盘之前要先报 loading，界面那格才不会像是卡住").toEqual(["loading", "done"]);
  });

  it("IDB 里字节数对不上就是坏了：删掉那条并继续往服务器走，不许就地停下", async () => {
    s.dbGet.mockResolvedValue(idbRecord(3, 8, 3 * 8 * 4 - 4));
    s.apiFetch.mockResolvedValue(jsonFail(503));
    const seen: EmbeddingProgress[] = [];
    const r = await initOnce("书C", (p) => seen.push(p));
    expect(s.dbDelete).toHaveBeenCalledWith("书C-" + ENGINE);
    expect(s.apiFetch, "坏了不是 return 的理由，得去服务器要一份").toHaveBeenCalled();
    expect(r.chunkCount, "坏缓存不该装出半套索引").toBe(0);
    expect(seen.map((p) => p.phase), "拿不到就不许报 done").toEqual(["loading"]);
  });

  it("服务器状态查询失败就停：不去构建、不去下载，也不报 done", async () => {
    s.apiFetch.mockResolvedValue(jsonFail(500));
    const seen: EmbeddingProgress[] = [];
    await initOnce("书D", (p) => seen.push(p));
    expect(s.buildAndPoll, "查不到状态不等于要构建").not.toHaveBeenCalled();
    expect(s.downloadIndex).not.toHaveBeenCalled();
    expect(useBuildStore.getState().getBuildStatus("书D", ENGINE), "状态窗口不该被点亮").toBeUndefined();
    expect(seen.map((p) => p.phase)).toEqual(["loading"]);
  });

  it("服务器说已就绪：下载 + 回读 IDB + 记进内存账，全程不许碰构建", async () => {
    s.apiFetch.mockResolvedValue(jsonOk({ status: "ready" }));
    s.downloadIndex.mockImplementation(async () => { s.dbGet.mockResolvedValue(idbRecord(2, 4)); });
    const seen: EmbeddingProgress[] = [];
    const r = await initOnce("书E", (p) => seen.push(p));
    expect(s.buildAndPoll).not.toHaveBeenCalled();
    expect(r.chunkCount).toBe(2);
    expect(m.lruHas("书E-" + ENGINE)).toBe(true);
    addedKeys.push("书E-" + ENGINE);
    expect(seen.map((p) => p.phase)).toEqual(["loading", "done"]);
  });

  it("要现场构建时：buildStore 三发都得收到（书架那个状态窗口靠它收尾）", async () => {
    s.apiFetch.mockResolvedValue(jsonOk({ status: "building" }));
    s.buildAndPoll.mockImplementation(async ({ onProgress }: { onProgress: (p: { status: string; message?: string; current?: number; total?: number }) => void }) => {
      onProgress({ status: "encoding", message: "编码中", current: 5, total: 10 });
      onProgress({ status: "other", current: 9, total: 10 });
    });
    s.downloadIndex.mockImplementation(async () => { s.dbGet.mockResolvedValue(idbRecord(1, 4)); });
    const seen: EmbeddingProgress[] = [];
    await initOnce("书F", (p) => seen.push(p));
    const st = useBuildStore.getState().getBuildStatus("书F", ENGINE);
    expect(st?.status, "构建完要收口，否则按钮永久禁着").toBe("done");
    expect(s.buildAndPoll).toHaveBeenCalledWith({ novelId: "书F", engine: ENGINE, onProgress: expect.any(Function) });
    expect(seen.map((p) => p.phase)).toEqual(["loading", "encoding", "loading", "done"]);
    expect(seen[1], "编码阶段要把 current/total 一起递出去，界面那格进度条要看").toEqual({ phase: "encoding", current: 5, total: 10 });
  });

  it("构建失败：把原因交给 buildStore 并就地收住——init 不许抛，也不许报 done", async () => {
    s.apiFetch.mockResolvedValue(jsonOk({ status: "building" }));
    s.buildAndPoll.mockRejectedValue(new Error("磁盘满了"));
    const seen: EmbeddingProgress[] = [];
    await expect(initOnce("书G", (p) => seen.push(p))).resolves.toBeInstanceOf(m.EmbeddingRetriever);
    const st = useBuildStore.getState().getBuildStatus("书G", ENGINE);
    expect(st?.status).toBe("error");
    expect(st?.error, "书架上那句红字就是这里来的").toBe("磁盘满了");
    expect(seen.map((p) => p.phase), "失败了还报 done，界面会转成「可以检索了」").toEqual(["loading"]);
  });

  it("构建失败但原因不是 Error：拿不到句子也要留个占位，不许写 undefined", async () => {
    s.apiFetch.mockResolvedValue(jsonOk({ status: "building" }));
    s.buildAndPoll.mockRejectedValue("字符串而已");
    await initOnce("书H");
    expect(useBuildStore.getState().getBuildStatus("书H", ENGINE)?.error).toBe("构建失败");
  });
});

describe("search：编码回退链与打分", () => {
  /** 三条向量：与查询 [1,0] 的点积分别是 3 / 1 / -2 */
  function retrieverForSearch() {
    const chunks: Chunk[] = [{ id: "a", content: "甲" }, { id: "b", content: "乙" }, { id: "c", content: "丙" }];
    const r = m.EmbeddingRetriever.fromData({
      vectors: [[3, 0], [1, 0], [-2, 0]], chunks, dim: 2,
    }, ENGINE);
    return r;
  }

  it("一条向量都没有就直接空手回来：连编码都不发起", async () => {
    // 样本刻意是「有维度、零条向量」：空实例那种（dim 也是 0）会先被下面那道一致性闸拦下，
    // 这一道摘掉就没有任何观察后果——两道门槛叠着时，宽的那道必须单独喂一个只有它说话的取值。
    const r = m.EmbeddingRetriever.fromData({ vectors: [], chunks: [], dim: 512 }, ENGINE);
    expect(r.isConsistent(), "这一发要越过一致性闸，才算到空索引这一道").toBe(true);
    expect(await r.search("随便")).toEqual([]);
    expect(s.apiFetch).not.toHaveBeenCalled();
    expect(s.encodeWorker).not.toHaveBeenCalled();
  });

  it("向量数与 chunk 数不一致时不检索：宁可空手，也不产出 NaN 分数", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = m.EmbeddingRetriever.fromData({ vectors: [[1, 0], [2, 0]], chunks: [{ id: "a", content: "甲" }], dim: 2 }, ENGINE);
    expect(await r.search("查")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 个 chunk 对应 2 条向量"));
    expect(s.encodeWorker, "不一致就别再花钱编码了").not.toHaveBeenCalled();
  });

  it("已经取消掉的查询不发起编码", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = retrieverForSearch();
    s.apiFetch.mockResolvedValue(jsonOk({ vectors: [[1, 0]] }));
    expect(await r.search("查", 15, { signal: ctrl.signal })).toEqual([]);
    expect(s.apiFetch).not.toHaveBeenCalled();
  });

  it("服务端编码成功就用它，不再起浏览器端 Worker（同一发查询不许算两遍）", async () => {
    s.apiFetch.mockResolvedValue(jsonOk({ vectors: [[1, 0]] }));
    const r = retrieverForSearch();
    const hits = await r.search("查");
    expect(s.encodeWorker, "服务端已经给出向量了").not.toHaveBeenCalled();
    expect(hits.map((h) => h.chunk.id), "点积 3 / 1 / -2").toEqual(["a", "b", "c"]);
    expect(hits[0].score).toBeCloseTo(3);
    expect(s.apiFetch).toHaveBeenCalledWith("/api/rag/encode", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ texts: ["查"], engine: ENGINE }),
    }));
  });

  it("服务端不行（含引擎不在白名单的 400）就退到浏览器 Worker：400 带回来的向量也不许用", async () => {
    // 样本故意给一份"能用"的向量：只判 `!resp.ok` 那一格有没有参与，靠的是这里两份向量
    // 打出来的顺序不同——把 ok 检查摘掉，服务端那份 [0,1] 会被拿去点积，三条全 0 分。
    s.apiFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ vectors: [[0, 1]] }) });
    s.encodeWorker.mockResolvedValue(new Float32Array([1, 0]));
    const r = retrieverForSearch();
    const hits = await r.search("查");
    expect(s.encodeWorker, "服务端 400 之后必须换本地这条腿").toHaveBeenCalled();
    expect(s.encodeWorker, "本地这条腿也得带着当前引擎，不许偷偷换成默认模型").toHaveBeenCalledWith(
      "查", ENGINE, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(hits.map((h) => h.chunk.id), "用的得是 Worker 那份 [1,0]：点积 3/1/-2").toEqual(["a", "b", "c"]);
  });

  it("编码跑到一半被取消：第二发不许再发起，直接空手回来", async () => {
    const ctrl = new AbortController();
    s.apiFetch.mockImplementation((_path: string, init?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("AbortError"); e.name = "AbortError"; rej(e);
        });
      }));
    const p = retrieverForSearch().search("查", 15, { signal: ctrl.signal });
    await vi.waitFor(() => expect(s.apiFetch).toHaveBeenCalled());
    ctrl.abort();
    expect(await p).toEqual([]);
    expect(s.encodeWorker, "人都走了，不该再去起 Worker").not.toHaveBeenCalled();
    expect(s.logs.some((m) => m.includes("查询已取消")), "取消那一发要说清是取消，不是失败").toBe(true);
  });

  it("服务端回了个不像样的形状也退回 Worker：不许拿 undefined 去点积", async () => {
    s.apiFetch.mockResolvedValue(jsonOk({ vectors: [] }));
    s.encodeWorker.mockResolvedValue(new Float32Array([1, 0]));
    const hits = await retrieverForSearch().search("查");
    expect(s.encodeWorker).toHaveBeenCalled();
    expect(hits.map((h) => h.chunk.id)).toEqual(["a", "b", "c"]);
  });

  it("两条腿都失败：空手回来并说明原因，不许把异常抛给检索链", async () => {
    s.apiFetch.mockRejectedValue(new Error("网络断了"));
    s.encodeWorker.mockResolvedValue(null);
    const r = retrieverForSearch();
    expect(await r.search("查")).toEqual([]);
    expect(s.logs.some((m) => m.includes("查询编码失败")), "日志里要留下那句「返回空」").toBe(true);
  });

  it("编码回来的维度与索引不符就放弃：不同模型的向量点积没有意义", async () => {
    s.apiFetch.mockResolvedValue(jsonOk({ vectors: [[1, 0, 0, 0]] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await retrieverForSearch().search("查")).toEqual([]);
    expect(s.logs.some((m) => m.includes("维度不匹配: 期望 2, 实际 4"))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("topK 只截尾巴，不改变顺序", async () => {
    s.apiFetch.mockResolvedValue(jsonOk({ vectors: [[1, 0]] }));
    const hits = await retrieverForSearch().search("查", 2);
    expect(hits.map((h) => h.chunk.id)).toEqual(["a", "b"]);
  });

  it("Worker 挂住不放：60 秒看门狗到点必须放人（R-30）", async () => {
    vi.useFakeTimers();
    s.apiFetch.mockResolvedValue(jsonFail(400)); // 服务端这条腿当场让开
    s.encodeWorker.mockImplementation((_t: string, _e: string, opts?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        opts?.signal?.addEventListener("abort", () => {
          const e = new Error("AbortError"); e.name = "AbortError"; rej(e);
        });
      }));
    const p = retrieverForSearch().search("查");
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(settled, "60 秒还没到，检索不该先回来").toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await p, "到点要放人，返回空而不是永久吊着").toEqual([]);
    expect(s.logs.some((m) => m.includes("查询编码失败")), "放人之后那句「返回空」要留在日志里").toBe(true);
  });
});

describe("索引本体的几个小决定", () => {
  it("loadFromBuffer 是视图不是拷贝：改缓冲里的字节，向量要跟着变", () => {
    const buf = new ArrayBuffer(2 * 4 * 4);
    new Float32Array(buf).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const r = m.EmbeddingRetriever.fromArrayBuffer(buf, [{ id: "a", content: "甲" }, { id: "b", content: "乙" }], 4, ENGINE);
    expect(Array.from(r.vectors[1])).toEqual([5, 6, 7, 8]);
    new Float32Array(buf)[0] = 99;
    expect(r.vectors[0][0], "零拷贝的意思就是共享同一块内存；改成 slice 拷贝的话 100MB 那道闸就量不到真身").toBe(99);
  });

  it("存出去再读回来：向量、chunk、维度三样都得原样", () => {
    const r = m.EmbeddingRetriever.fromData({ vectors: [[1.5, 0]], chunks: [{ id: "z", content: "丙" }], dim: 2 }, ENGINE);
    const data = r.toData();
    expect(data.vectors).toEqual([[1.5, 0]]);
    const back = m.EmbeddingRetriever.fromData(data, "别的模型");
    expect(Array.from(back.vectors[0])).toEqual([1.5, 0]);
    expect(back.vectorDim).toBe(2);
    expect(back.chunkCount).toBe(1);
  });

  it("范围过滤的前提：有一条带章节号才算「带章节索引」", () => {
    const withIdx = m.EmbeddingRetriever.fromData({
      vectors: [[1, 0], [0, 1]],
      chunks: [{ id: "a", content: "甲" }, { id: "b", content: "乙", chapterIndex: 3 }], dim: 2,
    }, ENGINE);
    expect(withIdx.supportsChapterRange()).toBe(true);
    const without = m.EmbeddingRetriever.fromData({
      vectors: [[1, 0]], chunks: [{ id: "a", content: "甲", chapterIndex: undefined }], dim: 2,
    }, ENGINE);
    expect(without.supportsChapterRange(), "全 undefined 不算带索引（那是老数据）").toBe(false);
  });

  it("完整性判据认 dim > 0：光数量对上而维度是 0 也是废的", () => {
    const ok = m.EmbeddingRetriever.fromData({ vectors: [[1, 0]], chunks: [{ id: "a", content: "甲" }], dim: 2 }, ENGINE);
    expect(ok.isConsistent()).toBe(true);
    const zeroDim = m.EmbeddingRetriever.fromData({ vectors: [[1, 0]], chunks: [{ id: "a", content: "甲" }], dim: 0 }, ENGINE);
    expect(zeroDim.isConsistent()).toBe(false);
    const short = m.EmbeddingRetriever.fromData({
      vectors: [[1, 0], [0, 1]], chunks: [{ id: "a", content: "甲" }], dim: 2,
    }, ENGINE);
    expect(short.isConsistent()).toBe(false);
  });

  it("dispose 之后要变回「空手」，而不是留着半截向量", () => {
    const r = m.EmbeddingRetriever.fromData({ vectors: [[1, 0]], chunks: [{ id: "a", content: "甲" }], dim: 2 }, ENGINE);
    r.dispose();
    expect(r.chunkCount).toBe(0);
    expect(r.vectorDim).toBe(0);
    expect(r.vectors).toEqual([]);
  });
});
