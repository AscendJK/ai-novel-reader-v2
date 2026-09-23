import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BookSelect } from "../BookSelect";
import { useNovelStore } from "@/stores/novel-store";
import { useUIStore } from "@/stores/ui-store";
import { useRAGStore } from "@/stores/rag-store";
import { useBuildStore } from "@/stores/build-store";
import { loadAllNovelMeta, deleteNovel } from "@/db/repositories";
import { apiFetch } from "@/lib/api-client";
import { ensureModelReady } from "@/rag/model-loader";
import { buildAndPollRAGIndex, downloadAndCacheIndex } from "@/rag/build-index";
import { enqueuePendingLeave, clearPendingLeave } from "@/sync/pending-leave";
import type { NovelMeta } from "@/parsers/types";

/**
 * `BookSelect` 里那些**只在组件内部发生**的语义。
 *
 * 浏览器那一档（`e2e/specs/b2-shelf.spec.ts`）钉的是"用户看得见的那一半"：卡片在不在、
 * 按钮能不能点、点完服务器收到几发。它有三件事天生做不到，全在这里补：
 *  1. 读库失败那一条分支（jsdom 里能让 `loadAllNovelMeta` 直接抛，真浏览器没有合法的注入点）；
 *  2. 构建状态轮询往 `build-store` 里映射的那四个分支（服务端回一样状态时浏览器层看不出区别）；
 *  3. 索引"下载→被驱逐→不许再自动下回来"那圈防抖（时间尺度在毫秒，e2e 拿不到）。
 *
 * 桩一律照真接口的形状给：`apiFetch` 回的是 `{ok, json()}` 而不是裸对象，
 * `broadcast.onDataChanged` 回的是 unsubscribe 函数——桩替被测代码把故障补好，
 * 变异就演不出来（这条踩过两次，见记忆里"桩不忠实"那一族）。
 */

const USER = "unit-shelf-user";
const ENGINE = "Xenova/bge-small-zh-v1.5";

function meta(over: Partial<NovelMeta> & { id: string; title: string }): NovelMeta {
  return {
    author: "",
    fileName: `${over.id}.txt`,
    fileFormat: "txt",
    totalChars: 120,
    chapterCount: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    ...over,
  } as NovelMeta;
}

// —— 接缝桩（全部 vi.hoisted 共享，好在每个用例里换剧本）
const { dataChangedCb, evictionCb } = vi.hoisted(() => ({
  dataChangedCb: { current: null as null | (() => void) },
  evictionCb: { current: null as null | ((e: { id: string }[]) => void) },
}));

vi.mock("@/db/repositories", () => ({
  loadAllNovelMeta: vi.fn().mockResolvedValue([]),
  deleteNovel: vi.fn().mockResolvedValue(undefined),
  loadNovel: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/db/database", () => ({
  sharedDB: { ragCache: { toArray: vi.fn().mockResolvedValue([]) } },
  getUserDB: () => ({
    novels: { put: vi.fn().mockResolvedValue(undefined) },
    chapters: { put: vi.fn().mockResolvedValue(undefined) },
    transaction: (_m: string, _t1: unknown, _t2: unknown, fn: () => Promise<void>) => fn(),
  }),
}));

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/broadcast", () => ({
  broadcast: {
    onDataChanged: (cb: () => void) => {
      dataChangedCb.current = cb;
      return () => { dataChangedCb.current = null; };
    },
    send: vi.fn(),
  },
}));

vi.mock("@/rag/model-loader", () => ({ ensureModelReady: vi.fn().mockResolvedValue(true) }));
vi.mock("@/rag/engines", () => ({
  resolveModelKey: () => "Xenova/bge-small-zh-v1.5",
  getEngineDisplayName: (e: string) => e,
}));
vi.mock("@/rag/build-index", () => ({
  buildAndPollRAGIndex: vi.fn().mockResolvedValue(undefined),
  downloadAndCacheIndex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/rag/rag-cache-utils", () => ({
  onCacheEviction: (cb: (e: { id: string }[]) => void) => {
    evictionCb.current = cb;
    return () => { evictionCb.current = null; };
  },
}));
vi.mock("@/sync/pending-leave", () => ({
  enqueuePendingLeave: vi.fn(),
  clearPendingLeave: vi.fn(),
}));
vi.mock("@/hooks/useFileParser", () => ({
  useFileParser: () => ({
    parseFile: vi.fn().mockResolvedValue(null),
    isParsing: false,
    progress: 0,
    warning: undefined,
  }),
}));
vi.mock("@/components/common/NovelBuildWindow", () => ({
  NovelBuildWindow: () => null,
}));

