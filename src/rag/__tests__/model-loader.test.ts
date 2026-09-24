/**
 * `src/rag/model-loader.ts`：模型能不能拿到、拿没拿重复、假账清没清。
 *
 * 为什么要单独钉：这只 464 行的文件是 2026-06 以来被改动最多的一只（40 笔），而
 * **每一个用它的测试文件都把它整只桩掉**（`RAGSettings`、`BookSelect-shelf`、
 * `AppLayout-shell`、`storage-stats` 各一份 `vi.mock`，共 6 处），于是"改坏了会不会有
 * 东西红"这一问从来没被答过。这里用真的 `rag-store`（下载标记与进度都由它持有），
 * 只桩三样外部边界：`@xenova/transformers`、后端地址来源、跨标签页广播。
 *
 * 浏览器层已有的不重复钉：D9/D12/D13 判的是「清理」按钮到 `clearAllModelCache` 那条接线
 * 与清完重算；这里判的是接线背后那些一发按钮点不出来的决定。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MODEL_A = "Xenova/bge-small-zh-v1.5";
const MODEL_B = "Xenova/gte-small";
const MODEL_C = "Xenova/multilingual-e5-small";
const SERVER = "https://backend.invalid";

/** 每一次 tokenizer / model 请求都记在这儿，用例自己决定成功还是抛 */
const h = {
  serverUrl: SERVER as string,
  env: {} as Record<string, unknown>,
  tok: vi.fn<(key: string, opts?: { progress_callback?: (d: unknown) => void }) => Promise<void>>(),
  model: vi.fn<(key: string, opts?: { progress_callback?: (d: unknown) => void }) => Promise<void>>(),
};

vi.mock("@xenova/transformers", () => ({
  AutoTokenizer: { from_pretrained: (k: string, o: { progress_callback?: (d: unknown) => void }) => h.tok(k, o) },
  AutoModel: { from_pretrained: (k: string, o: { progress_callback?: (d: unknown) => void }) => h.model(k, o) },
  env: h.env,
}));
vi.mock("@/lib/api-client", () => ({ getEffectiveServerUrl: () => h.serverUrl }));
/**
 * `vi.hoisted` 拿到 spy 本体，而不是在用例里 `await import("@/lib/broadcast")` 再取
 * `.mock`：那样 `send` 的类型是真签名，tsc 判 `.mock` 不存在（实测三条红）。
 */
const { sendSpy } = vi.hoisted(() => ({ sendSpy: vi.fn() }));
vi.mock("@/lib/broadcast", () => ({ broadcast: { send: sendSpy } }));

type Store = typeof import("../../stores/rag-store").useRAGStore;

/**
 * 每例重新加载一次：`downloadQueue` / `isDownloading` / `downloadWaiters` 都是模块级状态，
 * 上一例留在里面的东西会把这一例的排队判据搅浑。
 */
async function boot(): Promise<{ loader: typeof import("../model-loader"); store: Store }> {
  vi.resetModules();
  const loader = await import("../model-loader");
  const { useRAGStore } = await import("../../stores/rag-store");
  useRAGStore.setState({
    downloadedModels: new Set<string>(),
    savedCustomModels: [],
    currentDownload: null,
    downloadProgress: "",
    engine: MODEL_A,
  });
  return { loader, store: useRAGStore };
}

/** 喂 transformers.js 实际会发的那几种帧：半程 → 跑满 → done */
function emitFrames(cb: ((d: unknown) => void) | undefined, file: string): void {
  cb?.({ status: "progress", file, loaded: 1024 * 1024, total: 4 * 1024 * 1024 });
  cb?.({ status: "progress", file, loaded: 4 * 1024 * 1024, total: 4 * 1024 * 1024 });
  cb?.({ status: "done", file });
}

/** 一次成功的下载：tokenizer 与模型各报一轮进度 */
function succeed(): void {
  h.tok.mockImplementation(async (_key, opts) => emitFrames(opts?.progress_callback, "tokenizer.json"));
  h.model.mockImplementation(async (_key, opts) => emitFrames(opts?.progress_callback, "model.onnx"));
}

const progressOf = (store: Store): string => store.getState().downloadProgress;

