/**
 * `useSearch` 单元判据（地板第 2 档第十一批·hook 档）。
 *
 * 这一档只判**检索那一趟的取舍**：什么时候根本不该发请求、嵌入引擎建索引失败了要不要
 * 悄悄降级、正文不全时要不要回读全书、以及最难的那一条——**后到的旧搜索结果不许赢**。
 * 真后端那条腿（`e2e/specs-real/r-rag.spec.ts`）只能观察到最终界面：两次搜索谁先谁后
 * 由网络和模型说话，我在这儿造不出"甲晚于乙落地"这个时序。只有桩能按我要的顺序放行。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const rag = vi.hoisted(() => ({
  engine: "tfidf",
  buildIndex: vi.fn(),
  retrieve: vi.fn(),
  loadNovel: vi.fn(),
}));

vi.mock("@/rag/index", () => ({
  buildIndex: rag.buildIndex,
  retrieveRelevantWithDetails: rag.retrieve,
}));
vi.mock("@/db/repositories", () => ({ loadNovel: rag.loadNovel }));
vi.mock("@/stores/rag-store", () => ({
  useRAGStore: (sel: (s: { engine: string }) => unknown) => sel({ engine: rag.engine }),
}));

import { useSearch } from "../useSearch";

const CHAPTERS = [
  { id: "c-1", title: "第一章", content: "正文甲" },
  { id: "c-2", title: "第二章", content: "正文乙" },
];

/** 每一次检索都得带上这一趟的取消信号（第五个参数那个 opts 对象），不然"取消了"只丢结果、不停工 */
const SIGNAL = expect.objectContaining({ signal: expect.any(AbortSignal) });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
}

function setup(over: { engine?: string; chapters?: { id: string; title: string; content: string }[] } = {}) {
  rag.engine = over.engine ?? "tfidf";
  const hook = renderHook(() =>
    useSearch({ novelId: "book-1", chapters: over.chapters ?? CHAPTERS }),
  );
  return {
    hook,
    /** 换查询词：`handleSearch` 是按 searchQuery 建的闭包，得等它换掉 */
    async type(q: string) {
      act(() => hook.result.current.setSearchQuery(q));
      await flush();
    },
    /** 发起一次搜索，不 await（返回在飞的那趟，供手动放行） */
    fire() {
      let out!: Promise<void>;
      act(() => {
        out = hook.result.current.handleSearch();
      });
      return out;
    },
  };
}

/** 放一个宏任务，把这一拍能排上的微任务链全跑干（建索引→检索→setState 要好几跳） */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 放行一扇门（`gate.resolve` / `gate.reject`），并把随之而来的 setState 收进 act */
async function settle(run: Promise<void>, release: () => void) {
  await act(async () => {
    release();
    await run;
  });
  await flush();
}