/** 轮询要读到的那一发：`/api/rag/statuses/all` 回 `{ok:true, json()}`。 */
function stubStatuses(statuses: Record<string, Record<string, unknown>>) {
  vi.mocked(apiFetch).mockImplementation(async () =>
    ({ ok: true, status: 200, json: async () => statuses }) as unknown as Response);
}

function freshRows(rows: NovelMeta[]) {
  // 每次返回**新数组**：`mockResolvedValue(同一引用)` 会让 `setSavedNovels` 认成"状态没变"，
  // 于是轮询那条 effect 根本不再重跑——桩把自己的故障补好了，判据就成了空判。
  vi.mocked(loadAllNovelMeta).mockImplementation(async () => rows.map((r) => ({ ...r })));
}

async function rerunShelf() {
  // 借 `data-changed` 那一身重读一次：这是组件自己那条重读路，不重新挂载。
  // 必须等"调用次数真的加一"：首帧已经打过一次，拿 `toHaveBeenCalled()` 当地球人是空等。
  await waitFor(() => expect(dataChangedCb.current).not.toBeNull());
  const before = vi.mocked(loadAllNovelMeta).mock.calls.length;
  dataChangedCb.current!();
  await waitFor(() => expect(vi.mocked(loadAllNovelMeta).mock.calls.length).toBeGreaterThan(before));
  await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sync-username", USER);
  localStorage.setItem("sync-token", "unit-token");
  useNovelStore.setState({ currentNovel: null, novels: [], readingPositions: {} });
  useUIStore.setState({ offlineMode: false });
  useRAGStore.setState({ engine: ENGINE, cachedKeys: new Set(), lruKeys: new Set() });
  useBuildStore.setState({ builds: new Map() });
  vi.mocked(loadAllNovelMeta).mockReset().mockResolvedValue([]);
  vi.mocked(deleteNovel).mockClear();
  vi.mocked(ensureModelReady).mockReset().mockResolvedValue(true);
  const dlResult = { cacheKey: `n1-${ENGINE}`, chunkCount: 3, dim: 512 };
  vi.mocked(buildAndPollRAGIndex).mockReset().mockResolvedValue(dlResult);
  vi.mocked(downloadAndCacheIndex).mockReset().mockResolvedValue(dlResult);
  vi.mocked(apiFetch).mockReset();
  stubStatuses({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BookSelect：书架那一列从哪来", () => {
  it("没登录就不去读库——空书架和「读失败」不能长得一样", async () => {
    localStorage.removeItem("sync-username");
    render(<BookSelect />);
    await new Promise((r) => setTimeout(r, 20));
    expect(loadAllNovelMeta).not.toHaveBeenCalled();
  });

  it("读库失败停在旧列表上：不许把书架刷成空", async () => {
    vi.mocked(loadAllNovelMeta).mockResolvedValueOnce([
      meta({ id: "n1", title: "洛阳旧事", fileName: "luoyang.txt" }),
    ]);
    render(<BookSelect />);
    await screen.findByText("《洛阳旧事》");

    vi.mocked(loadAllNovelMeta).mockRejectedValueOnce(new Error("IDB 炸了"));
    await rerunShelf();
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByText("《洛阳旧事》")).toBeInTheDocument();
  });

  it("排序按「最后一次打开」，最近读过的排最前", async () => {
    localStorage.setItem(
      `novel-reader-last-opened:${USER}`,
      JSON.stringify({ n1: 100, n2: 900 }),
    );
    vi.mocked(loadAllNovelMeta).mockResolvedValue([
      meta({ id: "n1", title: "先建的" }),
      meta({ id: "n2", title: "后读的" }),
    ]);
    render(<BookSelect />);
    await screen.findByText("《后读的》");

    const cards = screen.getAllByText(/^《/).map((el) => el.textContent);
    expect(cards.slice(0, 2)).toEqual(["《后读的》", "《先建的》"]);
  });

  it("搜索框按书名/作者/文件名三个字段都算命中，计数跟着过滤走", async () => {
    vi.mocked(loadAllNovelMeta).mockResolvedValue([
      meta({ id: "n1", title: "内部题名", author: "佚名", fileName: "外来档案.epub", fileFormat: "epub" }),
      meta({ id: "n2", title: "洛阳旧事" }),
    ]);
    render(<BookSelect />);
    await screen.findByText("《内部题名》");

    const box = document.querySelector("#bookshelf-search") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "外来档案" } });
    expect(screen.getByText("《内部题名》")).toBeInTheDocument();
    expect(screen.queryByText("《洛阳旧事》")).toBeNull();
    expect(screen.getByRole("heading", { name: /我的书架/ }).textContent).toContain("1/2");

    fireEvent.change(box, { target: { value: "佚名" } });
    expect(screen.getByText("《内部题名》")).toBeInTheDocument();
  });
});