/**
 * 记下进度那一格依次出现过哪些字。**必须订阅着看**：收尾会无条件清空一次
 * （`:236`），只读最终值等于什么都看不到——失败那半句"下载失败"写下去紧跟着就被抹了。
 */
function watchProgress(store: Store): string[] {
  const ladder: string[] = [];
  store.subscribe((s) => ladder.push(s.downloadProgress));
  return ladder;
}

describe("下载那趟的排他", () => {
  it("已经标过下载的模型：一个请求都不发，直接回 true", async () => {
    const { loader, store } = await boot();
    store.getState().addDownloadedModel(MODEL_A);

    await expect(loader.downloadModel(MODEL_A)).resolves.toBe(true);
    expect(h.tok).not.toHaveBeenCalled();
    expect(h.model).not.toHaveBeenCalled();
  });

  it("同一个模型并发第二次：只下一趟，第二个人拿同一份结果", async () => {
    const { loader } = await boot();
    succeed();

    const first = loader.downloadModel(MODEL_A);
    const second = loader.downloadModel(MODEL_A);
    await vi.runAllTimersAsync();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(h.tok).toHaveBeenCalledTimes(1);
    expect(h.model).toHaveBeenCalledTimes(1);
  });

  it("那一趟失败了：等待者也要收到 false，不许让它永远等下去", async () => {
    const { loader } = await boot();
    h.tok.mockRejectedValue(new Error("404 not found"));
    h.model.mockRejectedValue(new Error("404 not found"));

    const first = loader.downloadModel(MODEL_A);
    const second = loader.downloadModel(MODEL_A);
    await vi.runAllTimersAsync();

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
  });

  it("三本不同模型并发：一次只下一本，排队的按到达顺序先来后到", async () => {
    const { loader } = await boot();
    const order: string[] = [];
    h.tok.mockImplementation(async (key) => { order.push(`tok:${key}`); });
    h.model.mockImplementation(async (key) => { order.push(`model:${key}`); });

    const a = loader.downloadModel(MODEL_A);
    const b = loader.downloadModel(MODEL_B);
    // C 必须排在 B 之后：两本排队时 push 与 unshift 结果相同，判不出先来后到，
    // 所以第三本才是这一格真正的判点（`insert-at-head` 那刀只有三本才咬得到）。
    const c = loader.downloadModel(MODEL_C);
    await vi.runAllTimersAsync();

    await expect(Promise.all([a, b, c])).resolves.toEqual([true, true, true]);
    expect(order).toEqual([
      `tok:${MODEL_A}`, `model:${MODEL_A}`,
      `tok:${MODEL_B}`, `model:${MODEL_B}`,
      `tok:${MODEL_C}`, `model:${MODEL_C}`,
    ]);
  });
});