/** 等在飞的那趟自己跑完，setState 同样收进 act */
async function drain(run: Promise<void>) {
  await act(async () => {
    await run;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rag.buildIndex.mockResolvedValue({} as never);
  rag.retrieve.mockResolvedValue({ text: "", results: [], engine: "tfidf" } as never);
  rag.loadNovel.mockResolvedValue(null as never);
});

describe("useSearch · 该不该发这一趟", () => {
  it("空查询和纯空格一律不搜，也不许把转圈打开", async () => {
    const { hook, type, fire } = setup();
    await type("   ");
    await flush();
    fire();
    await flush();
    expect(rag.buildIndex, "空查询也去建索引，等于每敲一次空格刷一遍全书").not.toHaveBeenCalled();
    expect(rag.retrieve).not.toHaveBeenCalled();
    expect(hook.result.current.searchLoading).toBe(false);
  });

  it("查询词两头空格在送进检索前就剪掉", async () => {
    const { type, fire } = setup();
    await type("  剑修  ");
    fire();
    await flush();
    expect(rag.retrieve).toHaveBeenCalledWith("book-1", "剑修", 10, "tfidf", SIGNAL);
  });
});

describe("useSearch · 引擎与索引", () => {
  it("嵌入引擎：先按 cacheOnly 建索引，检索仍按嵌入引擎名走", async () => {
    const { type, fire } = setup({ engine: "Xenova/bge-small-zh-v1.5" });
    await type("剑修");
    fire();
    await flush();
    expect(rag.buildIndex).toHaveBeenNthCalledWith(
      1,
      "book-1",
      CHAPTERS,
      "Xenova/bge-small-zh-v1.5",
      undefined,
      { cacheOnly: true },
    );
    expect(rag.retrieve).toHaveBeenCalledWith("book-1", "剑修", 10, "Xenova/bge-small-zh-v1.5", SIGNAL);
  });

  it("嵌入引擎建索引抛错 → 这一趟改用 tfidf，并且真的按 tfidf 建过一次", async () => {
    rag.buildIndex.mockRejectedValueOnce(new Error("模型没下载"));
    const { hook, type, fire } = setup({ engine: "Xenova/bge-small-zh-v1.5" });
    await type("剑修");
    fire();
    await flush();
    expect(rag.buildIndex).toHaveBeenNthCalledWith(2, "book-1", CHAPTERS, "tfidf");
    expect(rag.retrieve, "降级完了还把查询送给嵌入引擎，等于白降").toHaveBeenCalledWith(
      "book-1",
      "剑修",
      10,
      "tfidf",
      SIGNAL,
    );
    expect(hook.result.current.searchError, "降级是设计好的路，不该报错吓用户").toBeNull();
  });

  it("tfidf：章节正文都在 → 不许再回读全书", async () => {
    const { type, fire } = setup();
    await type("剑修");
    fire();
    await flush();
    expect(rag.loadNovel, "正文齐着还读全书，白多一份内存").not.toHaveBeenCalled();
    expect(rag.buildIndex).toHaveBeenCalledWith("book-1", CHAPTERS, "tfidf");
  });

  it("tfidf：有一章正文是空的 → 回读全书，并按读到的那份建索引", async () => {
    const full = [{ id: "c-1", title: "第一章", content: "正文甲" }];
    rag.loadNovel.mockResolvedValue({ id: "book-1", chapters: full } as never);
    const { type, fire } = setup({ chapters: [{ id: "c-1", title: "第一章", content: "" }] });
    await type("剑修");
    fire();
    await flush();
    expect(rag.loadNovel).toHaveBeenCalledWith("book-1", undefined, true);
    expect(rag.buildIndex).toHaveBeenCalledWith("book-1", full, "tfidf");
  });

  it("回读全书拿到 null → 就用本地这份建，不崩也不报错", async () => {
    rag.loadNovel.mockResolvedValue(null as never);
    const { type, fire, hook } = setup({ chapters: [{ id: "c-1", title: "第一章", content: "" }] });
    await type("剑修");
    fire();
    await flush();
    expect(rag.buildIndex).toHaveBeenCalledWith("book-1", [{ id: "c-1", title: "第一章", content: "" }], "tfidf");
    expect(hook.result.current.searchError).toBeNull();
  });
});

describe("useSearch · 后到的旧搜索不许赢", () => {
  it("甲的结果晚于乙落地 → 界面留在乙，甲不许覆盖上去", async () => {
    const gateA = deferred<unknown>();
    const gateB = deferred<unknown>();
    rag.retrieve.mockImplementation((_id: string, q: string) =>
      q === "甲" ? gateA.p : gateB.p,
    );
    const { hook, type, fire } = setup();
    await type("甲");
    const runA = fire();
    await type("乙");
    const runB = fire();

    await settle(
      runB,
      () => gateB.resolve({ text: "", results: [{ content: "乙的结果", score: 0.9 }], engine: "tfidf" }),
    );
    expect(hook.result.current.searchResults).toHaveLength(1);

    await settle(
      runA,
      () => gateA.resolve({ text: "", results: [{ content: "甲的结果", score: 0.8 }], engine: "tfidf" }),
    );
    expect(hook.result.current.searchResults.map((r) => r.content), "上一笔查询的结果回来了").toEqual(["乙的结果"]);
  });

  it("甲的错误晚到 → 不许把红字甩到界面上", async () => {
    const gateA = deferred<unknown>();
    rag.retrieve.mockImplementation((_id: string, q: string) => (q === "甲" ? gateA.p : Promise.resolve({ text: "", results: [], engine: "tfidf" })));
    const { hook, type, fire } = setup();
    await type("甲");
    const runA = fire();
    await type("乙");
    const runB = fire();
    await drain(runB);

    await settle(runA, () => gateA.reject(new Error("甲超时")));
    expect(hook.result.current.searchError, "用户早就换词搜完了，不该被上一次搜索的错打断").toBeNull();
  });

  it("索引还没建完就被新搜索掐了 → 那趟检索根本不该发出去", async () => {
    const gateBuild = deferred<unknown>();
    rag.buildIndex.mockImplementationOnce(() => gateBuild.p);
    const { type, fire } = setup();
    await type("甲");
    const runA = fire();
    await type("乙");
    const runB = fire();
    await drain(runB);
    await flush();

    await settle(runA, () => gateBuild.resolve({}));
    expect(rag.retrieve.mock.calls.map((c) => c[1]), "取消之后还发检索，白烧一次模型").toEqual(["乙"]);
  });

  it("被掐掉的那次不许提前把转圈停掉（转圈归最后一次搜索管）", async () => {
    const gateA = deferred<unknown>();
    const gateB = deferred<unknown>();
    rag.retrieve.mockImplementation((_id: string, q: string) => (q === "甲" ? gateA.p : gateB.p));
    const { hook, type, fire } = setup();
    await type("甲");
    const runA = fire();
    await type("乙");
    const runB = fire();
    await flush();

    await settle(runA, () => gateA.resolve({ text: "", results: [], engine: "tfidf" }));
    expect(hook.result.current.searchLoading, "乙还在路上，甲的收尾不许把转圈停了").toBe(true);

    await settle(runB, () => gateB.resolve({ text: "", results: [], engine: "tfidf" }));
    expect(hook.result.current.searchLoading).toBe(false);
  });
});

describe("useSearch · 结果、报错与清空", () => {
  it("检索回来的正文和引擎名一起落到界面上", async () => {
    rag.retrieve.mockResolvedValue({
      text: "",
      results: [
        { content: "第一段", score: 0.912 },
        { content: "第二段", score: 0.5 },
      ],
      engine: "tfidf",
    } as never);
    const { hook, type, fire } = setup();
    await type("剑修");
    fire();
    await flush();
    expect(hook.result.current.searchResults.map((r) => r.content)).toEqual(["第一段", "第二段"]);
    expect(hook.result.current.searchEngine).toBe("tfidf");
    expect(hook.result.current.searchLoading).toBe(false);
  });

  it("抛 Error → 原文照登，一个字都不许吞", async () => {
    rag.retrieve.mockRejectedValue(new Error("向量库被别的标签页占着"));
    const { hook, type, fire } = setup();
    await type("剑修");
    fire();
    await flush();
    expect(hook.result.current.searchError).toBe("向量库被别的标签页占着");
    expect(hook.result.current.searchLoading, "报错了也要把转圈停掉，不然界面永久卡住").toBe(false);
  });

  it("抛的不是 Error → 兜底成「搜索失败」，不显示 undefined", async () => {
    rag.retrieve.mockRejectedValue("字符串");
    const { hook, type, fire } = setup();
    await type("剑修");
    fire();
    await flush();
    expect(hook.result.current.searchError).toBe("搜索失败");
  });

  it("clearSearch 一次抹干：查询词、结果、引擎、错误", async () => {
    rag.retrieve.mockResolvedValue({
      text: "",
      results: [{ content: "第一段", score: 0.9 }],
      engine: "Xenova/gte-small",
    } as never);
    const { hook, type, fire } = setup({ engine: "Xenova/gte-small" });
    await type("剑修");
    fire();
    await flush();
    expect(hook.result.current.searchResults).toHaveLength(1);

    act(() => hook.result.current.clearSearch());
    await flush();
    expect(hook.result.current.searchQuery).toBe("");
    expect(hook.result.current.searchResults).toEqual([]);
    expect(hook.result.current.searchEngine, "引擎还挂着上本书的名字，界面就会说假话").toBe("none");
    expect(hook.result.current.searchError).toBeNull();
  });

  it("检索要收到这一次搜索的取消信号，清空之后这把信号得真的成立", async () => {
    const gate = deferred<unknown>();
    rag.retrieve.mockReturnValue(gate.p);
    const { hook, type, fire } = setup();
    await type("剑修");
    fire();
    await flush();

    const signal = (rag.retrieve.mock.calls[0][4] as { signal?: AbortSignal } | undefined)?.signal;
    expect(signal, "没把 signal 传进检索：取消了也停不下编码那一趟").toBeInstanceOf(AbortSignal);
    if (!signal) throw new Error("检索没收到取消信号，后面两格无从判起");
    expect(signal.aborted).toBe(false);

    act(() => hook.result.current.clearSearch());
    expect(signal.aborted, "清空说停了，检索那边却还以为有人要结果").toBe(true);
    gate.resolve({ text: "", results: [], engine: "tfidf" });
  });

  it("换书清空要掐住在飞的那趟——上一本的结果不许回来", async () => {
    const gate = deferred<unknown>();
    rag.retrieve.mockReturnValue(gate.p);
    const { hook, type, fire } = setup();
    await type("剑修");
    const run = fire();
    await flush();

    act(() => hook.result.current.clearSearch());
    await settle(
      run,
      () => gate.resolve({ text: "", results: [{ content: "上一本的结果", score: 0.9 }], engine: "tfidf" }),
    );
    expect(hook.result.current.searchResults, "换书之后铺上来的是上一本的结果").toEqual([]);
    expect(hook.result.current.searchLoading, "清空把那趟掐了，收尾就该由清空自己把转圈停下").toBe(false);
  });
});