describe("BookSelect：构建状态那一圈", () => {
  it("模型没下来也要「看得见地失败」——条目必须在门之前就建起来", async () => {
    vi.mocked(loadAllNovelMeta).mockResolvedValue([meta({ id: "n1", title: "洛阳旧事" })]);
    vi.mocked(ensureModelReady).mockResolvedValue(false);
    render(<BookSelect />);
    await screen.findByText("《洛阳旧事》");

    fireEvent.click(screen.getByRole("button", { name: "构建" }));

    await waitFor(() => {
      const entry = useBuildStore.getState().getBuildStatus("n1", ENGINE);
      expect(entry?.status).toBe("error");
      // 原因不能丢：只有"失败"两个字，用户不知道该不该再点一次
      expect(entry?.error).toContain("稍后再点一次构建");
    });
    expect(buildAndPollRAGIndex).not.toHaveBeenCalled();
  });

  /**
   * 真后端上限流那一发是 `ensureModelReady` **自己抛**（`/api/rag/model-proxy` 挂着
   * rateLimit(10)/分钟，实测用户那次取模型会被掐成 429 → fetch 抛错），不是老老实实回 false。
   * 这条单独钉是因为"条目在门之前就建好"这条契约**只有抛出去才量得出来**：
   * 回 false 的话门后面那句 `startBuild` 也来得及建条目，界面照样有失败——变异演不出来。
   */
  it("取模型那一发直接抛（服务端限流）时，卡片仍然要留下失败条目而不是「点了没反应」", async () => {
    vi.mocked(loadAllNovelMeta).mockResolvedValue([meta({ id: "n1", title: "洛阳旧事" })]);
    vi.mocked(ensureModelReady).mockRejectedValue(new Error("429 Too Many Requests"));
    render(<BookSelect />);
    await screen.findByText("《洛阳旧事》");

    fireEvent.click(screen.getByRole("button", { name: "构建" }));

    await waitFor(() => {
      const entry = useBuildStore.getState().getBuildStatus("n1", ENGINE);
      expect(entry, "条目必须已经在 store 里，failBuild 只改已有条目（build-store.ts 那句 if (existing)）").toBeDefined();
      expect(entry?.status).toBe("error");
      expect(entry?.error).toContain("429");
    });
  });

  it("轮询把服务端四种状态映射进 build-store：进行中推进度、ready 收尾、error 带原因", async () => {
    freshRows([meta({ id: "n1", title: "洛阳旧事" })]);
    stubStatuses({ n1: { [ENGINE]: { status: "building", current: 2, total: 5, message: "编码中" } } });
    render(<BookSelect />);
    await screen.findByText("《洛阳旧事》");
    await waitFor(() => {
      const e = useBuildStore.getState().getBuildStatus("n1", ENGINE);
      expect(e?.status).toBe("building");
      expect(e?.current).toBe(2);
      expect(e?.total).toBe(5);
    });

    // 第二轮才是"进度会往前推"那一眼：第一轮走的是"条目还没有"那一支（startBuild + 进度），
    // 只测第一轮的话，"已有条目不再搬进度"这种坏法演不出来（第一版就是这么漏的）。
    stubStatuses({ n1: { [ENGINE]: { status: "building", current: 4, total: 5, message: "编码中" } } });
    await rerunShelf();
    await waitFor(() => expect(useBuildStore.getState().getBuildStatus("n1", ENGINE)?.current).toBe(4));

    stubStatuses({ n1: { [ENGINE]: { status: "ready" } } });
    await rerunShelf();
    // `finishBuild` 是把条目转成 done（3 秒后才关窗口），不是把条目抹掉——
    // 判"还挂着构建中"就够了，别去判"消失"（那是 cleanup 的时限，不在这条契约上）
    await waitFor(() => expect(useBuildStore.getState().getBuildStatus("n1", ENGINE)?.status).toBe("done"));

    stubStatuses({ n1: { [ENGINE]: { status: "error", error: "白名单里没有这只模型" } } });
    await rerunShelf();
    await waitFor(() => {
      const e = useBuildStore.getState().getBuildStatus("n1", ENGINE);
      expect(e?.status).toBe("error");
      expect(e?.error).toContain("白名单");
    });
  });

  it("没有 token 时一轮轮询都不发（离线门那半在 e2e B15 里钉）", async () => {
    localStorage.removeItem("sync-token");
    vi.mocked(loadAllNovelMeta).mockResolvedValue([meta({ id: "n1", title: "洛阳旧事" })]);
    render(<BookSelect />);
    await screen.findByText("《洛阳旧事》");
    await new Promise((r) => setTimeout(r, 20));
    expect(
      vi.mocked(apiFetch).mock.calls.filter((c) => String(c[0]).includes("statuses/all")),
    ).toEqual([]);
  });

  it("服务端 ready 而本地没缓存就自动下索引；被驱逐过的那本不许再自动下回来", async () => {
    freshRows([meta({ id: "n1", title: "洛阳旧事" })]);
    stubStatuses({ n1: { [ENGINE]: { status: "ready" } } });
    render(<BookSelect />);
    await screen.findByText("《洛阳旧事》");
    await waitFor(() => expect(downloadAndCacheIndex).toHaveBeenCalledTimes(1));

    // 驱逐通知进来之后，同一份 ready 再走一轮 effect 也不许重下（否则 下载→驱逐→下载 来回抖）
    evictionCb.current!([{ id: `n1-${ENGINE}` }]);
    await rerunShelf();
    await new Promise((r) => setTimeout(r, 30));
    expect(downloadAndCacheIndex).toHaveBeenCalledTimes(1);
  });
});