describe("从哪儿拿、拿到什么终态", () => {
  it("模型一律从后端代理拿：remoteHost 必须是那条代理路径", async () => {
    const { loader } = await boot();
    succeed();

    await expect(loader.downloadModel(MODEL_A)).resolves.toBe(true);
    expect(h.env.remoteHost).toBe(`${SERVER}/api/rag/model-proxy`);
    expect(h.env.allowRemoteModels).toBe(true);
  });

  it("没配服务器地址：当场失败、一发都不往厂商发，也不许停在中间态", async () => {
    const { loader, store } = await boot();
    const ladder = watchProgress(store);
    h.serverUrl = "";
    succeed();

    const p = loader.downloadModel(MODEL_A);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(false);
    expect(h.tok).not.toHaveBeenCalled();
    expect(ladder, "没地址就不该已经开始下 tokenizer").not.toContain("下载 tokenizer...");
    expect(ladder.at(-1), "那一格不能停在「重试中」").toBe("");
  });

  it("收尾要归零：进度清空、让出「正在下载」那一格", async () => {
    const { loader, store } = await boot();
    succeed();

    await expect(loader.downloadModel(MODEL_A)).resolves.toBe(true);
    expect(progressOf(store)).toBe("");
    expect(store.getState().currentDownload, "不清的话下一次开面板还以为在下载").toBeNull();
  });

  it("进度文案的两格：没跑完是 `1.0/4MB`，跑满是 `✓`", async () => {
    const { loader, store } = await boot();
    const seen: string[] = [];
    h.tok.mockImplementation(async (_key, opts) => {
      const cb = opts?.progress_callback;
      cb?.({ status: "progress", file: "tokenizer.json", loaded: 1024 * 1024, total: 4 * 1024 * 1024 });
      seen.push(progressOf(store));
      cb?.({ status: "progress", file: "tokenizer.json", loaded: 4 * 1024 * 1024, total: 4 * 1024 * 1024 });
      seen.push(progressOf(store));
    });
    h.model.mockResolvedValue(undefined);

    await loader.downloadModel(MODEL_A);
    expect(seen).toEqual(["tokenizer 1.0/4MB", "tokenizer ✓"]);
  });

  it("三次都失败才判失败：每一趟都要把「第几次」写在进度上", async () => {
    const { loader, store } = await boot();
    const ladder = watchProgress(store);
    h.tok.mockRejectedValue(new Error("网络断了"));

    const p = loader.downloadModel(MODEL_A);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(false);
    expect(h.tok).toHaveBeenCalledTimes(3);
    expect(ladder.filter((x) => x.startsWith("下载中 ("))).toEqual([
      "下载中 (1/3)...",
      "下载中 (2/3)...",
      "下载中 (3/3)...",
    ]);
    expect(ladder).toContain("下载失败");
    expect(ladder.at(-1)).toBe("");
  });

  it("只有真下成了才广播给别的标签页", async () => {
    const { loader } = await boot();
    const before = sendSpy.mock.calls.length;
    h.tok.mockRejectedValue(new Error("炸了"));
    const failed = loader.downloadModel(MODEL_A);
    await vi.runAllTimersAsync();
    await expect(failed).resolves.toBe(false);
    expect(sendSpy.mock.calls.length, "没下成却广播＝别的标签页以为可以建库了").toBe(before);

    succeed();
    const ok = loader.downloadModel(MODEL_A);
    await vi.runAllTimersAsync();
    await expect(ok).resolves.toBe(true);
    expect(sendSpy.mock.calls.slice(before)).toEqual([["model-download-complete"]]);
  });
});

/** 一只够用的假 Cache Storage：只实现 model-loader 用到的那三个方法 */
function fakeCache(initial: Record<string, number>): { cache: unknown; removed: string[] } {
  const entries = new Map(Object.entries(initial));
  const removed: string[] = [];
  return {
    removed,
    cache: {
      async keys() {
        return [...entries.keys()].map((url) => ({ url }));
      },
      async match(req: { url: string }) {
        const bytes = entries.get(req.url);
        if (bytes === undefined) return undefined;
        return { headers: { get: (name: string) => (name === "content-length" ? String(bytes) : null) } };
      },
      async delete(req: { url: string }) {
        if (!entries.has(req.url)) return false;
        entries.delete(req.url);
        removed.push(req.url);
        return true;
      },
    },
  };
}

let cachesInstalled = false;

function installCaches(cache: unknown): void {
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { open: async () => cache } });
  cachesInstalled = true;
}

beforeEach(() => {
  h.serverUrl = SERVER;
  // 就地清，不换对象：mock 工厂只跑一次，`env: h.env` 传的是当时那一份引用
  for (const k of Object.keys(h.env)) delete h.env[k];
  h.tok = vi.fn();
  h.model = vi.fn();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (cachesInstalled) {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: undefined });
    cachesInstalled = false;
  }
});