describe("BookSelect：删除与 join 那两步", () => {
  it("leave 先记账再发；404 也算送达，不许留着队列反复补发", async () => {
    vi.mocked(loadAllNovelMeta).mockResolvedValue([meta({ id: "n1", title: "洛阳旧事" })]);
    const order: string[] = [];
    vi.mocked(enqueuePendingLeave).mockImplementation(() => { order.push("enqueue"); });
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      // 只记 leave 那一发：组件挂载时构建状态轮询也要打 apiFetch，全记会串成本地顺序
      if (String(url).includes("/leave")) order.push("leave");
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    render(<BookSelect />);
    await screen.findByText("《洛阳旧事》");

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByTitle("删除此书"));
    await waitFor(() => expect(deleteNovel).toHaveBeenCalledWith("n1"));
    await new Promise((r) => setTimeout(r, 20));

    expect(order, "记账必须发生在请求之前，否则这一发压根没送达就没人知道").toEqual(["enqueue", "leave"]);
    expect(clearPendingLeave).toHaveBeenCalledWith("n1");
  });

  it("章节没取回来就不许把书挂上书架（半截 join 比不响应更糟）", async () => {
    render(<BookSelect />);
    await screen.findByRole("button", { name: "从文件夹导入" });

    vi.mocked(apiFetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/api/novels?")) {
        return { ok: true, status: 200, json: async () => [
          meta({ id: "srv-1", title: "云端旧事" }),
        ] } as unknown as Response;
      }
      return { ok: false, status: 500, json: async () => ({ error: "炸了" }) } as unknown as Response;
    });

    fireEvent.click(screen.getByRole("button", { name: "扫描书库" }));
    await screen.findByText("《云端旧事》");
    fireEvent.click(screen.getByRole("button", { name: "加入书架" }));
    await new Promise((r) => setTimeout(r, 30));

    // 取章节失败：这一本**不许**长出书架卡片。书库那一行仍然挂着《云端旧事》是
    // 对的（它本来就在服务器上），所以判据要落在"书架仍是空的"那一面。
    expect(screen.getByText("书架上还没有书，上传第一本小说吧")).toBeInTheDocument();
    expect(useNovelStore.getState().novels).toEqual([]);
  });
});