describe("下载标记与实际缓存的账", () => {
  it("用户自己存的模型算已知，剩下的才进孤儿账（条数与字节都要对）", async () => {
    const { loader, store } = await boot();
    useSaved(store, ["my-org/my-tiny"]);
    installCaches(
      fakeCache({
        [`https://x/api/rag/model-proxy/${MODEL_A}/tokenizer.json`]: 1000,
        "https://x/api/rag/model-proxy/my-org/my-tiny/model.onnx": 2000,
        "https://x/api/rag/model-proxy/someone-else/stray/onnx": 3000,
      }).cache,
    );

    const info = await loader.getTransformersCacheInfo();
    expect([...info.modelFiles.keys()].sort()).toEqual([MODEL_A, "my-org/my-tiny"]);
    expect(info.modelFiles.get(MODEL_A)).toEqual({ count: 1, bytes: 1000 });
    expect(info.orphanCount, "自加的模型被算成孤儿，用户就成了'删不掉的垃圾'").toBe(1);
    expect(info.orphanBytes).toBe(3000);
  });

  it("标了下载但缓存里没文件：摘标记并回列表；缓存里有的一个都不许动", async () => {
    const { loader, store } = await boot();
    store.getState().addDownloadedModel(MODEL_A);
    store.getState().addDownloadedModel(MODEL_B);
    installCaches(fakeCache({ [`https://x/api/rag/model-proxy/${MODEL_A}/model.onnx`]: 10 }).cache);

    await expect(loader.verifyDownloadedModels()).resolves.toEqual([MODEL_B]);
    expect(store.getState().downloadedModels.has(MODEL_A), "真有缓存的那本不许被对账误删").toBe(true);
    expect(store.getState().downloadedModels.has(MODEL_B)).toBe(false);
  });

  it("一条标记都没有时对账直接空手回来，一次都不开缓存", async () => {
    const { loader } = await boot();
    const open = vi.fn();
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { open } });
    cachesInstalled = true;

    await expect(loader.verifyDownloadedModels()).resolves.toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it("deleteModelCache：只删这一本的条目、报删掉的条数，别的引擎的文件一个都不许多碰", async () => {
    const { loader, store } = await boot();
    store.getState().addDownloadedModel(MODEL_A);
    const c = fakeCache({
      [`https://x/api/rag/model-proxy/${MODEL_A}/tokenizer.json`]: 1,
      [`https://x/api/rag/model-proxy/${MODEL_A}/model.onnx`]: 2,
      [`https://x/api/rag/model-proxy/${MODEL_B}/model.onnx`]: 3,
    });
    installCaches(c.cache);

    await expect(loader.deleteModelCache(MODEL_A)).resolves.toBe(2);
    expect(c.removed.sort()).toEqual([
      `https://x/api/rag/model-proxy/${MODEL_A}/model.onnx`,
      `https://x/api/rag/model-proxy/${MODEL_A}/tokenizer.json`,
    ]);
    expect(store.getState().downloadedModels.has(MODEL_A), "文件没了标记还留着＝面板假账").toBe(false);
  });

  it("整只清空要把孤儿也算进删除数，并把全部下载标记一起清掉", async () => {
    const { loader, store } = await boot();
    store.getState().addDownloadedModel(MODEL_A);
    const c = fakeCache({
      [`https://x/api/rag/model-proxy/${MODEL_A}/model.onnx`]: 1,
      "https://x/api/rag/model-proxy/stray/onnx": 2,
    });
    installCaches(c.cache);

    await expect(loader.clearAllModelCache()).resolves.toBe(2);
    expect([...store.getState().downloadedModels]).toEqual([]);
  });

  it("降级清理只动别的引擎：当前引擎与默认引擎都得留着", async () => {
    const { loader, store } = await boot();
    store.getState().addDownloadedModel(MODEL_A);
    store.getState().addDownloadedModel(MODEL_B);
    store.getState().addDownloadedModel("Xenova/gte-large");
    store.setState({ engine: "Xenova/gte-large" });
    const c = fakeCache({
      [`https://x/api/rag/model-proxy/${MODEL_A}/model.onnx`]: 1,
      [`https://x/api/rag/model-proxy/${MODEL_B}/model.onnx`]: 2,
      "https://x/api/rag/model-proxy/Xenova/gte-large/model.onnx": 3,
    });
    installCaches(c.cache);

    await expect(loader.deleteNonActiveEmbeddingModels()).resolves.toBe(1);
    expect(c.removed).toEqual([`https://x/api/rag/model-proxy/${MODEL_B}/model.onnx`]);
    expect([...store.getState().downloadedModels].sort()).toEqual([MODEL_A, "Xenova/gte-large"].sort());
  });
});

/** 把"用户自己加过的模型"灌进 store（对账与孤儿判定要认它） */
function useSaved(store: Store, keys: string[]): void {
  store.getState().setSavedCustomModels(keys.map((key) => ({ key, name: key, size: "~1 MB" })));
}
